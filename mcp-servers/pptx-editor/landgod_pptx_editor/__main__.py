"""Entry point for python -m landgod_pptx_editor"""
import os
import sys

# Force UTF-8 on Windows to avoid charmap codec errors with CJK/emoji in output
if sys.platform == "win32":
    os.environ.setdefault("PYTHONUTF8", "1")
    if sys.stdout and hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if sys.stderr and hasattr(sys.stderr, "reconfigure"):
        try:
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

from . import main

main()
