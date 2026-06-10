import json
import os
import subprocess
import sys
import time

try:
    import win32com.client
    import pythoncom
except ImportError:
    win32com = None
    pythoncom = None

# 避免 emoji/中文输出在非 UTF-8 终端或 subprocess 下抛 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


SUPPORTED_BACKENDS = ("pywin32", "vba", "csharp", "csharp-addin", "pywin32-addin")


def add_backend_arguments(parser):
    parser.add_argument(
        "--backend",
        choices=SUPPORTED_BACKENDS,
        default=os.environ.get("PPTX_EDITOR_BACKEND", "pywin32"),
        help="底层执行策略: pywin32(默认)、vba 或 csharp",
    )
    parser.add_argument(
        "--vba-module",
        default=os.environ.get("PPTX_EDITOR_VBA_MODULE", "PptEditorBridge"),
        help="VBA backend 使用的宏模块名，默认 PptEditorBridge",
    )


def create_backend(name="pywin32", visible=False, vba_module="PptEditorBridge", csharp_host=None):
    backend = (name or "pywin32").lower()
    if backend == "pywin32":
        from .pptx_editor_com import PowerPointCOM

        return PowerPointCOM(visible=visible)
    if backend == "vba":
        return PowerPointVBA(visible=visible, macro_module=vba_module)
    if backend == "csharp":
        return PowerPointCSharp(visible=visible, host_exe=csharp_host)
    if backend == "csharp-addin":
        return PowerPointCSharpAddin(visible=visible)
    if backend == "pywin32-addin":
        return PowerPointPywin32Addin(visible=visible)
    raise ValueError(f"不支持的 backend: {name}")


def _find_csharp_project():
    """Locate the .csproj file for PptInteropHost (bundled with the package)."""
    cur = os.path.dirname(os.path.abspath(__file__))
    for _ in range(6):
        for proj_dir in ("csharp_host", "csharp_interop"):
            csproj = os.path.join(cur, proj_dir, "PptInteropHost", "PptInteropHost.csproj")
            if os.path.isfile(csproj):
                return os.path.dirname(csproj)
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return None


def _auto_build_csharp_host(project_dir):
    """Run ``dotnet build`` and return the exe path, or raise on failure."""
    print("🔨 首次使用 C# 后端，正在自动构建 PptInteropHost ...")
    try:
        result = subprocess.run(
            ["dotnet", "build", project_dir, "-c", "Release", "--nologo", "-v", "q"],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"dotnet build 失败 (exit {result.returncode}):\n{result.stderr or result.stdout}"
            )
    except FileNotFoundError:
        raise RuntimeError(
            "找不到 dotnet CLI。请先安装 .NET SDK:\n"
            "  winget install Microsoft.DotNet.SDK.9\n"
            "  或 https://dotnet.microsoft.com/download"
        )
    # Find the built exe
    bin_dir = os.path.join(project_dir, "bin")
    for cfg in ("Release", "Debug"):
        for tfm in ("net9.0-windows", "net8.0-windows", "net10.0-windows"):
            exe = os.path.join(bin_dir, cfg, tfm, "PptInteropHost.exe")
            if os.path.isfile(exe):
                print(f"✅ 构建完成: {exe}")
                return exe
    raise RuntimeError(f"dotnet build 成功但找不到输出 exe (搜索目录: {bin_dir})")


def _resolve_csharp_host():
    """Locate the C# Interop host exe (PptInteropHost.exe).

    Search order:
    1. PPTX_EDITOR_CSHARP_HOST env var
    2. Pre-built exe in csharp_host/ or csharp_interop/ (walk up from this file)
    3. Auto-build: find .csproj and run ``dotnet build`` (lazy first-use build)
    """
    env = os.environ.get("PPTX_EDITOR_CSHARP_HOST")
    if env and os.path.isfile(env):
        return env
    cur = os.path.dirname(os.path.abspath(__file__))
    for _ in range(6):
        # Bundled / published flat layout (installed skill keeps it under csharp_host/).
        for sub in ("csharp_host", os.path.join("csharp_host", "PptInteropHost")):
            exe = os.path.join(cur, sub, "PptInteropHost.exe")
            if os.path.isfile(exe):
                return exe
        # Dev build output (repo root has csharp_interop/, skill source uses csharp_host/).
        for proj in ("csharp_interop", "csharp_host"):
            base = os.path.join(cur, proj, "PptInteropHost", "bin")
            if os.path.isdir(base):
                for cfg in ("Release", "Debug"):
                    for tfm in ("net9.0-windows", "net8.0-windows", "net10.0-windows"):
                        exe = os.path.join(base, cfg, tfm, "PptInteropHost.exe")
                        if os.path.isfile(exe):
                            return exe
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent

    # Not found — try auto-build
    project_dir = _find_csharp_project()
    if project_dir:
        return _auto_build_csharp_host(project_dir)
    return None


