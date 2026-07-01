"""Split a Loop innerText dump into per-section snippets and merge them into
the team's accumulating updates files (1-todo / 4-release / 5-gdpval /
6-deep-worker etc.) WITHOUT clobbering any human /sr-update entries.

Strategy
--------
1. Scan the loop text line-by-line; treat any line that *equals* (after
   trimming) one of the configured section keywords as the start of that
   section. The section ends when we hit the next known keyword (or EOF).
2. For each target file, build a "loop-sync" block delimited by
       <!-- BEGIN LOOP-SYNC --> ... <!-- END LOOP-SYNC -->
   containing only the loop-extracted snippets for that file.
3. Read the existing remote file. If it already contains the markers,
   replace just the block. Otherwise, prepend the block (so human entries
   stay below, in their original order).

This guarantees /sr-update signed entries (which live OUTSIDE the markers)
are never overwritten.
"""
from __future__ import annotations

import datetime as dt
import re
from typing import Iterable

BEGIN_MARK = "<!-- BEGIN LOOP-SYNC -->"
END_MARK = "<!-- END LOOP-SYNC -->"

# Strip leading list/numbering prefix, e.g.:
#   "3.1 Lab Release plan"  -> "Lab Release plan"
#   "4.Digital Worker & Quality" -> "Digital Worker & Quality"
#   "• Action Items" -> "Action Items"
#   "1. Business Metrics ( Key Metrics ..." -> "Business Metrics ( key metrics ..."
_PREFIX_RE = re.compile(r"^\s*(?:[•●◦\-*]|\d+(?:\.\d+)*\.?)\s*")


