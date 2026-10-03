# Markdown 行内样式

内容样式的共同定义位于 `src/shared/markdownInlineStyles.ts`。当前集中管理粗体、
斜体、删除线、下标和上标；修改字重、字号比例、行高或对齐时在这里修改。

- Live/Source：`webview/src/helpers/inlineStyles.ts` 把共享样式绑定到 CodeMirror 类名。
- Preview 和导出：`src/export/exportStyles.ts` 把相同定义绑定到 HTML 元素。
- 标记显隐、光标、选区、语法着色以及既有模式专用颜色由各自适配层管理。

上下标的共同判定位于 `src/foundation/inlineScript.ts`，由 Lezer、Live 表格和
Preview/导出的 Markdown-it 适配器调用。`~文字~` 是下标，`^文字^` 是上标，
`~~文字~~` 是删除线。上下标内容按文字处理，空白必须转义；代码里的标记保持原文。

其他行内/块级样式仍使用既有定义，在对应功能改动时逐步接入共享来源。

修改后运行 `bun scripts/test-preview-rendering.ts` 和 `bun scripts/test-highlight.ts`。
两项共享同一组行为样例，验证实际渲染、转义、表格、模式切换和基础样式。