class _CSharpPrsShim:
    """Stand-in for a COM Presentation so callers that touch ``ppt.prs.Saved``
    (e.g. benchmark teardown) keep working with the C# backend."""

    Saved = False


class PowerPointCSharp:
    """PowerPoint backend driven by a persistent C# Interop host (stdio JSON-RPC).

    The C# host keeps one PowerPoint Application alive and talks late-bound COM,
    mirroring the VBA bridge protocol so benchmarks compare like-for-like."""

    def __init__(self, visible=False, host_exe=None):
        self.visible = visible
        self.prs = _CSharpPrsShim()
        self.filepath = None
        self._slide_count = 0
        self.host_exe = host_exe or _resolve_csharp_host()
        if not self.host_exe or not os.path.isfile(self.host_exe):
            raise RuntimeError(
                "找不到 C# host (PptInteropHost.exe) 且自动构建失败。\n"
                "请确认已安装 .NET SDK (winget install Microsoft.DotNet.SDK.9)\n"
                "或用环境变量 PPTX_EDITOR_CSHARP_HOST 指定 exe 路径。"
            )
        self.proc = subprocess.Popen(
            [self.host_exe],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )

    def _rpc(self, payload):
        if self.proc.poll() is not None:
            stderr = self.proc.stderr.read() if self.proc.stderr else ""
            raise RuntimeError(f"C# host 进程已退出。stderr: {stderr}")
        self.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            stderr = self.proc.stderr.read() if self.proc.stderr else ""
            raise RuntimeError(f"C# host 无响应。stderr: {stderr}")
        resp = json.loads(line)
        if not resp.get("ok"):
            raise RuntimeError(f"C# host 运行失败: {resp.get('error')}")
        return resp.get("result")

    def open(self, path):
        self.filepath = os.path.abspath(path)
        self._slide_count = self._rpc(
            {"cmd": "open", "path": self.filepath, "visible": bool(self.visible)}
        )
        print(f"📂 已打开: {self.filepath} ({self._slide_count}页)")
        return self

    def close(self):
        try:
            self._rpc({"cmd": "quit"})
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except Exception:
            try:
                self.proc.terminate()
            except Exception:
                pass

    def save(self, out=None):
        path = os.path.abspath(out) if out else self.filepath
        self._rpc({"cmd": "save", "path": path})
        print(f"💾 已另存为: {out}" if out else "💾 已保存")

    def inspect(self):
        data = self._rpc({"cmd": "inspect"})
        return data or {"slides": []}

    def inspect_slide(self, slide):
        data = self._rpc({"cmd": "inspect_slide", "slide": int(slide)})
        return data or {"slides": []}

    def print_structure(self, desc):
        for slide in desc.get("slides", []):
            print(f"\n{'=' * 50}\n📄 第 {slide['index']} 页 ({slide.get('layout', '')})\n{'=' * 50}")
            for idx, element in enumerate(slide.get("elements", []), 1):
                ph = f" [{element.get('ph_type_name','')}]" if element.get("is_placeholder") else ""
                labels = []
                if element.get("has_image"):
                    labels.append("[图片]")
                if element.get("has_chart"):
                    labels.append("[图表]")
                if element.get("has_table"):
                    labels.append("[表格]")
                if element.get("has_media"):
                    labels.append("[媒体]")
                txt = (element.get("text") or " ".join(labels) or "(无)")[:40].replace("\n", "↵")
                print(
                    f"  [{idx}] [{element.get('id')}] {element.get('name')}{ph} "
                    f"({element.get('position_label', '')}) → {txt}"
                )

    def set_notes(self, slide, text):
        return self._rpc({"cmd": "set_notes", "slide": int(slide), "text": text})

    def append_notes(self, slide, text, separator="\n"):
        return self._rpc(
            {"cmd": "append_notes", "slide": int(slide), "text": text, "separator": separator}
        )

    def execute_action(self, action_payload):
        return self._rpc({"cmd": "execute_action", "action": action_payload})

    def get_slide_count(self):
        """Return the number of slides in the open presentation."""
        return self._rpc({"cmd": "slide_count"})

    def export_slide_image(self, slide, path, width=1920, height=1080):
        """Export a slide to a PNG image file via the C# host."""
        return self._rpc({
            "cmd": "slide_image",
            "slide": int(slide),
            "path": path,
            "width": width,
            "height": height,
        })

    def execute_code(self, code):
        """Execute a C# script in-process against PptApi (CodeAct pattern).

        The script runs inside the C# host process with PptApi globals (App, Prs,
        SlideCount, Title(), SetText(), SetFont(), etc.). All N operations collapse
        into a single stdin/stdout round-trip.

        Returns the Print() output captured during script execution.
        """
        result = self._rpc({"cmd": "execute_code", "code": code})
        return result


