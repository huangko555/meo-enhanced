# MEO Enhanced

更顺手地编辑、审阅和预览复杂 Markdown。

A feature-rich Markdown editor for VS Code with live editing, change review, advanced tables, Mermaid, and LaTeX preview.

MEO Enhanced 是基于 [Markdown Editor Optimized（MEO）](https://github.com/vadimmelnicuk/meo) 开发的 VS Code Markdown 编辑器，在保留实时编辑体验的基础上，重点增强了文档导航、改动审阅、复杂内容编辑以及图片与表格交互。

[从 VS Code Marketplace 安装](https://marketplace.visualstudio.com/items?itemName=huangko555.meo-enhanced) · [下载 VSIX](https://github.com/huangko555/meo-enhanced/releases) · [查看变更记录](CHANGELOG.md) · [主题配置](docs/theming.md)

![MEO Enhanced 编辑与预览演示](https://raw.githubusercontent.com/huangko555/meo-enhanced/main/docs/demo.gif)

## 核心增强

以下功能以本项目分叉时的上游 MEO `v0.1.26` 为基准。

### 导航与编辑

- **行号跳转**：在工具栏输入行号并按 `Enter`，即可快速定位到目标行。
- **返回文档顶部**：点击文档右下角的返回顶部按钮，即可快速跳转到文档开头。
- **增强文档大纲**：以更清晰的层级展示标题，支持折叠、拖动排序和滚动同步，并可固定在编辑器左侧或右侧。
- **放弃本次编辑**：双击工具栏中的放弃编辑按钮，即可撤销尚未保存的全部修改。
- **长代码块折叠**：自动收起较长的代码块，减少浏览干扰；该功能默认启用，也可在工具栏中关闭。
- **显式换行**：支持 `<br>` 、`<br />`、`<br/>`三种 Markdown 换行写法。
- **多种阅读方式**：支持 Live、Source 和只读 Preview 模式，并在切换时尽量保持当前视口位置。

### 改动审阅

- **三种改动状态**：分别标记新增、修改和删除内容，并提供删除内容预览与差异概览标记。
- **全局改动概览**：在滚动条左侧显示新增、修改和删除标记在整个文档中的分布，便于快速定位改动位置。
- **可选对比基线**：可以与最新保存内容、最近一次保存前的版本或 Git HEAD 对比。
- **固定基线**：可将最近的有效保存版本固定为检查点，持续观察后续修改。
- **更稳定的差异结果**：针对重复行、表格和连续删除场景优化差异计算与显示。

![新增、修改、删除状态以及改动基线设置](docs/readme/changes-overview.png)

### 表格与嵌套内容

- **浮动表头**：浏览长表格时自动显示吸顶表头，滚动后仍能看到各列含义。
- **单元格内列表**：支持有序列表、无序列表及多级缩进显示。
- **单元格内换行**：编辑表格时按 `Shift + Enter`，可在当前单元格中插入换行并继续编辑。
- **单元格内图片**：支持在单元格内插入和显示图片，可直接从剪贴板粘贴插入。
- **跨单元格复制**：支持选择多个单元格，并通过 `Ctrl/Cmd + C` 复制为文本。
- **层级缩进**：表格、代码块、Mermaid 和块级公式可以正确嵌套在列表等结构中，并保持内容与操作控件对齐。
- **增强表格交互**：改进行列编辑、拖动、选择、删除和差异显示体验。

![长表格浮动表头、单元格列表与层级缩进](docs/readme/tables-and-nesting.png)

### Mermaid、公式与富内容

- **Mermaid 与块级公式**：支持源码、分栏和预览三种显示方式，兼顾直接编辑与渲染结果查看。
- **Frontmatter Properties**：在 Live 和 Preview 中显示 Obsidian 风格的属性、标签及复杂 YAML 内容。
- **颜色值预览**：识别 Markdown 中的颜色值，并直接显示对应颜色。
- **代码块增强**：支持代码块行号，并统一代码块、Mermaid 和块级公式在编辑、预览与导出结果中的样式。

![Mermaid 与块级公式的源码、分栏和预览模式](docs/readme/rich-content-modes.png)

### 图片与链接

- **大图预览**：双击图片即可查看大图。
- **系统应用打开**：图片右上角提供浮动操作按钮，可使用系统默认应用打开本地图片。
- **本地图片处理**：改进图片路径解析、尺寸保持和重新创建后的显示稳定性。
- **链接导航**：优化普通链接、图片链接和文档片段的点击与跳转交互。

### 稳定性改进

针对上游扩展在中文输入、表格交互、图片显示、Mermaid 渲染以及编辑模式切换等场景中的部分稳定性问题进行了修复和加固。

## 安装与使用

### VS Code Marketplace

1. 在 VS Code 中打开扩展面板，搜索 **MEO Enhanced - Markdown Editor**。
2. 确认扩展标识为 `huangko555.meo-enhanced`，然后点击 **Install**。
3. 在资源管理器中右键 `.md`、`.markdown`、`.mdx` 或 `.mdc` 文件，选择 **Open With MEO Enhanced**。

也可以通过命令行安装：

```shell
code --install-extension huangko555.meo-enhanced
```

### 手动安装 VSIX

如果无法访问 Marketplace，可从 [GitHub Releases](https://github.com/huangko555/meo-enhanced/releases) 下载最新的 `.vsix` 文件，然后在 VS Code 中执行 **Extensions: Install from VSIX...**。

如需将其设为 Markdown 默认编辑器，请执行命令 **MEO Enhanced: Set as Default**。

## 常用操作


| 操作                   | 使用方式                                                |
| ------------------------ | --------------------------------------------------------- |
| 切换实时模式与源码模式 | `Alt/Option + Shift + M`                                |
| 跳转到指定行           | 在工具栏输入行号并按`Enter`                             |
| 返回文档顶部           | 点击右下角的返回顶部按钮                                |
| 放弃未保存的修改       | 双击放弃编辑按钮                                        |
| 在表格单元格中换行     | `Shift + Enter`                                         |
| 调整大纲位置           | 将`meoEnhanced.outline.position` 设为 `left` 或 `right` |
| 选择改动对比基线       | 配置`meoEnhanced.changes.baseline`                      |

## 配置与主题

MEO Enhanced 支持 VS Code 深色与浅色外观，并提供可自定义的编辑器主题。主题导入、颜色配置和 JSONC 示例见 [主题配置文档](docs/theming.md)。

常用配置包括：

- `meoEnhanced.outline.position`：设置文档大纲显示在编辑器左侧或右侧。
- `meoEnhanced.changes.baseline`：选择改动对比基线，可选 `current-edit`、`recent-save` 或 `git-head`。
- `meoEnhanced.changes.enabled`：控制是否在编辑器中显示改动标记。
- `meoEnhanced.gitBlame.enabled`：控制是否显示 Git 行作者与提交信息。

## 与上游的关系

本项目基于 [Markdown Editor Optimized](https://github.com/vadimmelnicuk/meo) 修改，并与原版使用不同的命令、配置和编辑器标识，因此可以同时安装。

README 重点介绍当前版本的主要能力；逐版本新增、优化、修复和移除内容请查看 [CHANGELOG.md](CHANGELOG.md)。

## 致谢

- [Markdown Editor Optimized](https://github.com/vadimmelnicuk/meo) — 原始项目
- [VS Code](https://code.visualstudio.com/) — 扩展平台
- [CodeMirror](https://codemirror.net/) — 编辑器核心
- [Obsidian](https://obsidian.md/) — 交互设计参考

## 许可证

[MIT License](LICENSE)
