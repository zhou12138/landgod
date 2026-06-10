"""
LandGod PPTX Editor MCP Server
===============================
PowerPoint MCP server providing pptx_open, pptx_inspect,
pptx_exec_actions, pptx_exec_code, pptx_save, and pptx_close tools
for Windows desktop PowerPoint automation.

Supports three backends:
  - pywin32 (default): Direct COM automation via win32com — zero config, flexible
  - vba: VBA macro bridge via Application.Run — 10-20x faster for inspect/batch ops
  - csharp: C# Interop host with CodeAct — LLM generates C# scripts, 1 round-trip

Backend selection: pptx_open(backend="csharp") or env PPTX_EDITOR_BACKEND=csharp

Stateful — keeps a single COM connection alive across tool calls.

Install: pip install landgod-pptx-editor
Run:     python -m landgod_pptx_editor
"""
import json
import os
import sys
import logging
import base64
import io
import tempfile

logger = logging.getLogger("landgod-pptx-editor")

# ============================================
# Stateful globals — one instance at a time
# ============================================
_ppt = None          # PowerPointCOM or PowerPointVBA instance (or None)
_filepath = None     # Currently open file path
_backend_name = None # "pywin32" or "vba"
_com_initialized = False


# ============================================
# Tool Implementations
# ============================================

def _get_default_backend() -> str:
    """Get default backend from env or fall back to 'vba'."""
    return os.environ.get("PPTX_EDITOR_BACKEND", "vba").lower()


def tool_pptx_open(arguments: dict) -> dict:
    """Open a PPTX file via COM (pywin32 or VBA backend, with auto-fallback)."""
    global _ppt, _filepath, _backend_name, _com_initialized

    filepath = arguments.get("filepath")
    if not filepath:
        return {"success": False, "error": "filepath is required"}

    visible = arguments.get("visible", False)
    backend = arguments.get("backend", _get_default_backend())

    if backend not in ("pywin32", "vba", "csharp"):
        return {"success": False, "error": f"Unknown backend '{backend}'. Use 'pywin32', 'vba', or 'csharp'."}

    try:
        # Close previous if open
        if _ppt is not None:
            try:
                _ppt.close()
            except Exception:
                pass
            _ppt = None
            _filepath = None
            _backend_name = None

        # COM needs CoInitialize on the thread (Windows only)
        if not _com_initialized:
            try:
                import pythoncom
                pythoncom.CoInitialize()
                _com_initialized = True
            except ImportError:
                pass  # Not on Windows -- COM won't work anyway
            except Exception:
                pass

        fallback_used = False

        if backend == "vba":
            try:
                from .ppt_backend import PowerPointVBA
                ppt = PowerPointVBA(visible=visible)
                ppt.open(filepath)
            except Exception as vba_err:
                # VBA failed (Trust Center not enabled, etc.) — fallback to pywin32
                logger.warning("VBA backend failed (%s), falling back to pywin32", vba_err)
                try:
                    ppt.close()
                except Exception:
                    pass
                from .pptx_editor_com import PowerPointCOM
                ppt = PowerPointCOM(visible=visible)
                ppt.open(filepath)
                backend = "pywin32"
                fallback_used = True
        elif backend == "csharp":
            from .ppt_backend import PowerPointCSharp
            ppt = PowerPointCSharp(visible=visible)
            ppt.open(filepath)
        else:
            from .pptx_editor_com import PowerPointCOM
            ppt = PowerPointCOM(visible=visible)
            ppt.open(filepath)

        _ppt = ppt
        _filepath = filepath
        _backend_name = backend

        # Return structure for immediate context
        try:
            structure = ppt.inspect()
        except Exception:
            structure = {"note": "File opened but inspect failed"}

        result = {
            "success": True,
            "filepath": filepath,
            "backend": backend,
            "visible": visible,
            "structure": structure,
        }
        if fallback_used:
            result["warning"] = (
                "VBA backend failed, auto-fell back to pywin32. "
                "To enable VBA: PowerPoint -> File -> Options -> Trust Center -> "
                "Trust Center Settings -> Macro Settings -> "
                "Trust access to the VBA project object model"
            )
        return result
    except Exception as e:
        return {"success": False, "error": str(e)}


