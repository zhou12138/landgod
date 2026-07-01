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
        print(f"[_get_or_create_context] starting playwright…", file=sys.__stderr__, flush=True)
        _pw = await async_playwright().start()
        print(f"[_get_or_create_context] playwright started", file=sys.__stderr__, flush=True)

    last_exc: Exception | None = None
    for kw in ({}, {"channel": "chrome"}, {"channel": "msedge"}):
        try:
            print(f"[_get_or_create_context] launching persistent context headless={headless} {kw}",
                  file=sys.__stderr__, flush=True)
            _pw_ctx = await _pw.chromium.launch_persistent_context(
                user_data_dir=USER_DATA_DIR,
                headless=headless,
                viewport={"width": 1500, "height": 1000},
                **kw,
            )
            print(f"[_get_or_create_context] browser launched OK", file=sys.__stderr__, flush=True)
            _ctx_headless = headless
            _hot_count = 0
            return _pw_ctx, True       # cold
        except Exception as exc:
            print(f"[_get_or_create_context] launch failed ({kw}): {exc}", file=sys.__stderr__, flush=True)
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
    _rs = sys.__stderr__
    print("[_ensure_playwright] checking import…", file=_rs, flush=True)
    try:
        import playwright  # noqa: F401
    except ImportError:
        print("[_ensure_playwright] installing playwright …", file=_rs, flush=True)
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "--quiet", "playwright>=1.40"],
            stdin=subprocess.DEVNULL,
        )
    # Ensure chromium driver / msedge channel is available. We only need the
    # 'chrome' channel (system Chrome). If user has no Chrome, we fall back
    # to bundled chromium.
    try:
        # Just verify the playwright CLI works.
        print("[_ensure_playwright] verifying playwright CLI…", file=_rs, flush=True)
        subprocess.check_call(
            [sys.executable, "-m", "playwright", "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        print("[_ensure_playwright] done", file=_rs, flush=True)
    except Exception:
        print("[_ensure_playwright] version check failed (non-fatal)", file=_rs, flush=True)


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

        # Click "Print & PDF export" → popup.
        # Poll for the menu item to appear (dropdown may render slowly).
        popup = await _click_print_export(ctx, page, timeout_ms=30000)
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


async def _dismiss_dialogs(page) -> None:
    """Dismiss any modal dialog / popover overlay that blocks pointer events.

    Known blockers:
    - fui-DialogSurface__backdrop: Welcome / What's new / consent dialogs
    - "Present in Teams" popover (presentInTeamsPopoverImage): promo popup
    - Any portal-rendered overlay with aria-hidden backdrop
    """
    try:
        # 1. Fluent UI Dialog backdrop (Welcome / What's new / consent)
        backdrop = page.locator(".fui-DialogSurface__backdrop")
        if await backdrop.count() > 0:
            surface = page.locator(".fui-DialogSurface")
            for selector in [
                'button[aria-label="Close"]',
                'button[aria-label="关闭"]',
                'button[aria-label="Dismiss"]',
                'button[aria-label="Got it"]',
                'button[aria-label="知道了"]',
                'button[aria-label="Not now"]',
                'button[aria-label="以后再说"]',
            ]:
                btn = surface.locator(selector).first
                if await btn.count() > 0:
                    await btn.click(timeout=3000)
                    await page.wait_for_timeout(500)
                    return
            # Click any dismiss/close button inside the dialog
            for role_btn in [
                surface.locator('button:has-text("Close")').first,
                surface.locator('button:has-text("关闭")').first,
                surface.locator('button:has-text("Got it")').first,
                surface.locator('button:has-text("OK")').first,
            ]:
                if await role_btn.count() > 0:
                    await role_btn.click(timeout=3000)
                    await page.wait_for_timeout(500)
                    return
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(500)

        # 2. "Present in Teams" popover and similar portal-rendered overlays
        #    These are div[data-portal-node] containing promo images that
        #    intercept pointer events on the menu items underneath.
        dismissed = await page.evaluate("""() => {
            let count = 0;
            // Remove portal overlays containing promo/popover images
            for (const portal of document.querySelectorAll('div[data-portal-node]')) {
                const img = portal.querySelector('img[src*="presentInTeams"], img[src*="popover"], img[src*="Popover"]');
                if (img) { portal.remove(); count++; continue; }
                // Also catch generic popover surfaces that block clicks
                const popover = portal.querySelector('.fui-PopoverSurface');
                if (popover) { portal.remove(); count++; }
            }
            return count;
        }""")
        if dismissed:
            print(f"[_dismiss_dialogs] removed {dismissed} portal overlay(s)",
                  file=sys.__stderr__, flush=True)
            await page.wait_for_timeout(300)

    except Exception:
        # Non-fatal — if no dialog, proceed normally
        pass


async def _poll_and_click_overflow(page, max_wait_s: int = 60) -> bool:
    """Poll every 2 s for the overflow button; click it as soon as found."""
    for _ in range(max_wait_s // 2):
        await _dismiss_dialogs(page)
        if await _open_overflow(page):
            return True
        await page.wait_for_timeout(2000)
    return False


async def _click_print_export(ctx, page, timeout_ms: int = 30000):
    """Click 'Print & PDF export' in the overflow menu and return the popup.

    The overflow menu may render slowly after the button click, so we poll
    for the menu item text (zh-CN / en) up to ``timeout_ms`` ms.  Once found,
    we click it inside ``ctx.expect_page()`` to capture the popup.
    """
    labels = ["打印和 PDF 导出", "Print & PDF export"]
    deadline = asyncio.get_event_loop().time() + timeout_ms / 1000
    last_err: Exception | None = None
    while asyncio.get_event_loop().time() < deadline:
        await _dismiss_dialogs(page)
        for label in labels:
            loc = page.get_by_text(label, exact=False).first
            if await loc.count() > 0:
                try:
                    async with ctx.expect_page(timeout=15000) as info:
                        await loc.click()
                    return await info.value
                except Exception as exc:
                    last_err = exc
                    # Menu may have closed; re-open overflow and retry.
                    await _open_overflow(page)
                    await page.wait_for_timeout(800)
        await page.wait_for_timeout(1000)
    raise LoopFetchError(
        f"Could not click 'Print & PDF export' within {timeout_ms}ms: {last_err}"
    )


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
    _rs = sys.__stderr__
    print(f"[fetch_loop_markdown] headless={headless} wait_for_user={wait_for_user}", file=_rs, flush=True)
    _ensure_playwright()
    print(f"[fetch_loop_markdown] playwright ensured, creating bg loop", file=_rs, flush=True)
    loop = _ensure_bg_loop()
    print(f"[fetch_loop_markdown] bg loop ready, submitting coro", file=_rs, flush=True)
    coro = _fetch_async(loop_url, headless=headless, wait_for_user=wait_for_user)
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    print(f"[fetch_loop_markdown] coro submitted, waiting for result (300s cap)", file=_rs, flush=True)
    text = future.result(timeout=300)   # 5-min safety cap
    return _clean(text)


def fetch_loop_with_fallback(loop_url: str) -> str:
    """Try headless first (fast, bundled chromium avoids conflicts);
    if not signed in, fall back to headed+interactive so user can login.
    """
    _rs = sys.__stderr__
    print(f"[fetch_loop_with_fallback] called, url={loop_url[:60]}\u2026", file=_rs, flush=True)
    try:
        return fetch_loop_markdown(loop_url, headless=True)
    except LoopFetchError as exc:
        msg = str(exc).lower()
        if "not signed in" in msg or "more options" in msg or "button" in msg:
            print(f"[loop_fetch] headless failed (likely not signed in); "
                  f"retrying headed+interactive ...", file=_rs, flush=True)
            shutdown_browser()
            return fetch_loop_markdown(loop_url, headless=False, wait_for_user=True)
        print(f"[loop_fetch] headless failed ({exc}); falling back to "
              f"headed ...", file=_rs, flush=True)
        shutdown_browser()
        return fetch_loop_markdown(loop_url, headless=False)