def _norm(s: str) -> str:
    s = _PREFIX_RE.sub("", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def _line_matches(line: str, keyword_norm: str) -> bool:
    """Match if the (prefix-stripped) line equals the keyword OR starts with
    the keyword followed by a non-letter char. This catches PDF artefacts like
    `Business Metrics (` or `Action Items   `."""
    nl = _norm(line)
    if nl == keyword_norm:
        return True
    if nl.startswith(keyword_norm) and len(nl) > len(keyword_norm):
        ch = nl[len(keyword_norm)]
        if not ch.isalnum():
            return True
    return False


def split_loop(text: str, section_map: dict[str, list[str]],
               stop_headings: Iterable[str] = ()) -> dict[str, list[tuple[str, str]]]:
    """Slice loop text into sections.

    section_map: {target_filename: [keyword_heading, ...]}
        e.g. {"1-todo.md": ["Action Items"]}
    stop_headings: extra headings that terminate a section but are NOT synced
        anywhere (e.g. "Highlights", "Overall progress").

    Returns: {target_filename: [(matched_heading, body_text), ...]}
        - body_text is the lines AFTER the heading, until the next known heading
          (across ALL targets + stop_headings) or EOF.
        - Multiple keyword hits for the same target are kept as separate tuples
          (e.g. release file may collect "Pending release" + "Lab Release plan").
    """
    # Build inverse lookup: list of (norm_keyword, target, original_keyword).
    # We can't use a dict alone because matching is now "equals or starts-with";
    # we need to test each keyword against each line.
    keyword_entries: list[tuple[str, str, str]] = []  # (norm, target, original)
    for target, keywords in section_map.items():
        for kw in keywords:
            keyword_entries.append((_norm(kw), target, kw))
    stop_norms = [_norm(s) for s in stop_headings]

    def find_hit(line: str):
        for nk, tg, orig in keyword_entries:
            if _line_matches(line, nk):
                return (tg, orig)
        return None

    def is_boundary(line: str) -> bool:
        if find_hit(line) is not None:
            return True
        return any(_line_matches(line, sn) for sn in stop_norms)

    lines = text.splitlines()
    out: dict[str, list[tuple[str, str]]] = {t: [] for t in section_map}

    i = 0
    n = len(lines)
    while i < n:
        hit = find_hit(lines[i])
        if hit:
            target, original = hit
            j = i + 1
            while j < n and not is_boundary(lines[j]):
                j += 1
            body = "\n".join(lines[i + 1 : j]).strip("\n")
            out[target].append((original, body))
            i = j
        else:
            i += 1
    return out


def render_sync_block(snippets: list[tuple[str, str]], source_url: str = "") -> str:
    """Render the LOOP-SYNC block body for one target file."""
    ts = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    lines = [
        BEGIN_MARK,
        f"<!-- Auto-synced from currentloop.md at {ts}. Do NOT edit between these markers --",
        f"     human entries should go OUTSIDE this block; they will be preserved. -->",
    ]
    if source_url:
        lines.append(f"_Source: {source_url}_")
        lines.append("")
    if not snippets:
        lines.append("_(no matching section found in currentloop.md)_")
    else:
        for heading, body in snippets:
            lines.append(f"### {heading}  _(from Loop, {ts[:10]})_")
            lines.append("")
            lines.append(body if body.strip() else "_(empty)_")
            lines.append("")
    lines.append(END_MARK)
    lines.append("")
    return "\n".join(lines)


_BLOCK_RE = re.compile(
    re.escape(BEGIN_MARK) + r".*?" + re.escape(END_MARK) + r"\n?",
    re.DOTALL,
)


def merge_block(existing_text: str, sync_block: str, file_header: str) -> str:
    """Return new file content with the sync_block injected.

    - If existing_text already contains a LOOP-SYNC block, replace it in place.
    - Otherwise, place the block right after the file header (or at top if no
      recognizable header), so human-signed entries below stay untouched.
    """
    if _BLOCK_RE.search(existing_text):
        return _BLOCK_RE.sub(sync_block, existing_text, count=1)

    if not existing_text.strip():
        return file_header + "\n" + sync_block

    # Place after the first header line (`# ...`) if present.
    lines = existing_text.splitlines(keepends=True)
    insert_at = 0
    for idx, line in enumerate(lines):
        if line.lstrip().startswith("# "):
            insert_at = idx + 1
            # Skip a blank line right after the header, if any.
            if insert_at < len(lines) and lines[insert_at].strip() == "":
                insert_at += 1
            break
    head = "".join(lines[:insert_at])
    tail = "".join(lines[insert_at:])
    return head + sync_block + ("\n" if not tail.startswith("\n") else "") + tail


def default_stop_headings() -> list[str]:
    """Headings that terminate a section but are not synced into any target.
    Tunable via shiproom-config.yaml: loop_sync.stop_headings.

    Only true non-content noise lives here. Anything that has actual content
    we want to keep should go into a target file (default: 7-others.md).
    """
    return [
        "Guidance",
        "Highlights",
        "Business Metrics",
        "OCV",
        "Overall progress",
    ]


def default_section_map() -> dict[str, list[str]]:
    """Fallback keywords if shiproom-config.yaml does not override.
    Keywords are matched case-insensitively against whole trimmed lines
    (with leading bullets / numeric prefixes like '3.1' stripped).
    """
    return {
        "1-todo.md": ["Action Items", "Action item", "行动项"],
        "4-release.md": [
            "Pending release",
            "Lab Release plan",
            "Lab release",
            "Consumer Release 0430",
            "Consumer Release",
            "Release plan",
        ],
        "5-gdpval.md": [
            "GDPVal-AA Manufacturing",
            "GDPVal",
        ],
        "6-deep-worker.md": [
            "Digital Worker & Quality",
            "Digital Worker",
            "Deep Worker",
        ],
        # Catch-all: anything else worth keeping that doesn't fit the four
        # fixed/floating themes above. Add new weekly topics here as they
        # appear (e.g. AAD release, security reviews, MCP, ...).
        "7-others.md": [
            "MSA Security Review",
            "Excel agent",
            "Commercial compliance",
            "MCP Hubs",
            "AAD",
            "AAD release",
        ],
    }


def file_header_for(target: str) -> str:
    """Standard file header used when a target file does not exist yet."""
    label = {
        "1-todo.md": "# 1 — Todo / Action Items",
        "4-release.md": "# 4 — Release",
        "5-gdpval.md": "# 5 — GDPVal",
        "6-deep-worker.md": "# 6 — Deep Worker",
        "7-others.md": "# 7 — Others (uncategorised topics from this week's Loop)",
    }.get(target, f"# {target}")
    return label + "\n"
