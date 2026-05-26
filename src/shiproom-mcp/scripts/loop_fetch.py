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
import atexit
import os
import subprocess
import sys
import threading
from pathlib import Path

USER_DATA_DIR = os.path.join(
    os.path.expanduser("~"), ".playwright", "sharepoint-shiproom-loop"
)

# -- Persistent browser pool (hot-start) ------------------------------------
# Keeps a background event loop + Playwright browser context alive across
# calls so the second+ fetch skips browser launch, page load, and the long
# initial settle wait.
_bg_loop: asyncio.AbstractEventLoop | None = None
_bg_thread: threading.Thread | None = None
_pw: object | None = None            # async_playwright instance
_pw_ctx: object | None = None        # persistent browser context
_ctx_headless: bool | None = None    # headless mode of current context
_hot_count: int = 0
_cached_print_url: str | None = None  # reuse on hot start


def _ensure_bg_loop() -> asyncio.AbstractEventLoop:
    """Return a long-lived event loop running on a daemon thread."""
    global _bg_loop, _bg_thread
    if _bg_loop is None or _bg_loop.is_closed():
        _bg_loop = asyncio.new_event_loop()
        _bg_thread = threading.Thread(
            target=_bg_loop.run_forever, daemon=True, name="pw-hot"
        )
        _bg_thread.start()
    return _bg_loop


async def _get_or_create_context(headless: bool = True):
    """Return (context, is_cold).  Reuses browser context if possible."""
    global _pw, _pw_ctx, _ctx_headless, _hot_count

    # If mode changed (headless ↔ headed), tear down first.
    if _pw_ctx is not None and _ctx_headless != headless:
        await _close_browser()

    # Try reusing existing context.
    if _pw_ctx is not None:
        try:
            _ = _pw_ctx.pages          # liveness check
            _hot_count += 1
            return _pw_ctx, False      # hot
        except Exception:
            _pw_ctx = None

    # Fresh context needed.
    if _pw is None:
        from playwright.async_api import async_playwright
        _pw = await async_playwright().start()

    last_exc: Exception | None = None
    for kw in ({"channel": "chrome"}, {"channel": "msedge"}, {}):
        try:
            _pw_ctx = await _pw.chromium.launch_persistent_context(
                user_data_dir=USER_DATA_DIR,
                headless=headless,
                viewport={"width": 1500, "height": 1000},
                **kw,
            )
            _ctx_headless = headless
            _hot_count = 0
            return _pw_ctx, True       # cold
        except Exception as exc:
            last_exc = exc
    raise LoopFetchError(
        f"Could not launch browser: {last_exc}. "
        "Run `python -m playwright install chromium`."
    )


async def _close_browser() -> None:
    """Tear down persistent context + Playwright instance."""
    global _pw_ctx, _pw, _ctx_headless
    if _pw_ctx:
        try:
            await _pw_ctx.close()
        except Exception:
            pass
        _pw_ctx = None
    if _pw:
        try:
            await _pw.stop()
        except Exception:
            pass
        _pw = None
    _ctx_headless = None


def shutdown_browser() -> None:
    """Sync helper — call before headed fallback or at process exit."""
    loop = _bg_loop
    if loop and not loop.is_closed():
        fut = asyncio.run_coroutine_threadsafe(_close_browser(), loop)
        try:
            fut.result(timeout=10)
        except Exception:
            pass


