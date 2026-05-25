"""Societas Shiproom MCP Server — full edition.

Exposes both read and write tools:
  Read:  SharePoint file listing & reading, history browsing
  Fetch: Loop document (headless Chrome), OCV Excel (Graph API),
         Teams meeting notes (Graph API + Chrome)
  Write: update sections, append notes, archive, upload markdown
  Ops:   pre-meeting checklist, render HTML dashboard, get URLs

Run:
    python server.py            # stdio transport (default)
    python server.py --sse      # SSE transport on port 8811
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from mcp.server.fastmcp import FastMCP

# ---- Bootstrap: use bundled scripts (self-contained) ---------------------
_THIS_DIR = Path(__file__).resolve().parent
SKILL_SCRIPTS = os.environ.get("SHIPROOM_SKILL_SCRIPTS", str(_THIS_DIR / "scripts"))
if SKILL_SCRIPTS not in sys.path:
    sys.path.insert(0, SKILL_SCRIPTS)

SKILL_ROOT = _THIS_DIR
DEFAULT_CONFIG = _THIS_DIR / "shiproom-config.yaml"

_cloud = None
_cfg = None


def _load_config():
    global _cfg
    if _cfg is not None:
        return _cfg
    import yaml
    config_path = os.environ.get("SHIPROOM_CONFIG", str(DEFAULT_CONFIG))
    _cfg = yaml.safe_load(Path(config_path).read_text(encoding="utf-8"))
    return _cfg


def _get_cloud():
    global _cloud
    if _cloud is not None:
        return _cloud
    from cloud_io import ShiproomCloud
    _cloud = ShiproomCloud.from_config(_load_config())
    return _cloud


# ---- MCP Server -----------------------------------------------------------

mcp = FastMCP(
    "shiproom",
    instructions="Societas Shiproom — read/write SharePoint data, fetch Loop/OCV/Notes, manage meeting lifecycle (update, archive, prep, render)",
)


# ---- 1. Login & Identity --------------------------------------------------

@mcp.tool()
def shiproom_login() -> str:
    """Trigger MSAL interactive login and cache the token to disk.
    Must be called once before other tools work. If running headless,
    run `python cloud_cli.py whoami` in a visible terminal first."""
    from cloud_io import get_token, get_identity, _save_cache, _get_app
    try:
        get_token()
        app = _get_app()
        if app.token_cache:
            _save_cache(app.token_cache)
        ident = get_identity()
        return json.dumps({
            "status": "ok",
            "upn": ident["upn"],
            "name": ident["name"],
        }, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({
            "status": "error",
            "message": str(exc),
            "hint": "Run in a visible terminal: python cloud_cli.py whoami",
        }, ensure_ascii=False)


@mcp.tool()
def shiproom_whoami() -> str:
    """Show the currently signed-in user identity (UPN, display name)."""
    from cloud_io import get_identity, short_name
    ident = get_identity()
    return json.dumps({
        "upn": ident["upn"],
        "name": ident["name"],
        "short": short_name(),
    }, ensure_ascii=False)


# ---- 2. SharePoint files (read-only) --------------------------------------

@mcp.tool()
def shiproom_status() -> str:
    """List all files in current/ and current/updates/ with sizes."""
    cloud = _get_cloud()
    result = {"folder": cloud.web_url("current") or ""}
    items = cloud.list_dir("current")
    result["current"] = [
        {"name": it["name"], "type": "folder" if "folder" in it else "file",
         "size": it.get("size", 0)}
        for it in sorted(items, key=lambda x: x["name"])
    ]
    sub = cloud.list_dir("current", "updates")
    if sub:
        result["updates"] = [
            {"name": it["name"], "size": it.get("size", 0)}
            for it in sorted(sub, key=lambda x: x["name"])
        ]
    return json.dumps(result, ensure_ascii=False)


@mcp.tool()
def shiproom_read(remote_path: str) -> str:
    """Read a file's UTF-8 content from SharePoint.

    Args:
        remote_path: path relative to Shiproom/, e.g. "current/updates/1-todo.md"
                     or "history/2026-05-18/updates/4-release.md".
    """
    cloud = _get_cloud()
    parts = [p for p in remote_path.split("/") if p]
    if not parts:
        return json.dumps({"error": "remote_path is empty"})
    text = cloud.read_text(*parts, default="")
    if not text:
        return json.dumps({"error": f"not found or empty: {remote_path}"})
    return text


@mcp.tool()
def shiproom_list_history() -> str:
    """List all archived meeting dates under history/."""
    cloud = _get_cloud()
    items = cloud.list_dir("history")
    dirs = sorted([it["name"] for it in items if "folder" in it], reverse=True)
    return json.dumps([
        {"date": d, "url": cloud.web_url("history", d)} for d in dirs
    ], ensure_ascii=False)


# ---- 3. Loop document fetch -----------------------------------------------

@mcp.tool()
def shiproom_fetch_loop() -> str:
    """Fetch the Current Loop page via headless Chrome, upload as
    current/currentloop.md, and auto-split into per-section files.

    Data source: Loop page (virtual-scrolled SPA, captured via Playwright).
    Auth: browser cookie in persistent Playwright profile."""
    return _call_cli_inproc("fetch-loop")


# ---- 4. OCV Excel fetch ---------------------------------------------------

@mcp.tool()
def shiproom_fetch_ocv() -> str:
    """Fetch the OCV Issues & Bugs Excel workbook via Graph API,
    extract latest sheet as markdown table, merge into 3-ocv.md.

    Data source: SharePoint Excel workbook.
    Auth: MSAL Graph token."""
    return _call_cli_inproc("fetch-ocv")



# ---- 6. Write: update section ----------------------------------------------

@mcp.tool()
def shiproom_update(section: str, text: str) -> str:
    """Append a signed update entry to a section file.

    The entry is timestamped and signed with the current user's identity.
    Written to current/updates/<section>.md on SharePoint.

    Args:
        section: section name, e.g. "1-todo", "2-data", "3-ocv",
                 "4-release", "5-gdpval", "6-deep-worker", "7-others"
        text: the update content to append
    """
    if not text.strip():
        return json.dumps({"error": "update text is empty"})
    cloud = _get_cloud()
    try:
        res = cloud.append_signed_entry(section, text)
        from cloud_io import short_name
        return json.dumps({
            "status": "ok",
            "file": f"current/updates/{section}.md",
            "signed_by": short_name(),
            "url": res.get("webUrl", ""),
        }, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"error": str(exc)})


# ---- 7. Write: meeting notes -----------------------------------------------

@mcp.tool()
def shiproom_notes(text: str) -> str:
    """Append timestamped meeting notes to current/notes.md.

    The entry is signed with the current user's identity.

    Args:
        text: the notes content to append
    """
    if not text.strip():
        return json.dumps({"error": "notes text is empty"})
    cloud = _get_cloud()
    try:
        import datetime as dt
        from cloud_io import short_name
        ts = dt.datetime.now().astimezone().isoformat(timespec="seconds")
        entry = f"### @{short_name()} · {ts}\n\n{text.strip()}\n"
        cloud.append_text(entry, "current", "notes.md", ensure_header="# Notes\n\n")
        return json.dumps({
            "status": "ok",
            "file": "current/notes.md",
            "signed_by": short_name(),
        }, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"error": str(exc)})


# ---- 8. Archive current/ to history/ --------------------------------------

@mcp.tool()
def shiproom_archive(date: str = "", clear: bool = False) -> str:
    """Archive current/ to history/<date>/ on SharePoint.

    Default mode is carry-forward (current/ keeps content but mtime stays old
    so /sr-prep flags stale files). Set clear=True to also wipe current/.

    Args:
        date: archive date in YYYY-MM-DD format (defaults to today)
        clear: if True, delete current/ children after copying (not recommended)
    """
    import datetime as dt
    date_str = date.strip() or dt.date.today().isoformat()
    try:
        dt.date.fromisoformat(date_str)
    except ValueError:
        return json.dumps({"error": f"invalid date '{date_str}', expected YYYY-MM-DD"})

    cloud = _get_cloud()
    existing = cloud.list_dir("history")
    if any(it["name"] == date_str for it in existing):
        return json.dumps({"error": f"history/{date_str}/ already exists"})

    try:
        res = cloud.archive_current(date_str, clear=clear)
        return json.dumps({
            "status": "ok",
            "date": date_str,
            "history_url": cloud.web_url("history", date_str),
            "cleared": res.get("cleared", False),
        }, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"error": str(exc)})


# ---- 9. Pre-meeting checklist ----------------------------------------------

@mcp.tool()
def shiproom_prep() -> str:
    """Run the pre-meeting checklist: compare current/ files against
    the expected set, flag missing/stale/leftover artifacts.

    Returns structured JSON with file statuses and recommended next steps."""
    return _call_cli_inproc("prep")


# ---- 10. Upload markdown to SharePoint ------------------------------------

@mcp.tool()
def shiproom_upload_md(local_path: str, remote_path: str) -> str:
    """Upload a local markdown file to SharePoint.

    For auto-merged files (e.g. current/updates/2-data.md, 3-ocv.md),
    content is merged into LOOP-SYNC markers preserving human entries.

    Args:
        local_path: absolute path to the local .md file
        remote_path: destination relative to Shiproom/, e.g. "current/updates/2-data.md"
    """
    return _call_cli_inproc("upload-md", [local_path, remote_path])


# ---- 11. Render HTML dashboard --------------------------------------------

@mcp.tool()
def shiproom_render_view() -> str:
    """Generate current/view.html — the Shiproom meeting dashboard.

    Reads all current/updates/*.md files, applies the hard-coded HTML/CSS
    template, and uploads view.html to SharePoint. Should be run LAST
    in the prep workflow after all data is fresh."""
    return _call_cli_inproc("render-view")


# ---- 12. Get SharePoint URL -----------------------------------------------

@mcp.tool()
def shiproom_url(path: str = "") -> str:
    """Get the SharePoint web URL for a path under Shiproom/.

    Args:
        path: relative path, e.g. "current/updates/1-todo.md" or "history/2026-05-18".
              Empty string returns the Shiproom root URL.
    """
    cloud = _get_cloud()
    parts = [p for p in path.split("/") if p] if path else []
    url = cloud.web_url(*parts) or "(not found)"
    return json.dumps({"path": path or "/", "url": url}, ensure_ascii=False)


# ---- In-process CLI helper ------------------------------------------------

def _call_cli_inproc(subcommand: str, extra_args: list[str] | None = None) -> str:
    """Run a cloud_cli subcommand IN-PROCESS (no subprocess spawn).

    Eliminates ~10-15 s of overhead that _run_cli incurs from:
      - Python interpreter cold start
      - Module re-imports (requests, msal, yaml, …)
      - MSAL broker (WAM) re-initialization

    Use for Graph API / SharePoint tools where the Hub's 60 s wall-clock
    timeout would otherwise be hit even though the work itself is fast.
    """
    import io
    from contextlib import redirect_stdout, redirect_stderr

    config_path = os.environ.get("SHIPROOM_CONFIG", str(DEFAULT_CONFIG))
    from cloud_cli import HANDLERS, build_parser, _load_cloud
    from pathlib import Path as _Path

    args_ns = build_parser().parse_args(
        ["--config", config_path, subcommand, *(extra_args or [])]
    )
    cloud = _load_cloud(_Path(config_path))
    handler = HANDLERS[subcommand]

    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    try:
        with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
            rc = handler(args_ns, cloud)
    except Exception as exc:
        return json.dumps({"error": str(exc)})

    output = stdout_buf.getvalue()
    if stderr_buf.getvalue().strip():
        output += "\n[stderr]\n" + stderr_buf.getvalue()
    if rc and rc != 0:
        output += f"\n[exit_code: {rc}]"
    return output.strip() or "(no output)"


# ---- CLI subprocess helper ------------------------------------------------

def _run_cli(subcommand: str, args: list[str] | None = None) -> str:
    """Run a cloud_cli.py subcommand and return stdout+stderr.

    Acquires a Graph token in this process (where WAM/console is available)
    and passes it to the subprocess via SHIPROOM_ACCESS_TOKEN so the child
    never needs to pop an interactive login window.
    """
    import subprocess
    config_path = os.environ.get("SHIPROOM_CONFIG", str(DEFAULT_CONFIG))

    # Get token in the parent process where WAM interactive login works,
    # then inject it into the subprocess environment.
    child_env = {**os.environ, "PYTHONPATH": SKILL_SCRIPTS, "PYTHONUTF8": "1",
                 # Tell the child that it's running as a non-interactive subprocess:
                 # get_token() will use silent_only=True and never block on WAM/browser.
                 "SHIPROOM_SILENT_AUTH": "1"}
    try:
        from cloud_io import get_token
        # Use silent_only=True so we never block the MCP server's thread waiting
        # for an interactive login dialog (WAM/browser).
        child_env["SHIPROOM_ACCESS_TOKEN"] = get_token(silent_only=True)
    except Exception:
        pass  # No cached token — child will rely on MSAL persistent cache (silent only).

    cmd = [
        sys.executable, "-X", "utf8",
        str(Path(SKILL_SCRIPTS) / "cloud_cli.py"),
        "--config", config_path,
        subcommand,
        *(args or []),
    ]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", timeout=300,
            cwd=str(SKILL_ROOT),
            env=child_env,
        )
        output = result.stdout or ""
        if result.stderr:
            output += "\n[stderr]\n" + result.stderr
        if result.returncode != 0:
            output += f"\n[exit_code: {result.returncode}]"
        return output.strip() or "(no output)"
    except subprocess.TimeoutExpired:
        return json.dumps({"error": f"timed out after 300s: {subcommand}"})
    except Exception as exc:
        return json.dumps({"error": str(exc)})


# ---- Entry point -----------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Shiproom MCP Server")
    parser.add_argument("--sse", action="store_true", help="Use SSE transport")
    parser.add_argument("--port", type=int, default=8811)
    args = parser.parse_args()
    mcp.run(transport="sse" if args.sse else "stdio")


if __name__ == "__main__":
    main()
