# 超大 Markdown 文档体验：成熟编辑器的一手资料核对

本文只记录官方文档、官方源码或维护者一手说明。资料用于架构取舍，不把其他产品的阈值直接当作本项目默认值。

## 结论先行

成熟编辑器通常组合三层策略：

1. 保持完整的文本/文档模型，避免用截断内容替代真实数据。
2. 只把视口附近的内容挂载到 DOM 或执行高成本装饰。
3. 对超过预算的功能做明确、可逆的降级（语法高亮、折叠、全文高亮、图表、复杂布局等）。

视口渲染只限制编辑器视图本身的 DOM 成本，不会自动限制业务派生计算。如果每次输入仍然对完整 Markdown 做 AST、HTML、Mermaid、数学公式或目录重算，DOM 虚拟化也无法保证实时响应。任何替换块的窗口化还必须维护块高度、滚动锚点、选择位置、查找、复制、打印和无障碍语义；不能把 Markdown 字符串简单裁成可见片段。

## VS Code / Monaco

VS Code 的大文件优化是按多个维度和功能成本做决策。当前 `TextModel` 源码定义了 `20 * 1024 * 1024` 的文本长度阈值、`300 * 1000` 行阈值，以及 `256 * 1024 * 1024` 的 heap-operation 阈值；这里的长度来自 `getValueLengthInRange`，是 text buffer 的值长度（JavaScript/模型使用的 UTF-16 code-unit 计数），不是磁盘上的 UTF-8 文件字节数。创建模型时若启用 `largeFileOptimizations`，文本长度超过阈值或行数超过阈值就永久标记为过大，之后不再 tokenization。这个决定发生在模型构造时，不会因为文档后来增长而自动切换。

