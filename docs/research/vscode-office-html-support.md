# vscode-office 的 Markdown 内嵌 HTML 支持调研

日期：2026-08-01  
对象：[`cweijan/vscode-office`](https://github.com/cweijan/vscode-office) 的提交 [`0672048a5121dde4d7a1136888bfd4732ad9838d`](https://github.com/cweijan/vscode-office/tree/0672048a5121dde4d7a1136888bfd4732ad9838d)

## 结论

`vscode-office` 没有分别为 `<p>`、`<a>`、`<strong>` 等标签编写组件，也没有维护公开的“支持标签白名单”。它把 Markdown 交给内置的 Vditor/Lute，HTML 被统一识别为行内或块级 HTML 节点，再交给浏览器显示；点击 HTML 节点后，则通过统一的源码弹窗编辑。

因此，它的实际范围是“Lute 能保留、浏览器能呈现的 HTML”，而不是逐项保证交互、资源加载和导出一致性的完整 HTML 子集。

截图中的 README 写法可以正常呈现：

```html
<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>
```

在该提交随附的 Lute `1.7.3` 中，以默认 `sanitize: true` 运行转换后，`<p align>`、`<a href>` 和 `<strong>` 都会保留，嵌套关系也不会丢失。

## 实际渲染链路

1. Markdown Webview 在 [`resource/markdown/index.js`](https://github.com/cweijan/vscode-office/blob/0672048a5121dde4d7a1136888bfd4732ad9838d/resource/markdown/index.js#L3-L18) 中用文档原文创建 `Vditor`。
2. Vditor 初始化时加载打包的 Lute，并在 [`setLute`](https://github.com/cweijan/vscode-office/blob/0672048a5121dde4d7a1136888bfd4732ad9838d/vditor/src/ts/markdown/setLute.ts#L1-L24) 中配置 Markdown 转换选项。
3. 默认 `sanitize` 为 `true`，见 [`Constants.MARKDOWN_OPTIONS`](https://github.com/cweijan/vscode-office/blob/0672048a5121dde4d7a1136888bfd4732ad9838d/vditor/src/ts/constants.ts#L32-L46)。
4. WYSIWYG/IR 使用 `Md2VditorDOM` 或 `Md2VditorIRDOM` 生成内容，HTML 被归为 `html-inline` 或 `html-block` 节点。
5. 点击 HTML 节点会进入统一源码编辑器，保存后重新走同一转换链，见 [`handleHtmlEditorClick`](https://github.com/cweijan/vscode-office/blob/0672048a5121dde4d7a1136888bfd4732ad9838d/vditor/src/ts/htmlInline/htmlInlineEditor.ts#L555-L592)。

## 实际可呈现范围

| 类别 | 代表标签 | 结论 |
| --- | --- | --- |
| 截图所需 | `p[align]`、`a[href]`、`strong` | 可以呈现并保留属性和嵌套关系 |
| 常用行内 | `span`、`em`、`b`、`i`、`del`、`mark`、`code`、`kbd`、`sub`、`sup`、`br` | 由通用行内 HTML 节点呈现 |
| 常用块级 | `div`、`p`、`blockquote`、`ul`、`ol`、`li`、`table`、`thead`、`tbody`、`tr`、`th`、`td`、`hr`、`pre` | 由通用块级 HTML 节点呈现，排版取决于浏览器和编辑器 CSS |
| 媒体与原生控件 | `img`、`details`、`summary`、`video`、`audio`、`iframe`、`form`、`input`、`button` | 转换器会保留输出，但不代表扩展保证完整交互、资源加载或导出效果 |
| 危险内容 | `script`、`onclick`、`onerror` 等事件属性 | 默认转换会移除 |

## 链接行为

`<a href>` 的显示来自通用 HTML 渲染，而链接的打开方式由扩展单独控制：`#fragment` 用于文档内跳转，普通链接需要双击或按住 Ctrl/Command 点击，见 [`onLinkClick`](https://github.com/cweijan/vscode-office/blob/0672048a5121dde4d7a1136888bfd4732ad9838d/resource/markdown/index.js#L38-L63)。

## 安全与能力边界

- `sanitize: true` 不等于稳定、公开的标签白名单，不能据此承诺任意标签、属性、CSS 和嵌入内容都可用。
- 实测中 `script` 和 `on*` 属性会被移除，但 `href="javascript:…"` 仍可能保留，所以不能照搬其 URL 安全策略。
- `iframe`、媒体与表单控件需要单独考虑 Webview 权限、CSP、外部资源、交互和导出一致性。
- `vscode-office` 的 HTML 节点采用“只读呈现，点击后弹窗编辑源码”的方式，不是把每个标签拆成 Live 行内 Markdown 装饰。

## 对本项目的建议

建议先实现一个明确、安全且三模式一致的子集：

- 优先：`p[align]`、`div[align]`、`a[href,title]`、`strong/b`、`em/i`、`del/s`、`mark`、`code`、`kbd`、`br`、`span`、`sub`、`sup`、`img[src,alt,width,height]`、`details[open]`、`summary`。
- 第二批再评估 HTML 表格和列表，避免与现有 Markdown 表格、列表工具冲突。
- 默认不纳入 `script`、事件属性、任意 `style`、`iframe`、表单控件以及音视频标签。

实现时应让 Live、Preview 和导出共用同一套标签、属性与 URL 协议策略，避免同一文档在不同模式下显示不一致。
