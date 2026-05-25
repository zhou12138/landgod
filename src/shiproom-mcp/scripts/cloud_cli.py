"""Agent-facing CLI for the SharePoint backend.

Subcommands map 1:1 to the slash commands in AGENT.md when storage.backend == "sharepoint".

All operations target the Shiproom channel folder configured in shiproom-config.yaml
under storage.sharepoint. Identity is taken from the signed-in MSAL token.

Usage:
    python framework/scripts/cloud_cli.py status
    python framework/scripts/cloud_cli.py update <section> <text...>
    python framework/scripts/cloud_cli.py notes <text...>
    python framework/scripts/cloud_cli.py upload-loop <local-pdf>
    python framework/scripts/cloud_cli.py upload-notes <local-pdf>
    python framework/scripts/cloud_cli.py archive [<YYYY-MM-DD>]
    python framework/scripts/cloud_cli.py whoami
    python framework/scripts/cloud_cli.py url [<path-under-base>]
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path
from typing import Optional

# Force UTF-8 stdout/stderr so emoji in print() never crash on cp1252 terminals.
# reconfigure() is available on Python 3.7+ text-mode streams on Windows.
for _s in (sys.stdout, sys.stderr):
    if _s is not None and hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

THIS = Path(__file__).resolve()
sys.path.insert(0, str(THIS.parent))

from cloud_io import ShiproomCloud, get_identity, short_name  # noqa: E402

# Config lookup order (first existing wins):
#   1. --config <path>   (explicit CLI arg)
#   2. <workspace>/shiproom-config.yaml          -- team override
#   3. <skill>/shiproom-config.yaml              -- bundled default
SKILL_ROOT = THIS.parent.parent           # shiproom-mcp/
WORKSPACE_ROOT = THIS.parents[3]          # repo root (parent of src/)
WORKSPACE_CONFIG = WORKSPACE_ROOT / "shiproom-config.yaml"
BUNDLED_CONFIG = SKILL_ROOT / "shiproom-config.yaml"


def _resolve_config(explicit: Path | None) -> Path:
    if explicit is not None:
        return explicit
    if WORKSPACE_CONFIG.exists():
        return WORKSPACE_CONFIG
    return BUNDLED_CONFIG


def _load_cloud(cfg_path: Path) -> ShiproomCloud:
    import yaml
    cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    return ShiproomCloud.from_config(cfg)


# ============================================================================
# Subcommand handlers
# ============================================================================

def cmd_whoami(_args, _cloud) -> int:
    ident = get_identity()
    print(f"upn  : {ident['upn']}")
    print(f"name : {ident['name']}")
    print(f"short: {short_name()}")
    return 0


def cmd_status(_args, cloud: ShiproomCloud) -> int:
    print(f"=== Shiproom cloud status ===")
    print(f"folder: {cloud.web_url('current') or '(empty)'}")
    print()
    items = cloud.list_dir("current")
    if not items:
        print("(current/ is empty — run /sr-prep)")
        return 0
    print("current/")
    for it in sorted(items, key=lambda x: x["name"]):
        kind = "DIR " if "folder" in it else "FILE"
        size = it.get("size", 0)
        print(f"  [{kind}] {it['name']}  ({size} B)")
    sub = cloud.list_dir("current", "updates")
    if sub:
        print("\ncurrent/updates/")
        for it in sorted(sub, key=lambda x: x["name"]):
            size = it.get("size", 0)
            print(f"  [FILE] {it['name']}  ({size} B)")
    return 0


def cmd_update(args, cloud: ShiproomCloud) -> int:
    section = args.section
    body = " ".join(args.text).strip()
    if not body:
        print("ERROR: update text is empty", file=sys.stderr)
        return 2
    res = cloud.append_signed_entry(section, body)
    print(f"✅ Appended to current/updates/{section}.md")
    print(f"   by @{short_name()}")
    print(f"   {res.get('webUrl', '')}")
    return 0


def cmd_notes(args, cloud: ShiproomCloud) -> int:
    body = " ".join(args.text).strip()
    if not body:
        print("ERROR: notes text is empty", file=sys.stderr)
        return 2
    ts = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    entry = f"### @{short_name()} · {ts}\n\n{body}\n"
    cloud.append_text(entry, "current", "notes.md", ensure_header="# Notes\n\n")
    print(f"✅ Notes appended (current/notes.md)")
    return 0


def cmd_upload(args, cloud: ShiproomCloud, remote_name: str) -> int:
    local = Path(args.path)
    if not local.exists():
        print(f"ERROR: file not found: {local}", file=sys.stderr)
        return 2
    res = cloud.upload_file(local, "current", remote_name)
    print(f"✅ Uploaded {local.name} → current/{remote_name}")
    print(f"   {res.get('webUrl', '')}")
    return 0


def cmd_upload_loop(args, cloud):
    """Upload a host-exported Loop PDF, then auto-extract text and run the
    same section splitter as /sr-fetch-loop. PDF text extraction works well
    for the Loop “Print & PDF export” output -- no fidelity loss observed.
    """
    rc = cmd_upload(args, cloud, "currentloop.pdf")
    if rc != 0:
        return rc
    # Best-effort: extract PDF text and sync sections.
    local = Path(args.path)
    try:
        from pdfminer.high_level import extract_text
    except ImportError:
        print("⚠️  pdfminer.six not installed; skipping section auto-split.", file=sys.stderr)
        print("   Install with: pip install pdfminer.six", file=sys.stderr)
        return 0
    try:
        text = extract_text(str(local)) or ""
    except Exception as exc:  # noqa: BLE001
        print(f"⚠️  PDF text extraction failed: {exc}", file=sys.stderr)
        print("   currentloop.pdf is uploaded; section files NOT updated.", file=sys.stderr)
        return 0
    if len(text) < 200:
        print(f"⚠️  PDF text suspiciously short ({len(text)} chars); skipping auto-split.", file=sys.stderr)
        return 0
    import yaml
    cfg_path = _resolve_config(args.config)
    cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    sync_cfg = cfg.get("loop_sync") or {}
    if not sync_cfg.get("enabled", True):
        return 0
    web_url = cloud.web_url("current", "currentloop.pdf") or ""
    try:
        _sync_loop_to_updates(cloud, text, sync_cfg, web_url)
    except Exception as exc:  # noqa: BLE001
        print(f"⚠️  Auto-split failed: {exc}", file=sys.stderr)
    return 0


def cmd_upload_notes(args, cloud):
    return cmd_upload(args, cloud, "notes.pdf")


def cmd_fetch_notes(args, cloud: ShiproomCloud) -> int:
    """Find the latest meeting-notes Loop URL in the configured Teams group
    chat (notes_source.teams_chat_topic), fetch its content silently via
    headless Chrome, and upload as current/notes.md.

    UX contract:
    - Default path is fully silent: scan chat -> headless fetch -> upload.
    - On silent fetch failure (typically: this machine has never accessed
      the organizer's OneDrive Loop before), we automatically reopen the
      same URL in a visible browser so the host can SSO / approve
      "request access" once. Subsequent /sr-fetch-notes runs on this
      machine are silent again.
    - Final fallback: instruct the host to upload a PDF themselves
      via /sr-upload-notes.
    """
    import yaml
    from notes_finder import find_recent_meeting_notes, NotesFinderError
    from loop_fetch import (
        LoopFetchError, fetch_loop_markdown, fetch_loop_with_fallback,
    )

    cfg_path = _resolve_config(args.config)
    cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    ns = cfg.get("notes_source") or {}
    topic = (ns.get("teams_chat_topic") or "").strip()
    if not topic:
        print("ERROR: notes_source.teams_chat_topic is not set in shiproom-config.yaml.",
              file=sys.stderr)
        print("       Set it to a substring of the Teams group-chat title,", file=sys.stderr)
        print("       e.g. 'Stride Shiproom'.", file=sys.stderr)
        return 2

    n = max(1, int(getattr(args, "n", 1) or 1))
    print(f"🔍 Scanning Teams chat {topic!r} for the latest meeting notes ...")
    try:
        entries = find_recent_meeting_notes(topic, n=n)
    except NotesFinderError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 3

    latest = entries[0]
    print(f"   found {len(entries)} candidate(s); latest = {latest.timestamp}")

    interactive = bool(getattr(args, "interactive", False))
    print(f"📥 Fetching Loop content ({'headed (interactive)' if interactive else 'headless'}) ...")
    try:
        if interactive:
            markdown = fetch_loop_markdown(latest.url, headless=False, wait_for_user=True)
        else:
            markdown = fetch_loop_with_fallback(latest.url)
    except LoopFetchError as exc:
        print(f"⚠️  Could not fetch Loop content automatically: {exc}", file=sys.stderr)
        print("", file=sys.stderr)
        print("Please open the meeting-notes Loop below and export to PDF", file=sys.stderr)
        print("(Print & PDF export -> Save as PDF), then upload via /sr-upload-notes:", file=sys.stderr)
        print(f"  {latest.url}", file=sys.stderr)
        return 4
    except Exception as exc:  # noqa: BLE001
        print(f"⚠️  Unexpected error: {exc}", file=sys.stderr)
        print(f"  Loop URL: {latest.url}", file=sys.stderr)
        return 1

    import tempfile
    tmp = Path(tempfile.gettempdir()) / "shiproom_meeting_notes.md"
    # Stamp the source so we know which meeting / where it came from later.
    header = (f"<!-- meeting-notes auto-fetched {dt.datetime.now().isoformat(timespec='seconds')} -->\n"
              f"<!-- source-meeting: {latest.timestamp} -->\n"
              f"<!-- source-url: {latest.url} -->\n\n")
    tmp.write_text(header + markdown, encoding="utf-8")
    res = cloud.upload_file(tmp, "current", "notes.md")
    web_url = res.get("webUrl", "")
    print(f"✅ Fetched meeting notes -> current/notes.md ({len(markdown)} chars)")
    print(f"   meeting: {latest.timestamp}")
    print(f"   {web_url}")
    return 0


def cmd_fetch_loop(args, cloud: ShiproomCloud) -> int:
    """Auto-fetch the Current Loop page, upload as current/currentloop.md,
    then auto-split it into per-section update files (1-todo / 4-release /
    5-gdpval / 6-deep-worker) preserving any human entries in those files.

    Reads the loop URL from config: prefers loop_source.url, falls back to
    references.loop_current. On any fetch failure, prints actionable
    instructions including the loop URL so the host can open it directly
    and upload manually.
    """
    import yaml
    from loop_fetch import LoopFetchError, fetch_loop_with_fallback

    cfg_path = _resolve_config(args.config)
    cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    loop_cfg = cfg.get("loop_source") or {}
    refs = cfg.get("references") or {}
    loop_url = (loop_cfg.get("url") or refs.get("loop_current") or "").strip()
    if not loop_url:
        print("ERROR: no Loop URL configured (set loop_source.url or references.loop_current).", file=sys.stderr)
        return 2

    print(f"Fetching Loop content (silent headless; headed fallback if needed) ...")
    try:
        markdown = fetch_loop_with_fallback(loop_url)
    except LoopFetchError as exc:
        print(f"⚠️  Auto-fetch failed: {exc}", file=sys.stderr)
        print("", file=sys.stderr)
        print("Please open the Loop page, export to PDF (Print & PDF export -> Save as PDF),", file=sys.stderr)
        print("then upload it via /sr-upload-loop. Loop URL:", file=sys.stderr)
        print(f"  {loop_url}", file=sys.stderr)
        return 3
    except Exception as exc:  # noqa: BLE001
        print(f"⚠️  Unexpected error: {exc}", file=sys.stderr)
        print(f"  Loop URL: {loop_url}", file=sys.stderr)
        return 1

    import tempfile
    tmp = Path(tempfile.gettempdir()) / "shiproom_currentloop.md"
    tmp.write_text(markdown, encoding="utf-8")
    res = cloud.upload_file(tmp, "current", "currentloop.md")
    web_url = res.get("webUrl", "")
    print(f"✅ Fetched Loop -> current/currentloop.md ({len(markdown)} chars)")
    print(f"   {web_url}")

    # Auto-split into per-section update files (1-todo / 4-release / ...).
    sync_cfg = (cfg.get("loop_sync") or {})
    if sync_cfg.get("enabled", True):
        try:
            _sync_loop_to_updates(cloud, markdown, sync_cfg, web_url)
        except Exception as exc:  # noqa: BLE001
            print(f"⚠️  Loop content uploaded, but auto-split failed: {exc}", file=sys.stderr)
            print("   The Loop file is fine; sections were not synced.", file=sys.stderr)
    return 0


def _sync_loop_to_updates(cloud: ShiproomCloud, loop_text: str,
                           sync_cfg: dict, source_url: str) -> None:
    """Split currentloop.md into snippets per target file and merge them into
    each target's LOOP-SYNC block. Human /sr-update entries (outside the
    markers) are preserved."""
    from loop_split import (default_section_map, default_stop_headings,
                            file_header_for, merge_block, render_sync_block,
                            split_loop)

    section_map = sync_cfg.get("targets") or default_section_map()

    # HARD GUARDRAIL: 2-data.md and 3-ocv.md are owned by external sources
    # only (Claire's manual upload, and the OCV xlsx via fetch-ocv). Loop
    # content must NEVER touch them, even if the config is wrong.
    PROTECTED = {"2-data.md", "3-ocv.md"}
    bad = PROTECTED & set(section_map)
    if bad:
        print(f"⚠️  loop_sync.targets contains protected files {sorted(bad)}; "
              "ignoring those entries.", file=sys.stderr)
        section_map = {k: v for k, v in section_map.items() if k not in PROTECTED}

    stops = sync_cfg.get("stop_headings") or default_stop_headings()
    sliced = split_loop(loop_text, section_map, stop_headings=stops)

    print("--- Auto-syncing Loop sections into team updates ---")
    for target, snippets in sliced.items():
        try:
            existing = cloud.read_text("current", "updates", target)
        except Exception:
            existing = ""
        block = render_sync_block(snippets, source_url=source_url)
        new_text = merge_block(existing, block, file_header_for(target))
        if new_text == existing:
            print(f"  [skip] {target} (no change)")
            continue
        import tempfile
        tmp = Path(tempfile.gettempdir()) / f"shiproom_sync_{target}"
        tmp.write_text(new_text, encoding="utf-8")
        cloud.upload_file(tmp, "current", "updates", target)
        tag = f"{len(snippets)} snippet(s)" if snippets else "empty (no match)"
        print(f"  [sync] current/updates/{target}  ({tag})")


def cmd_split_loop(args, cloud: ShiproomCloud) -> int:
    """Re-run the loop section splitter on the existing current/currentloop.md.
    Useful after manually editing the section_map or when /sr-fetch-loop already
    ran but the per-section sync was skipped."""
    import yaml
    cfg_path = _resolve_config(args.config)
    cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    try:
        loop_text = cloud.read_text("current", "currentloop.md")
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: could not read current/currentloop.md: {exc}", file=sys.stderr)
        print("Run /sr-fetch-loop first.", file=sys.stderr)
        return 2
    sync_cfg = cfg.get("loop_sync") or {}
    web_url = cloud.web_url("current", "currentloop.md") or ""
    _sync_loop_to_updates(cloud, loop_text, sync_cfg, web_url)
    return 0


def cmd_archive(args, cloud: ShiproomCloud) -> int:
    date_str = args.date or dt.date.today().isoformat()
    # validate
    try:
        dt.date.fromisoformat(date_str)
    except ValueError:
        print(f"ERROR: invalid date '{date_str}' (expected YYYY-MM-DD)", file=sys.stderr)
        return 2

    # safety: don't overwrite an existing history entry
    existing = cloud.list_dir("history")
    if any(it["name"] == date_str for it in existing):
        print(f"ERROR: history/{date_str}/ already exists. Pick a different date or delete it first.", file=sys.stderr)
        return 2

    print(f"Archiving current/ → history/{date_str}/ ...")
    clear = bool(getattr(args, "clear", False))
    res = cloud.archive_current(date_str, clear=clear)
    mode = "cleared current/" if res.get("cleared") else "carry-forward (current/ untouched)"
    print(f"✅ Archived to {res['history_path']}  [{mode}]")
    print(f"   {cloud.web_url('history', date_str)}")
    if not res.get("cleared"):
        print("   Note: current/ files keep their previous mtime, so /sr-prep checklist will")
        print("   still flag last-week content as [STALE]/[LEFT] until you re-fetch.")
    return 0


def cmd_url(args, cloud: ShiproomCloud) -> int:
    parts = args.path.split("/") if args.path else []
    print(cloud.web_url(*parts) or "(not found)")
    return 0


# Expected files in current/ for a "ready" pre-meeting state.
# kind:
#   refresh    -- MUST be re-fetched every /sr-prep run (live external sources).
#                 Stale = older than the start of the current ISO week, or > 48h old.
#   accumulate -- grown across the week by team /sr-update calls; presence is enough.
#   generate   -- written by the agent after analysing the others; should be the
#                 newest file when prep is "done".
PREP_CHECKLIST = [
    ("currentloop.{md|pdf}",             "current",         "refresh",    "auto: /sr-fetch-loop  |  manual: /sr-upload-loop <pdf>"),
    ("updates/2-data.md",                 "current/updates", "refresh",    "Claire posts the weekly usage-analysis report, /sr-update 2-data"),
    ("updates/3-ocv.md",                  "current/updates", "refresh",    "host paste latest OCV snapshot, /sr-upload-md"),
    ("updates/1-todo.md",                 "current/updates", "accumulate", "team /sr-update entries"),
    ("updates/4-release.md",              "current/updates", "accumulate", "team /sr-update entries"),
    ("updates/5-gdpval.md",               "current/updates", "accumulate", "team /sr-update entries"),
    ("updates/6-deep-worker.md",          "current/updates", "accumulate", "team /sr-update entries"),
    ("updates/7-others.md",               "current/updates", "accumulate", "catch-all for topics outside 1/4/5/6 (auto-filled by fetch-loop, plus team /sr-update 7-others)"),
    ("updates/0-meeting-prep-summary.md", "current/updates", "generate",   "agent writes LAST after analysing the above"),
]


def _is_stale(item: dict, kind: str, cutoff: Optional[dt.datetime] = None) -> tuple[bool, str]:
    """Return (stale, reason).
    refresh    : stale if mtime < cutoff, or > 48h old.
    accumulate : stale if mtime < cutoff (=> probably leftover from last cycle;
                 host likely forgot to /sr-archive).
    generate   : never auto-stale (agent always regenerates explicitly).

    cutoff defaults to the start of this ISO week (Monday 00:00 UTC) when no
    archive marker exists. When `current/.last-archive` is present, the caller
    passes that timestamp instead — this lets us support multi-meeting weeks
    (e.g. Wednesday + Friday cadences) without hard-coding a schedule.
    """
    if kind == "generate":
        return (False, "")
    iso = item.get("lastModifiedDateTime")
    if not iso:
        return (True, "no mtime")
    try:
        # Graph returns "2026-05-08T03:14:21Z"
        mtime = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return (True, f"unparseable mtime {iso}")
    now = dt.datetime.now(dt.timezone.utc)
    if cutoff is None:
        today = now.date()
        cutoff = dt.datetime.combine(
            today - dt.timedelta(days=today.weekday()),
            dt.time.min,
            tzinfo=dt.timezone.utc,
        )
    elif cutoff.tzinfo is None:
        cutoff = cutoff.replace(tzinfo=dt.timezone.utc)
    if mtime < cutoff:
        return (True, f"from {mtime.astimezone().strftime('%Y-%m-%d %H:%M')} (before last archive {cutoff.astimezone().strftime('%Y-%m-%d %H:%M')})")
    if kind == "refresh" and (now - mtime) > dt.timedelta(hours=48):
        return (True, f"{int((now - mtime).total_seconds() // 3600)}h old")
    return (False, mtime.astimezone().strftime("%Y-%m-%d %H:%M"))


def cmd_prep(_args, cloud: ShiproomCloud) -> int:
    """Print a pre-meeting checklist comparing current/ to expected files,
    flagging stale 'refresh' artifacts that must be re-fetched."""
    cur_root = {it["name"]: it for it in cloud.list_dir("current")}
    cur_updates = {it["name"]: it for it in cloud.list_dir("current", "updates")}
    cutoff = _load_archive_cutoff(cloud)

    print("=== Shiproom pre-meeting checklist ===")
    print(f"folder: {cloud.web_url('current')}")
    if cutoff:
        print(f"cutoff: {cutoff.astimezone().isoformat(timespec='minutes')}  (from current/.last-archive)")
    else:
        print("cutoff: this-week-Monday 00:00 UTC  (no current/.last-archive marker yet)")
    print()
    must_refresh: list[tuple[str, str]] = []   # (relpath, why)
    missing: list[tuple[str, str]] = []
    ok = 0
    stale_accumulate: list[tuple[str, str]] = []  # leftover from last cycle
    for relpath, parent, kind, hint in PREP_CHECKLIST:
        name = relpath.split("/")[-1]
        bag = cur_updates if parent.endswith("updates") else cur_root
        # Special-case the loop file: accept either currentloop.md or currentloop.pdf.
        if name == "currentloop.{md|pdf}":
            item = bag.get("currentloop.md") or bag.get("currentloop.pdf")
            display = ("currentloop.md" if bag.get("currentloop.md")
                       else ("currentloop.pdf" if bag.get("currentloop.pdf") else "currentloop.{md|pdf}"))
        else:
            item = bag.get(name)
            display = relpath
        if not item:
            missing.append((display, hint))
            print(f"  [MISS] {display:<40} ({kind:<10}) <- {hint}")
            continue
        size = item.get("size", 0)
        stale, info = _is_stale(item, kind, cutoff=cutoff)
        if stale and kind == "accumulate":
            stale_accumulate.append((display, info))
            print(f"  [LEFT] {display:<40} ({kind:<10}) {size} B  ⚠️ {info} -- leftover from last cycle")
        elif stale:
            must_refresh.append((display, info))
            print(f"  [STALE]{display:<40} ({kind:<10}) {size} B  ⚠️ {info} -- re-fetch before meeting")
        else:
            ok += 1
            tag = info or "ok"
            print(f"  [OK]   {display:<40} ({kind:<10}) {size} B  {tag}")

    print()
    total = len(PREP_CHECKLIST)
    print(f"ready: {ok} / {total}    missing: {len(missing)}    stale: {len(must_refresh)}    leftover: {len(stale_accumulate)}")

    if stale_accumulate:
        if cutoff:
            print("\n📎 Carry-forward leftover files (expected right after /sr-archive):")
            for rel, why in stale_accumulate:
                print(f"  - {rel}  ({why})")
            print("\nThese files were carried forward from the previous cycle. They will NOT")
            print("appear in this cycle's view.html (render_view filters manual entries by the")
            print("cutoff above). Next steps for this meeting cycle:")
            print("  1. /sr-fetch-loop      → refreshes LOOP-SYNC blocks in 1/4/5/6/7-*.md")
            print("  2. /sr-fetch-ocv       → refreshes 3-ocv.md")
            print("  3. ask Claire for new 2-data.md (or upload-md if she sends markdown)")
            print("  4. team /sr-update entries land naturally as they happen")
            print("  5. /sr-prep            → regenerate prep summary + view.html")
            print("If you DID NOT just run /sr-archive, see archive.md before continuing —")
            print("the cutoff in current/.last-archive may be stale.")
        else:
            print("\n⚠️ Leftover team-update files from last cycle:")
            for rel, why in stale_accumulate:
                print(f"  - {rel}  ({why})")
            print("\nNo current/.last-archive marker found. Likely cause: last meeting was not")
            print("archived (or this is a legacy repo). Recommended fix:")
            print("  1. Pick the date of the last meeting, then run:")
            print("     python framework/scripts/cloud_cli.py archive <YYYY-MM-DD>")
            print("     (default = carry-forward; current/ keeps content. Add --clear to also wipe.)")
            print("  2. After archive, run fetch-loop / fetch-ocv / ask Claire for new 2-data.")
            print("  3. Re-run `cloud_cli.py prep` to confirm.")

    if missing or must_refresh:
        print("\nNext steps the agent MUST perform (in order):")
        for rel, why in must_refresh:
            print(f"  - REFRESH {rel}  ({why})")
        for rel, hint in missing:
            kind = next((k for r, _, k, _ in PREP_CHECKLIST if r == rel), "")
            print(f"  - FETCH   {rel}  [{kind}]  {hint}")
        print("\nDo not skip the REFRESH step even if a file with the same name already exists.")
    elif not stale_accumulate:
        print("\nAll prep artifacts present and fresh. Generate/refresh 0-meeting-prep-summary.md last.")
    return 0


def cmd_upload_md(args, cloud: ShiproomCloud) -> int:
    """Upload a local markdown file to a path under base.

    For files in AUTO_MERGED (e.g. current/updates/2-data.md), the local file
    is treated as an auto-source snapshot and is merged into the remote
    file's <!-- BEGIN LOOP-SYNC --> ... <!-- END LOOP-SYNC --> block instead
    of overwriting the whole file. This preserves any human /sr-update
    entries below the block.
    """
    local = Path(args.local)
    if not local.exists():
        print(f"ERROR: file not found: {local}", file=sys.stderr)
        return 2
    parts = [p for p in args.remote.split("/") if p]
    if not parts:
        print("ERROR: remote path is empty", file=sys.stderr)
        return 2

    rel = "/".join(parts)
    if rel in AUTO_MERGED:
        header, default_label = AUTO_MERGED[rel]
        body_md = local.read_text(encoding="utf-8")
        _merge_auto_into(
            cloud, body_md,
            parts=tuple(parts),
            header=header,
            source_label=f"manual upload: {local.name}",
            summary=f"{local.stat().st_size} B from {local.name}",
        )
        return 0

    res = cloud.upload_file(local, *parts)
    print(f"✅ Uploaded {local.name} → {args.remote}  ({local.stat().st_size} B)")
    print(f"   {res.get('webUrl', '')}")
    return 0


def cmd_read(args, cloud: ShiproomCloud) -> int:
    """Print contents of a cloud file to stdout (raw utf-8 bytes, LF preserved).

    NOTE: do NOT use shell redirection (`> file.md`) on Windows PowerShell -- it will
    re-encode the stream to UTF-16 and corrupt the file. Use the `download` subcommand
    instead when you want to save to disk.
    """
    parts = [p for p in args.remote.split("/") if p]
    if not parts:
        print("ERROR: remote path is empty", file=sys.stderr)
        return 2
    try:
        text = cloud.read_text(*parts)
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: could not read {args.remote}: {exc}", file=sys.stderr)
        return 1
    sys.stdout.buffer.write(text.encode("utf-8"))
    return 0


def cmd_download(args, cloud: ShiproomCloud) -> int:
    """Download a cloud file to a local path (binary-safe, no shell pipe involved)."""
    parts = [p for p in args.remote.split("/") if p]
    if not parts:
        print("ERROR: remote path is empty", file=sys.stderr)
        return 2
    local = Path(args.local)
    try:
        cloud.download_file(local, *parts)
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: could not download {args.remote}: {exc}", file=sys.stderr)
        return 1
    size = local.stat().st_size
    print(f"\u2705 Downloaded {args.remote} -> {local}  ({size} B)")
    return 0


def cmd_list_history(_args, cloud: ShiproomCloud) -> int:
    """List archived dates under history/."""
    items = cloud.list_dir("history")
    dirs = sorted([it["name"] for it in items if "folder" in it], reverse=True)
    if not dirs:
        print("(history/ is empty)")
        return 0
    print(f"=== History ({len(dirs)} entries) ===")
    for d in dirs:
        print(f"  {d}    {cloud.web_url('history', d)}")
    return 0


def _load_archive_cutoff(cloud: ShiproomCloud) -> Optional[dt.datetime]:
    """Read current/.last-archive ISO timestamp written by archive_current().

    Returns None if the marker is absent (first run / legacy repo) so callers
    fall back to their own default (e.g. this week's Monday).
    """
    raw = cloud.read_text("current", ".last-archive", default="").strip()
    if not raw:
        return None
    try:
        ts = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return ts


def cmd_render_view(args, cloud: ShiproomCloud) -> int:
    """Render current/view.html with the hard-coded Shiproom dashboard template."""
    from render_view import SECTION_SOURCES, ViewInput, render_view

    texts = {}
    missing = []
    for key, remote in SECTION_SOURCES.items():
        parts = [p for p in remote.split("/") if p]
        text = cloud.read_text(*parts, default="")
        texts[key] = text
        if not text and key not in {"prep_summary", "loop"}:
            missing.append(remote)

    cutoff = _load_archive_cutoff(cloud)
    html_text = render_view(ViewInput(texts=texts, archive_cutoff=cutoff))
    res = cloud.write_text(html_text, "current", "view.html", content_type="text/html")

    if getattr(args, "local", None):
        local = Path(args.local)
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_text(html_text, encoding="utf-8")
        print(f"✅ Rendered local copy -> {local}  ({local.stat().st_size} B)")
    if missing:
        print("⚠️  Rendered with missing sections:")
        for remote in missing:
            print(f"   - {remote}")
    cutoff_msg = f" (manual entries since {cutoff.isoformat(timespec='minutes')})" if cutoff else " (no .last-archive — using this-week-Monday cutoff)"
    print(f"✅ Rendered hard-coded dashboard → current/view.html  ({len(html_text.encode('utf-8'))} B){cutoff_msg}")
    print(f"   {res.get('webUrl', cloud.web_url('current', 'view.html'))}")
    return 0


# ============================================================================
# fetch-ocv  (auto-refresh OCV snapshot for /sr-prep)
# ============================================================================


def cmd_fetch_ocv(args, cloud: ShiproomCloud) -> int:
    """Try to read the OCV xlsx via Graph and upload a markdown summary.
    Preferred source is a workbook path under the Shiproom SharePoint folder.
    Falls back to a share URL source for backward compatibility.
    """
    import yaml

    cfg_path = _resolve_config(args.config)
    cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    from cloud_io import _request
    ocv_cfg = cfg.get("ocv_source") or {}

    remote_path = (ocv_cfg.get("remote_path") or "").strip().strip("/")
    if not remote_path:
        print("ERROR: set ocv_source.remote_path in shiproom-config.yaml", file=sys.stderr)
        return 2

    parts = [p for p in remote_path.split("/") if p]
    r = _request("GET", cloud._item_url(*parts))
    if r.status_code == 404:
        print(f"ERROR: OCV workbook not found at {cloud.base_path}/{remote_path}", file=sys.stderr)
        print("Set ocv_source.remote_path to the correct file under Shiproom/.", file=sys.stderr)
        return 2
    r.raise_for_status()
    item = r.json()
    drive_id = cloud.drive_id
    item_id = item["id"]
    source_label = cloud.web_url(*parts) or f"{cloud.base_path}/{remote_path}"

    # List worksheets
    ws = _request("GET", f"https://graph.microsoft.com/v1.0/drives/{drive_id}/items/{item_id}/workbook/worksheets")
    ws.raise_for_status()
    sheets = [s["name"] for s in ws.json().get("value", [])]
    if not sheets:
        print("ERROR: OCV workbook has no sheets", file=sys.stderr)
        return 1

    pick = ((cfg.get("ocv_source") or {}).get("sheet_pick") or "last")
    if pick == "first":
        sheet = sheets[0]
    elif pick == "by_name":
        sheet = sorted(sheets)[-1]
    else:
        sheet = sheets[-1]

    max_rows = int((cfg.get("ocv_source") or {}).get("max_rows", 30))

    # Step 1: Get used-range dimensions only (address field, no values — tiny response).
    # This avoids downloading thousands of rows that we immediately discard.
    base_url = f"https://graph.microsoft.com/v1.0/drives/{drive_id}/items/{item_id}/workbook/worksheets('{sheet}')"
    dim_resp = _request("GET", f"{base_url}/usedRange(valuesOnly=true)?$select=address")
    dim_resp.raise_for_status()
    full_address = dim_resp.json().get("address", "")

    # Step 2: Derive a trimmed range address covering only header + max_rows data rows.
    # Graph address is like "Sheet1!A1:AB4828" or "A1:AB4828".
    import re
    _rng_addr = full_address
    rows: list = []
    total_data_rows = 0
    m = re.search(r"(\$?[A-Z]+)\$?1:(\$?[A-Z]+)\$?(\d+)$", full_address)
    if m:
        col_start, col_end, total_str = m.groups()
        total_rows = int(total_str)
        total_data_rows = max(0, total_rows - 1)
        fetch_rows = min(total_rows, max_rows + 1)  # header + max_rows data rows
        # Do NOT include the sheet prefix — the worksheet is already in the URL path.
        # Including it causes double-quoting errors for sheet names with special chars.
        _rng_addr = f"{col_start}1:{col_end}{fetch_rows}"

    # Step 3: Fetch only the needed rows (header + max_rows).
    rng = _request("GET", f"{base_url}/range(address='{_rng_addr}')?$select=values")
    rng.raise_for_status()
    payload = rng.json()
    rows = payload.get("values") or []
    if not rows:
        print(f"ERROR: sheet '{sheet}' is empty", file=sys.stderr)
        return 1

    header, *body = rows
    # body is already trimmed to max_rows by the range fetch; trim again for safety
    body = body[:max_rows]

    def _cell(v):
        if v is None or v == "":
            return ""
        return str(v).replace("|", "\\|").replace("\n", " ")

    md_lines = [
        f"# OCV snapshot — sheet `{sheet}` ({full_address})",
        "",
        f"_Auto-fetched from {source_label}_",
        "",
        "| " + " | ".join(_cell(c) for c in header) + " |",
        "|" + "|".join(["---"] * len(header)) + "|",
    ]
    for row in body:
        md_lines.append("| " + " | ".join(_cell(c) for c in row) + " |")
    if total_data_rows > max_rows:
        md_lines.append("")
        md_lines.append(f"_Truncated to first {max_rows} rows; full sheet has {total_data_rows} data rows._")

    import tempfile
    body = "\n".join(md_lines) + "\n"
    _merge_auto_into(cloud, body,
                     parts=("current", "updates", "3-ocv.md"),
                     header="# 3 \u2014 OCV\n",
                     source_label=source_label,
                     summary=f"sheet '{sheet}', {len(body)} rows")
    return 0


# ============================================================================
# Generic auto-sync merger (used by fetch-ocv, upload-md for protected files)
# ============================================================================

# Files where ANY auto-source upload (Claire's data report, OCV xlsx fetch)
# must NOT clobber human /sr-update entries. Auto content lives between
# <!-- BEGIN LOOP-SYNC --> ... <!-- END LOOP-SYNC --> markers; everything
# outside survives.
AUTO_MERGED = {
    "current/updates/2-data.md": ("# 2 \u2014 Data\n", "Claire's weekly usage-analysis report"),
    "current/updates/3-ocv.md":  ("# 3 \u2014 OCV\n",  "OCV xlsx via fetch-ocv"),
}


def _merge_auto_into(cloud: ShiproomCloud, body_md: str, *, parts: tuple,
                     header: str, source_label: str, summary: str = "") -> dict:
    """Wrap body_md in a LOOP-SYNC block and merge into the remote file at
    parts, preserving anything outside the markers (i.e. human /sr-update
    entries). Uploads and prints a confirmation."""
    from loop_split import BEGIN_MARK, END_MARK, merge_block
    ts = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    block = (
        f"{BEGIN_MARK}\n"
        f"<!-- Auto-synced at {ts}. Do NOT edit between these markers --\n"
        f"     human /sr-update entries should go OUTSIDE this block; they will be preserved. -->\n"
        f"_Source: {source_label}_\n\n"
        f"{body_md.rstrip()}\n"
        f"{END_MARK}\n"
    )
    try:
        existing = cloud.read_text(*parts)
    except Exception:
        existing = ""
    new_text = merge_block(existing, block, header)
    import tempfile
    tmp = Path(tempfile.gettempdir()) / f"shiproom_auto_{parts[-1]}"
    tmp.write_text(new_text, encoding="utf-8")
    res = cloud.upload_file(tmp, *parts)
    rel = "/".join(parts)
    extra = f"  ({summary})" if summary else ""
    print(f"\u2705 Auto-synced \u2192 {rel}{extra}")
    print(f"   {res.get('webUrl', '')}")
    return res


# ============================================================================
# Argparse
# ============================================================================

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="cloud_cli.py", description=__doc__)
    p.add_argument("--config", type=Path, default=None,
                   help=f"Path to shiproom-config.yaml (default: {WORKSPACE_CONFIG} "
                        f"if present, else bundled {BUNDLED_CONFIG})")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("whoami", help="print signed-in identity")
    sub.add_parser("status", help="list current/ contents")

    u = sub.add_parser("update", help="append signed entry to current/updates/<section>.md")
    u.add_argument("section", help="e.g. 1-todo, 2-data, 3-ocv, 4-release")
    u.add_argument("text", nargs="+", help="update body (joined with spaces)")

    n = sub.add_parser("notes", help="append signed line to current/notes.md")
    n.add_argument("text", nargs="+")

    ul = sub.add_parser("upload-loop", help="upload <pdf> as current/currentloop.pdf")
    ul.add_argument("path")

    un = sub.add_parser("upload-notes", help="upload <pdf> as current/notes.pdf")
    un.add_argument("path")

    a = sub.add_parser("archive", help="copy current/ → history/<date>/ (default: carry-forward; use --clear to also wipe current/)")
    a.add_argument("date", nargs="?", default=None, help="YYYY-MM-DD (default: today)")
    a.add_argument("--clear", action="store_true", help="legacy: also delete contents of current/ after copy. Default: carry-forward (current/ untouched).")

    url = sub.add_parser("url", help="print SharePoint web URL of a file/folder")
    url.add_argument("path", nargs="?", default="")

    sub.add_parser("prep", help="show pre-meeting checklist (what's missing in current/)")

    um = sub.add_parser("upload-md", help="upload local markdown to <remote-path-under-base>")
    um.add_argument("local", help="local file path")
    um.add_argument("remote", help="cloud path under base, e.g. current/updates/2-data.md")

    rd = sub.add_parser("read", help="print a cloud file to stdout")
    rd.add_argument("remote", help="cloud path under base, e.g. current/notes.md or history/2026-05-08/notes.md")

    dl = sub.add_parser("download", help="download a cloud file to a local path (binary-safe)")
    dl.add_argument("remote", help="cloud path under base")
    dl.add_argument("local", help="local destination path")

    sub.add_parser("list-history", help="list archived meeting dates under history/")

    rv = sub.add_parser("render-view", help="render current/view.html with the hard-coded dashboard template")
    rv.add_argument("--local", default="./view.html", help="optional local preview path (default: ./view.html)")

    sub.add_parser("fetch-ocv", help="build current/updates/3-ocv.md from the OCV xlsx (Graph)")
    sub.add_parser("fetch-loop", help="auto-fetch Current Loop -> current/currentloop.md (headless Chrome)")
    sub.add_parser("split-loop", help="re-run loop section splitter on the existing current/currentloop.md")

    return p


HANDLERS = {
    "whoami": cmd_whoami,
    "status": cmd_status,
    "update": cmd_update,
    "notes": cmd_notes,
    "upload-loop": cmd_upload_loop,
    "upload-notes": cmd_upload_notes,
    "archive": cmd_archive,
    "url": cmd_url,
    "prep": cmd_prep,
    "upload-md": cmd_upload_md,
    "read": cmd_read,
    "download": cmd_download,
    "list-history": cmd_list_history,
    "render-view": cmd_render_view,
    "fetch-ocv": cmd_fetch_ocv,
    "fetch-loop": cmd_fetch_loop,
    "split-loop": cmd_split_loop,
}


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    cfg_path = _resolve_config(args.config)
    if args.cmd != "whoami" and not cfg_path.exists():
        print(f"ERROR: config not found: {cfg_path}", file=sys.stderr)
        return 2
    cloud = _load_cloud(cfg_path) if args.cmd != "whoami" else None
    handler = HANDLERS[args.cmd]
    return handler(args, cloud)


if __name__ == "__main__":
    sys.exit(main())