def tool_pptx_inspect(arguments: dict) -> dict:
    """Get current presentation structure."""
    global _ppt, _filepath

    if _ppt is None:
        return {"success": False, "error": "No presentation open. Use pptx_open first."}

    try:
        structure = _ppt.inspect()
        return {
            "success": True,
            "filepath": _filepath,
            "structure": structure,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def _goto_slide(slide_num: int) -> None:
    """Navigate PowerPoint UI to the given slide (1-based) when visible."""
    global _ppt
    if _ppt is None:
        return
    try:
        app = _ppt.app
        if not app or not app.Visible:
            return
        win = app.ActiveWindow
        if win is None:
            return
        # ppViewNormal = 9, ppViewSlide = 1 — both support GotoSlide
        view = win.View
        view.GotoSlide(int(slide_num))
    except Exception:
        pass  # Non-critical — don't break editing if UI nav fails


def tool_pptx_exec_actions(arguments: dict) -> dict:
    """Execute batch JSON actions on the open presentation."""
    global _ppt, _filepath, _backend_name

    if _ppt is None:
        return {"success": False, "error": "No presentation open. Use pptx_open first."}

    actions = arguments.get("actions")
    if not actions:
        return {"success": False, "error": "actions array is required"}

    if isinstance(actions, str):
        try:
            actions = json.loads(actions)
        except json.JSONDecodeError as e:
            return {"success": False, "error": f"Invalid JSON actions: {e}"}

    if isinstance(actions, dict):
        actions = [actions]

    if not isinstance(actions, list):
        return {"success": False, "error": f"actions must be an array, got {type(actions).__name__}"}

    results = []

    if _backend_name in ("vba", "csharp"):
        # VBA/C# backend: route through backend's execute_action()
        for i, act in enumerate(actions):
            try:
                slide_num = act.get("slide")
                if slide_num is not None and _backend_name == "vba":
                    _goto_slide(slide_num)
                result = _ppt.execute_action(act)
                results.append({
                    "index": i + 1,
                    "action": act.get("action", ""),
                    "success": True,
                    "result": str(result) if result is not None else "ok",
                })
            except Exception as e:
                results.append({
                    "index": i + 1,
                    "action": act.get("action", ""),
                    "success": False,
                    "error": str(e),
                })
    else:
        # pywin32 backend: use _dispatch from pptx_editor_llm
        from .pptx_editor_llm import _dispatch

        for i, act in enumerate(actions):
            action = act.get("action", "")
            slide = act.get("slide")
            target = act.get("target", {})
            params = act.get("params", {})

            try:
                if slide is not None:
                    _goto_slide(slide)
                result = _dispatch(_ppt, action, slide, target, params)
                results.append({
                    "index": i + 1,
                    "action": action,
                    "success": True,
                    "result": str(result) if result is not None else "ok",
                })
            except Exception as e:
                results.append({
                    "index": i + 1,
                    "action": action,
                    "success": False,
                    "error": str(e),
                })

    return {
        "success": True,
        "total": len(actions),
        "backend": _backend_name or "pywin32",
        "results": results,
    }


def tool_pptx_save(arguments: dict) -> dict:
    """Save the current presentation."""
    global _ppt, _filepath

    if _ppt is None:
        return {"success": False, "error": "No presentation open. Use pptx_open first."}

    output_path = arguments.get("output_path")

    try:
        if output_path:
            _ppt.save(output_path)
            return {
                "success": True,
                "message": f"Saved as {output_path}",
                "filepath": output_path,
            }
        else:
            _ppt.save()
            return {
                "success": True,
                "message": f"Saved {_filepath}",
                "filepath": _filepath,
            }
    except Exception as e:
        return {"success": False, "error": str(e)}


def tool_pptx_help(arguments: dict) -> dict:
    """Return comprehensive PPTX editing reference for the LLM."""
    topic = arguments.get("topic", "all")

    sections = {}

    sections["actions"] = r"""## 可用操作 (action) 完整列表

### 文本操作
- modify_text: 修改文本
  {action:"modify_text", slide:1, target:{type:"title"}, params:{new_text:"新文本"}}
- modify_font: 修改字体样式
  {action:"modify_font", slide:1, target:{...}, params:{font_size:24, bold:true, italic:false, underline:false, strikethrough:false, color:255, font_name:"微软雅黑", font_size_factor:1.5}}
  color 是 BGR 整数! 参数均可选，只传需要修改的。
- set_alignment: 设置对齐
  {action:"set_alignment", slide:1, target:{...}, params:{align:"center"}}
  align: left/center/right/justify

### 形状外观
- set_fill: 填充颜色
  {action:"set_fill", slide:1, target:{...}, params:{color_bgr:16711680}}
- set_border: 边框
  {action:"set_border", slide:1, target:{...}, params:{color_bgr:255, weight:2}}
- set_shadow: 阴影效果
  {action:"set_shadow", slide:1, target:{...}, params:{preset:1}}
- set_reflection: 倒影效果
  {action:"set_reflection", slide:1, target:{...}, params:{preset:1}}
- set_glow: 发光效果
  {action:"set_glow", slide:1, target:{...}, params:{color_bgr:255, radius:10}}
- set_3d_rotation: 3D旋转
  {action:"set_3d_rotation", slide:1, target:{...}, params:{x:10, y:20, z:0}}

### 位置/大小 (单位: points, 72pt = 1 inch)
- move_shape: 移动形状
  {action:"move_shape", slide:1, target:{...}, params:{left:100, top:200}}
- resize_shape: 缩放形状
  {action:"resize_shape", slide:1, target:{...}, params:{width:400, height:300}}
  或用 scale_factor: {action:"resize_shape", slide:1, target:{...}, params:{scale_factor:1.5}}
- delete / delete_shape: 删除形状
  {action:"delete", slide:1, target:{...}}
- rotate_shape: 旋转形状
  {action:"rotate_shape", slide:1, target:{...}, params:{angle:45}}
- flip_shape: 翻转形状
  {action:"flip_shape", slide:1, target:{...}, params:{direction:"horizontal"}}
- set_zorder: 设置层叠顺序
  {action:"set_zorder", slide:1, target:{...}, params:{position:"front"}}

### 添加元素
- add_textbox: 添加文本框
  {action:"add_textbox", slide:1, params:{text:"内容", left:100, top:100, width:300, height:50, fill_color:16777215, font_size:24, font_color:255}}
- add_shape: 添加基本形状
  {action:"add_shape", slide:1, params:{shape_type:1, left:100, top:100, width:300, height:200, fill_color:16777215, line_visible:true}}
- add_picture: 插入图片
  {action:"add_picture", slide:1, params:{pic_path:"image.png", left:100, top:100, width:200, height:150}}
- add_table: 添加表格
  {action:"add_table", slide:1, params:{rows:3, cols:4, left:100, top:100, width:400, height:200}}
- add_chart: 添加图表
  {action:"add_chart", slide:1, params:{chart_type:4, data:[[1,2,3],[4,5,6]], left:100, top:100, width:400, height:300}}
- add_smartart: 添加SmartArt
  {action:"add_smartart", slide:1, params:{layout_id:1, left:100, top:100, width:400, height:300}}
- add_audio: 插入音频
  {action:"add_audio", slide:1, params:{audio_path:"sound.mp3", left:100, top:100, width:50, height:50}}
- add_video: 插入视频
  {action:"add_video", slide:1, params:{video_path:"demo.mp4", left:100, top:100, width:400, height:300}}
- add_freeform: 添加自由形状
  {action:"add_freeform", slide:1, params:{points:[[100,100],[200,100],[180,180],[100,200]]}}

### 幻灯片管理
- add_slide: 添加幻灯片
  {action:"add_slide", params:{index:3, layout:12}}
  layout: 1=标题, 2=标题+正文, 7=空白, 12=空白
- delete_slide: 删除幻灯片
  {action:"delete_slide", slide:2}
- move_slide: 移动幻灯片位置
  {action:"move_slide", slide:2, params:{new_pos:1}}
- duplicate_slide: 复制幻灯片
  {action:"duplicate_slide", slide:2}
- set_slide_size: 设定页面尺寸
  {action:"set_slide_size", params:{width:960, height:540}}
- set_slide_size_preset: 预设尺寸
  {action:"set_slide_size_preset", params:{preset:"widescreen"}}
- set_slide_background: 设置背景颜色
  {action:"set_slide_background", slide:1, params:{color_bgr:16777215}}
- set_slide_background_image: 设置背景图片
  {action:"set_slide_background_image", slide:1, params:{image_path:"bg.png"}}
- set_notes: 设置演讲者备注
  {action:"set_notes", slide:1, params:{text:"演讲者备注"}}
- append_notes: 追加备注
  {action:"append_notes", slide:1, params:{text:"补充备注", separator:"\n"}}
- add_comment: 添加评论
  {action:"add_comment", slide:1, params:{text:"需要复核", author:"Reviewer", x:10, y:10}}
- delete_comment: 删除评论
  {action:"delete_comment", slide:1, params:{comment_idx:1}}
- add_section / delete_section / rename_section: 分节管理
  {action:"add_section", params:{name:"Overview", slide_idx:1}}
  {action:"delete_section", params:{section_idx:1}}
  {action:"rename_section", params:{section_idx:1, new_name:"Intro"}}

### 表格操作
- modify_cell: 修改单元格 (1-based行列)
  {action:"modify_cell", slide:1, target:{type:"table"}, params:{row:1, col:2, text:"新内容"}}
- table_row_add / table_row_delete / table_col_add / table_col_delete
  {action:"table_row_add", slide:1, target:{type:"table"}}
  {action:"table_row_delete", slide:1, target:{type:"table"}, params:{row:3}}

### 动画 (COM独有)
- animation: 添加动画
  {action:"animation", slide:1, target:{...}, params:{effect:"fade"}}
  effect: appear/fly/fade/zoom/bounce
- remove_animation: 删除动画
  {action:"remove_animation", slide:1, params:{anim_index:1}}
- modify_animation_effect: 修改动画效果
  {action:"modify_animation_effect", slide:1, params:{anim_index:1, effect:"zoom"}}

### 图片操作
- crop_picture: 裁剪图片
  {action:"crop_picture", slide:1, target:{type:"picture"}, params:{left:10, top:0, right:10, bottom:0}}
- set_brightness / set_contrast: 亮度/对比度
  {action:"set_brightness", slide:1, target:{type:"picture"}, params:{value:0.4}}
  {action:"set_contrast", slide:1, target:{type:"picture"}, params:{value:0.3}}
- replace_picture: 替换图片
  {action:"replace_picture", slide:1, target:{type:"picture"}, params:{new_path:"new.png"}}

### 文本增强
- add_bullet: 添加项目符号
  {action:"add_bullet", slide:1, target:{...}, params:{level:1}}
- set_text_autofit: 文本自适应
  {action:"set_text_autofit", slide:1, target:{...}, params:{mode:"fit"}}
- add_hyperlink: 添加超链接
  {action:"add_hyperlink", slide:1, target:{...}, params:{url:"https://example.com", text:"访问链接"}}
- set_word_art: 艺术字样式
  {action:"set_word_art", slide:1, target:{...}, params:{style:1}}
- set_line_spacing / set_paragraph_spacing: 行距/段距
  {action:"set_line_spacing", slide:1, target:{...}, params:{spacing:1.5}}
  {action:"set_paragraph_spacing", slide:1, target:{...}, params:{before:6, after:4}}

### 图表操作
- set_chart_title / set_chart_style / modify_chart_data
  {action:"set_chart_title", slide:1, target:{type:"chart"}, params:{title:"季度营收"}}
  {action:"set_chart_style", slide:1, target:{type:"chart"}, params:{style_id:10}}
  {action:"modify_chart_data", slide:1, target:{type:"chart"}, params:{series_idx:1, values:[1,2,3,4]}}

### 媒体控制
- set_media_playback: 设置媒体播放
  {action:"set_media_playback", slide:1, target:{name:"Video 1"}, params:{auto_play:true, loop:false, hide_on_stop:false}}

### 切换效果
- transition: 幻灯片切换
  {action:"transition", slide:1, params:{transition:"fade", duration:1.5}}

### 导出
- export_pdf: 导出PDF
  {action:"export_pdf", params:{}}
- export_image: 导出幻灯片为图片
  {action:"export_image", slide:1, params:{output_path:"slide1.png", width:1920, height:1080}}

### 放映与打印
- set_slideshow_settings: 放映设置
  {action:"set_slideshow_settings", params:{loop:false, show_narration:true, show_animation:true}}
- start_slideshow: 开始放映
  {action:"start_slideshow", params:{from_slide:1, to_slide:3}}
- merge_presentations: 合并演示文稿
  {action:"merge_presentations", params:{file_paths:["other.pptx"], output_path:"merged.pptx"}}
- print_presentation: 打印
  {action:"print_presentation", params:{printer_name:"Microsoft Print to PDF", copies:1}}

### 工具动作
- sleep: 等待若干秒
  {action:"sleep", params:{seconds:2}}"""

    sections["target"] = """## Target 定位选择器

target 用于定位已有形状，支持以下字段（可组合）:

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| type | string | 按占位符类型 | "title", "subtitle", "body", "table", "picture", "chart", "textbox" |
| name | string | 按形状名称精确匹配 | "Rectangle 1", "Title 1" |
| text_match | string | 按包含的文本片段匹配 | "季度报告" |
| position | string | 按形状当前位置区域 | "左上", "中中", "右下", "left_top", "center", "right_bottom" |
| index | integer | 按形状索引(1-based) | 1, 2, 3 |
| id | integer | 按形状 Shape ID | 5 |

组合示例：{type:"title", text_match:"2024"} — 匹配类型为标题且包含"2024"的形状。

**重要**: target.position 是形状的【当前位置】，用于定位形状，不是移动的目标位置。
移动目标放在 params.left / params.top。
例如"把标题移到左上" → target:{type:"title"}, params:{left:0, top:0}"""

    sections["colors"] = """## BGR 颜色参考

⚠️ COM 使用 BGR 格式，不是 RGB！

| 颜色 | BGR值 | 十六进制 |
|------|-------|---------|
| 红色 | 255 | 0x0000FF |
| 蓝色 | 16711680 | 0xFF0000 |
| 绿色 | 43520 | 0x00AA00 |
| 黄色 | 55039 | 0x00D7FF |
| 黑色 | 0 | 0x000000 |
| 白色 | 16777215 | 0xFFFFFF |
| 橙色 | 36095 | 0x008CFF |
| 紫色 | 8388736 | 0x800080 |
| 粉色 | 11823615 | 0xB469FF |
| 灰色 | 8947848 | 0x888888 |

RGB→BGR 转换公式: BGR = R + G*256 + B*65536"""

    sections["pitfalls"] = """## 关键注意事项

1. **BGR 颜色！** COM 用 BGR 不是 RGB。红=0x0000FF，蓝=0xFF0000。
2. **1-Based 索引** — 所有 slide、shape、row、col 索引从 1 开始。
3. **位置单位是 points** — 72 points = 1 inch ≈ 2.54 cm。标准宽屏(16:9)尺寸为 960×540 pt。
4. **空白布局无占位符** — layout 7/12 没有 title/subtitle/body，用 name/text_match/position/index 定位，或先 add_textbox。
5. **非文本 shape** — modify_font/set_alignment 对图片等无文本框的 shape 会跳过（不报错）。
6. **Session 0 限制** — schtasks 启动的进程无法 COM Open/SaveAs，需 RDP 桌面会话。
7. **OneDrive 路径** — Presentations.Open() 对 OneDrive 同步路径可能失败，先复制到本地非同步目录。
8. **inspect 返回结构** — 包含 slides → shapes → text/position/size/type，shape 如果包含图片/图表/表格/媒体会有 has_image/has_chart/has_table/has_media 标记。"""

    sections["workflow"] = """## 推荐工作流

1. **pptx_open** — 打开文件，返回结构
2. **pptx_inspect** — 查看当前结构（open 已返回，通常不需要再调）
3. **pptx_help** — 查看可用 actions 和参数（你现在正在读的）
4. **pptx_exec_actions** — 执行编辑操作（可批量多个 action 一次性提交）
5. **pptx_switch** — 切换到指定页（配合截图工具可视觉审查每页）
6. **pptx_save** — 保存（可选 output_path 另存为）
7. **pptx_close** — 关闭释放资源

典型流程: open → (inspect if needed) → exec_actions → save → close
视觉审查: open(visible=true) → switch(1) → screenshot → switch(2) → screenshot → ..."""

    # Filter by topic
    if topic == "all":
        parts = [sections["workflow"], sections["actions"], sections["target"], sections["colors"], sections["pitfalls"]]
    elif topic in sections:
        parts = [sections[topic]]
    else:
        available = ", ".join(sections.keys())
        return {
            "success": False,
            "error": f"Unknown topic '{topic}'. Available: {available}",
        }

    return {
        "success": True,
        "topic": topic,
        "reference": "\n\n".join(parts),
    }


def tool_pptx_switch(arguments: dict) -> dict:
    """Switch to a specific slide in the PowerPoint UI."""
    global _ppt, _filepath

    if _ppt is None:
        return {"success": False, "error": "No presentation open. Use pptx_open first."}

    slide = arguments.get("slide")
    if slide is None:
        return {"success": False, "error": "slide number is required (1-based)."}

    slide = int(slide)

    try:
        app = _ppt.app
        if not app:
            return {"success": False, "error": "COM application not available."}

        # Get total slide count
        if hasattr(_ppt, 'prs') and _ppt.prs:
            total = int(_ppt.prs.Slides.Count)
        else:
            total = None

        if total is not None and (slide < 1 or slide > total):
            return {"success": False, "error": f"Slide {slide} out of range (1-{total})."}

        # Ensure visible
        if not app.Visible:
            app.Visible = True

        win = app.ActiveWindow
        if win is None:
            return {"success": False, "error": "No active window. Open with visible=true."}

        win.View.GotoSlide(slide)

        return {
            "success": True,
            "slide": slide,
            "total_slides": total,
            "message": f"Switched to slide {slide}" + (f" of {total}" if total else ""),
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def tool_pptx_slide_image(arguments: dict) -> dict:
    """Export a slide as an image and return base64 for inline display."""
    global _ppt, _filepath

    if _ppt is None:
        return {"success": False, "error": "No presentation open. Use pptx_open first."}

    slide = arguments.get("slide")
    if slide is None:
        return {"success": False, "error": "slide number is required (1-based)."}

    slide = int(slide)
    max_width = arguments.get("max_width", 1280)
    quality = arguments.get("quality", 60)

    try:
        if _backend_name == "csharp":
            total = int(_ppt.get_slide_count())
        else:
            total = int(_ppt.prs.Slides.Count)
        if slide < 1 or slide > total:
            return {"success": False, "error": f"Slide {slide} out of range (1-{total})."}

        # Export slide to temp PNG file via COM
        tmp_path = os.path.join(tempfile.gettempdir(), f"pptx_slide_{slide}.png")
        # Use 1920 width for initial export (high quality source)
        export_w = 1920
        export_h = 1080
        if _backend_name == "csharp":
            _ppt.export_slide_image(slide, os.path.abspath(tmp_path), export_w, export_h)
        else:
            _ppt.prs.Slides(slide).Export(os.path.abspath(tmp_path), "PNG", export_w, export_h)

        if not os.path.exists(tmp_path):
            return {"success": False, "error": f"Export failed — file not created: {tmp_path}"}

        # Read and resize if needed, convert to JPEG for smaller transfer
        try:
            from PIL import Image
            img = Image.open(tmp_path)
            if img.width > max_width:
                ratio = max_width / img.width
                img = img.resize((max_width, int(img.height * ratio)), Image.LANCZOS)
            buffer = io.BytesIO()
            img.save(buffer, format="JPEG", quality=quality)
            b64 = base64.b64encode(buffer.getvalue()).decode("utf-8")
            w, h = img.width, img.height
            fmt = "jpeg"
        except ImportError:
            # Fallback: read raw PNG without resize
            with open(tmp_path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")
            w, h = export_w, export_h
            fmt = "png"

        # Clean up temp file
        try:
            os.remove(tmp_path)
        except OSError:
            pass

        return {
            "success": True,
            "image_base64": b64,
            "format": fmt,
            "width": w,
            "height": h,
            "screen_width": export_w,
            "screen_height": export_h,
            "slide": slide,
            "total_slides": total,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def tool_pptx_close(arguments: dict) -> dict:
    """Close the presentation and clean up COM."""
    global _ppt, _filepath, _backend_name

    if _ppt is None:
        return {"success": True, "message": "No presentation was open."}

    try:
        _ppt.close()
    except Exception as e:
        logger.warning("Error closing COM: %s", e)

    closed_path = _filepath
    closed_backend = _backend_name
    _ppt = None
    _filepath = None
    _backend_name = None

    return {
        "success": True,
        "message": f"Closed {closed_path} (backend: {closed_backend})",
    }


def tool_pptx_exec_code(arguments: dict) -> dict:
    """Execute a C# script against the open presentation (CodeAct pattern).

    Only works with the 'csharp' backend. The script runs inside the C# host
    process with PptApi as globals — all operations happen in one round-trip.
    """
    global _ppt, _backend_name

    if _ppt is None:
        return {"success": False, "error": "No presentation open. Use pptx_open first."}

    if _backend_name != "csharp":
        return {
            "success": False,
            "error": f"pptx_exec_code requires backend='csharp', current backend is '{_backend_name}'. "
                     f"Re-open with pptx_open(backend='csharp').",
        }

    code = arguments.get("code")
    if not code:
        return {"success": False, "error": "code is required"}

    try:
        result = _ppt.execute_code(code)
        return {
            "success": True,
            "backend": "csharp",
            "result": result,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================
# MCP Server Protocol (stdio JSON-RPC)
# ============================================

TOOLS = {
    "pptx_open": {
        "name": "pptx_open",
        "description": (
            "Open a PowerPoint file (.pptx) via COM automation. "
            "Returns the presentation structure (slides, shapes, text). "
            "Only one file can be open at a time — opening a new file closes the previous one. "
            "Default backend is 'vba' (10-20x faster); auto-falls back to 'pywin32' "
            "if Trust Center macro access is not enabled."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "filepath": {
                    "type": "string",
                    "description": "Absolute path to the .pptx file to open.",
                },
                "visible": {
                    "type": "boolean",
                    "default": False,
                    "description": "Whether to show the PowerPoint window. Default false (hidden).",
                },
                "backend": {
                    "type": "string",
                    "enum": ["pywin32", "vba"],
                    "description": (
                        "COM backend to use. "
                        "'vba' (default): VBA macro bridge, 10-20x faster, auto-imports macros on open. "
                        "'pywin32': direct COM, zero config fallback. "
                        "Default is 'vba' with auto-fallback to 'pywin32' if VBA fails."
                    ),
                },
            },
            "required": ["filepath"],
        },
    },
    "pptx_inspect": {
        "name": "pptx_inspect",
        "description": (
            "Get the full structure of the currently open presentation — "
            "slides, shapes, text content, positions, sizes. "
            "Call this to understand the layout before making edits."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    "pptx_exec_actions": {
        "name": "pptx_exec_actions",
        "description": (
            "Execute a batch of edit actions on the open presentation. "
            "Each action is an object with: action (string), slide (number), "
            "target (object for finding shapes), params (object with action-specific parameters). "
            "Supports: modify_text, modify_font, add_textbox, add_picture, add_shape, "
            "add_slide, delete_slide, move_slide, delete_shape, move_shape, resize_shape, "
            "set_fill, set_border, set_alignment, add_animation, set_transition, "
            "add_chart, add_table, modify_cell, set_slide_background, set_notes, "
            "export_pdf, export_image, and more. "
            "Colors use BGR format (red=0x0000FF, blue=0xFF0000). Indices are 1-based."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "actions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "action": {
                                "type": "string",
                                "description": "Action name (e.g. modify_font, add_textbox, add_slide).",
                            },
                            "slide": {
                                "type": "integer",
                                "description": "1-based slide number to operate on.",
                            },
                            "target": {
                                "type": "object",
                                "description": "Shape selector: {type: 'title'|'subtitle'|'body'|'table'|'picture'}, {text_match: '...'}, or {position: 'left_top'|'center'|'right_bottom'}.",
                            },
                            "params": {
                                "type": "object",
                                "description": "Action-specific parameters.",
                            },
                        },
                        "required": ["action"],
                    },
                    "description": "Array of action objects to execute in order.",
                },
            },
            "required": ["actions"],
        },
    },
    "pptx_exec_code": {
        "name": "pptx_exec_code",
        "description": (
            "Execute a C# script against the open presentation (CodeAct). "
            "Requires backend='csharp'. The script runs in-process with PptApi globals — "
            "all operations collapse into ONE round-trip (vs N round-trips with pptx_exec_actions).\n\n"
            "## PptApi Reference (available as globals in your script)\n\n"
            "### Output\n"
            "- `Print(msg)` — append to script output (returned as result.output)\n\n"
            "### Navigation\n"
            "- `SlideCount` — number of slides\n"
            "- `Slide(i)` — get slide by 1-based index\n"
            "- `Shape(slide, idx)` — shape by 1-based slide+shape index\n"
            "- `ShapeCount(slide)` — number of shapes on slide\n"
            "- `Title(slide)` — first title placeholder (or null)\n"
            "- `FindByText(slide, contains)` — first shape containing text (or null)\n"
            "- `FindByName(slide, name)` — first shape with matching Name (or null)\n"
            "- `FindById(slide, id)` — first shape with matching Id (or null)\n\n"
            "### Text & Font\n"
            "- `SetText(shp, text)` — replace shape text\n"
            "- `GetText(shp)` — read shape text\n"
            "- `SetFont(shp, size?, bold?, italic?, colorBgr?, name?)` — modify font\n\n"
            "### Geometry (units: points, 72pt = 1 inch)\n"
            "- `Move(shp, left, top)` — reposition shape\n"
            "- `Resize(shp, width, height)` — resize shape\n\n"
            "### Appearance\n"
            "- `SetFill(shp, colorBgr)` — solid fill\n"
            "- `SetBorder(shp, colorBgr, weight?)` — border\n"
            "- `SetSlideBackground(slide, colorBgr)` — slide background\n\n"
            "### Create\n"
            "- `AddTextbox(slide, text, left, top, width, height)` — returns new shape\n\n"
            "### Notes\n"
            "- `SetNotes(slide, text)` — set speaker notes\n\n"
            "### Raw COM (escape hatch for anything not wrapped)\n"
            "- `App` — PowerPoint.Application COM object\n"
            "- `Prs` — active Presentation COM object\n\n"
            "### Colors: BGR! (red=0x0000FF, blue=0xFF0000)\n"
            "### All indices: 1-based\n\n"
            "## Example\n"
            "```csharp\n"
            "var t = Title(1);\n"
            "if (t != null) {\n"
            "    SetText(t, \"New Title\");\n"
            "    SetFont(t, bold: true, colorBgr: 0x0000FF);\n"
            "}\n"
            "for (int i = 1; i <= SlideCount; i++) {\n"
            "    var s = FindByText(i, \"TODO\");\n"
            "    if (s != null) SetText(s, \"DONE\");\n"
            "}\n"
            "Print($\"Updated {SlideCount} slides\");\n"
            "```"
        ),
        "inputSchema": {
            "type": "object",
            "required": ["code"],
            "properties": {
                "code": {
                    "type": "string",
                    "description": (
                        "C# script to execute. Runs against PptApi globals (Print, SlideCount, Title, "
                        "SetText, SetFont, Move, Resize, SetFill, SetBorder, AddTextbox, etc.). "
                        "Use Print() for output. Can use loops, conditionals, LINQ. "
                        "Access raw COM via App/Prs for anything not wrapped."
                    ),
                },
            },
        },
    },
    "pptx_save": {
        "name": "pptx_save",
        "description": (
            "Save the currently open presentation. "
            "Optionally save to a new path (save-as)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "output_path": {
                    "type": "string",
                    "description": "Optional: save to this path instead (save-as). Omit to save in place.",
                },
            },
        },
    },
    "pptx_switch": {
        "name": "pptx_switch",
        "description": (
            "Switch the PowerPoint UI to a specific slide. "
            "Use this to navigate between slides for visual review — "
            "combine with screenshot tools to visually inspect each slide. "
            "Automatically makes the window visible if it was hidden. "
            "Returns the current slide number and total slide count."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "slide": {
                    "type": "integer",
                    "description": "1-based slide number to navigate to.",
                },
            },
            "required": ["slide"],
        },
    },
    "pptx_slide_image": {
        "name": "pptx_slide_image",
        "description": (
            "Capture a slide as an image and return it inline (base64). "
            "Use this to visually preview slides without leaving the conversation. "
            "Returns image data in the same format as computer_screenshot."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "slide": {
                    "type": "integer",
                    "description": "1-based slide number to capture.",
                },
                "max_width": {
                    "type": "integer",
                    "default": 1280,
                    "description": "Max image width in pixels (default 1280). Smaller = faster transfer.",
                },
                "quality": {
                    "type": "integer",
                    "default": 60,
                    "description": "JPEG quality 1-100 (default 60). Lower = smaller file.",
                },
            },
            "required": ["slide"],
        },
    },
    "pptx_close": {
        "name": "pptx_close",
        "description": (
            "Close the currently open presentation and release the COM connection. "
            "Always close when done editing to free resources."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    "pptx_help": {
        "name": "pptx_help",
        "description": (
            "Get comprehensive PPTX editing reference — all available actions, parameters, "
            "target selectors, BGR color table, pitfalls, and workflow guidance. "
            "Call this BEFORE your first pptx_exec_actions to understand the full API surface. "
            "Use topic parameter to get a specific section instead of the full reference."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "topic": {
                    "type": "string",
                    "default": "all",
                    "description": (
                        "Which section to return. Options: "
                        "'all' (everything), 'actions' (full action list with params), "
                        "'target' (shape selector reference), 'colors' (BGR color table), "
                        "'pitfalls' (common mistakes), 'workflow' (recommended steps). "
                        "Default: 'all'."
                    ),
                },
            },
        },
    },
}

