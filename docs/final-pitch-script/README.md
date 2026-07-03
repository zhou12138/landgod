# MCPHub / WorkIQ 终极演讲稿

本目录归档终极版 WorkIQ → MCPHub 产品 Pitch 的演讲材料。

## 文件

- `final-3min-product-pitch-cn.md` — 3 分钟中文产品 Pitch，可直接照读。
- `talking-points.md` — 精简讲述要点，适合临场复习。
- `qa.md` — 演讲后 Q&A 备答。

## 对应终极版 PPT

终极版 PPT/预览/COM JSON 位于：

```text
../workiq-origin-pitch-package/workiq-origin-pitch.html
../workiq-origin-pitch-package/workiq-origin-pitch-three-slides.png
../workiq-origin-pitch-package/current-architecture-workflows-com-operations.json
```

## 核心定位

```text
MCPHub Gateway / MCPHub Client
Cloud intelligence, local execution.
Gateway governs. Client executes. Activity proves.
```

## 术语约定

- `MCPHub Gateway`：云端控制面。
- `MCPHub Client`：用户设备上的本地执行端 / Worker Runtime。
- `Signed Call Dispatcher`：Gateway 内负责对 tool call 做签名、绑定和分发的模块。
- `Capability Catalog`：能力目录，Client 发布的用户级本地工具能力目录。