def _resolve_powerpnt_exe():
    """Locate POWERPNT.EXE for launching an interactive PowerPoint instance
    (required so the in-process C# COM add-in loads — automation/DispatchEx does
    NOT auto-load COM add-ins)."""
    env = os.environ.get("PPTX_EDITOR_POWERPNT")
    if env and os.path.isfile(env):
        return env
    candidates = [
        r"C:\Program Files\Microsoft Office\root\Office16\POWERPNT.EXE",
        r"C:\Program Files (x86)\Microsoft Office\root\Office16\POWERPNT.EXE",
        r"C:\Program Files\Microsoft Office\Office16\POWERPNT.EXE",
        r"C:\Program Files (x86)\Microsoft Office\Office16\POWERPNT.EXE",
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


class PowerPointCSharpAddin:
    """PowerPoint backend driven by an IN-PROCESS C# COM add-in.

    Unlike PowerPointCSharp (out-of-process exe host) and pywin32 (out-of-process
    automation), this backend runs the editing logic *inside* POWERPNT.EXE via a
    COM add-in, exactly like VBA — so the PowerPoint object model is touched with
    zero cross-process marshalling. The Python driver makes ONE coarse cross-process
    call per operation (InspectJson / InspectSlideJson / ExecuteActionJson) and all
    per-shape traversal happens in-process.

    PowerPoint COM add-ins only load under an *interactive* launch (automation /
    DispatchEx refuses to connect them), so this backend launches POWERPNT.EXE with
    the deck and attaches via GetActiveObject."""

    PROGID = "PptEditor.AddIn"

    def __init__(self, visible=True, powerpnt_exe=None):
        if win32com is None or pythoncom is None:
            print("❌ pip install pywin32 (Windows + Office required)")
            sys.exit(1)
        pythoncom.CoInitialize()
        self.exe = powerpnt_exe or _resolve_powerpnt_exe()
        if not self.exe:
            raise RuntimeError(
                "找不到 POWERPNT.EXE。请用环境变量 PPTX_EDITOR_POWERPNT 指定路径。"
            )
        self.app = None
        self.proc = None
        self.prs = None
        self.filepath = None
        self._bridge = None

    def _ensure_bridge(self):
        if self._bridge is not None:
            return self._bridge
        try:
            addin = self.app.COMAddIns.Item(self.PROGID)
        except Exception as exc:
            raise RuntimeError(
                f"C# add-in 未注册 ({self.PROGID})。请先注册:\n"
                f"  powershell -ExecutionPolicy Bypass -File csharp_addin/register.ps1\n"
                f"原始错误: {exc}"
            ) from exc
        try:
            if not addin.Connect:
                addin.Connect = True
        except Exception:
            pass
        bridge = addin.Object
        if bridge is None:
            raise RuntimeError(
                "C# add-in 已注册但未连接 (COMAddIn.Object 为空)。"
                "请确认以交互方式启动 PowerPoint，并已构建 csharp_addin。"
            )
        self._bridge = bridge
        return bridge

    def open(self, path):
        self.filepath = os.path.abspath(path)
        # Interactive launch so the COM add-in loads in-process.
        self.proc = subprocess.Popen([self.exe, self.filepath])
        # Attach to the interactive instance and wait until the deck is fully
        # loaded. GetActiveObject can succeed before the presentation window is
        # ready (ActivePresentation then raises "no active presentation"), so we
        # gate on being able to read Presentations.Item(1).Slides.Count.
        for _ in range(90):
            try:
                if self.app is None:
                    self.app = win32com.client.GetActiveObject("PowerPoint.Application")
                if int(self.app.Presentations.Count) >= 1:
                    cand = self.app.Presentations.Item(1)
                    _ = int(cand.Slides.Count)  # confirm fully loaded
                    self.prs = cand
                    break
            except Exception:
                self.app = None
            time.sleep(1)
        if self.prs is None:
            raise RuntimeError(
                "无法连接到交互式 PowerPoint 实例或演示文稿未就绪 (启动超时)。"
            )
        self._ensure_bridge()
        print(f"📂 已打开: {self.filepath} ({int(self.prs.Slides.Count)}页)")
        return self

    def close(self):
        try:
            if self.prs is not None:
                self.prs.Saved = True
                self.prs.Close()
        except Exception:
            pass
        try:
            if self.app is not None:
                self.app.Quit()
        except Exception:
            pass
        try:
            if self.proc is not None:
                self.proc.terminate()
        except Exception:
            pass
        try:
            pythoncom.CoUninitialize()
        except Exception:
            pass

    def _get_save_format(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext == ".pptx":
            return 24
        if ext == ".ppt":
            return 1
        return None

    def save(self, out=None):
        path = os.path.abspath(out) if out else self.filepath
        fmt = self._get_save_format(path)
        if fmt is None:
            self.prs.SaveAs(path)
        else:
            self.prs.SaveAs(path, fmt)
        print(f"💾 已另存为: {out}" if out else "💾 已保存")

    def inspect(self):
        raw = self._ensure_bridge().InspectJson
        return json.loads(raw) if raw else {"slides": []}

    def inspect_slide(self, slide):
        raw = self._ensure_bridge().InspectSlideJson(int(slide))
        return json.loads(raw) if raw else {"slides": []}

    def print_structure(self, desc):
        for slide in desc.get("slides", []):
            print(f"\n{'=' * 50}\n📄 第 {slide['index']} 页 ({slide.get('layout', '')})\n{'=' * 50}")
            for idx, element in enumerate(slide.get("elements", []), 1):
                ph = f" [{element.get('ph_type_name','')}]" if element.get("is_placeholder") else ""
                labels = []
                if element.get("has_image"):
                    labels.append("[图片]")
                if element.get("has_chart"):
                    labels.append("[图表]")
                if element.get("has_table"):
                    labels.append("[表格]")
                if element.get("has_media"):
                    labels.append("[媒体]")
                txt = (element.get("text") or " ".join(labels) or "(无)")[:40].replace("\n", "↵")
                print(
                    f"  [{idx}] [{element.get('id')}] {element.get('name')}{ph} "
                    f"({element.get('position_label', '')}) → {txt}"
                )

    def set_notes(self, slide, text):
        return self.execute_action(
            {"action": "set_notes", "slide": int(slide), "params": {"text": text}}
        )

    def append_notes(self, slide, text, separator="\n"):
        return self.execute_action(
            {"action": "append_notes", "slide": int(slide), "params": {"text": text, "separator": separator}}
        )

    def execute_action(self, action_payload):
        return self._ensure_bridge().ExecuteActionJson(
            json.dumps(action_payload, ensure_ascii=False)
        )


class PowerPointPywin32Addin(PowerPointCSharpAddin):
    """PowerPoint backend driven by an IN-PROCESS *Python* (pywin32) COM add-in.

    The in-process twin of the pywin32 backend and the Python counterpart of
    PowerPointCSharpAddin: identical interactive-launch + GetActiveObject +
    COMAddIns.Item(ProgId).Object bridging, but the in-process logic is pure
    Python (pptx_pyaddin.py reusing PowerPointCOM + _dispatch). Proves the
    pywin32 slowness was the cross-process IPC, not the language.

    The only behavioural difference vs the C# add-in: the bridge object is a
    pywin32 COM server, so InspectJson / InspectSlideJson are METHODS (called
    with parentheses), not C# parameterless-property getters.
    """

    PROGID = "PptEditor.PyAddIn"

    def _ensure_bridge(self):
        if self._bridge is not None:
            return self._bridge
        try:
            addin = self.app.COMAddIns.Item(self.PROGID)
        except Exception as exc:
            raise RuntimeError(
                f"Python add-in 未注册 ({self.PROGID})。请先注册:\n"
                f"  python pptx_pyaddin.py\n"
                f"原始错误: {exc}"
            ) from exc
        try:
            if not addin.Connect:
                addin.Connect = True
        except Exception:
            pass
        bridge = addin.Object
        if bridge is None:
            raise RuntimeError(
                "Python add-in 已注册但未连接 (COMAddIn.Object 为空)。"
                "请确认以交互方式启动 PowerPoint，并已安装 pywin32。"
            )
        self._bridge = bridge
        return bridge

    def inspect(self):
        raw = self._ensure_bridge().InspectJson()
        return json.loads(raw) if raw else {"slides": []}

    def inspect_slide(self, slide):
        raw = self._ensure_bridge().InspectSlideJson(int(slide))
        return json.loads(raw) if raw else {"slides": []}


class PowerPointVBA:
    """PowerPoint backend that routes inspect/actions through Application.Run."""

    ERROR_PREFIX = "__VBA_ERROR__:"

    def __init__(self, visible=False, macro_module="PptEditorBridge"):
        if win32com is None or pythoncom is None:
            print("❌ pip install pywin32 (Windows + Office required)")
            sys.exit(1)
        pythoncom.CoInitialize()
        self.app = win32com.client.Dispatch("PowerPoint.Application")
        self.app.AutomationSecurity = 1  # msoAutomationSecurityLow
        if visible:
            self.app.Visible = True
        self.prs = None
        self.filepath = None
        self.macro_module = macro_module
        self._references_dir = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), os.pardir, "references"
        )

    def _run_macro(self, macro_name, *args):
        try:
            result = self.app.Run(f"{self.macro_module}.{macro_name}", *args)
            return self._normalize_macro_result(macro_name, result)
        except Exception as exc:
            raise RuntimeError(
                f"VBA backend 调用失败: {self.macro_module}.{macro_name}。"
                f"请先导入/实现 VBA 桥接模块。原始错误: {exc}"
            ) from exc

    def _normalize_macro_result(self, macro_name, result):
        if isinstance(result, str) and result.startswith(self.ERROR_PREFIX):
            raise RuntimeError(f"VBA backend 运行失败 [{macro_name}]: {result[len(self.ERROR_PREFIX):].strip()}")
        return result

    def open(self, path):
        self.filepath = os.path.abspath(path)
        with_window = self.app.Visible
        self.prs = self.app.Presentations.Open(self.filepath, False, False, with_window)
        self._ensure_vba_modules()
        print(f"📂 已打开: {self.filepath} ({self.prs.Slides.Count}页)")
        return self

    def _ensure_vba_modules(self):
        """Auto-import PptEditorBridge.bas and JsonConverter.bas if missing."""
        required = ["JsonConverter", self.macro_module]
        vba = self.prs.VBProject
        existing = set()
        for i in range(1, vba.VBComponents.Count + 1):
            existing.add(vba.VBComponents.Item(i).Name)
        for mod_name in required:
            if mod_name in existing:
                continue
            bas_path = os.path.join(self._references_dir, f"{mod_name}.bas")
            if not os.path.isfile(bas_path):
                continue
            try:
                vba.VBComponents.Import(bas_path)
                print(f"📥 自动导入 VBA 模块: {mod_name}")
            except Exception as exc:
                print(f"⚠️  导入 {mod_name} 失败: {exc}")

    def close(self):
        try:
            if self.prs:
                self.prs.Close()
            if self.app:
                self.app.Quit()
        except Exception:
            pass
        pythoncom.CoUninitialize()

    def _get_save_format(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext == ".pptx":
            return 24
        if ext == ".ppt":
            return 1
        return None

    def save(self, out=None):
        path = os.path.abspath(out) if out else self.filepath
        fmt = self._get_save_format(path)
        if fmt is None:
            self.prs.SaveAs(path)
        else:
            self.prs.SaveAs(path, fmt)
        print(f"💾 已另存为: {out}" if out else "💾 已保存")

    def inspect(self):
        raw = self._run_macro("InspectPresentationJson")
        if raw and isinstance(raw, str):
            try:
                data = json.loads(raw)
                if isinstance(data, dict) and data.get("error"):
                    raise RuntimeError(f"VBA backend inspect 失败: {data['error']}")
                return data
            except json.JSONDecodeError:
                pass  # Fall through to per-slide fallback
        elif raw and not isinstance(raw, str):
            return raw

        # Fallback: full-deck JSON was empty or corrupt (large file / COM truncation).
        # Inspect one slide at a time and merge results.
        print("⚠️  全量 inspect 返回空，改用逐页 inspect 降级策略")
        slide_count = self.prs.Slides.Count
        merged = {"slides": []}
        for si in range(1, slide_count + 1):
            try:
                part = self.inspect_slide(si)
                if part and part.get("slides"):
                    merged["slides"].extend(part["slides"])
                else:
                    merged["slides"].append({"index": si, "elements": [], "note": "inspect failed"})
            except Exception as exc:
                merged["slides"].append({"index": si, "elements": [], "error": str(exc)})
        return merged

    def inspect_slide(self, slide):
        raw = self._run_macro("InspectSlideJson", int(slide))
        if not raw:
            return {"slides": []}
        if isinstance(raw, str):
            data = json.loads(raw)
            if isinstance(data, dict) and data.get("error"):
                raise RuntimeError(f"VBA backend inspect_slide 失败: {data['error']}")
            return data
        return raw

    def print_structure(self, desc):
        for slide in desc.get("slides", []):
            print(f"\n{'=' * 50}\n📄 第 {slide['index']} 页 ({slide.get('layout', '')})\n{'=' * 50}")
            for idx, element in enumerate(slide.get("elements", []), 1):
                ph = f" [{element.get('ph_type_name','')}]" if element.get("is_placeholder") else ""
                labels = []
                if element.get("has_image"):
                    labels.append("[图片]")
                if element.get("has_chart"):
                    labels.append("[图表]")
                if element.get("has_table"):
                    labels.append("[表格]")
                if element.get("has_media"):
                    labels.append("[媒体]")
                txt = (element.get("text") or " ".join(labels) or "(无)")[:40].replace("\n", "↵")
                print(
                    f"  [{idx}] [{element.get('id')}] {element.get('name')}{ph} "
                    f"({element.get('position_label', '')}) → {txt}"
                )

    def save_as(self, path):
        """Alias for save(out=path) — ensures API parity with PowerPointCOM."""
        self.save(out=path)

    # ---- 3D / Visual effects (API parity with PowerPointCOM) ----
    # When called via _dispatch in pptx_editor_llm.py, `shape` is a COM object.
    # We apply effects directly via COM — same as PowerPointCOM implementation.

    def set_shadow(self, shape, preset):
        """Set shadow preset (0-20+). 0 = no shadow."""
        shape.Shadow.Type = 1 if preset > 0 else 0
        if preset > 0:
            try:
                shape.Shadow.Style = preset
            except Exception:
                shape.Shadow.Visible = True
        else:
            shape.Shadow.Visible = False
        return f"Shadow preset {preset} set on [{shape.Name}]"

    def set_reflection(self, shape, preset):
        """Set reflection preset."""
        try:
            shape.Reflection.Type = preset
        except Exception:
            return f"Reflection not supported on [{shape.Name}]"
        return f"Reflection preset {preset} set on [{shape.Name}]"

    def set_glow(self, shape, color_bgr, radius=10):
        """Set glow effect."""
        color_bgr = max(0, min(16777215, int(color_bgr)))
        try:
            shape.Glow.Color.RGB = color_bgr
            shape.Glow.Radius = radius
        except Exception:
            return f"Glow not supported on [{shape.Name}]"
        return f"Glow set on [{shape.Name}] color={hex(color_bgr)} radius={radius}"

    def set_3d_rotation(self, shape, x=0, y=0, z=0):
        """Set 3D rotation on shape."""
        try:
            shape.ThreeD.RotationX = x
            shape.ThreeD.RotationY = y
            shape.ThreeD.RotationZ = z
        except Exception:
            return f"3D rotation not supported on [{shape.Name}]"
        return f"3D rotation [{shape.Name}] x={x} y={y} z={z}"

    def set_notes(self, slide, text):
        return self._run_macro("SetNotes", int(slide), text)

    def append_notes(self, slide, text, separator="\n"):
        return self._run_macro("AppendNotes", int(slide), text, separator)

    def execute_action(self, action_payload):
        return self._run_macro("ExecuteActionJson", json.dumps(action_payload, ensure_ascii=False))