TOOL_HANDLERS = {
    "pptx_open": tool_pptx_open,
    "pptx_inspect": tool_pptx_inspect,
    "pptx_exec_actions": tool_pptx_exec_actions,
    "pptx_exec_code": tool_pptx_exec_code,
    "pptx_save": tool_pptx_save,
    "pptx_switch": tool_pptx_switch,
    "pptx_slide_image": tool_pptx_slide_image,
    "pptx_close": tool_pptx_close,
    "pptx_help": tool_pptx_help,
}


def handle_message(msg: dict) -> dict | None:
    """Handle a JSON-RPC message and return a response."""
    method = msg.get("method", "")
    msg_id = msg.get("id")
    params = msg.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {
                    "name": "landgod-pptx-editor",
                    "version": "0.1.0",
                },
            },
        }

    if method == "notifications/initialized":
        return None  # No response for notifications

    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {"tools": list(TOOLS.values())},
        }

    if method == "tools/call":
        tool_name = params.get("name", "")
        arguments = params.get("arguments", {})

        handler = TOOL_HANDLERS.get(tool_name)
        if not handler:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps({"error": f"Unknown tool: {tool_name}"})}],
                    "isError": True,
                },
            }

        result = handler(arguments)
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, default=str)}],
                "isError": not result.get("success", False),
            },
        }

    # Unknown method
    return {
        "jsonrpc": "2.0",
        "id": msg_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main():
    """Run the MCP server over stdio (Windows-compatible)."""
    import sys
    import os

    # Windows: force stdin/stdout to binary mode
    if os.name == 'nt':
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

    while True:
        try:
            line = sys.stdin.readline()
        except (OSError, IOError):
            break

        if not line:
            break

        line_str = line.strip()
        if not line_str:
            continue

        try:
            msg = json.loads(line_str)
        except json.JSONDecodeError:
            continue

        response = handle_message(msg)
        if response is not None:
            out = json.dumps(response, ensure_ascii=False, default=str) + "\n"
            sys.stdout.write(out)
            sys.stdout.flush()


if __name__ == "__main__":
    main()
