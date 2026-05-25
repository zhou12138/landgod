"""Fetch the Current Shiproom Loop page as markdown via headless Chrome.

Why this exists:
- The Loop page is virtually-scrolled; a normal HTTP fetch returns ~empty.
- The "Print & PDF export" popup at loop.cloud.microsoft/print/... renders the
  FULL document tree at once (DOM, not canvas).
- We grab popup.innerText -- it contains everything, including paragraphs that
  Chromium's print-to-PDF + pdfminer drop on the floor.

Reused user-data-dir (under ~/.playwright/sharepoint-shiproom-loop) so the
MSAL/SharePoint cookies persist across runs after one interactive login.
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path

USER_DATA_DIR = os.path.join(
    os.path.expanduser("~"), ".playwright", "sharepoint-shiproom-loop"
)


class LoopFetchError(RuntimeError):
    pass


def _ensure_playwright() -> None:
    """Lazy-install playwright + chromium driver if missing."""
    try:
        import playwright  # noqa: F401
    except ImportError:
        print("[loop_fetch] installing playwright ...", file=sys.stderr)
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "--quiet", "playwright>=1.40"]
        )
    # Ensure chromium driver / msedge channel is available. We only need the
    # 'chrome' channel (system Chrome). If user has no Chrome, we fall back
    # to bundled chromium.
    try:
        # Just verify the playwright CLI works.
        subprocess.check_call(
            [sys.executable, "-m", "playwright", "--version"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass


async def _open_overflow(page) -> bool:
    """Click the Loop page header '...' (more options) button."""
    btns = await page.evaluate(
        """
        () => Array.from(document.querySelectorAll('button'))
          .filter(b => {
            const r = b.getBoundingClientRect();
            return r.top < 120 && r.right > window.innerWidth * 0.5
                   && r.width > 0 && r.height > 0;
          })
          .map(b => b.getAttribute('aria-label') || '')
        """
    )
    for a in btns:
        if a == "设置及更多":  # Edge/Chrome's own settings button -- skip
            continue
        if "更多选项" in a or "more options" in a.lower():
            await page.locator(f'button[aria-label="{a}"]').last.click()
            return True
    return False


async def _fetch_async(loop_url: str, timeout_ms: int = 60000,
                        headless: bool = True,
                        wait_for_user: bool = False) -> str:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        # Try system Chrome first; fall back to bundled chromium.
        for launch_kwargs in (
            {"channel": "chrome"},
            {"channel": "msedge"},
            {},  # bundled chromium
        ):
            try:
                ctx = await p.chromium.launch_persistent_context(
                    user_data_dir=USER_DATA_DIR,
                    headless=headless,
                    viewport={"width": 1500, "height": 1000},
                    **launch_kwargs,
                )
                break
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
        else:
            raise LoopFetchError(
                f"Could not launch browser: {last_exc}. "
                "Run `python -m playwright install chromium`."
            )

        try:
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            await page.goto(loop_url, wait_until="domcontentloaded", timeout=timeout_ms)
            # Loop is heavy; give it time to settle. Wait for network to go
            # idle (lazy-loaded sections, embedded mentions, presence pings)
            # then add a fixed buffer for any post-network rendering.
            try:
                await page.wait_for_load_state("networkidle", timeout=45000)
            except Exception:
                pass
            await page.wait_for_timeout(25000)

            if wait_for_user:
                # Headed fallback: let the human SSO / approve access, then
                # press ENTER on stdin. Used by /sr-fetch-notes when headless
                # silent fetch fails (typically: profile has no token for the
                # other user's OneDrive yet).
                print("\n" + "=" * 70, file=sys.stderr)
                print("[loop_fetch] Browser opened. Sign in / approve access if needed,", file=sys.stderr)
                print("[loop_fetch] then press ENTER here to start the capture.", file=sys.stderr)
                print("=" * 70 + "\n", file=sys.stderr)
                await asyncio.get_event_loop().run_in_executor(None, input)

            if not await _open_overflow(page):
                raise LoopFetchError(
                    "Could not find Loop's '更多选项' / 'more options' button. "
                    "Likely not signed in -- delete the user-data-dir and re-run."
                )
            await page.wait_for_timeout(800)

            # Click "Print & PDF export" -> opens a popup at loop.cloud.microsoft/print/...
            # which renders the FULL document tree (DOM, not canvas).
            try:
                async with ctx.expect_page(timeout=30000) as info:
                    await page.get_by_text("打印和 PDF 导出", exact=False).first.click()
            except Exception:
                async with ctx.expect_page(timeout=30000) as info:
                    await page.get_by_text("Print & PDF export", exact=False).first.click()
            popup = await info.value
            await popup.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
            print_url = popup.url
            await popup.close()

            # Reopen the print URL in a fresh page that has window.print()
            # neutralized via init script. Some Loop print pages auto-fire
            # window.print() on load -- the resulting native dialog destroys
            # the JS execution context and breaks innerText capture.
            page2 = await ctx.new_page()
            await page2.add_init_script("window.print = () => {};")
            await page2.goto(print_url, wait_until="domcontentloaded", timeout=timeout_ms)

            # Poll until innerText length stops growing for ~3s, capped at 30s.
            text = await _wait_until_stable(page2)
            if not text or len(text) < 200:
                raise LoopFetchError(f"Print page innerText unexpectedly short ({len(text)} chars)")
            return text
        finally:
            await ctx.close()


async def _wait_until_stable(page, idle_ms: int = 6000, max_ms: int = 90000,
                              poll_ms: int = 500) -> str:
    """Poll document.body.innerText.length; return text once length is stable
    for `idle_ms` (or after `max_ms` total)."""
    elapsed = 0
    last_len = -1
    stable_for = 0
    text = ""
    while elapsed < max_ms:
        await page.wait_for_timeout(poll_ms)
        elapsed += poll_ms
        text = await page.evaluate("() => document.body.innerText")
        cur = len(text or "")
        if cur == last_len and cur > 0:
            stable_for += poll_ms
            if stable_for >= idle_ms:
                return text
        else:
            stable_for = 0
            last_len = cur
    return text



def _clean(text: str) -> str:
    """Lightly normalize the Loop popup innerText -- collapse runs of empty
    table-cell separators and excessive blank lines."""
    out_lines: list[str] = []
    blank = 0
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            blank += 1
            if blank <= 1:
                out_lines.append("")
            continue
        blank = 0
        # Drop pure tab lines that come from empty table cells.
        if line.strip() == "":
            continue
        out_lines.append(line)
    return "\n".join(out_lines).rstrip() + "\n"


def fetch_loop_markdown(loop_url: str, *, headless: bool = True,
                         wait_for_user: bool = False) -> str:
    """Synchronous wrapper. Returns cleaned markdown-ish text or raises LoopFetchError.

    headless=True (default) is silent — used for the Current Loop and the common
    case for meeting-notes Loops (the persistent profile usually already has
    the SharePoint cookie).

    headless=False + wait_for_user=True is the fallback for first-time access
    to someone else's OneDrive Loop: the host sees a window, signs in / clicks
    "request access", presses ENTER, and the same capture path runs.
    """
    if not loop_url or not loop_url.startswith("http"):
        raise LoopFetchError(f"Invalid Loop URL: {loop_url!r}")
    _ensure_playwright()
    text = asyncio.run(_fetch_async(
        loop_url, headless=headless, wait_for_user=wait_for_user
    ))
    return _clean(text)


def fetch_loop_with_fallback(loop_url: str) -> str:
    """Try silent headless first; on LoopFetchError, retry with a visible
    browser so the host can SSO / approve once. After the first successful
    interactive run, the persistent profile holds the cookie and subsequent
    runs go silent."""
    try:
        return fetch_loop_markdown(loop_url, headless=True)
    except LoopFetchError as exc:
        print(f"[loop_fetch] silent fetch failed ({exc}); falling back to "
              f"headed mode for SSO ...", file=sys.stderr)
        return fetch_loop_markdown(loop_url, headless=False, wait_for_user=True)
