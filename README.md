# MEO Enhanced

基于 [Markdown Editor Optimized（MEO）](https://github.com/vadimmelnicuk/meo) 修改的 VS Code Markdown 编辑器。

![演示](https://raw.githubusercontent.com/huangko555/meo-enhanced/main/docs/demo.gif)

## 主要改动

以下内容以本项目分叉时的上游 `v0.1.26` 为基准。

### 新增

- 新增只读预览模式，以及预览工具栏、外观切换、搜索和链接导航。
- 新增文档改动基线，可对比当前编辑、最近保存和 Git HEAD，并支持手动保存检查点。
- 新增固定基线模式，可固定最近有效保存版本，并在固定基线与原有改动模式之间快速切换。
- 新增行作者开关、删除内容预览、差异概览标记和搜索概览标记。
- 新增 Obsidian 风格的 Frontmatter Properties，在 Live 和 Preview 中显示属性、标签与复杂 YAML 内容。
- 新增 Mermaid 源码、分栏和预览编辑模式，以及可编辑的 LaTeX 块模式。
- 新增代码块行号和长代码块折叠。
- 新增长表格吸顶表头，并支持在表格单元格中编辑列表。
- 新增带缩进表格的渲染支持；Preview 中的列表内表格可正常渲染，并与同级代码块等内容对齐。
- 新增跨单元格选择复制，可通过 `Ctrl/Cmd + C` 复制为文本。
- 新增图片双击预览、图片链接操作和更完整的本地图片处理。
- 新增颜色值预览，并区分颜色文本与 Markdown 标签。
- 新增工具栏行号跳转和编辑模式记忆。

### 优化

- 优化表格的行列编辑、拖动、选择、删除和差异显示。
- 优化文档大纲的展示、折叠、拖动排序和滚动同步。
- 优化图片、链接和文档片段的点击与跳转交互。
- 优化 Mermaid、数学公式、代码块和内联 Markdown 的实时编辑体验。
- 优化列表内代码块、Mermaid 和块级公式的缩进，折叠按钮与内容保持对齐。
- 统一代码块、Mermaid 和块级公式在 Live 与 Preview 中的圆角样式。
- 优化 Live、Source 与 Preview 相互切换时的视口保持，以及预览主题、表格布局和导出一致性。
- 优化查找控件、工具栏、模式切换器和滚动条的布局与样式。
- 优化行号跳转框以及 Live / Source / Preview、Light / Dark 切换器的边框和对齐。
- 优化 Git 差异算法，使重复行、表格行和连续删除的标记更稳定。
- 将 HKK 设为默认主题，并完善主题导入、语义颜色和 JSONC 配置处理。

### 修复

- 修复中文等输入法组合输入时的编辑异常和样式边界问题。
- 修复粗体、斜体、删除线等嵌套格式互相污染或标记颜色错误的问题。
- 修复表格点击后滚动跳动、选择丢失、拖动终点错误和删除错行等问题。
- 修复吸顶表头边线显示不完整，以及普通链接偶发无法展开的问题。
- 修复与原版 MEO 同时安装或进行 F5 调试时命令、配置和编辑器标识冲突的问题。
- 修复图片滚动闪烁、路径解析、重新创建和预览尺寸不稳定的问题。
- 修复 Mermaid 预览高度、分栏尺寸、主题和运行时加载问题。
- 修复数学公式在实时模式、预览和导出结果中表现不一致的问题。
- 修复预览搜索、链接导航、滚动位置和外观状态无法保持的问题。
- 修复大纲在不同编辑模式下定位或滚动不同步的问题。
- 修复长代码块控制按钮、行号对齐和内联渲染问题。
- 修复回车后快速输入时光标偶发跳动的问题。
- 修复 Preview 中列表内代码块前出现多余空白块的问题。
- 修复重复文本、表格编辑和连续删除场景中的 Git 差异错位问题。

### 移除

- 移除早期的代码块折叠实现，替换为只针对长代码块的折叠方式。
- 移除代码块行号分隔线，简化代码块视觉样式。
- 移除表格差异中重复的删除间隙和删除标记。

## 使用

可从 [GitHub Releases](https://github.com/huangko555/meo-enhanced/releases) 下载 `.vsix`，然后在 VS Code 中执行 **Extensions: Install from VSIX...** 安装。

1. 在资源管理器中右键 `.md`、`.markdown`、`.mdx` 或 `.mdc` 文件，选择 **Open With MEO Enhanced**。
2. 执行命令 **MEO Enhanced: Set as Default**，可将其设为 Markdown 默认编辑器。
3. 使用 `Alt/Option + Shift + M` 切换实时模式和源码模式。

## 致谢

- [Markdown Editor Optimized](https://github.com/vadimmelnicuk/meo) — 原始项目
- [VS Code](https://code.visualstudio.com/) — 扩展平台
- [CodeMirror](https://codemirror.net/) — 编辑器核心
- [Obsidian](https://obsidian.md/) — 交互设计参考

## 变更记录

详细记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT License](LICENSE)
