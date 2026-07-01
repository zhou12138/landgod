"""Find the latest meeting-notes Loop URLs in a Teams group chat.

Pattern (verified for Stride Shiproom):
- A "Facilitator" bot posts a summary message after each meeting whose body
  starts with "各位，会议结束了" (zh) or "that's a wrap" (en).
- The body contains a single <a href="..." itemtype="http://schema.skype.com/FluidAutoEmbedLink">
  pointing at a personal-OneDrive Loop file (https://*-my.sharepoint.com/:fl:/g/personal/<organizer>/...).

This module locates that chat (by display topic), scans recent messages,
and returns the most recent N (timestamp, loop_url) pairs.

Auth: uses its own MSAL PublicClientApplication with Chat.Read scope.
We can't reuse cloud_io's Azure-CLI client_id because that app has only
Files/User scopes consented; chat reads need a separate app registration
(default = the same one teams-graph skill uses).
"""
from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

import msal
import requests

GRAPH = "https://graph.microsoft.com/v1.0"
DEFAULT_TENANT_ID = "72f988bf-86f1-41af-91ab-2d7cd011db47"  # microsoft.com
# Same client_id the teams-graph skill uses; has Chat.ReadWrite + User.Read.
DEFAULT_CHAT_CLIENT_ID = "4542b8c8-95b1-44c8-bf08-2ff2aa579776"
SCOPES = ["Chat.Read", "User.Read"]

# Facilitator's signature openers.
_NOTES_MARKERS = ("会议结束了", "that's a wrap", "that’s a wrap")
# Anchor inside the message body that carries the Loop URL.
_HREF_RE = re.compile(
    r'<a[^>]+href="(?P<url>https?://[^"]+)"[^>]*itemtype="[^"]*FluidAutoEmbedLink"',
    re.IGNORECASE,
)


class NotesFinderError(RuntimeError):
    pass


@dataclass
class NotesEntry:
    timestamp: str   # ISO8601 from createdDateTime
    url: str
    sender: str      # display name or "?"
    message_id: str


_app: Optional[msal.PublicClientApplication] = None


def _get_chat_token() -> str:
    """Acquire a Graph token with Chat.Read. Silent if cached, interactive once."""
    global _app
    if _app is None:
        tenant = os.environ.get("MICROSOFT_TENANT_ID", DEFAULT_TENANT_ID)
        client_id = os.environ.get("SHIPROOM_CHAT_CLIENT_ID", DEFAULT_CHAT_CLIENT_ID)
        _app = msal.PublicClientApplication(
            client_id=client_id,
            authority=f"https://login.microsoftonline.com/{tenant}",
            enable_broker_on_windows=sys.platform == "win32",
            enable_broker_on_mac=sys.platform == "darwin",
        )
    result = None
    accounts = _app.get_accounts()
    if accounts:
        result = _app.acquire_token_silent(SCOPES, account=accounts[0])
    if not result or "access_token" not in result:
        # WAM interactive can be hidden behind VS Code; device_code is more
        # terminal-friendly: prints a short URL+code the user pastes in any browser.
        flow = _app.initiate_device_flow(scopes=SCOPES)
        if "user_code" not in flow:
            raise NotesFinderError(f"Failed to start device flow: {flow}")
        print(flow["message"], flush=True)   # e.g. "Go to https://microsoft.com/devicelogin and enter code XXXXXXXX"
        result = _app.acquire_token_by_device_flow(flow)  # blocks until user completes
    if "access_token" not in result:
        raise NotesFinderError(
            f"Chat-token auth failed: {result.get('error_description', result)}"
        )
    return result["access_token"]


def _headers() -> dict:
    return {"Authorization": f"Bearer {_get_chat_token()}",
            "Accept": "application/json"}


def _find_chat_id(chat_topic: str) -> str:
    """Return the chat id whose `topic` contains chat_topic (case-insensitive)."""
    needle = chat_topic.lower()
    url = f"{GRAPH}/me/chats?$top=50&$select=id,topic"
    while url:
        r = requests.get(url, headers=_headers(), timeout=30)
        r.raise_for_status()
        data = r.json()
        for chat in data.get("value", []):
            topic = (chat.get("topic") or "").lower()
            if topic and needle in topic:
                return chat["id"]
        url = data.get("@odata.nextLink")
    raise NotesFinderError(
        f"No Teams chat found whose topic contains {chat_topic!r}. "
        f"Check notes_source.teams_chat_topic in shiproom-config.yaml."
    )


def _iter_messages(chat_id: str, max_pages: int = 6):
    """Yield raw message dicts newest-first across up to max_pages of 50."""
    url = f"{GRAPH}/me/chats/{chat_id}/messages?$top=50"
    pages = 0
    while url and pages < max_pages:
        r = requests.get(url, headers=_headers(), timeout=30)
        r.raise_for_status()
        data = r.json()
        for m in data.get("value", []):
            yield m
        url = data.get("@odata.nextLink")
        pages += 1


def _extract_loop_url(msg: dict) -> Optional[str]:
    body = (msg.get("body") or {}).get("content") or ""
    if not any(m in body for m in _NOTES_MARKERS):
        return None
    match = _HREF_RE.search(body)
    if match:
        return match.group("url")
    return None


def find_recent_meeting_notes(chat_topic: str, n: int = 1,
                               max_pages: int = 6) -> List[NotesEntry]:
    """Return up to `n` most-recent meeting-notes entries from the named chat.

    chat_topic: substring matched against chat.topic (case-insensitive).
                e.g. "Stride Shiproom" matches "Stride Shiproom (Link attached)".
    """
    chat_id = _find_chat_id(chat_topic)
    out: List[NotesEntry] = []
    for m in _iter_messages(chat_id, max_pages=max_pages):
        url = _extract_loop_url(m)
        if not url:
            continue
        sender = (((m.get("from") or {}).get("user") or {}).get("displayName") or "?")
        out.append(NotesEntry(
            timestamp=m.get("createdDateTime") or "",
            url=url,
            sender=sender,
            message_id=m.get("id") or "",
        ))
        if len(out) >= n:
            break
    if not out:
        raise NotesFinderError(
            f"No facilitator-summary messages found in chat {chat_topic!r}. "
            "Either no meetings have happened yet, or the marker phrase changed."
        )
    return out


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--topic", default="Stride Shiproom",
                    help="substring of the Teams chat topic")
    ap.add_argument("--n", type=int, default=2, help="how many recent entries")
    args = ap.parse_args()
    for i, e in enumerate(find_recent_meeting_notes(args.topic, n=args.n)):
        print(f"[{i}] {e.timestamp}  by {e.sender}\n    {e.url}")
