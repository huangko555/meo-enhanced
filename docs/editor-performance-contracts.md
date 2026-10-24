# 编辑体验与性能接入约束

本文是后续功能开发的维护约束。[性能工作记录](large-document-performance.md)和[策略证据](large-document-policy-evidence.md)用于查阅原因与历史测量；具体阈值、接口和测试命令以当前源码及 `package.json` 为准。

## 改动前确定影响

按行为判断是否需要接入性能机制，包括输入、渲染、布局、滚动、焦点、历史、模式切换、异步资源及相关设置。按钮、弹窗、样式和新语法也可能影响这些行为。实现前找出受影响的状态所有者、同步热路径与派生更新路径；无需等待用户单独提出“性能优化”。纯文案等未改变这些行为的改动沿用普通验证流程。

## 接入现有机制

| 影响范围 | 首先查阅的现有入口 | 维护要求 |
| --- | --- | --- |
| 输入与派生工作 | [liveInputDerivedWork.ts](../webview/src/editor/liveInputDerivedWork.ts)、[liveMode.ts](../webview/src/liveMode.ts) | 立即接受文本和选择变化；昂贵派生工作合并调度。键入、IME、粘贴、工具栏、颜色调整及历史操作均保留正确的事务来源，接入对应的更新路径。 |
| Live 局部呈现 | [liveMode.ts](../webview/src/liveMode.ts)、[liveWidgetPositions.ts](../webview/src/editor/liveWidgetPositions.ts) | 映射未变范围，复用仍然有效的装饰和 DOM。能证明局部影响时只更新受影响内容；引用、语法边界或其他全局依赖变化时走正确的失效与重建路径。 |
| 语法与全文功能 | [backgroundMarkdownStructure.ts](../webview/src/editor/backgroundMarkdownStructure.ts)、[markdownStructure.ts](../webview/src/editor/markdownStructure.ts) | 接受与当前文档版本匹配的结果，明确区分部分树与完整结果。目录、搜索和引用依据完整文本模型，独立于是否挂载屏外 DOM。 |
| 阅读位置与分栏同步 | [viewportController.ts](../webview/src/helpers/viewportController.ts)、[interactionContinuity.ts](../webview/src/editor/interactionContinuity.ts) | 通过现有控制器交接定位所有权；新的用户操作使旧的定位任务失效。输入、资源完成与模式切换遵守同一位置规则。 |
| 块编辑与浮层焦点 | [blockInteraction.ts](../webview/src/editor/blockInteraction.ts)、[livePointerSelection.ts](../webview/src/editor/livePointerSelection.ts) | 按下、拖动、松开及取消构成完整交互；按住鼠标期间保持被操作内容稳定。工具栏与弹窗借用焦点后恢复有效选择，区分操作控件和新的正文选择。 |
| 表格操作 | [tableCommand.ts](../webview/src/application/tableCommand.ts)、[codeMirrorTableCommandEffectAdapter.ts](../webview/src/editor/internal/codeMirrorTableCommandEffectAdapter.ts) | 待提交单元格输入与结构命令使用现有事务及历史所有者；移动、排序、删除后保持有效焦点、源码位置和撤销重做。 |
| Preview 与屏外资源 | [preview.ts](../webview/src/helpers/preview.ts)、[previewViewport.ts](../webview/src/helpers/previewViewport.ts)、[previewViewportResources.ts](../webview/src/helpers/previewViewportResources.ts) | 保留已接受的正文，复用有效节点，以当前窗口调度资源与测量；异步完成校验当前版本和生命周期，隐藏或销毁时释放相应工作。 |
| 大文档策略 | [largeDocument.ts](../src/foundation/largeDocument.ts)、[策略证据](large-document-policy-evidence.md) | 打开方式偏好与运行时优化分别处理。普通文档保留轻量路径，同时覆盖小而复杂、巨型单块和编辑后增长的文档。 |

功能优先接入上述所有者；确需替换时，连同取消、失败、历史和销毁语义一起迁移，并移除被替代路径。每项文档状态保持一个权威来源，缓存和展示投影可从它重建。新建缓存、Worker 或调度层应对应已测出的缺口，并定义失效条件、容量和生命周期。

## 用户可见的稳定性

- 输入期间保留未变内容的身份、行号和几何；内容自身换行或结构变化带来的布局变化属于正常行为。需要重新解析时保留有效呈现，避免让未完成结果反复替换正文。
- 光标仍可见时维持当前阅读位置；确需显露光标或命令目标时采用最小滚动。新的点击、键盘导航和用户滚动优先于旧的异步定位任务。验收同时观察输入中及输入停止后的收敛过程。
- Source/Live 的侧边预览遵守现有同步开关及定位所有权：关闭同步时维持右侧阅读锚点；开启时通过源码与渲染几何的映射同步。点击后的最小显露应平滑交接给下一次滚动；程序滚动不能形成反向反馈。
- Live、Source、Preview 及分栏之间保留文本、有效选择和语义阅读位置。虚拟化只改变呈现范围，保存、复制、查找、导出和历史仍使用完整文档。
- 沿用模式切换与目录的延迟加载反馈；快速完成直接显示内容，高频编辑更新保留正文。慢更新的修复优先针对调度和呈现，避免为每次输入增加加载提示。

## 按风险验证并完成交付

测试层级、长验收授权与证据复用统一遵循[测试流程](testing-workflow.md#validation-for-commits-and-merges)。普通提交、合并和功能完成本身不触发发布级长验收；文档修改验证链接及相关文档合同，复用仍然覆盖当前运行时代码的证据。

按本次改动影响选择下列场景，涉及共享基础机制时扩大覆盖面：

- **规模与模式：**小而简单、小而复杂、大文档、巨型单块；相关模式的冷启动、暖缓存切换，以及单栏与侧边预览。
- **真实交互：**点击、按住与松开、连续输入、IME、换行、粘贴、相关工具栏及浮层、撤销重做、滚轮与滚动条。表格、代码、公式、HTML、Mermaid、脚注等按依赖关系取样。
- **中间状态：**输入当帧、派生更新、输入停止后、Worker/图片/字体迟到、模式切换取消及销毁。闪烁或跳动回归检查中间帧与最终状态，单张结束截图不足以证明稳定。
- **正确性与成本：**核对文本、格式、选择、历史及阅读位置；性能检查优先约束扫描、DOM 与资源工作的规模。耗时对照固定文档、环境和构建，区分冷暖并保留多次结果；单次无头浏览器测量不表述为原生 VS Code 或所有设备上的保证。

修复优先扩展现有行为回归，验证用户可见结果与必要的工作预算。新增或移动测试按[测试登记流程](testing-workflow.md#adding-or-changing-tests)接入门禁；简单文案无需增加复述实现的测试。

完成时应能说明：受影响行为由哪个机制承接、相关回归结果、复用证据的适用范围，以及尚未执行的必要验收。发布前在候选冻结后安排完整发布门禁、长时交互和适用的原生安装验收；后续运行时代码变化重新判断受影响证据。
