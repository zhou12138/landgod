"""SharePoint cloud I/O for Societas Shiproom.

All meeting data lives in a Teams channel's SharePoint folder.
This module provides file-like operations against that folder via Microsoft Graph.

Auth: uses Azure CLI client_id via MSAL (broader Graph scopes consented tenant-wide).
First run pops a WAM/browser sign-in; subsequent runs use cached account silently.

Identity for signing updates is parsed from the access token.
"""
from __future__ import annotations

import base64
import datetime as dt
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import requests
import msal
from msal import PublicClientApplication

GRAPH = "https://graph.microsoft.com/v1.0"
AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"
DEFAULT_TENANT_ID = "72f988bf-86f1-41af-91ab-2d7cd011db47"  # microsoft.com


# ============================================================================
# Auth (cached; silent if possible)
# ============================================================================

_app: Optional[PublicClientApplication] = None
_token_cache: dict = {}  # {scope_key: (token, expires_at_epoch)}

# Persistent MSAL token cache — survives process restarts (e.g. MCP subprocess).
_CACHE_DIR = Path(os.environ.get("SHIPROOM_CACHE_DIR",
                                  os.path.join(os.path.expanduser("~"), ".shiproom")))
_MSAL_CACHE_PATH = _CACHE_DIR / "msal_token_cache.bin"


def _get_persistent_cache() -> msal.SerializableTokenCache:
    """Return an MSAL token cache backed by a local file."""
    cache = msal.SerializableTokenCache()
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if _MSAL_CACHE_PATH.exists():
        cache.deserialize(_MSAL_CACHE_PATH.read_text(encoding="utf-8"))
    return cache


def _save_cache(cache: msal.SerializableTokenCache) -> None:
    """Persist the MSAL token cache to disk if it changed."""
    if cache.has_state_changed:
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _MSAL_CACHE_PATH.write_text(cache.serialize(), encoding="utf-8")


def _get_app() -> PublicClientApplication:
    global _app
    if _app is None:
        tenant = os.environ.get("MICROSOFT_TENANT_ID", DEFAULT_TENANT_ID)
        cache = _get_persistent_cache()
        _app = PublicClientApplication(
            client_id=AZURE_CLI_CLIENT_ID,
            authority=f"https://login.microsoftonline.com/{tenant}",
            enable_broker_on_windows=sys.platform == "win32",
            enable_broker_on_mac=sys.platform == "darwin",
            token_cache=cache,
        )
    return _app


def get_token(scopes: Optional[list[str]] = None) -> str:
    """Return a Graph access token. Silent when possible, interactive as fallback.

    If SHIPROOM_ACCESS_TOKEN is set in the environment, use it directly
    (token injected by the parent MCP server process where WAM is available).
    """
    injected = os.environ.get("SHIPROOM_ACCESS_TOKEN", "").strip()
    if injected:
        return injected

    if scopes is None:
        scopes = ["https://graph.microsoft.com/.default"]
    key = ",".join(scopes)
    cached = _token_cache.get(key)
    now = time.time()
    if cached and cached[1] - now > 60:
        return cached[0]

    app = _get_app()
    result = None
    accounts = app.get_accounts()
    if accounts:
        result = app.acquire_token_silent(scopes, account=accounts[0])
    if not result or "access_token" not in result:
        result = app.acquire_token_interactive(
            scopes=scopes,
            parent_window_handle=msal.PublicClientApplication.CONSOLE_WINDOW_HANDLE,
        )
    if "access_token" not in result:
        raise RuntimeError(f"Auth failed: {result.get('error_description', result)}")
    # Persist cache to disk so MCP subprocess restarts don't lose the token.
    if hasattr(app, '_cache') and app._cache:
        _save_cache(app._cache)
    elif app.token_cache:
        _save_cache(app.token_cache)
    expires_at = now + int(result.get("expires_in", 3600))
    _token_cache[key] = (result["access_token"], expires_at)
    return result["access_token"]


def get_identity() -> dict:
    """Decode the access token's payload to extract the signed-in user identity.

    Returns dict with keys: upn, name, oid.
    """
    token = get_token()
    try:
        payload_b64 = token.split(".")[1]
        # pad
        payload_b64 += "=" * (-len(payload_b64) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload_b64))
    except Exception:
        return {"upn": "unknown", "name": "unknown", "oid": ""}
    return {
        "upn": claims.get("upn") or claims.get("preferred_username") or "unknown",
        "name": claims.get("name") or claims.get("upn") or "unknown",
        "oid": claims.get("oid", ""),
    }


def short_name() -> str:
    """Return short handle from upn (everything before @)."""
    upn = get_identity()["upn"]
    return upn.split("@")[0] if "@" in upn else upn


# ============================================================================
# Graph helpers
# ============================================================================

def _headers(extra: Optional[dict] = None) -> dict:
    h = {"Authorization": f"Bearer {get_token()}"}
    if extra:
        h.update(extra)
    return h


