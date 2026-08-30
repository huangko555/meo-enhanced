
# MEO Enhanced

Edit complex Markdown and see every addition, modification, and deletion as you work—all inside VS Code.

在 VS Code 中编辑复杂 Markdown，并在工作过程中清楚看到每一处新增、修改与删除。

<p align="center">
  <a href="https://github.com/huangko555/meo-enhanced/blob/main/README.md">English</a> · <strong>简体中文</strong> · <a href="CONTRIBUTING.md">贡献指南</a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=huangko555.meo-enhanced">从 VS Code Marketplace 安装</a> ·
  <a href="https://github.com/huangko555/meo-enhanced/releases">下载 VSIX</a> ·
  <a href="https://github.com/huangko555/meo-enhanced/blob/main/CHANGELOG.md">查看变更记录</a>
</p>

![MEO Enhanced 在同一份 Live 文档中显示独立的深色和浅色外观](docs/readme/editor-appearance-dark-light.png)

MEO Enhanced 是一款围绕稳定 Live 编辑工作流构建的 VS Code Markdown 编辑器。它把源码编辑、实时渲染、改动审阅、高级表格、Mermaid、LaTeX、图片和文档导航放进同一个编辑器，避免在互相割裂的视图之间来回切换。

项目基于 [Markdown Editor Optimized（MEO）](https://github.com/vadimmelnicuk/meo) 开发，重点增强大型文档和复杂结构文档的交互、审阅与布局稳定性。

## 安装

从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=huangko555.meo-enhanced) 安装 **MEO Enhanced - Markdown Editor**，也可以执行：

```shell
code --install-extension huangko555.meo-enhanced
```

随后右键 `.md`、`.markdown`、`.mdx` 或 `.mdc` 文件，选择 **Open With MEO Enhanced**。如需设为默认 Markdown 编辑器，可在命令面板中执行 **MEO Enhanced: Set as Default**。

离线安装时，可从 [GitHub Releases](https://github.com/huangko555/meo-enhanced/releases) 下载 `.vsix`，然后执行 **Extensions: Install from VSIX...**。

## 三种显示模式

- **Live**：直接编辑 Markdown，同时在原位置显示标题、表格、图片、图表和公式等内容的渲染效果。
- **Source**：在带有语法高亮的源码编辑器中，专注查看和编辑原始 Markdown 文本。
- **Preview**：以完整渲染后的效果阅读和检查文档，不进入编辑状态。

## 边写边审阅改动

新增、修改和删除会直接显示在文档旁，不必切换到单独的 Diff 编辑器。你可以比较当前内容、最近保存版本或 Git 版本，也可以固定一个保存版本作为对比基线，并通过概览标记快速了解改动分布。

## 处理复杂 Markdown

- 直接编辑 Markdown 表格，包括长表格和单元格内的丰富内容。
- 在编辑器中处理 Mermaid、LaTeX、代码块、图片和安全 HTML。
- 在同一套流程中使用文档链接、Wiki 链接、脚注、提示块和 Frontmatter Properties。
- 编辑嵌套列表、表格和图表等复杂结构时，尽量保持内容清晰稳定。

![长表格浮动表头、单元格嵌套列表与缩进块级内容](docs/readme/tables-and-nesting.png)

![Mermaid 与块级公式的源码、分栏和预览模式](docs/readme/rich-content-modes.png)

## 查找、导航与分享

- 在可编辑内容和已渲染内容中查找与替换。
- 使用行号跳转或文档大纲浏览长文档。
- 编辑、保存或切换模式时尽量保持当前位置。
- 在 Preview 中检查最终效果，并导出为 HTML 或 PDF。

## 常用操作

| 操作 | 使用方式 |
| --- | --- |
| 切换 Live 与 Source | `Alt/Option + Shift + M` |
| 查找或替换 | `Ctrl/Cmd + F`；替换使用 `Ctrl + H`（Windows/Linux）或 `Cmd + Option + F`（macOS） |
| 跳转到指定行 | 在工具栏输入行号并按 `Enter` |
| 在表格单元格中换行 | `Shift + Enter` |
| 选择改动基线 | 打开 **More**，选择 Current Edits、Recent Save 或 Git HEAD |
| 导出 HTML 或 PDF | 打开 **Preview**，然后使用导出控件 |

## 配置与外观

打开 VS Code 设置并搜索 **MEO Enhanced**，即可调整界面语言、Editor 与 Preview 外观、Preview 字体和代码颜色、大纲位置、内容宽度、大文档行为、改动对比基线和粘贴图片目录。

## 兼容性与项目范围

- 需要 VS Code `1.97.0` 或更高版本。
- 通过自定义编辑器处理 `.md`、`.markdown`、`.mdx` 和 `.mdc` 文件。
- 与原版 MEO 使用不同的命令、设置和编辑器标识，因此可以同时安装。
- 本文以项目分叉时的上游 MEO `v0.1.26` 作为功能对比基准。
- 逐版本新增、修改、修复和移除内容请查看[变更记录](CHANGELOG.md)。

## 致谢

- [Markdown Editor Optimized](https://github.com/vadimmelnicuk/meo) — 原始项目
- [VS Code](https://code.visualstudio.com/) — 扩展平台
- [CodeMirror](https://codemirror.net/) — 编辑器核心
- [Obsidian](https://obsidian.md/) — 交互设计参考

## 许可证

[MIT License](LICENSE)
