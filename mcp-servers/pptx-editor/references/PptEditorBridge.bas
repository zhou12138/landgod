Attribute VB_Name = "PptEditorBridge"
Option Explicit

' VBA bridge for the experimental --backend vba strategy.
' Import this module into a macro-enabled presentation/add-in.
' Requires the bundled JsonConverter.bas in the same VBA project.

Public Function Ping() As String
    On Error GoTo ErrHandler
    Ping = "PptEditorBridge ready"
    Exit Function

ErrHandler:
    Ping = BuildMacroErrorText("Ping", Err)
End Function

Public Function InspectPresentationJson() As String
    On Error GoTo ErrHandler
    Dim prs As Presentation
    Dim result As Object
    Dim slidesArr As Collection
    Dim slideObj As Object
    Dim elementsArr As Collection
    Dim sld As Slide
    Dim shp As Shape

    Set prs = ActivePresentation
    Set result = CreateObject("Scripting.Dictionary")
    Set slidesArr = New Collection

    For Each sld In prs.Slides
        Set slideObj = CreateObject("Scripting.Dictionary")
        slideObj("index") = CLng(sld.SlideIndex)
        slideObj("layout") = GetSlideLayoutName(sld)

        Set elementsArr = New Collection
        For Each shp In sld.Shapes
            elementsArr.Add InspectShape(prs, shp)
        Next shp

        Set slideObj("elements") = elementsArr
        slidesArr.Add slideObj
    Next sld

    Set result("slides") = slidesArr
    InspectPresentationJson = JsonConverter.ConvertToJson(result)
    Exit Function

ErrHandler:
    InspectPresentationJson = BuildMacroErrorJson("InspectPresentationJson", Err)
End Function

' Inspect a single slide only — avoids full-deck cost when caller needs one page.
Public Function InspectSlideJson(ByVal slideIndex As Long) As String
    On Error GoTo ErrHandler
    Dim prs As Presentation
    Dim result As Object
    Dim slidesArr As Collection
    Dim slideObj As Object
    Dim elementsArr As Collection
    Dim sld As Slide
    Dim shp As Shape

    Set prs = ActivePresentation
    Set result = CreateObject("Scripting.Dictionary")
    Set slidesArr = New Collection

    Set sld = prs.Slides(slideIndex)
    Set slideObj = CreateObject("Scripting.Dictionary")
    slideObj("index") = CLng(sld.SlideIndex)
    slideObj("layout") = GetSlideLayoutName(sld)

    Set elementsArr = New Collection
    For Each shp In sld.Shapes
        elementsArr.Add InspectShape(prs, shp)
    Next shp

    Set slideObj("elements") = elementsArr
    slidesArr.Add slideObj

    Set result("slides") = slidesArr
    InspectSlideJson = JsonConverter.ConvertToJson(result)
    Exit Function

ErrHandler:
    InspectSlideJson = BuildMacroErrorJson("InspectSlideJson", Err)
End Function

Public Function ExecuteActionJson(ByVal actionJson As String) As String
    On Error GoTo ErrHandler
    Dim actionObj As Object
    Dim actionName As String

    Set actionObj = JsonConverter.ParseJson(actionJson)
    actionName = LCase$(CStr(actionObj("action")))

    Select Case actionName
        Case "add_slide"
            ExecuteActionJson = HandleAddSlide(actionObj)
        Case "delete_slide"
            ExecuteActionJson = HandleDeleteSlide(actionObj)
        Case "move_slide"
            ExecuteActionJson = HandleMoveSlide(actionObj)
        Case "duplicate_slide"
            ExecuteActionJson = HandleDuplicateSlide(actionObj)
        Case "modify_text"
            ExecuteActionJson = HandleModifyText(actionObj)
        Case "modify_font"
            ExecuteActionJson = HandleModifyFont(actionObj)
        Case "set_alignment"
            ExecuteActionJson = HandleSetAlignment(actionObj)
        Case "set_fill"
            ExecuteActionJson = HandleSetFill(actionObj)
        Case "set_border"
            ExecuteActionJson = HandleSetBorder(actionObj)
        Case "move_shape"
            ExecuteActionJson = HandleMoveShape(actionObj)
        Case "resize_shape"
            ExecuteActionJson = HandleResizeShape(actionObj)
        Case "set_zorder"
            ExecuteActionJson = HandleSetZOrder(actionObj)
        Case "delete", "delete_shape"
            ExecuteActionJson = HandleDeleteShape(actionObj)
        Case "add_textbox"
            ExecuteActionJson = HandleAddTextbox(actionObj)
        Case "add_shape"
            ExecuteActionJson = HandleAddShape(actionObj)
        Case "add_picture"
            ExecuteActionJson = HandleAddPicture(actionObj)
        Case "add_table"
            ExecuteActionJson = HandleAddTable(actionObj)
        Case "set_slide_background"
            ExecuteActionJson = HandleSetSlideBackground(actionObj)
        Case "set_slide_background_image"
            ExecuteActionJson = HandleSetSlideBackgroundImage(actionObj)
        Case "modify_cell"
            ExecuteActionJson = HandleModifyCell(actionObj)
        Case "table_row_add"
            ExecuteActionJson = HandleTableRowAdd(actionObj)
        Case "table_row_delete"
            ExecuteActionJson = HandleTableRowDelete(actionObj)
        Case "table_col_add"
            ExecuteActionJson = HandleTableColAdd(actionObj)
        Case "table_col_delete"
            ExecuteActionJson = HandleTableColDelete(actionObj)
        Case "animation"
            ExecuteActionJson = HandleAnimation(actionObj)
        Case "remove_animation"
            ExecuteActionJson = HandleRemoveAnimation(actionObj)
        Case "modify_animation_effect"
            ExecuteActionJson = HandleModifyAnimationEffect(actionObj)
        Case "transition"
            ExecuteActionJson = HandleTransition(actionObj)
        Case "set_notes"
            ExecuteActionJson = SetNotes(CLng(actionObj("slide")), CStr(actionObj("params")("text")))
        Case "append_notes"
            ExecuteActionJson = AppendNotes( _
                CLng(actionObj("slide")), _
                CStr(actionObj("params")("text")), _
                GetOptionalString(actionObj("params"), "separator", vbCrLf) _
            )
        Case "sleep"
            ExecuteActionJson = HandleSleep(actionObj)
        Case "set_shadow"
            ExecuteActionJson = HandleSetShadow(actionObj)
        Case "set_reflection"
            ExecuteActionJson = HandleSetReflection(actionObj)
        Case "set_glow"
            ExecuteActionJson = HandleSetGlow(actionObj)
        Case "set_3d_rotation"
            ExecuteActionJson = HandleSet3DRotation(actionObj)
        Case "rotate_shape"
            ExecuteActionJson = HandleRotateShape(actionObj)
        Case "flip_shape"
            ExecuteActionJson = HandleFlipShape(actionObj)
        Case "crop_picture"
            ExecuteActionJson = HandleCropPicture(actionObj)
        Case "set_brightness"
            ExecuteActionJson = HandleSetBrightness(actionObj)
        Case "set_contrast"
            ExecuteActionJson = HandleSetContrast(actionObj)
        Case "replace_picture"
            ExecuteActionJson = HandleReplacePicture(actionObj)
        Case "set_line_spacing"
            ExecuteActionJson = HandleSetLineSpacing(actionObj)
        Case "set_paragraph_spacing"
            ExecuteActionJson = HandleSetParagraphSpacing(actionObj)
        Case "set_text_autofit"
            ExecuteActionJson = HandleSetTextAutofit(actionObj)
        Case "add_bullet"
            ExecuteActionJson = HandleAddBullet(actionObj)
        Case "add_hyperlink"
            ExecuteActionJson = HandleAddHyperlink(actionObj)
        Case "set_word_art"
            ExecuteActionJson = HandleSetWordArt(actionObj)
        Case "set_media_playback"
            ExecuteActionJson = HandleSetMediaPlayback(actionObj)
        Case "set_chart_title"
            ExecuteActionJson = HandleSetChartTitle(actionObj)
        Case "set_chart_style"
            ExecuteActionJson = HandleSetChartStyle(actionObj)
        Case "modify_chart_data"
            ExecuteActionJson = HandleModifyChartData(actionObj)
        Case "add_chart"
            ExecuteActionJson = HandleAddChart(actionObj)
        Case "add_smartart"
            ExecuteActionJson = HandleAddSmartArt(actionObj)
        Case "add_freeform"
            ExecuteActionJson = HandleAddFreeform(actionObj)
        Case "add_audio"
            ExecuteActionJson = HandleAddAudio(actionObj)
        Case "add_video"
            ExecuteActionJson = HandleAddVideo(actionObj)
        Case "set_slide_size"
            ExecuteActionJson = HandleSetSlideSize(actionObj)
        Case "set_slide_size_preset"
            ExecuteActionJson = HandleSetSlideSizePreset(actionObj)
        Case "add_comment"
            ExecuteActionJson = HandleAddComment(actionObj)
        Case "delete_comment"
            ExecuteActionJson = HandleDeleteComment(actionObj)
        Case "add_section"
            ExecuteActionJson = HandleAddSection(actionObj)
        Case "rename_section"
            ExecuteActionJson = HandleRenameSection(actionObj)
        Case "delete_section"
            ExecuteActionJson = HandleDeleteSection(actionObj)
        Case "export_image"
            ExecuteActionJson = HandleExportImage(actionObj)
        Case "export_pdf"
            ExecuteActionJson = HandleExportPdf(actionObj)
        Case "set_slideshow_settings"
            ExecuteActionJson = HandleSetSlideshowSettings(actionObj)
        Case "start_slideshow"
            ExecuteActionJson = HandleStartSlideshow(actionObj)
        Case "merge_presentations"
            ExecuteActionJson = HandleMergePresentations(actionObj)
        Case "print_presentation"
            ExecuteActionJson = HandlePrintPresentation(actionObj)
        Case Else
            Err.Raise vbObjectError + 2049, "PptEditorBridge", _
                "Unsupported action for VBA backend: " & actionName
    End Select
    Exit Function