def _request(method: str, url: str, **kw) -> requests.Response:
    h = kw.pop("headers", {})
    h = {**_headers(), **h}
    return requests.request(method, url, headers=h, timeout=60, **kw)


# ============================================================================
# ShiproomCloud: high-level API
# ============================================================================

@dataclass
class ShiproomCloud:
    """Interface to the Shiproom SharePoint folder structure.

    Layout (under <channel>/Shiproom/):
        current/
            ... files appended/uploaded during the active week
        history/
            <YYYY-MM-DD>/
                ... archived snapshot of current/
    """

    drive_id: str
    base_path: str  # path of the channel folder relative to drive root, e.g. "Shiproom"
    current_dir: str = "current"
    history_dir: str = "history"

    @classmethod
    def from_config(cls, cfg: dict) -> "ShiproomCloud":
        sp = (cfg.get("storage") or {}).get("sharepoint") or {}
        if not sp.get("drive_id"):
            raise ValueError("storage.sharepoint.drive_id missing in config")
        return cls(
            drive_id=sp["drive_id"],
            base_path=sp.get("base_path", "Shiproom").strip("/"),
            current_dir=sp.get("current_dir", "current"),
            history_dir=sp.get("history_dir", "history"),
        )

    # ---- path helpers -----------------------------------------------------

    def _path(self, *parts: str) -> str:
        joined = "/".join(p.strip("/") for p in (self.base_path, *parts) if p)
        return joined

    def _item_url(self, *parts: str) -> str:
        """Return Graph URL using path notation: /drives/{id}/root:/path:"""
        return f"{GRAPH}/drives/{self.drive_id}/root:/{self._path(*parts)}:"

    # ---- read / write -----------------------------------------------------

    def read_text(self, *parts: str, default: str = "") -> str:
        r = _request("GET", self._item_url(*parts) + "/content")
        if r.status_code == 404:
            return default
        r.raise_for_status()
        raw = r.content
        # Detect UTF-16 (BOM or null-byte heuristic) -- happens when a Windows shell
        # accidentally re-encoded the file via `> file.md`. Decode it as UTF-16 so
        # we can recover the real text instead of getting U+FFFD garbage.
        if raw[:2] == b"\xff\xfe":
            text = raw[2:].decode("utf-16-le", errors="replace")
        elif raw[:2] == b"\xfe\xff":
            text = raw[2:].decode("utf-16-be", errors="replace")
        elif len(raw) >= 4 and raw[1] == 0 and raw[3] == 0:
            text = raw.decode("utf-16-le", errors="replace")
        else:
            text = raw.decode("utf-8-sig", errors="replace")
        # Normalize Windows CRLF to LF so write-back is idempotent.
        return text.replace("\r\n", "\n")

    def write_text(self, content: str, *parts: str, content_type: str = "text/markdown") -> dict:
        r = _request(
            "PUT",
            self._item_url(*parts) + "/content",
            headers={"Content-Type": content_type},
            data=content.encode("utf-8"),
        )
        r.raise_for_status()
        return r.json()

    def upload_file(self, local_path: str | Path, *parts: str) -> dict:
        """Upload a binary file (PDF, xlsx, etc.). Small file path (< 4MB)."""
        local = Path(local_path)
        data = local.read_bytes()
        ct = "application/octet-stream"
        ext = local.suffix.lower()
        if ext == ".pdf":
            ct = "application/pdf"
        elif ext == ".md":
            ct = "text/markdown"
        elif ext in (".xlsx", ".xls"):
            ct = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        r = _request(
            "PUT",
            self._item_url(*parts) + "/content",
            headers={"Content-Type": ct},
            data=data,
        )
        r.raise_for_status()
        return r.json()

    def download_file(self, dest: str | Path, *parts: str) -> Path:
        r = _request("GET", self._item_url(*parts) + "/content")
        r.raise_for_status()
        out = Path(dest)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(r.content)
        return out

    def append_text(self, text: str, *parts: str, ensure_header: Optional[str] = None) -> dict:
        """Append text to a markdown file. Creates the file with `ensure_header` if missing.

        Race conditions: not atomic. Acceptable for the Shiproom load (a few writes/min).
        """
        existing = self.read_text(*parts, default="")
        if not existing and ensure_header:
            existing = ensure_header.rstrip() + "\n\n"
        new = existing.rstrip() + "\n\n" + text.rstrip() + "\n"
        return self.write_text(new, *parts)

    def append_signed_entry(
        self,
        section: str,
        body: str,
        *,
        section_header_template: str = "# {section}\n\n",
    ) -> dict:
        """Append an /sr-update style entry to current/updates/<section>.md.

        Signed with current user's short name + ISO timestamp.
        """
        from datetime import datetime, timezone

        ident = get_identity()
        ts = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
        entry = (
            f"### @{ident['upn'].split('@')[0]} · {ts}\n\n"
            f"{body.strip()}\n"
        )
        header = section_header_template.format(section=section)
        return self.append_text(
            entry,
            self.current_dir,
            "updates",
            f"{section}.md",
            ensure_header=header,
        )

    # ---- folder / list ----------------------------------------------------

    def list_dir(self, *parts: str) -> list[dict]:
        url = self._item_url(*parts) + "/children"
        items = []
        while url:
            r = _request("GET", url)
            if r.status_code == 404:
                return []
            r.raise_for_status()
            j = r.json()
            items.extend(j.get("value", []))
            url = j.get("@odata.nextLink")
        return items

    def ensure_folder(self, *parts: str) -> dict:
        """mkdir -p semantics."""
        # Walk down, creating each segment if missing.
        # Build full path segments under base_path.
        segs = [self.base_path] + [p.strip("/") for p in parts if p]
        # Find existing prefix
        cur_path = ""
        for s in segs:
            cur_path = f"{cur_path}/{s}".lstrip("/")
            r = _request("GET", f"{GRAPH}/drives/{self.drive_id}/root:/{cur_path}")
            if r.status_code == 404:
                # create under parent
                parent = "/".join(cur_path.split("/")[:-1])
                parent_url = (
                    f"{GRAPH}/drives/{self.drive_id}/root:/{parent}:/children"
                    if parent
                    else f"{GRAPH}/drives/{self.drive_id}/root/children"
                )
                cr = _request(
                    "POST",
                    parent_url,
                    headers={"Content-Type": "application/json"},
                    json={
                        "name": s,
                        "folder": {},
                        "@microsoft.graph.conflictBehavior": "fail",
                    },
                )
                cr.raise_for_status()
            elif not r.ok:
                r.raise_for_status()
        # return final folder metadata
        r = _request("GET", f"{GRAPH}/drives/{self.drive_id}/root:/{cur_path}")
        r.raise_for_status()
        return r.json()

    def delete(self, *parts: str) -> bool:
        r = _request("DELETE", self._item_url(*parts))
        if r.status_code in (200, 204):
            return True
        if r.status_code == 404:
            return False
        r.raise_for_status()
        return False

    def archive_current(self, date_str: str, clear: bool = False) -> dict:
        """Snapshot current/* to history/<date_str>/.

        Behaviour:
          * Always copies current/ to history/<date>/ (preserving everything).
          * If clear=True, ALSO deletes children of current/ afterwards (legacy
            "reset to empty" mode — not recommended; team /sr-update entries
            from this week would be lost if clear is used mid-cycle).
          * Default clear=False (carry-forward mode): current/ keeps its content,
            but mtime stays at the original write time so /sr-prep's [STALE]/[LEFT]
            checks still flag last-week content for refresh.
        """
        # Ensure history exists
        self.ensure_folder(self.history_dir)
        # Get current item id
        r = _request("GET", self._item_url(self.current_dir))
        r.raise_for_status()
        current_id = r.json()["id"]
        # Get history folder id
        r = _request("GET", self._item_url(self.history_dir))
        r.raise_for_status()
        history_id = r.json()["id"]
        # Copy
        copy_url = f"{GRAPH}/drives/{self.drive_id}/items/{current_id}/copy"
        cr = _request(
            "POST",
            copy_url,
            headers={"Content-Type": "application/json"},
            json={
                "parentReference": {"driveId": self.drive_id, "id": history_id},
                "name": date_str,
            },
        )
        if cr.status_code not in (200, 202):
            cr.raise_for_status()
        # Wait for copy to complete (Graph returns 202 + Location for monitoring)
        monitor = cr.headers.get("Location")
        if monitor:
            for _ in range(60):
                m = requests.get(monitor, timeout=30)
                if m.status_code in (200, 303):
                    if m.status_code == 303:
                        break
                    j = m.json()
                    if j.get("status") in ("completed", "failed"):
                        if j["status"] == "failed":
                            raise RuntimeError(f"Copy failed: {j}")
                        break
                time.sleep(1)
        # Optional: clear current/ children (legacy mode). Default carry-forward.
        if clear:
            for child in self.list_dir(self.current_dir):
                del_url = f"{GRAPH}/drives/{self.drive_id}/items/{child['id']}"
                _request("DELETE", del_url)
        # Stamp the new archive cutoff so /sr-prep + render_view filter manual
        # entries from the *previous* meeting cycle out of the next view.
        # Carry-forward depends on this marker; do NOT skip it.
        cutoff_iso = dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")
        try:
            self.write_text(cutoff_iso + "\n", self.current_dir, ".last-archive",
                            content_type="text/plain")
        except Exception as exc:  # pragma: no cover - best-effort marker
            print(f"WARN: could not write .last-archive marker: {exc}")
        return {
            "date": date_str,
            "history_path": self._path(self.history_dir, date_str),
            "cleared": clear,
            "cutoff": cutoff_iso,
        }

    # ---- convenience ------------------------------------------------------

    def web_url(self, *parts: str) -> str:
        r = _request("GET", self._item_url(*parts))
        if r.ok:
            return r.json().get("webUrl", "")
        return ""