- [textModel.ts（当前源码）](https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/model/textModel.ts)
- [textModel.ts（commit 227803b，常量）](https://github.com/microsoft/vscode/blob/227803b34283533344c393fd854a6fbcfe97a158/src/vs/editor/common/model/textModel.ts#L176-L180)
- [textModel.ts（commit 227803b，构造时条件）](https://github.com/microsoft/vscode/blob/227803b34283533344c393fd854a6fbcfe97a158/src/vs/editor/common/model/textModel.ts#L304-L318)

对应的工作台贡献会告知用户已关闭 tokenization、word wrapping、folding、CodeLens、word highlighting 和 sticky scroll，并提供强制启用的操作；强制启用需要重新打开文件。这是“保留文本编辑、关闭昂贵派生功能”的可逆降级，而不是直接拒绝打开。

- [largeFileOptimizations.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/codeEditor/browser/largeFileOptimizations.ts)

VS Code 还按单行长度独立控制 tokenization。当前设置源码把 `editor.maxTokenizationLineLength` 默认写为 20,000，并说明超过该长度的行不会 tokenization；`editor.experimental.asyncTokenization` 默认开启，可在 Web Worker 中异步执行 tokenization。

- [editorConfigurationSchema.ts](https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/config/editorConfigurationSchema.ts)

因此不能把“大文档”简化成一个文件字节阈值：行数、最长行和具体派生功能都可能先成为瓶颈。上述数值是 VS Code 当前源码的实现细节，不应未经基准测试复制到其他产品。

## CodeMirror 6 / Lezer

CodeMirror 6 对大文档的核心做法是 viewport：只将当前可见区域加上 margin 绘制到 DOM，同时为屏外内容维护高度估算和后续测量。`visibleRanges` 可供高亮、搜索标记等插件进一步缩小工作范围。

- [CodeMirror System Guide：Viewport](https://codemirror.net/docs/guide/#viewport)
- [CodeMirror Reference：visibleRanges](https://codemirror.net/docs/ref/#view.EditorView.visibleRanges)

装饰 API 区分直接和间接 decorations。间接 decorations 在 viewport 计算后生成，适合语法高亮和搜索命中；会改变垂直布局的块级小部件必须使用直接 decorations，因为它们会影响 viewport 和高度计算。`RangeSet` 用于大规模范围的高效位置映射。

- [CodeMirror Decoration Example](https://codemirror.net/examples/decoration/)

Lezer 解析器通过可复用的 `TreeFragment` 做增量解析，解析上下文带有 viewport，并能跳过屏外区间，在变为可见时重新启动；后台解析还可逐步推进语法树。

- [CodeMirror ParseContext](https://codemirror.net/docs/ref/#language.ParseContext)
- [Lezer TreeFragment](https://lezer.codemirror.net/docs/ref/#common.TreeFragment)

这套机制只为编辑器解析/装饰提供预算。业务层若在每个输入事件上遍历全文、重建所有块 HTML 或渲染全部 Mermaid，仍然会占满主线程。

## ProseMirror 与富文本窗口化

ProseMirror 官方明确指出，大文档每次整棵 DOM 重绘会很慢。其默认优化是保留持久化文档模型，比较旧文档和新文档，只更新发生变化的 DOM 节点；典型输入甚至不需要 DOM 变更。

- [ProseMirror Guide：Efficient updating](https://prosemirror.net/docs/guide/#view)

这个优化仍假设文档节点大体已经存在，因此不等于完整的 DOM 虚拟化。一个第三方、可审源码的 ProseMirror subtree-windowing **实验原型**让完整文档留在 `EditorState`，屏外 block 只保留定高 placeholder，靠 `IntersectionObserver` materialize；窗口移动使用无 step 的 decoration transaction，不进入历史记录。它不是 ProseMirror 官方或成熟编辑器的默认能力，只作为窗口化取舍的实现参考。

- [prosemirror-subtree-window](https://github.com/karollan/prosemirror-subtree-window)

该原型同时记录了窗口化的边界：浏览器查找、屏幕阅读器、打印和 DOM 导出无法访问未 materialize 的内容；跳转和模型驱动操作需要先 reveal。placeholder 高度必须与真实内容相关，否则滚动锚点和光标定位会漂移。这些限制说明块级替换不是简单的“只保留当前几段”。

## Mermaid 与其他重型块

Mermaid 官方 API 支持关闭自动启动（`startOnLoad:false`），通过 `mermaid.run` 指定节点或选择器渲染；外部图表注册的 `lazyLoad` 默认开启。实时模式可以只对进入 viewport 的 Mermaid 块渲染，并缓存 SVG，但仍要处理块高度变化和滚动锚点。

- [Mermaid Usage](https://mermaid.js.org/config/usage)
- [Mermaid API：run/render/lazyLoad](https://mermaid.js.org/config/setup/mermaid/interfaces/Mermaid.html)

## 浏览器层能力与测量

`content-visibility:auto` 可以让浏览器跳过屏外元素的 layout 和 paint，配合 `contain-intrinsic-size` 提供尺寸估算；屏外内容仍存在于 DOM 和可访问性树。它适合做低投入实验，但不是编辑器级窗口化的替代品，尤其要验证选择、查找、打印和测量行为。

- [MDN：content-visibility](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/content-visibility)

`IntersectionObserver` 异步报告元素跨过可见阈值，适合触发块的懒挂载/卸载。`PerformanceObserver` 的 Long Tasks API 将持续至少 50ms 的主线程任务记录为长任务，可用于定位输入、解析、DOM commit、布局和图表渲染的阻塞阶段。

- [MDN：Intersection Observer API](https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API)
- [MDN：PerformanceLongTaskTiming](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongTaskTiming)

## 对 MEO 的可验证路线

建议先做功能级预算而不是立即重写编辑器：

1. 建立 1 MiB、不同块密度、不同最长行和不同 Mermaid 数量的基线，分别测输入延迟、滚动帧、解析、派生计算、DOM commit 和布局。
2. 第一阶段按 VS Code 的模式加入分项降级：限制可见区外的高亮/图表/数学渲染，暂停全文派生计算，明确提示关闭了哪些功能，并允许本次强制启用。
3. 若实时模式仍超预算，再按 Markdown block 建索引和 viewport renderer。源文本和结构模型保持完整，窗口只控制物化视图；为块高度、选择、查找、复制、打印和无障碍设计 reveal/全文镜像路径。
4. 只有在上述测量证明 DOM 数量是主要瓶颈时，才投入真正的 placeholder/windowing。不能以 CodeMirror 的 viewport 机制推断业务派生计算也自动获得同样的性能收益。