atexit.register(shutdown_browser)


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
    global _cached_print_url
    ctx, is_cold = await _get_or_create_context(headless=headless)
    _tag = "cold" if is_cold else f"hot#{_hot_count}"

    pages_opened: list = []
    try:
        # ── HOT PATH: skip Loop page entirely, reuse cached print URL ──
        if not is_cold and _cached_print_url and not wait_for_user:
            import time as _t
            t0 = _t.monotonic()
            print(f"[loop_fetch] {_tag} → cached print URL", file=sys.stderr)
            page = await ctx.new_page()
            pages_opened.append(page)
            await page.add_init_script("window.print = () => {};")
            await page.goto(_cached_print_url,
                            wait_until="domcontentloaded", timeout=timeout_ms)
            text = await _wait_until_stable(page)
            if text and len(text) >= 200:
                print(f"[loop_fetch] {_tag} done in {_t.monotonic()-t0:.1f}s",
                      file=sys.stderr)
                return text
            # Cached URL stale → fall through to full flow.
            print("[loop_fetch] cached print URL stale, full flow",
                  file=sys.stderr)
            for p in pages_opened:
                try:
                    await p.close()
                except Exception:
                    pass
            pages_opened.clear()

        # ── COLD / FULL PATH ──
        import time as _t
        t0 = _t.monotonic()
        print(f"[loop_fetch] {_tag} full flow", file=sys.stderr)
        page = await ctx.new_page()
        pages_opened.append(page)
        await page.goto(loop_url, wait_until="domcontentloaded", timeout=timeout_ms)

        if wait_for_user:
            print("\n" + "=" * 70, file=sys.stderr)
            print("[loop_fetch] Browser opened. Sign in / approve access if needed,", file=sys.stderr)
            print("[loop_fetch] then press ENTER here to start the capture.", file=sys.stderr)
            print("=" * 70 + "\n", file=sys.stderr)
            await asyncio.get_event_loop().run_in_executor(None, input)

        # Poll for the overflow button instead of fixed networkidle + settle.
        # The button lives in the header and loads well before full content.
        clicked = await _poll_and_click_overflow(page, max_wait_s=60)
        if not clicked:
            raise LoopFetchError(
                "Could not find Loop's '更多选项' / 'more options' button. "
                "Likely not signed in -- delete the user-data-dir and re-run."
            )
        await page.wait_for_timeout(800)

        # Click "Print & PDF export" → popup.
        try:
            async with ctx.expect_page(timeout=30000) as info:
                await page.get_by_text("打印和 PDF 导出", exact=False).first.click()
        except Exception:
            async with ctx.expect_page(timeout=30000) as info:
                await page.get_by_text("Print & PDF export", exact=False).first.click()
        popup = await info.value
        pages_opened.append(popup)
        await popup.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
        print_url = popup.url
        _cached_print_url = print_url          # cache for next hot call
        await popup.close()
        pages_opened.remove(popup)

        # Reopen print URL with window.print() neutralized.
        page2 = await ctx.new_page()
        pages_opened.append(page2)
        await page2.add_init_script("window.print = () => {};")
        await page2.goto(print_url, wait_until="domcontentloaded", timeout=timeout_ms)

        text = await _wait_until_stable(page2)
        if not text or len(text) < 200:
            raise LoopFetchError(
                f"Print page innerText unexpectedly short ({len(text)} chars)"
            )
        print(f"[loop_fetch] {_tag} done in {_t.monotonic()-t0:.1f}s",
              file=sys.stderr)
        return text
    finally:
        for p in pages_opened:
            try:
                await p.close()
            except Exception:
                pass


async def _poll_and_click_overflow(page, max_wait_s: int = 60) -> bool:
    """Poll every 2 s for the overflow button; click it as soon as found."""
    for _ in range(max_wait_s // 2):
        if await _open_overflow(page):
            return True
        await page.wait_for_timeout(2000)
    return False


async def _wait_until_stable(page, idle_ms: int = 3000, max_ms: int = 60000,
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

    Hot-start: the browser context is kept alive across calls on a background
    event-loop thread. Second+ calls skip browser launch and use a shorter
    settle wait (5 s vs 15 s cold).
    """
    if not loop_url or not loop_url.startswith("http"):
        raise LoopFetchError(f"Invalid Loop URL: {loop_url!r}")
    _ensure_playwright()
    loop = _ensure_bg_loop()
    coro = _fetch_async(loop_url, headless=headless, wait_for_user=wait_for_user)
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    text = future.result(timeout=300)   # 5-min safety cap
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
        shutdown_browser()  # close headless ctx before opening headed
        return fetch_loop_markdown(loop_url, headless=False, wait_for_user=True)