ErrHandler:
    ExecuteActionJson = BuildMacroErrorText("ExecuteActionJson", Err)
End Function

Private Function HandleAddSlide(ByVal actionObj As Object) As String
    Dim params As Object
    Dim slideIndex As Long
    Dim layout As Long

    Set params = actionObj("params")
    slideIndex = GetOptionalLong(params, "index", ActivePresentation.Slides.Count + 1)
    layout = GetOptionalLong(params, "layout", 1)
    ActivePresentation.Slides.Add slideIndex, layout
    HandleAddSlide = "添加幻灯片: 第" & slideIndex & "页 (layout=" & layout & ")"
End Function

Private Function HandleDeleteSlide(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    slideIndex = CLng(actionObj("slide"))
    ActivePresentation.Slides(slideIndex).Delete
    HandleDeleteSlide = "删除第" & slideIndex & "页"
End Function

Private Function HandleMoveSlide(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    Dim newPos As Long
    slideIndex = CLng(actionObj("slide"))
    newPos = CLng(actionObj("params")("new_pos"))
    ActivePresentation.Slides(slideIndex).MoveTo newPos
    HandleMoveSlide = "第" & slideIndex & "页移动到第" & newPos & "页"
End Function

Private Function HandleDuplicateSlide(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    slideIndex = CLng(actionObj("slide"))
    ActivePresentation.Slides(slideIndex).Duplicate
    HandleDuplicateSlide = "Duplicated slide " & slideIndex
End Function

Private Function InspectShape(ByVal prs As Presentation, ByVal shp As Shape) As Object
    Dim element As Object
    Dim detected As Object
    Dim placeholderInfo As Object
    Dim cx As Double
    Dim cy As Double
    Dim sw As Double
    Dim sh As Double

    Set element = CreateObject("Scripting.Dictionary")
    Set detected = DetectShapeContent(shp)
    Set placeholderInfo = GetPlaceholderInfo(shp)

    sw = prs.PageSetup.SlideWidth
    sh = prs.PageSetup.SlideHeight
    cx = shp.Left + shp.Width / 2
    cy = shp.Top + shp.Height / 2

    element("id") = CLng(shp.Id)
    element("name") = shp.Name
    element("type") = CLng(shp.Type)
    element("left") = Round(shp.Left, 1)
    element("top") = Round(shp.Top, 1)
    element("width") = Round(shp.Width, 1)
    element("height") = Round(shp.Height, 1)
    element("text") = GetShapeText(shp)
    element("is_placeholder") = CBool(placeholderInfo("is_placeholder"))
    element("has_image") = CBool(detected("has_image"))
    element("has_chart") = CBool(detected("has_chart"))
    element("has_table") = CBool(detected("has_table"))
    element("has_media") = CBool(detected("has_media"))
    element("position_label") = BuildPositionLabel(cx, cy, sw, sh)

    If element("is_placeholder") Then
        element("ph_type") = CLng(placeholderInfo("ph_type"))
        element("ph_type_name") = CStr(placeholderInfo("ph_type_name"))
    End If

    Set InspectShape = element
End Function

Private Function DetectShapeContent(ByVal shp As Shape) As Object
    Dim info As Object
    Dim pf As PlaceholderFormat

    Set info = CreateObject("Scripting.Dictionary")
    info("has_image") = False
    info("has_chart") = False
    info("has_table") = False
    info("has_media") = False

    On Error Resume Next
    info("has_table") = CBool(shp.HasTable)
    Err.Clear
    info("has_chart") = CBool(shp.HasChart)
    Err.Clear

    If CLng(shp.Type) = 13 Then info("has_image") = True
    If CLng(shp.Type) = 16 Then info("has_media") = True
    Err.Clear

    Set pf = shp.PlaceholderFormat
    If Err.Number = 0 Then
        Select Case CLng(pf.ContainedType)
            Case 13
                info("has_image") = True
            Case 8
                info("has_chart") = True
            Case 19
                info("has_table") = True
            Case 16
                info("has_media") = True
        End Select
    End If
    Err.Clear
    On Error GoTo 0

    Set DetectShapeContent = info
End Function

Private Function GetPlaceholderInfo(ByVal shp As Shape) As Object
    Dim info As Object
    Dim pf As PlaceholderFormat

    Set info = CreateObject("Scripting.Dictionary")
    info("is_placeholder") = False

    On Error Resume Next
    Set pf = shp.PlaceholderFormat
    If Err.Number = 0 Then
        info("is_placeholder") = True
        info("ph_type") = CLng(pf.Type)
        info("ph_type_name") = PlaceholderTypeName(CLng(pf.Type))
    End If
    Err.Clear
    On Error GoTo 0

    Set GetPlaceholderInfo = info
End Function

Private Function GetSlideLayoutName(ByVal sld As Slide) As String
    On Error Resume Next
    GetSlideLayoutName = sld.CustomLayout.Name
    If Err.Number <> 0 Then
        Err.Clear
        GetSlideLayoutName = CStr(sld.Layout)
    End If
    On Error GoTo 0
End Function

Private Function GetShapeText(ByVal shp As Shape) As String
    On Error Resume Next
    If shp.HasTextFrame Then
        GetShapeText = shp.TextFrame.TextRange.Text
    Else
        GetShapeText = ""
    End If
    Err.Clear
    On Error GoTo 0
End Function

Private Function BuildPositionLabel(ByVal cx As Double, ByVal cy As Double, ByVal sw As Double, ByVal sh As Double) As String
    Dim h As String
    Dim v As String

    If cx < sw * 0.33 Then
        h = "左"
    ElseIf cx > sw * 0.67 Then
        h = "右"
    Else
        h = "中"
    End If

    If cy < sh * 0.33 Then
        v = "上"
    ElseIf cy > sh * 0.67 Then
        v = "下"
    Else
        v = "中"
    End If

    BuildPositionLabel = h & v
End Function

Private Function HandleModifyText(ByVal actionObj As Object) As String
    Dim shp As Shape
    Dim oldText As String
    Dim newText As String

    Set shp = FindFirstShape(CLng(actionObj("slide")), actionObj("target"))
    If shp Is Nothing Then
        Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"
    End If

    oldText = GetShapeText(shp)
    newText = CStr(actionObj("params")("new_text"))
    shp.TextFrame.TextRange.Text = newText
    HandleModifyText = "文本: '" & Left$(oldText, 20) & "' → '" & Left$(newText, 20) & "'"
End Function

Private Function HandleModifyFont(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then
        Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"
    End If

    Set results = New Collection
    For Each shp In shapes
        results.Add ApplyModifyFont(shp, actionObj("params"))
    Next shp
    HandleModifyFont = JoinCollection(results, "; ")
End Function

Private Function HandleSetAlignment(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim alignValue As Long
    Dim alignLabel As String

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then
        Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"
    End If

    alignLabel = CStr(actionObj("params")("align"))
    alignValue = ResolveAlignment(alignLabel)
    Set results = New Collection
    For Each shp In shapes
        results.Add ApplyAlignment(shp, alignValue, alignLabel)
    Next shp
    HandleSetAlignment = JoinCollection(results, "; ")
End Function

Private Function HandleSetFill(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim colorValue As Long

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then
        Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"
    End If

    colorValue = CLng(actionObj("params")("color_bgr"))
    Set results = New Collection
    For Each shp In shapes
        shp.Fill.Solid
        shp.Fill.ForeColor.RGB = ClampColor(colorValue)
        results.Add "填充颜色 → " & ToHexColor(colorValue)
    Next shp
    HandleSetFill = JoinCollection(results, "; ")
End Function

Private Function HandleSetBorder(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim changes As Collection
    Dim params As Object

    Set params = actionObj("params")
    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then
        Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"
    End If

    Set results = New Collection
    For Each shp In shapes
        Set changes = New Collection
        If ExistsKey(params, "color_bgr") Then
            shp.Line.ForeColor.RGB = ClampColor(CLng(params("color_bgr")))
            changes.Add "边框颜色→" & ToHexColor(CLng(params("color_bgr")))
        End If
        If ExistsKey(params, "weight") Then
            shp.Line.Weight = CDbl(params("weight"))
            changes.Add "边框粗细→" & CStr(params("weight"))
        End If
        If changes.Count = 0 Then
            results.Add "边框未修改"
        Else
            results.Add JoinCollection(changes, ", ")
        End If
    Next shp
    HandleSetBorder = JoinCollection(results, "; ")
End Function

Private Function HandleMoveShape(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim changes As Collection
    Dim params As Object

    Set params = actionObj("params")
    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then
        Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"
    End If

    Set results = New Collection
    For Each shp In shapes
        Set changes = New Collection
        If ExistsKey(params, "left") Then
            shp.Left = CDbl(params("left"))
            changes.Add "Left→" & CStr(params("left"))
        End If
        If ExistsKey(params, "top") Then
            shp.Top = CDbl(params("top"))
            changes.Add "Top→" & CStr(params("top"))
        End If
        results.Add "移动 [" & shp.Name & "] " & JoinCollection(changes, ", ")
    Next shp
    HandleMoveShape = JoinCollection(results, "; ")
End Function

Private Function HandleResizeShape(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim changes As Collection
    Dim params As Object
    Dim factor As Double
    Dim newW As Double
    Dim newH As Double

    Set params = actionObj("params")
    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then
        Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"
    End If

    Set results = New Collection
    For Each shp In shapes
        Set changes = New Collection
        If ExistsKey(params, "scale_factor") Then
            factor = CDbl(params("scale_factor"))
            newW = shp.Width * factor
            newH = shp.Height * factor
            ' Clamp to safe range
            If newW < 0.1 Then newW = 0.1
            If newH < 0.1 Then newH = 0.1
            If newW > 5000 Then newW = 5000
            If newH > 5000 Then newH = 5000
            shp.Width = newW
            shp.Height = newH
            changes.Add "Width→" & Round(shp.Width, 1)
            changes.Add "Height→" & Round(shp.Height, 1)
        Else
            If ExistsKey(params, "width") Then
                newW = CDbl(params("width"))
                If newW < 0.1 Then newW = 0.1
                If newW > 5000 Then newW = 5000
                shp.Width = newW
                changes.Add "Width→" & CStr(newW)
            End If
            If ExistsKey(params, "height") Then
                newH = CDbl(params("height"))
                If newH < 0.1 Then newH = 0.1
                If newH > 5000 Then newH = 5000
                shp.Height = newH
                changes.Add "Height→" & CStr(newH)
            End If
        End If
        results.Add "缩放 [" & shp.Name & "] " & JoinCollection(changes, ", ")
    Next shp
    HandleResizeShape = JoinCollection(results, "; ")
End Function

Private Function HandleDeleteShape(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shapeNames As Collection
    Dim results As Collection
    Dim shp As Shape
    Dim i As Long

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then
        Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"
    End If

    Set shapeNames = New Collection
    For Each shp In shapes
        shapeNames.Add shp.Name
    Next shp

    Set results = New Collection
    For i = shapes.Count To 1 Step -1
        results.Add "删除 [" & shapeNames(i) & "]"
        shapes(i).Delete
    Next i
    HandleDeleteShape = JoinCollection(results, "; ")
End Function

Private Function HandleSetZOrder(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim position As Variant

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then
        Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"
    End If

    position = ResolveZOrder(actionObj("params")("position"))
    Set results = New Collection
    For Each shp In shapes
        shp.ZOrder position
        results.Add "Z-order [" & shp.Name & "] -> " & CStr(actionObj("params")("position"))
    Next shp
    HandleSetZOrder = JoinCollection(results, "; ")
End Function

Private Function HandleAddTextbox(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    Dim params As Object
    Dim shp As Shape
    Dim textValue As String

    slideIndex = CLng(actionObj("slide"))
    Set params = actionObj("params")
    textValue = CStr(params("text"))

    Set shp = ActivePresentation.Slides(slideIndex).Shapes.AddTextbox( _
        1, _
        GetOptionalDouble(params, "left", 100), _
        GetOptionalDouble(params, "top", 100), _
        GetOptionalDouble(params, "width", 300), _
        GetOptionalDouble(params, "height", 50) _
    )
    shp.TextFrame.TextRange.Text = textValue

    If ExistsKey(params, "fill_color") Then
        shp.Fill.Solid
        shp.Fill.ForeColor.RGB = ClampColor(CLng(params("fill_color")))
    End If
    If ExistsKey(params, "font_size") Then
        Dim tbFontSize As Double
        tbFontSize = CDbl(params("font_size"))
        If tbFontSize < 1 Then tbFontSize = 1
        If tbFontSize > 400 Then tbFontSize = 400
        shp.TextFrame.TextRange.Font.Size = CLng(tbFontSize)
    End If
    If ExistsKey(params, "font_color") Then
        shp.TextFrame.TextRange.Font.Color.RGB = ClampColor(CLng(params("font_color")))
    End If

    HandleAddTextbox = "第" & slideIndex & "页添加文本框: '" & Left$(textValue, 30) & "'"
End Function

Private Function HandleAddShape(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    Dim params As Object
    Dim shp As Shape
    Dim shapeType As Long
    Dim leftValue As Double
    Dim topValue As Double

    slideIndex = CLng(actionObj("slide"))
    Set params = actionObj("params")
    shapeType = GetOptionalLong(params, "shape_type", 1)
    leftValue = GetOptionalDouble(params, "left", 100)
    topValue = GetOptionalDouble(params, "top", 100)

    Set shp = ActivePresentation.Slides(slideIndex).Shapes.AddShape( _
        shapeType, _
        leftValue, _
        topValue, _
        GetOptionalDouble(params, "width", 300), _
        GetOptionalDouble(params, "height", 200) _
    )

    If ExistsKey(params, "fill_color") Then
        shp.Fill.Solid
        shp.Fill.ForeColor.RGB = ClampColor(CLng(params("fill_color")))
    End If
    If ExistsKey(params, "line_visible") Then
        shp.Line.Visible = CBool(params("line_visible"))
    End If

    HandleAddShape = "第" & slideIndex & "页添加形状: type=" & shapeType & " at (" & leftValue & "," & topValue & ")"
End Function

Private Function HandleAddPicture(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    Dim params As Object
    Dim picPath As String

    slideIndex = CLng(actionObj("slide"))
    Set params = actionObj("params")
    picPath = CStr(params("pic_path"))

    ActivePresentation.Slides(slideIndex).Shapes.AddPicture _
        picPath, False, True, _
        GetOptionalDouble(params, "left", 100), _
        GetOptionalDouble(params, "top", 100), _
        GetOptionalDouble(params, "width", 200), _
        GetOptionalDouble(params, "height", 150)

    HandleAddPicture = "第" & slideIndex & "页插入图片: " & picPath
End Function

Private Function HandleAddTable(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    Dim params As Object
    Dim rowsCount As Long
    Dim colsCount As Long

    slideIndex = CLng(actionObj("slide"))
    Set params = actionObj("params")
    rowsCount = CLng(params("rows"))
    colsCount = CLng(params("cols"))

    ActivePresentation.Slides(slideIndex).Shapes.AddTable _
        rowsCount, colsCount, _
        GetOptionalDouble(params, "left", 100), _
        GetOptionalDouble(params, "top", 100), _
        GetOptionalDouble(params, "width", 400), _
        GetOptionalDouble(params, "height", 200)

    HandleAddTable = "Added " & rowsCount & "x" & colsCount & " table on slide " & slideIndex
End Function

Private Function HandleSetSlideBackground(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    Dim colorValue As Long
    Dim sld As Slide

    slideIndex = CLng(actionObj("slide"))
    colorValue = CLng(actionObj("params")("color_bgr"))
    Set sld = ActivePresentation.Slides(slideIndex)

    sld.FollowMasterBackground = msoFalse
    sld.Background.Fill.Solid
    sld.Background.Fill.ForeColor.RGB = ClampColor(colorValue)
    HandleSetSlideBackground = "第" & slideIndex & "页背景 → " & ToHexColor(colorValue)
End Function

Private Function HandleSetSlideBackgroundImage(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    Dim imagePath As String
    Dim sld As Slide

    slideIndex = CLng(actionObj("slide"))
    imagePath = CStr(actionObj("params")("image_path"))
    Set sld = ActivePresentation.Slides(slideIndex)

    sld.FollowMasterBackground = msoFalse
    sld.Background.Fill.UserPicture imagePath
    HandleSetSlideBackgroundImage = "Slide " & slideIndex & " background set to " & imagePath
End Function

Private Function HandleModifyCell(ByVal actionObj As Object) As String
    Dim tableShape As Shape
    Dim tableObj As Table
    Dim rowIdx As Long
    Dim colIdx As Long
    Dim oldText As String
    Dim newText As String

    Set tableShape = FindTableShape(CLng(actionObj("slide")), actionObj("target"))
    If tableShape Is Nothing Then
        Err.Raise vbObjectError + 2051, "PptEditorBridge", "第" & actionObj("slide") & "页未找到表格"
    End If

    rowIdx = CLng(actionObj("params")("row"))
    colIdx = CLng(actionObj("params")("col"))
    newText = CStr(actionObj("params")("text"))
    Set tableObj = tableShape.Table
    oldText = tableObj.Cell(rowIdx, colIdx).Shape.TextFrame.TextRange.Text
    tableObj.Cell(rowIdx, colIdx).Shape.TextFrame.TextRange.Text = newText
    HandleModifyCell = "表格(" & rowIdx & "," & colIdx & "): '" & Left$(oldText, 20) & "' → '" & Left$(newText, 20) & "'"
End Function

Private Function HandleTableRowAdd(ByVal actionObj As Object) As String
    Dim tableShape As Shape
    Set tableShape = FindTableShape(CLng(actionObj("slide")), actionObj("target"))
    If tableShape Is Nothing Then Err.Raise vbObjectError + 2051, "PptEditorBridge", "未找到表格"
    tableShape.Table.Rows.Add
    HandleTableRowAdd = "表格添加一行 (共" & tableShape.Table.Rows.Count & "行)"
End Function

Private Function HandleTableRowDelete(ByVal actionObj As Object) As String
    Dim tableShape As Shape
    Dim rowIdx As Long
    Set tableShape = FindTableShape(CLng(actionObj("slide")), actionObj("target"))
    If tableShape Is Nothing Then Err.Raise vbObjectError + 2051, "PptEditorBridge", "未找到表格"
    rowIdx = CLng(actionObj("params")("row"))
    tableShape.Table.Rows(rowIdx).Delete
    HandleTableRowDelete = "表格删除第" & rowIdx & "行"
End Function

Private Function HandleTableColAdd(ByVal actionObj As Object) As String
    Dim tableShape As Shape
    Set tableShape = FindTableShape(CLng(actionObj("slide")), actionObj("target"))
    If tableShape Is Nothing Then Err.Raise vbObjectError + 2051, "PptEditorBridge", "未找到表格"
    tableShape.Table.Columns.Add
    HandleTableColAdd = "表格添加一列 (共" & tableShape.Table.Columns.Count & "列)"
End Function

Private Function HandleTableColDelete(ByVal actionObj As Object) As String
    Dim tableShape As Shape
    Dim colIdx As Long
    Set tableShape = FindTableShape(CLng(actionObj("slide")), actionObj("target"))
    If tableShape Is Nothing Then Err.Raise vbObjectError + 2051, "PptEditorBridge", "未找到表格"
    colIdx = CLng(actionObj("params")("col"))
    tableShape.Table.Columns(colIdx).Delete
    HandleTableColDelete = "表格删除第" & colIdx & "列"
End Function

Private Function HandleAnimation(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim effectId As Long
    Dim slideIndex As Long

    slideIndex = CLng(actionObj("slide"))
    Set shapes = FindShapes(slideIndex, actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"
    effectId = ResolveAnimationEffect(GetOptionalString(actionObj("params"), "effect", "appear"))
    Set results = New Collection
    For Each shp In shapes
        ActivePresentation.Slides(slideIndex).TimeLine.MainSequence.AddEffect _
            Shape:=shp, effectId:=effectId, trigger:=1
        results.Add "动画 [" & shp.Name & "] → " & GetOptionalString(actionObj("params"), "effect", "appear")
    Next shp
    HandleAnimation = JoinCollection(results, "; ")
End Function

Private Function HandleRemoveAnimation(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    Dim seq As Sequence
    Dim animIndex As Long

    slideIndex = CLng(actionObj("slide"))
    Set seq = ActivePresentation.Slides(slideIndex).TimeLine.MainSequence
    animIndex = GetOptionalLong(actionObj("params"), "anim_index", 1)
    If animIndex <= seq.Count Then
        seq.Item(animIndex).Delete
        HandleRemoveAnimation = "第" & slideIndex & "页删除第" & animIndex & "个动画"
    Else
        HandleRemoveAnimation = "第" & slideIndex & "页无第" & animIndex & "个动画"
    End If
End Function

Private Function HandleModifyAnimationEffect(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    Dim animIndex As Long
    Dim newEffect As String
    Dim seq As Sequence

    slideIndex = CLng(actionObj("slide"))
    animIndex = CLng(actionObj("params")("anim_index"))
    newEffect = CStr(actionObj("params")("effect"))
    Set seq = ActivePresentation.Slides(slideIndex).TimeLine.MainSequence
    If animIndex > seq.Count Then Err.Raise vbObjectError + 2052, "PptEditorBridge", "动画索引不存在"
    seq.Item(animIndex).EffectType = ResolveAnimationEffect(newEffect)
    HandleModifyAnimationEffect = "第" & slideIndex & "页第" & animIndex & "个动画效果 → " & newEffect
End Function

Private Function HandleTransition(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    Dim trans As String
    Dim sld As Slide

    slideIndex = CLng(actionObj("slide"))
    trans = GetOptionalString(actionObj("params"), "transition", "fade")
    Set sld = ActivePresentation.Slides(slideIndex)
    sld.SlideShowTransition.EntryEffect = ResolveTransitionEffect(trans)
    If ExistsKey(actionObj("params"), "duration") Then
        sld.SlideShowTransition.Duration = CDbl(actionObj("params")("duration"))
    End If
    HandleTransition = "第" & slideIndex & "页切换效果: " & trans
End Function

Private Function HandleSleep(ByVal actionObj As Object) As String
    Dim seconds As Double
    Dim startTime As Single

    seconds = CDbl(actionObj("params")("seconds"))
    startTime = Timer
    Do While Timer - startTime < seconds
        DoEvents
    Loop
    HandleSleep = "等待 " & seconds & "s"
End Function

Private Function HandleSetShadow(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim preset As Long

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"

    preset = GetOptionalLong(actionObj("params"), "preset", 1)
    Set results = New Collection
    For Each shp In shapes
        On Error Resume Next
        If preset > 0 Then
            shp.Shadow.Type = 1
            shp.Shadow.Style = preset
            shp.Shadow.Visible = msoTrue
        Else
            shp.Shadow.Visible = msoFalse
        End If
        If Err.Number <> 0 Then
            Err.Clear
            results.Add "Shadow not supported on [" & shp.Name & "]"
        Else
            results.Add "Shadow preset " & preset & " set on [" & shp.Name & "]"
        End If
        On Error GoTo 0
    Next shp
    HandleSetShadow = JoinCollection(results, "; ")
End Function

Private Function HandleSetReflection(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim preset As Long

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"

    preset = GetOptionalLong(actionObj("params"), "preset", 1)
    Set results = New Collection
    For Each shp In shapes
        On Error Resume Next
        shp.Reflection.Type = preset
        If Err.Number <> 0 Then
            Err.Clear
            results.Add "Reflection not supported on [" & shp.Name & "]"
        Else
            results.Add "Reflection preset " & preset & " set on [" & shp.Name & "]"
        End If
        On Error GoTo 0
    Next shp
    HandleSetReflection = JoinCollection(results, "; ")
End Function

Private Function HandleSetGlow(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim colorValue As Long
    Dim radius As Double
    Dim hasColor As Boolean

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"

    hasColor = ExistsKey(actionObj("params"), "color_bgr")
    If hasColor Then
        colorValue = CLng(actionObj("params")("color_bgr"))
    Else
        colorValue = CLng(16776960)  ' default: cyan (#00FFFF in BGR = 16776960)
    End If
    radius = GetOptionalDouble(actionObj("params"), "radius", 10)
    Set results = New Collection
    For Each shp In shapes
        On Error Resume Next
        shp.Glow.Color.RGB = ClampColor(colorValue)
        shp.Glow.radius = radius
        If Err.Number <> 0 Then
            Err.Clear
            results.Add "Glow not supported on [" & shp.Name & "]"
        Else
            results.Add "Glow set on [" & shp.Name & "] color=" & ToHexColor(colorValue) & " radius=" & radius
        End If
        On Error GoTo 0
    Next shp
    HandleSetGlow = JoinCollection(results, "; ")
End Function

Private Function HandleSet3DRotation(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim xVal As Double
    Dim yVal As Double
    Dim zVal As Double

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"

    xVal = GetOptionalDouble(actionObj("params"), "x", 0)
    yVal = GetOptionalDouble(actionObj("params"), "y", 0)
    zVal = GetOptionalDouble(actionObj("params"), "z", 0)
    Set results = New Collection
    For Each shp In shapes
        On Error Resume Next
        shp.ThreeD.RotationX = xVal
        shp.ThreeD.RotationY = yVal
        shp.ThreeD.RotationZ = zVal
        If Err.Number <> 0 Then
            Err.Clear
            results.Add "3D rotation not supported on [" & shp.Name & "]"
        Else
            results.Add "3D rotation [" & shp.Name & "] x=" & xVal & " y=" & yVal & " z=" & zVal
        End If
        On Error GoTo 0
    Next shp
    HandleSet3DRotation = JoinCollection(results, "; ")
End Function

' ---------------------------------------------------------------------------
' Shape Transform handlers
' ---------------------------------------------------------------------------
Private Function HandleRotateShape(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim angle As Double

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"

    angle = CDbl(actionObj("params")("angle"))
    Set results = New Collection
    For Each shp In shapes
        shp.Rotation = angle
        results.Add "Rotated [" & shp.Name & "] to " & angle & " degrees"
    Next shp
    HandleRotateShape = JoinCollection(results, "; ")
End Function

Private Function HandleFlipShape(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim direction As String
    Dim flipVal As Long

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"

    direction = GetOptionalString(actionObj("params"), "direction", "horizontal")
    If LCase$(direction) = "vertical" Then
        flipVal = 1  ' msoFlipVertical
    Else
        flipVal = 0  ' msoFlipHorizontal
    End If

    Set results = New Collection
    For Each shp In shapes
        shp.Flip flipVal
        results.Add "Flipped [" & shp.Name & "] " & direction
    Next shp
    HandleFlipShape = JoinCollection(results, "; ")
End Function

' ---------------------------------------------------------------------------
' Picture handlers
' ---------------------------------------------------------------------------
Private Function HandleCropPicture(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim params As Object
    Dim l As Double, t As Double, r As Double, b As Double

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"
    Set params = actionObj("params")

    l = GetOptionalDouble(params, "left", 0)
    t = GetOptionalDouble(params, "top", 0)
    r = GetOptionalDouble(params, "right", 0)
    b = GetOptionalDouble(params, "bottom", 0)

    Set results = New Collection
    For Each shp In shapes
        On Error Resume Next
        shp.PictureFormat.CropLeft = l
        shp.PictureFormat.CropTop = t
        shp.PictureFormat.CropRight = r
        shp.PictureFormat.CropBottom = b
        If Err.Number <> 0 Then
            Err.Clear
            results.Add "Crop not supported on [" & shp.Name & "]"
        Else
            results.Add "Cropped [" & shp.Name & "] L=" & l & " T=" & t & " R=" & r & " B=" & b
        End If
        On Error GoTo 0
    Next shp
    HandleCropPicture = JoinCollection(results, "; ")
End Function

Private Function HandleSetBrightness(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim val As Double

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"

    val = CDbl(actionObj("params")("value"))
    Set results = New Collection
    For Each shp In shapes
        On Error Resume Next
        shp.PictureFormat.Brightness = val
        If Err.Number <> 0 Then
            Err.Clear
            results.Add "Brightness not supported on [" & shp.Name & "]"
        Else
            results.Add "Brightness [" & shp.Name & "] -> " & val
        End If
        On Error GoTo 0
    Next shp
    HandleSetBrightness = JoinCollection(results, "; ")
End Function

Private Function HandleSetContrast(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim val As Double

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"

    val = CDbl(actionObj("params")("value"))
    Set results = New Collection
    For Each shp In shapes
        On Error Resume Next
        shp.PictureFormat.Contrast = val
        If Err.Number <> 0 Then
            Err.Clear
            results.Add "Contrast not supported on [" & shp.Name & "]"
        Else
            results.Add "Contrast [" & shp.Name & "] -> " & val
        End If
        On Error GoTo 0
    Next shp
    HandleSetContrast = JoinCollection(results, "; ")
End Function

Private Function HandleReplacePicture(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    Dim shp As Shape
    Dim newPath As String
    Dim l As Double, t As Double, w As Double, h As Double
    Dim sld As Slide

    slideIndex = CLng(actionObj("slide"))
    Set shp = FindFirstShape(slideIndex, actionObj("target"))
    If shp Is Nothing Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"

    newPath = CStr(actionObj("params")("new_path"))
    l = shp.Left: t = shp.Top: w = shp.Width: h = shp.Height
    Set sld = ActivePresentation.Slides(slideIndex)
    shp.Delete
    sld.Shapes.AddPicture newPath, msoFalse, msoTrue, l, t, w, h
    HandleReplacePicture = "Replaced picture on slide " & slideIndex
End Function

' ---------------------------------------------------------------------------
' Text enhancement handlers
' ---------------------------------------------------------------------------
Private Function HandleSetLineSpacing(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim spacing As Double
    Dim pi As Long

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"

    spacing = CDbl(actionObj("params")("spacing"))
    Set results = New Collection
    For Each shp In shapes
        For pi = 1 To shp.TextFrame.TextRange.Paragraphs().Count
            shp.TextFrame.TextRange.Paragraphs(pi).ParagraphFormat.SpaceWithin = spacing
        Next pi
        results.Add "Line spacing [" & shp.Name & "] -> " & spacing
    Next shp
    HandleSetLineSpacing = JoinCollection(results, "; ")
End Function

Private Function HandleSetParagraphSpacing(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim params As Object
    Dim bef As Double, aft As Double
    Dim pi As Long

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"

    Set params = actionObj("params")
    bef = GetOptionalDouble(params, "before", 0)
    aft = GetOptionalDouble(params, "after", 0)
    Set results = New Collection
    For Each shp In shapes
        For pi = 1 To shp.TextFrame.TextRange.Paragraphs().Count
            shp.TextFrame.TextRange.Paragraphs(pi).ParagraphFormat.SpaceBefore = bef
            shp.TextFrame.TextRange.Paragraphs(pi).ParagraphFormat.SpaceAfter = aft
        Next pi
        results.Add "Paragraph spacing [" & shp.Name & "] before=" & bef & " after=" & aft
    Next shp
    HandleSetParagraphSpacing = JoinCollection(results, "; ")
End Function

Private Function HandleSetTextAutofit(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim mode As String
    Dim modeVal As Long

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"

    mode = CStr(actionObj("params")("mode"))
    Select Case LCase$(mode)
        Case "fit": modeVal = 1  ' ppAutoSizeShapeToFitText
        Case "shrink": modeVal = 2  ' ppAutoSizeMixed
        Case Else: modeVal = 0  ' ppAutoSizeNone
    End Select

    Set results = New Collection
    For Each shp In shapes
        shp.TextFrame.AutoSize = modeVal
        results.Add "Text autofit [" & shp.Name & "] -> " & mode
    Next shp
    HandleSetTextAutofit = JoinCollection(results, "; ")
End Function

Private Function HandleAddBullet(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim level As Long
    Dim cnt As Long

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"

    level = GetOptionalLong(actionObj("params"), "level", 1)
    Set results = New Collection
    For Each shp In shapes
        cnt = shp.TextFrame.TextRange.Paragraphs().Count
        shp.TextFrame.TextRange.Paragraphs(cnt).IndentLevel = level
        results.Add "Bullet level " & level & " set on [" & shp.Name & "]"
    Next shp
    HandleAddBullet = JoinCollection(results, "; ")
End Function

Private Function HandleAddHyperlink(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim params As Object
    Dim url As String

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"

    Set params = actionObj("params")
    url = CStr(params("url"))
    Set results = New Collection
    For Each shp In shapes
        If ExistsKey(params, "text") Then
            shp.TextFrame.TextRange.Text = CStr(params("text"))
        End If
        shp.TextFrame.TextRange.ActionSettings(1).Hyperlink.Address = url  ' ppMouseClick=1
        results.Add "Hyperlink added to [" & shp.Name & "]: " & url
    Next shp
    HandleAddHyperlink = JoinCollection(results, "; ")
End Function

Private Function HandleSetWordArt(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim style As Long

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"

    style = CLng(actionObj("params")("style"))
    Set results = New Collection
    For Each shp In shapes
        On Error Resume Next
        shp.TextFrame.TextRange.Font.WordArt = True
        shp.TextEffect.PresetTextEffect = style
        If Err.Number <> 0 Then
            Err.Clear
            results.Add "WordArt not supported on [" & shp.Name & "]"
        Else
            results.Add "WordArt style " & style & " set on [" & shp.Name & "]"
        End If
        On Error GoTo 0
    Next shp
    HandleSetWordArt = JoinCollection(results, "; ")
End Function

' ---------------------------------------------------------------------------
' Media playback handler
' ---------------------------------------------------------------------------
Private Function HandleSetMediaPlayback(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim params As Object
    Dim autoPlay As Boolean, loopMedia As Boolean, hideStop As Boolean

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"

    Set params = actionObj("params")
    autoPlay = GetOptionalBool(params, "auto_play", False)
    loopMedia = GetOptionalBool(params, "loop", False)
    hideStop = GetOptionalBool(params, "hide_on_stop", False)

    Set results = New Collection
    For Each shp In shapes
        On Error Resume Next
        shp.AnimationSettings.PlaySettings.PlayOnEntry = autoPlay
        shp.AnimationSettings.PlaySettings.LoopUntilStopped = loopMedia
        shp.AnimationSettings.PlaySettings.HideWhileNotPlaying = hideStop
        If Err.Number <> 0 Then
            Err.Clear
            results.Add "Media playback not supported on [" & shp.Name & "]"
        Else
            results.Add "Media playback [" & shp.Name & "] auto=" & autoPlay & " loop=" & loopMedia & " hide=" & hideStop
        End If
        On Error GoTo 0
    Next shp
    HandleSetMediaPlayback = JoinCollection(results, "; ")
End Function

' ---------------------------------------------------------------------------
' Chart handlers
' ---------------------------------------------------------------------------
Private Function HandleSetChartTitle(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim title As String

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"

    title = CStr(actionObj("params")("title"))
    Set results = New Collection
    For Each shp In shapes
        On Error Resume Next
        shp.Chart.HasTitle = True
        shp.Chart.ChartTitle.Text = title
        If Err.Number <> 0 Then
            Err.Clear
            results.Add "Chart title not supported on [" & shp.Name & "]"
        Else
            results.Add "Chart title set to '" & title & "'"
        End If
        On Error GoTo 0
    Next shp
    HandleSetChartTitle = JoinCollection(results, "; ")
End Function

Private Function HandleSetChartStyle(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim styleId As Long

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"

    styleId = CLng(actionObj("params")("style_id"))
    Set results = New Collection
    For Each shp In shapes
        On Error Resume Next
        shp.Chart.ChartStyle = styleId
        If Err.Number <> 0 Then
            Err.Clear
            results.Add "Chart style not supported on [" & shp.Name & "]"
        Else
            results.Add "Chart style set to " & styleId
        End If
        On Error GoTo 0
    Next shp
    HandleSetChartStyle = JoinCollection(results, "; ")
End Function

Private Function HandleModifyChartData(ByVal actionObj As Object) As String
    Dim shapes As Collection
    Dim shp As Shape
    Dim results As Collection
    Dim seriesIdx As Long
    Dim params As Object

    Set shapes = FindShapes(CLng(actionObj("slide")), actionObj("target"))
    If shapes.Count = 0 Then Err.Raise vbObjectError + 2050, "PptEditorBridge", "未找到匹配的 shape"

    Set params = actionObj("params")
    seriesIdx = CLng(params("series_idx"))
    Set results = New Collection
    For Each shp In shapes
        On Error Resume Next
        Dim vals As Object
        Set vals = params("values")
        ' Convert Collection to array for SeriesCollection.Values
        Dim arr() As Variant
        ReDim arr(1 To vals.Count)
        Dim vi As Long
        For vi = 1 To vals.Count
            arr(vi) = vals(vi)
        Next vi
        shp.Chart.SeriesCollection(seriesIdx).Values = arr
        If Err.Number <> 0 Then
            Err.Clear
            results.Add "Chart data update failed on [" & shp.Name & "]"
        Else
            results.Add "Chart series " & seriesIdx & " data updated"
        End If
        On Error GoTo 0
    Next shp
    HandleModifyChartData = JoinCollection(results, "; ")
End Function

Private Function HandleAddChart(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    Dim params As Object
    Dim chartType As Long
    Dim sld As Slide

    slideIndex = CLng(actionObj("slide"))
    Set params = actionObj("params")
    chartType = GetOptionalLong(params, "chart_type", 4)  ' xlLine=4
    Set sld = ActivePresentation.Slides(slideIndex)

    On Error Resume Next
    sld.Shapes.AddChart2 -1, chartType, _
        GetOptionalDouble(params, "left", 100), _
        GetOptionalDouble(params, "top", 100), _
        GetOptionalDouble(params, "width", 400), _
        GetOptionalDouble(params, "height", 300)
    If Err.Number <> 0 Then
        Err.Clear
        sld.Shapes.AddChart chartType, _
            GetOptionalDouble(params, "left", 100), _
            GetOptionalDouble(params, "top", 100), _
            GetOptionalDouble(params, "width", 400), _
            GetOptionalDouble(params, "height", 300)
    End If
    On Error GoTo 0
    HandleAddChart = "Chart added on slide " & slideIndex & " type=" & chartType
End Function

Private Function HandleAddSmartArt(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    Dim params As Object
    Dim layoutId As Long
    Dim sld As Slide

    slideIndex = CLng(actionObj("slide"))
    Set params = actionObj("params")
    layoutId = GetOptionalLong(params, "layout_id", 1)
    Set sld = ActivePresentation.Slides(slideIndex)

    On Error Resume Next
    Dim layout As Object
    Set layout = Application.SmartArtLayouts(layoutId)
    sld.Shapes.AddSmartArt layout, _
        GetOptionalDouble(params, "left", 100), _
        GetOptionalDouble(params, "top", 100), _
        GetOptionalDouble(params, "width", 400), _
        GetOptionalDouble(params, "height", 300)
    If Err.Number <> 0 Then
        Dim errMsg As String
        errMsg = Err.Description
        Err.Clear
        On Error GoTo 0
        HandleAddSmartArt = "SmartArt failed: " & errMsg
        Exit Function
    End If
    On Error GoTo 0
    HandleAddSmartArt = "SmartArt added on slide " & slideIndex
End Function

Private Function HandleAddFreeform(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    Dim params As Object
    Dim points As Object
    Dim sld As Slide
    Dim builder As Object
    Dim i As Long

    slideIndex = CLng(actionObj("slide"))
    Set params = actionObj("params")
    Set points = params("points")
    Set sld = ActivePresentation.Slides(slideIndex)

    If points.Count < 2 Then
        HandleAddFreeform = "Need at least 2 points"
        Exit Function
    End If

    ' points(1) is first [x, y] pair
    Set builder = sld.Shapes.BuildFreeform(0, CDbl(points(1)(1)), CDbl(points(1)(2)))  ' msoEditingAuto=0
    For i = 2 To points.Count
        builder.AddNodes 0, 0, CDbl(points(i)(1)), CDbl(points(i)(2))  ' msoSegmentLine=0, msoEditingAuto=0
    Next i
    builder.ConvertToShape
    HandleAddFreeform = "Freeform added on slide " & slideIndex & " with " & points.Count & " points"
End Function

Private Function HandleAddAudio(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    Dim params As Object
    Dim audioPath As String
    Dim sld As Slide

    slideIndex = CLng(actionObj("slide"))
    Set params = actionObj("params")
    audioPath = CStr(params("audio_path"))
    Set sld = ActivePresentation.Slides(slideIndex)

    sld.Shapes.AddMediaObject2 audioPath, msoFalse, msoTrue, _
        GetOptionalDouble(params, "left", 100), _
        GetOptionalDouble(params, "top", 100), _
        GetOptionalDouble(params, "width", 50), _
        GetOptionalDouble(params, "height", 50)
    HandleAddAudio = "Audio added on slide " & slideIndex & ": " & audioPath
End Function

Private Function HandleAddVideo(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    Dim params As Object
    Dim videoPath As String
    Dim sld As Slide

    slideIndex = CLng(actionObj("slide"))
    Set params = actionObj("params")
    videoPath = CStr(params("video_path"))
    Set sld = ActivePresentation.Slides(slideIndex)

    sld.Shapes.AddMediaObject2 videoPath, msoFalse, msoTrue, _
        GetOptionalDouble(params, "left", 100), _
        GetOptionalDouble(params, "top", 100), _
        GetOptionalDouble(params, "width", 400), _
        GetOptionalDouble(params, "height", 300)
    HandleAddVideo = "Video added on slide " & slideIndex & ": " & videoPath
End Function

' ---------------------------------------------------------------------------
' Slide management handlers
' ---------------------------------------------------------------------------
Private Function HandleSetSlideSize(ByVal actionObj As Object) As String
    Dim params As Object
    Set params = actionObj("params")
    ActivePresentation.PageSetup.SlideWidth = CDbl(params("width"))
    ActivePresentation.PageSetup.SlideHeight = CDbl(params("height"))
    HandleSetSlideSize = "Slide size set to " & params("width") & "x" & params("height")
End Function

Private Function HandleSetSlideSizePreset(ByVal actionObj As Object) As String
    Dim preset As String
    Dim presetVal As Long

    preset = CStr(actionObj("params")("preset"))
    Select Case LCase$(preset)
        Case "standard": presetVal = 0   ' ppSlideSizeOnScreen
        Case "letter": presetVal = 1     ' ppSlideSizeLetterPaper
        Case "a4": presetVal = 3         ' ppSlideSizeA4Paper
        Case "overhead": presetVal = 5   ' ppSlideSizeOverhead
        Case "banner": presetVal = 6     ' ppSlideSizeBanner
        Case "widescreen": presetVal = 8 ' ppSlideSizeOnScreen16x9
        Case Else: presetVal = CLng(preset)
    End Select
    ActivePresentation.PageSetup.SlideSize = presetVal
    HandleSetSlideSizePreset = "Slide size preset set to " & preset
End Function

Private Function HandleAddComment(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    Dim params As Object
    Dim sld As Slide

    slideIndex = CLng(actionObj("slide"))
    Set params = actionObj("params")
    Set sld = ActivePresentation.Slides(slideIndex)

    sld.Comments.Add _
        GetOptionalDouble(params, "x", 10), _
        GetOptionalDouble(params, "y", 10), _
        GetOptionalString(params, "author", "Author"), _
        "", _
        CStr(params("text"))
    HandleAddComment = "Comment added on slide " & slideIndex & " by " & GetOptionalString(params, "author", "Author")
End Function

Private Function HandleDeleteComment(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    Dim commentIdx As Long

    slideIndex = CLng(actionObj("slide"))
    commentIdx = CLng(actionObj("params")("comment_idx"))
    ActivePresentation.Slides(slideIndex).Comments(commentIdx).Delete
    HandleDeleteComment = "Deleted comment " & commentIdx & " on slide " & slideIndex
End Function

Private Function HandleAddSection(ByVal actionObj As Object) As String
    Dim params As Object
    Set params = actionObj("params")
    ActivePresentation.SectionProperties.AddSection CLng(params("slide_idx")), CStr(params("name"))
    HandleAddSection = "Section '" & params("name") & "' added at slide " & params("slide_idx")
End Function

Private Function HandleRenameSection(ByVal actionObj As Object) As String
    Dim params As Object
    Set params = actionObj("params")
    ActivePresentation.SectionProperties.Rename CLng(params("section_idx")), CStr(params("new_name"))
    HandleRenameSection = "Section " & params("section_idx") & " renamed to '" & params("new_name") & "'"
End Function

Private Function HandleDeleteSection(ByVal actionObj As Object) As String
    Dim sectionIdx As Long
    sectionIdx = CLng(actionObj("params")("section_idx"))
    ActivePresentation.SectionProperties.Delete sectionIdx, False
    HandleDeleteSection = "Section " & sectionIdx & " deleted"
End Function

' ---------------------------------------------------------------------------
' Export / slideshow / merge / print handlers
' ---------------------------------------------------------------------------
Private Function HandleExportImage(ByVal actionObj As Object) As String
    Dim slideIndex As Long
    Dim params As Object
    Dim outPath As String

    slideIndex = CLng(actionObj("slide"))
    Set params = actionObj("params")
    outPath = GetOptionalString(params, "output_path", "slide" & slideIndex & ".png")
    ActivePresentation.Slides(slideIndex).Export outPath, "PNG", _
        GetOptionalLong(params, "width", 1920), _
        GetOptionalLong(params, "height", 1080)
    HandleExportImage = "导出图片: " & outPath
End Function

Private Function HandleExportPdf(ByVal actionObj As Object) As String
    Dim pdfPath As String
    Dim params As Object
    Set params = actionObj("params")

    If ExistsKey(params, "output_path") Then
        pdfPath = CStr(params("output_path"))
    Else
        ' Derive from presentation name
        Dim prsName As String
        prsName = ActivePresentation.FullName
        If InStr(prsName, ".") > 0 Then
            pdfPath = Left$(prsName, InStrRev(prsName, ".") - 1) & ".pdf"
        Else
            pdfPath = prsName & ".pdf"
        End If
    End If
    ActivePresentation.SaveAs pdfPath, 32  ' ppSaveAsPDF=32
    HandleExportPdf = "导出 PDF: " & pdfPath
End Function

Private Function HandleSetSlideshowSettings(ByVal actionObj As Object) As String
    Dim params As Object
    Set params = actionObj("params")
    With ActivePresentation.SlideShowSettings
        .LoopUntilStopped = GetOptionalBool(params, "loop", False)
        .ShowWithNarration = GetOptionalBool(params, "show_narration", True)
        .ShowWithAnimation = GetOptionalBool(params, "show_animation", True)
    End With
    HandleSetSlideshowSettings = "Slideshow settings updated"
End Function

Private Function HandleStartSlideshow(ByVal actionObj As Object) As String
    Dim params As Object
    Set params = actionObj("params")
    With ActivePresentation.SlideShowSettings
        .StartingSlide = GetOptionalLong(params, "from_slide", 1)
        If ExistsKey(params, "to_slide") Then
            .EndingSlide = CLng(params("to_slide"))
        End If
        .Run
    End With
    HandleStartSlideshow = "Slideshow started from slide " & GetOptionalLong(params, "from_slide", 1)
End Function

Private Function HandleMergePresentations(ByVal actionObj As Object) As String
    Dim params As Object
    Dim filePaths As Object
    Dim i As Long
    Dim idx As Long

    Set params = actionObj("params")
    Set filePaths = params("file_paths")

    For i = 1 To filePaths.Count
        idx = ActivePresentation.Slides.Count
        ActivePresentation.Slides.InsertFromFile CStr(filePaths(i)), idx
    Next i
    HandleMergePresentations = "Merged " & filePaths.Count & " presentations"
End Function

Private Function HandlePrintPresentation(ByVal actionObj As Object) As String
    Dim params As Object
    Set params = actionObj("params")

    If ExistsKey(params, "printer_name") Then
        Application.ActivePrinter = CStr(params("printer_name"))
    End If

    If ExistsKey(params, "print_range") Then
        Dim pr As Object
        Set pr = params("print_range")
        ActivePresentation.PrintOptions.RangeType = 4  ' ppPrintSlideRange
        ActivePresentation.PrintOptions.Ranges.Add CLng(pr(1)), CLng(pr(2))
    End If

    ActivePresentation.PrintOut Copies:=GetOptionalLong(params, "copies", 1)
    HandlePrintPresentation = "Printed " & GetOptionalLong(params, "copies", 1) & " copies"
End Function

Private Function FindFirstShape(ByVal slideIndex As Long, ByVal target As Object) As Shape
    Dim matches As Collection
    Set matches = FindShapes(slideIndex, target)
    If matches.Count > 0 Then Set FindFirstShape = matches(1)
End Function

Private Function FindTableShape(ByVal slideIndex As Long, ByVal target As Object) As Shape
    Dim tableTarget As Object
    If target Is Nothing Then
        Set tableTarget = CreateObject("Scripting.Dictionary")
        tableTarget("type") = "table"
        Set FindTableShape = FindFirstShape(slideIndex, tableTarget)
    Else
        Set FindTableShape = FindFirstShape(slideIndex, target)
    End If
End Function

Private Function FindShapes(ByVal slideIndex As Long, ByVal target As Object) As Collection
    Dim shp As Shape
    Dim shapeIndex As Long
    Dim hits As Collection

    Set hits = New Collection
    shapeIndex = 0
    For Each shp In ActivePresentation.Slides(slideIndex).Shapes
        shapeIndex = shapeIndex + 1
        If MatchShape(shp, shapeIndex, target) Then
            hits.Add shp
        End If
    Next shp
    Set FindShapes = hits
End Function

Private Function MatchShape(ByVal shp As Shape, ByVal shapeIndex As Long, ByVal target As Object) As Boolean
    MatchShape = True
    If target Is Nothing Then Exit Function

    If ExistsKey(target, "type") Then
        MatchShape = MatchShapeType(shp, LCase$(CStr(target("type"))))
        If Not MatchShape Then Exit Function
    End If

    If ExistsKey(target, "text_match") Then
        MatchShape = (InStr(1, GetShapeText(shp), CStr(target("text_match")), vbTextCompare) > 0)
        If Not MatchShape Then Exit Function
    End If

    If ExistsKey(target, "name") Then
        MatchShape = (InStr(1, shp.Name, CStr(target("name")), vbTextCompare) > 0)
        If Not MatchShape Then Exit Function
    End If

    If ExistsKey(target, "position") Then
        MatchShape = (BuildPositionLabel(shp.Left + shp.Width / 2, shp.Top + shp.Height / 2, _
                      ActivePresentation.PageSetup.SlideWidth, ActivePresentation.PageSetup.SlideHeight) = CStr(target("position")))
        If Not MatchShape Then Exit Function
    End If

    If ExistsKey(target, "index") Then
        MatchShape = (shapeIndex = CLng(target("index")))
    End If
End Function

Private Function MatchShapeType(ByVal shp As Shape, ByVal targetType As String) As Boolean
    On Error Resume Next
    Select Case targetType
        Case "title"
            MatchShapeType = (shp.PlaceholderFormat.Type = 1 Or shp.PlaceholderFormat.Type = 3)
        Case "subtitle"
            MatchShapeType = (shp.PlaceholderFormat.Type = 4)
        Case "body"
            MatchShapeType = (shp.PlaceholderFormat.Type = 2 Or shp.PlaceholderFormat.Type = 7)
        Case "picture"
            MatchShapeType = (CLng(shp.Type) = 13)
        Case "chart"
            MatchShapeType = CBool(shp.HasChart)
        Case "textbox"
            MatchShapeType = (CLng(shp.Type) = 17)
        Case "table"
            MatchShapeType = CBool(shp.HasTable)
        Case Else
            MatchShapeType = False
    End Select
    If Err.Number <> 0 Then
        MatchShapeType = False
        Err.Clear
    End If
    On Error GoTo 0
End Function

Private Function ExistsKey(ByVal dict As Object, ByVal key As String) As Boolean
    On Error Resume Next
    ExistsKey = dict.Exists(key)
    If Err.Number <> 0 Then
        ExistsKey = False
        Err.Clear
    End If
    On Error GoTo 0
End Function

Private Function GetOptionalString(ByVal dict As Object, ByVal key As String, ByVal defaultValue As String) As String
    If ExistsKey(dict, key) Then
        GetOptionalString = CStr(dict(key))
    Else
        GetOptionalString = defaultValue
    End If
End Function

Private Function GetOptionalLong(ByVal dict As Object, ByVal key As String, ByVal defaultValue As Long) As Long
    If ExistsKey(dict, key) Then
        GetOptionalLong = CLng(dict(key))
    Else
        GetOptionalLong = defaultValue
    End If
End Function

Private Function GetOptionalDouble(ByVal dict As Object, ByVal key As String, ByVal defaultValue As Double) As Double
    If ExistsKey(dict, key) Then
        GetOptionalDouble = CDbl(dict(key))
    Else
        GetOptionalDouble = defaultValue
    End If
End Function

Private Function GetOptionalBool(ByVal dict As Object, ByVal key As String, ByVal defaultValue As Boolean) As Boolean
    If ExistsKey(dict, key) Then
        GetOptionalBool = CBool(dict(key))
    Else
        GetOptionalBool = defaultValue
    End If
End Function

Private Function JoinCollection(ByVal values As Collection, Optional ByVal separator As String = ", ") As String
    Dim i As Long
    For i = 1 To values.Count
        If i > 1 Then JoinCollection = JoinCollection & separator
        JoinCollection = JoinCollection & CStr(values(i))
    Next i
End Function

Private Function ClampColor(ByVal c As Long) As Long
    If c < 0 Then c = 0
    If c > 16777215 Then c = 16777215
    ClampColor = c
End Function

Private Function ToHexColor(ByVal value As Long) As String
    ToHexColor = "0x" & Right$("000000" & Hex$(value), 6)
End Function

Private Function ApplyModifyFont(ByVal shp As Shape, ByVal params As Object) As String
    Dim tr As TextRange
    Dim changes As Collection
    Dim oldSize As Double
    Dim newSize As Double

    Set tr = shp.TextFrame.TextRange
    Set changes = New Collection

    If ExistsKey(params, "font_size") Then
        Dim fontSize As Double
        fontSize = CDbl(params("font_size"))
        If fontSize < 1 Then fontSize = 1
        If fontSize > 400 Then fontSize = 400
        fontSize = CLng(fontSize)
        tr.Font.Size = fontSize
        changes.Add "字号→" & CStr(fontSize)
    End If

    If ExistsKey(params, "font_size_factor") Then
        oldSize = tr.Font.Size
        If oldSize > 0 Then
            newSize = Round(oldSize * CDbl(params("font_size_factor")), 1)
            If newSize < 1 Then newSize = 1
            If newSize > 400 Then newSize = 400
            tr.Font.Size = newSize
            changes.Add "字号 " & oldSize & "→" & newSize
        End If
    End If

    If ExistsKey(params, "bold") Then
        tr.Font.Bold = CBool(params("bold"))
        If CBool(params("bold")) Then
            changes.Add "加粗"
        Else
            changes.Add "取消加粗"
        End If
    End If
    If ExistsKey(params, "italic") Then
        tr.Font.Italic = CBool(params("italic"))
        If CBool(params("italic")) Then
            changes.Add "斜体"
        Else
            changes.Add "取消斜体"
        End If
    End If
    If ExistsKey(params, "underline") Then
        tr.Font.Underline = CBool(params("underline"))
        If CBool(params("underline")) Then
            changes.Add "下划线"
        Else
            changes.Add "取消下划线"
        End If
    End If
    If ExistsKey(params, "color") Then
        tr.Font.Color.RGB = ClampColor(CLng(params("color")))
        changes.Add "颜色→" & ToHexColor(CLng(params("color")))
    End If
    If ExistsKey(params, "font_name") Then
        tr.Font.Name = CStr(params("font_name"))
        changes.Add "字体→" & CStr(params("font_name"))
    End If

    ApplyModifyFont = JoinCollection(changes, ", ")
End Function

Private Function ApplyAlignment(ByVal shp As Shape, ByVal alignValue As Long, ByVal alignLabel As String) As String
    Dim pi As Long
    For pi = 1 To shp.TextFrame.TextRange.Paragraphs.Count
        shp.TextFrame.TextRange.Paragraphs(pi).ParagraphFormat.Alignment = alignValue
    Next pi
    ApplyAlignment = "对齐方式 → " & alignLabel
End Function

Private Function ResolveAlignment(ByVal align As Variant) As Long
    Dim key As String
    key = LCase$(CStr(align))
    Select Case key
        Case "左", "left"
            ResolveAlignment = 1
        Case "居中", "center"
            ResolveAlignment = 2
        Case "右", "right"
            ResolveAlignment = 3
        Case "两端", "justify"
            ResolveAlignment = 4
        Case Else
            ResolveAlignment = CLng(align)
    End Select
End Function

Private Function ResolveZOrder(ByVal position As Variant) As Long
    Dim key As String
    key = LCase$(CStr(position))
    Select Case key
        Case "front"
            ResolveZOrder = 0
        Case "back"
            ResolveZOrder = 1
        Case "forward"
            ResolveZOrder = 2
        Case "backward"
            ResolveZOrder = 3
        Case Else
            ResolveZOrder = CLng(position)
    End Select
End Function

Private Function ResolveAnimationEffect(ByVal effectName As String) As Long
    Select Case LCase$(effectName)
        Case "appear"
            ResolveAnimationEffect = 1
        Case "fly"
            ResolveAnimationEffect = 2
        Case "fade"
            ResolveAnimationEffect = 10
        Case "zoom"
            ResolveAnimationEffect = 53
        Case "bounce"
            ResolveAnimationEffect = 26
        Case Else
            ResolveAnimationEffect = 1
    End Select
End Function

Private Function ResolveTransitionEffect(ByVal transitionName As String) As Long
    ' Real PowerPoint ppEntryEffect constants (see pptx_editor_com.py set_transition).
    Select Case LCase$(transitionName)
        Case "fade"
            ResolveTransitionEffect = 3849
        Case "push"
            ResolveTransitionEffect = 3334
        Case "wipe"
            ResolveTransitionEffect = 769
        Case "split"
            ResolveTransitionEffect = 3073
        Case "dissolve"
            ResolveTransitionEffect = 1537
        Case "cut"
            ResolveTransitionEffect = 257
        Case "cover"
            ResolveTransitionEffect = 1025
        Case "uncover"
            ResolveTransitionEffect = 1793
        Case "random"
            ResolveTransitionEffect = 513
        Case "none"
            ResolveTransitionEffect = 0
        Case Else
            ResolveTransitionEffect = 2745
    End Select
End Function

Private Function PlaceholderTypeName(ByVal phType As Long) As String
    Select Case phType
        Case 1: PlaceholderTypeName = "TITLE"
        Case 2: PlaceholderTypeName = "BODY"
        Case 3: PlaceholderTypeName = "CENTER_TITLE"
        Case 4: PlaceholderTypeName = "SUBTITLE"
        Case 7: PlaceholderTypeName = "OBJECT"
        Case 8: PlaceholderTypeName = "CHART"
        Case 9: PlaceholderTypeName = "TABLE"
        Case 12: PlaceholderTypeName = "MEDIA"
        Case 13: PlaceholderTypeName = "SLIDE_NUMBER"
        Case 15: PlaceholderTypeName = "FOOTER"
        Case Else: PlaceholderTypeName = "(" & phType & ")"
    End Select
End Function

Public Function SetNotes(ByVal slideIndex As Long, ByVal noteText As String) As String
    On Error GoTo ErrHandler
    With ActivePresentation.Slides(slideIndex).NotesPage.Shapes.Placeholders(2).TextFrame.TextRange
        .Text = noteText
    End With
    SetNotes = "备注已更新"
    Exit Function

ErrHandler:
    SetNotes = BuildMacroErrorText("SetNotes", Err)
End Function

Public Function AppendNotes(ByVal slideIndex As Long, ByVal noteText As String, Optional ByVal separator As String = vbCrLf) As String
    On Error GoTo ErrHandler
    Dim currentText As String
    With ActivePresentation.Slides(slideIndex).NotesPage.Shapes.Placeholders(2).TextFrame.TextRange
        currentText = .Text
        If Len(currentText) > 0 Then
            .Text = currentText & separator & noteText
        Else
            .Text = noteText
        End If
    End With
    AppendNotes = "备注已追加"
    Exit Function

ErrHandler:
    AppendNotes = BuildMacroErrorText("AppendNotes", Err)
End Function

Private Function BuildMacroErrorJson(ByVal sourceName As String, ByVal errObj As ErrObject) As String
    BuildMacroErrorJson = "{""error"":""" & EscapeJsonString(BuildMacroErrorMessage(sourceName, errObj)) & """}"
End Function

Private Function BuildMacroErrorText(ByVal sourceName As String, ByVal errObj As ErrObject) As String
    BuildMacroErrorText = "__VBA_ERROR__:" & BuildMacroErrorMessage(sourceName, errObj)
End Function

Private Function BuildMacroErrorMessage(ByVal sourceName As String, ByVal errObj As ErrObject) As String
    Dim parts As Collection
    Set parts = New Collection

    parts.Add sourceName
    If Len(errObj.Source) > 0 Then parts.Add errObj.Source
    If errObj.Number <> 0 Then parts.Add "#" & CStr(errObj.Number)
    If Len(errObj.Description) > 0 Then
        parts.Add errObj.Description
    Else
        parts.Add "Unknown VBA error"
    End If

    BuildMacroErrorMessage = JoinCollection(parts, " | ")
End Function

Private Function EscapeJsonString(ByVal value As String) As String
    value = Replace(value, "\", "\\")
    value = Replace(value, """", "\""")
    value = Replace(value, vbCrLf, "\n")
    value = Replace(value, vbCr, "\n")
    value = Replace(value, vbLf, "\n")
    ' Strip control characters that break JSON
    Dim i As Long
    Dim ch As String
    Dim cleaned As String
    cleaned = ""
    For i = 1 To Len(value)
        ch = Mid$(value, i, 1)
        Select Case AscW(ch)
            Case 0 To 8, 11, 12, 14 To 31
                cleaned = cleaned & "\u" & Right$("0000" & Hex$(AscW(ch)), 4)
            Case Else
                cleaned = cleaned & ch
        End Select
    Next i
    EscapeJsonString = cleaned
End Function
