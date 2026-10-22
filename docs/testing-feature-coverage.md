# 功能验收覆盖

这份清单按用户能完成的操作组织验收。测试存在、控件出现和消息发出，都不能单独证明操作成功。每行要求检查相应结果；新功能、命令或设置必须补充对应行及进入发布门禁的测试。

`scripts/test-test-workflow.ts` 检查所有公开命令、设置均在本表登记，引用的测试进入发布门禁，而且快速门禁不能比发布门禁覆盖更多基本合同。它检查登记和调度完整性；实际行为仍由各项测试断言。

## 编辑、阅读与内容操作

| 功能 | 必须检查的结果 | 门禁证据与边界 |
| --- | --- | --- |
| Live / Source / Preview 切换 | 文档一致；每个可见帧有内容；阅读位置和可编辑组件选区连续 | [模式矩阵](../scripts/test-mode-transition-matrix.ts)、[选区连续性](../scripts/test-mode-selection-continuity.ts) |
| Source 当前行高亮 | 普通行、引用及代码行使用 VS Code 原生背景色，保留半透明度，不绘制矩形描边 | [当前行样式](../scripts/test-source-active-line.ts)；覆盖 Light / Dark 2026、自定义半透明和透明背景 |
| MEO / 原生 MD 标签页切换 | Live、Source、Preview、联动与独立分栏逐帧保持可见内容及位置；打开后首次出现原生选区、已有原生选区、其他文档及重复返回均覆盖 | [生产 Webview 标签页返回](../scripts/test-tab-switch-reading-position.ts)、[Panel Session 事件链](../scripts/test-panel-session-tab-navigation.ts)；安装包 Workbench 行为另验 |
| 初次打开、关闭重开、进程重启 | 保存模式直接显示正确内容且可交互，不靠切换模式补救 | [启动合同](../scripts/test-editor-startup-load.ts)；最终 VSIX 另做原生重开和重启检查 |
| 正文输入、换行、选区、多光标、IME | 内容与光标一致，组合输入不重复提交，不丢字 | [输入路径](../scripts/test-live-input-path-production.ts)、[IME](../scripts/test-ime-composition.ts)、[快捷键](../scripts/test-editor-shortcuts.ts)；原生输入法另验 |
| 行内代码 | 阅读态隐藏反引号不占宽；正文、引用、列表、标题、表格和 HTML 内边距一致；编辑边界、折行与 Source 正常 | [行内代码布局](../scripts/test-inline-code-layout-production.ts)；覆盖 Live、Preview 和 HTML 导出两种主题 |
| Markdown 行内语法边界 | 字面代码、公式、链接地址/标题、注释不参与外部配对；嵌套格式、未闭合标记及表格与正文一致；编辑和撤销保留源码 | [共享分隔符](../scripts/test-inline-style-delimiters.ts)、[渲染边界](../scripts/test-inline-syntax-boundaries.ts)、[生产边界](../scripts/test-inline-syntax-boundaries-production.ts)；覆盖深浅主题、光标状态、Preview 与 HTML/PDF/DOCX 渲染 |
| 格式工具与选中文字菜单 | 加粗、斜体、删除线、高亮、代码、链接等实际修改正文，撤销重做准确 | [基础功能矩阵](../scripts/test-basic-capability-production-matrix.ts) |
| 滚轮与阅读稳定 | 向下/向上持续前进；一次手势多帧完成时不被拉回；迟到布局只补偿几何变化 | [滚动进度](../scripts/test-native-scroll-progress-production.ts)、[虚拟块布局](../scripts/test-virtual-block-scroll-stability.ts)；全篇检查必须实际到达首尾 |
| 文档滚动条 | 长文档的正文滑块在浅色和深色下清晰可见；拖动滑块实际改变阅读位置并能到达首尾；预设切换、分屏、目录开关及面板缩窄后仍可见、可操作 | 真实 VS Code 用户环境必验，使用 [GitHub 对照样例](../scripts/fixtures/github-readme/README.md)；覆盖默认 / GitHub README、独立 Preview / 分屏 Preview，并检查 Live / Source；`scrollHeight`、滚动条 CSS 色值或占位存在均不能单独证明滑块已正常绘制 |
| 搜索、替换、上一项/下一项 | 匹配正确；可见项不多滚；离屏项进入可用视口；替换及撤销内容准确 | [搜索替换](../scripts/test-search-replace-production.ts)、[搜索控件](../scripts/test-webview-search-controls.ts) |
| 目录、行号、链接导航、返回顶部 | 定位目标正确；行号与内容在输入中同步，编号设置一致；空行光标确实绘制；返回顶部真实滚到开头；搜索、导航、输入、用户滚动不竞争旧定位 | [目录同步](../scripts/test-outline-scroll-sync.ts)、[行号跳转](../scripts/test-line-jump.ts)、[行号布局契约](../scripts/test-line-number-layout-contract.ts)、[输入帧与绘制](../scripts/test-display-math-gutter-paint.ts)、[空行光标](../scripts/test-source-empty-line-caret.ts)、[光标导航](../scripts/test-input-cursor-navigation-production.ts)、[返回顶部](../scripts/test-webview-viewport.ts) |
| 工具栏、菜单、外部窗口返回 | 非输入控件保留插入点；输入控件合理取得焦点；仅活动状态变化不触发窗口恢复；窗口返回不抢走其他页面的输入焦点，返回 MEO 后马上能输入且点击优先 | [焦点与视口](../scripts/test-toolbar-input-viewport.ts)、[窗口状态转换](../scripts/test-panel-session-window-focus.ts)、[页面焦点归属](../scripts/test-editor-focus-window-return.ts)、[输入框与正文交接](../scripts/test-input-focus-return-production.ts)；浏览器不能证明 Windows Alt+Tab / 原生菜单 Esc 行为 |
| 撤销重做 | 正文与嵌套编辑共用历史；结构、选区、视口、渲染状态一起正确恢复 | [历史矩阵](../scripts/test-history-matrix.ts)、[渲染内容回放](../scripts/test-rendered-content-history-roundtrip.ts) |
| 表格单元格与结构操作 | 编辑、多行、增加删除行列、对齐、跨模式选区及历史正确；工具栏红绿图标在深浅色、悬停和键盘聚焦时保留颜色 | [表格编辑](../scripts/test-table-cell-editing-production.ts)、[表格历史](../scripts/test-table-history.ts)、[工具栏](../scripts/test-table-context-menu-production.ts) |
| 表格复制粘贴 | 选区、Markdown 样式、转义管道、多行、外部 TSV 保留；粘贴和撤销准确 | [剪贴板合同](../scripts/test-table-clipboard.ts)、[生产复制粘贴](../scripts/test-table-clipboard-production.ts)；浏览器 ClipboardEvent 不能证明系统剪贴板权限 |
| 表格列宽与浮动表头 | 默认/手调列宽经窗口变化有效；浮动表头能导航；搜索目标不被遮挡 | [列宽生命周期](../scripts/test-table-column-width-lifecycle.ts)、[浮动表头](../scripts/test-table-body-interaction-sticky-production.ts) |
| 代码块 | 高亮、全选复制、长代码折叠、行号和编辑后的首次显示正确 | [高亮](../scripts/test-highlight.ts)、[长代码](../scripts/test-long-code-blocks.ts)、[代码行号](../scripts/test-code-block-line-numbers.ts) |
| Mermaid / LaTeX | Mermaid 在主文档展开源码，支持上下／左右布局、分栏拖动及完成收起；公式直接展开源码与下方结果；缩放、错误恢复、历史与全局模式往返正确 | [块呈现](../scripts/test-rendered-block-mode-shell-production.ts)、[Mermaid 编辑](../scripts/test-mermaid-editing.ts)、[嵌套输入](../scripts/test-live-embedded-input-viewport.ts) |
| Live 块间进出与阅读焦点 | 公式、HTML、短代码、长代码和两种 Mermaid 布局的方向键进出、鼠标释放、完成／Esc、文末与反向 Tab 保留正确目标；首帧及转换过程内容可见，新输入可接管；无关更新不清除阅读焦点或重建相邻内容 | [统一块转换](../scripts/test-block-editing-transitions.ts)、[被动更新](../scripts/test-block-passive-updates.ts)、[长代码](../scripts/test-long-code-blocks.ts) |
| 图表与公式操作 | Preview Mermaid 按全屏、图片复制、源码复制排列；Live Mermaid 与块级公式的图片复制紧邻源码复制左侧；行内公式不加入口；PNG 包含完整内容和不透明背景，禁用状态自动跟随有效结果；全屏仅查看控件；鼠标移开隐藏操作条，鼠标进出全屏不留焦点框，键盘焦点及循环可见；更新、失败反馈及中英文深浅色正确 | [Preview 渲染块操作](../scripts/test-preview-rendered-actions.ts)、[Live 图片复制](../scripts/test-live-rendered-image-copy.ts)、[悬停、焦点与可用状态](../scripts/test-rendered-block-action-state.ts)、[源码复制与导出隔离](../scripts/test-preview-code-copy.ts)；真实 VS Code Webview 权限另验 |
| 图片 | 路径解析、加载失败、重新加载及迟到尺寸不破坏阅读位置；全屏查看、缩放、拖动、重置和退出实际生效且不改正文；导出使用正确资源 | [图片布局与查看器](../scripts/test-image-layout.ts)、[路径合同](../scripts/test-webview-image-src.ts)、[导出图片](../scripts/test-preview-export-images.ts)；系统图片粘贴与写盘另验 |
| HTML、注释、安全渲染 | 源码和渲染切换、换行、编辑、注释开关、导出一致；粘贴后展开源码及预览，原文/光标与历史保持，末尾空行不立即收起；主动格式化及单步撤销重做、过滤反馈、空白保留和异步编辑保护；滚轮后展开 HTML/公式保持上方内容位置；隐藏尾节点和嵌套容器不影响后续行号及鼠标落点，HTML/公式源码可完整拖选和复制；不执行不安全内容 | [HTML](../scripts/test-html-content.ts)、[HTML 输入](../scripts/test-html-enter-gutter-stability.ts)、[注释](../scripts/test-comment-visibility-browser.ts) |
| Frontmatter Properties | 属性增加修改删除、复杂 YAML 回退、源码与渲染切换、历史正确 | [属性交互](../scripts/test-frontmatter-properties-interaction.mjs)、[编辑稳定性](../scripts/test-editor-stability.ts) |
| 列表、任务、引用、Alerts、脚注、链接与行内扩展 | 解析和渲染正确；可编辑项的输入、换行、勾选与历史正确 | [语法矩阵](../scripts/test-editor-syntax-parsing-matrix.ts)、[复合列表](../scripts/test-live-composite-lists.ts)、[列表编辑](../scripts/test-list-editing-transaction.ts)、[列表按钮与光标](../scripts/test-list-toolbar-browser.ts)、[链接合同](../scripts/test-document-links.ts)；打开外部目标由 Host 合同检查 |
| 合并冲突 | 接受当前/传入/双方后内容准确，标记移除，撤销重做恢复结构 | [基础功能矩阵](../scripts/test-basic-capability-production-matrix.ts) |
| Source 分栏预览 | 双向映射单调；滚动驱动侧唯一；迟到资源、重排和模式切换不竞争 | [双栏生产测试](../scripts/test-source-side-preview.ts)、[迟到布局](../scripts/test-source-preview-late-layout.ts)、[映射合同](../scripts/test-linked-viewport-map.ts) |
| Preview 预设 | 默认 / GitHub README 切换生效；控件按能力显示；默认设置恢复；内置 / 自定义预设改变排版时逐帧保持正文阅读点，分栏同步开关、快速切换及用户滚动接管正确；分屏菜单、本地状态与导出快照正确；固定最大正文宽度；HTML/PDF 沿用预设，Word 隔离；普通链接和脚注引用 / 回链的颜色与下划线、键帽边框与阴影、Mermaid 居中符合实页 | [渲染与协议](../scripts/test-preview-presets.ts)、[生产浏览器](../scripts/test-preview-presets-browser.ts)、[切换阅读位置](../scripts/test-preview-preset-position.ts)、[导出与实页测量](../scripts/test-github-preset-export-browser.ts)、[目录视口恢复](../scripts/test-preview-outline-viewport-browser.ts)；GitHub 效果为本地近似，视觉细项另按 [预设验收步骤](preview-presets.md#验证) 检查，不能只检查导出 HTML |
| 修改审阅 | 基线选择、增删改标记、修改前内容、概览与定位一致；菜单末项底部和两侧留白一致，悬停样式与设置菜单一致，仅比较方式单选项保留更强的选中底色，普通开关开启时无常驻底色，五个分组标题弱于普通选项；按钮与菜单的红绿增减数量在深浅色与悬停时颜色鲜明且对比度达标 | [一致性](../scripts/test-changes-review-consistency.ts)、[基线](../scripts/test-diff-baseline-selection.ts)、[概览](../scripts/test-git-diff-overview-ruler.ts) |
| 保存、自动保存、外部修改、重载 | 不覆盖新修订；先提交活动单元格；失败能重试；恢复保留草稿 | [保存并发](../scripts/test-document-auto-save-concurrency.ts)、[原生保存表格](../scripts/test-native-save-table-flush.ts)、[重载重试](../scripts/test-document-reload-retry-browser.ts)、[同步恢复](../scripts/test-document-sync-recovery.ts)；最终包另验实际 VS Code 写盘 |
| 通知、重试、另存副本 | 状态与下一步动作一致；副本内容正确；当前文档不被替换；反馈按钮可执行 | [通知](../scripts/test-editor-notice.ts)、[副本适配器](../scripts/test-vscode-document-copy-adapter.ts)、[副本反馈](../scripts/test-vscode-document-copy-feedback.ts)、[传输](../scripts/test-document-copy-transport.ts)；系统对话框另验 |
| 自定义 Preview 预设 | 文件夹导入复制、重复 ID 更新确认、移除确认；管理页固定内置项、显示状态持久化、跨文档隐藏回退、双语指南与共享提示；CSS 实际换行；旧 JSON 迁移；切换失败回滚与启动恢复；单主题禁用切换并说明；双主题切换；仅继承样式；注释与代码着色独立可切换或固定；固定开关隐藏；内置和自定义预设统一说明字段与分隔线；导入、加载、渲染错误状态及恢复；切回后恢复用户设置；CSS 与编辑界面隔离；导出冻结样式版本 | [配置与存储](../scripts/test-custom-preview-presets.ts)、[VS Code 存储适配器](../scripts/test-vscode-preview-presets.ts)、[生产预览与实际 PDF](../scripts/test-custom-preview-presets-browser.ts)、[管理页操作与布局](../scripts/test-preview-preset-management-browser.ts)；实际原生菜单及跨窗口重载另按 [配置指南](../preview-presets/README.zh-CN.md) 检查 |
| HTML / PDF / Word 导出与目录 | HTML/PDF 沿用当前预览预设和实际明暗主题，Word 使用固定样式；内容、资源、高亮、公式、分页与目录正确；Word 隐藏节点不外露、可见子节点保留，行内 HTML 文字、图注及显式换行不丢失；失败可重试 | [导出外观](../scripts/test-export-appearance.ts)、[含目录导出](../scripts/test-export-table-of-contents.ts)、[PDF 布局](../scripts/test-pdf-mermaid-layout.ts)、[Word 生成](../scripts/test-docx-export-runtime.ts)、[实际 PDF / Word 文件生成](../scripts/test-docx-export-browser.ts)；PDF 文件检查验证格式完整性，逐页视觉检查和原生保存对话框另验 |
| 长文档 | 固定文档、明确采样类别与未覆盖目标；编辑和历史不跳；完整阅读确实到达两端 | 发布范围选用受保护的 endurance / large-document 入口，不能把采样编辑称为每个位置都已测试 |

## 设置、输入辅助与快捷键

| 功能 | 必须检查的结果 | 门禁证据与边界 |
| --- | --- | --- |
| 小菜单与完整设置 | 小菜单保持 288px 和原有主题/语言/字号控件；三个 Tab、连续章节、搜索、焦点返回、恢复默认范围正确；中英文和亮暗/窄屏可用 | [正式窗口](../scripts/test-settings-window-production.ts)、[工具栏菜单](../scripts/test-toolbar-menus-browser.ts) |
| 包裹、补对、跳过、退格与列表续写 | 原生 Markdown 全部 11 组及中文符号、连续标记/单双反引号、正反/多行/代码内/多选区；空白、引号、转义前缀例外；包裹与空光标补齐独立，智能/始终/关闭；自动符号来源随撤销恢复、外部文档更新清除；正文与单元格一致；预编辑不改写、IME 自带整对不重复 | [输入辅助](../scripts/test-input-assistance-production.ts)、[编辑场景](../scripts/test-editing-features-production.ts)；CDP 输入法事件覆盖浏览器流程，原生中文输入法另验 |
| HTML 注释输入与切换 | 行/精确选区切换，无内侧填充；现有注释取消且保留空白；混合选区不嵌套；`/comment`、手动补全/完整闭合标记跳过/空注释退格；Tab、Esc、Enter、IME、Live/Source、表格焦点、撤销及快捷键配置正确 | [注释生产输入](../scripts/test-html-comment-input-production.ts)；原生输入法及 VS Code 快捷键截获另验 |
| HTML 共用候选菜单 | Live/Source 标签、属性及预设属性值补全；自动/手动唤起、Enter/Tab/点击确认与单步撤销；关闭开关即时生效且保留标签自动闭合；Esc 保留光标、IME 不接受候选；共用上下方偏好、可见顺序及中英文深浅色/窄屏外观 | [HTML 候选交互](../scripts/test-html-completion-production.ts)、[偏好合同](../scripts/test-editing-preferences.ts)、[正式窗口](../scripts/test-settings-window-production.ts)；原生输入法及宿主快捷键另验 |
| 表格、URL、HTML 与纯文本粘贴 | 正文转换、代码原样、已有表格覆盖/扩展、Markdown 源码保留；CSV/TSV 引号/换行/管道、HTML 合并与换行、混合正文与多表格顺序；首尾结构块边界、双 MIME、容量与无效表格整次回退、转换开关及一次撤销/重做正确 | [混合 HTML 生产粘贴](../scripts/test-mixed-html-paste-production.ts)、[编辑场景](../scripts/test-editing-features-production.ts)、[生产表格剪贴板](../scripts/test-table-clipboard-production.ts)、[服务合同](../scripts/test-editor-services.ts)；真实 Excel/系统剪贴板往返另验 |
| 格式、结构、行/块、表格与多光标命令 | 命令实际改变正确选区；格式可取消；Source/Live 表格行列与对齐逐项验证及一次撤销；多选区、下一处匹配和光标添加有效 | [编辑场景](../scripts/test-editing-features-production.ts)、[基础功能矩阵](../scripts/test-basic-capability-production-matrix.ts)、[历史矩阵](../scripts/test-history-matrix.ts) |
| 快捷键修改、清除与恢复默认 | 修改后新键执行操作、旧键不再响应；HTML 片段格式化支持改绑/清除并同步气泡标签；冲突必须明确替换；保留其他绑定；原生规则不可改；输入法和不同上下文不误执行；恢复仅影响快捷键 | [偏好合同](../scripts/test-editing-preferences.ts)、[快捷键路由](../scripts/test-editor-shortcuts.ts)、[正式窗口](../scripts/test-settings-window-production.ts)、[HTML 编辑](../scripts/test-html-content.ts)；操作系统/VS Code 优先处理的键需原生另验 |
| 链接、斜杠和表情候选 | 工作区/远程根路径与逐级目录；路径段、锚点和别名保留；vault 模糊/多词搜索、排序后限量、后台元数据失效与同名消歧；地址独占斜杠；表格别名不拆列；各菜单选中截断项无需悬停显示全文；Enter/Tab、IME（当前输入段过滤分隔符，目录中的单引号保留）、失焦后点回路径继续选择、旧请求、Esc 后刷新与销毁正确 | [链接候选合同](../scripts/test-link-candidates.ts)、[链接候选生产交互](../scripts/test-link-candidates-production.ts)、[编辑场景](../scripts/test-editing-features-production.ts)、[服务合同](../scripts/test-editor-services.ts)；真实远程 VS Code 窗口和原生输入法另验 |

## 公开设置

| 设置 | 结果与证据 |
| --- | --- |
| `meoEnhanced.editing.preferences` | 输入偏好与快捷键跨面板合并、重载保持、保存失败不伪报成功、旧版本消息不覆盖新值；[偏好合同](../scripts/test-editing-preferences.ts)、[正式窗口](../scripts/test-settings-window-production.ts) |
| `meoEnhanced.language` | 中英文与自动跟随改变实际标签，[语言切换](../scripts/test-live-ui-language-switch.ts) |
| `meoEnhanced.appearance.editor`、`meoEnhanced.appearance.preview` | 独立亮暗外观和主题更新有效，[主题过渡](../scripts/test-vscode-theme-transition.ts) |
| `meoEnhanced.appearance.colors` | 八项基础色严格校验、拖动逐帧投影与合并自动保存、关闭冲刷有效更改、无效 HEX 不覆盖有效设置、保存失败与重试、延迟回应保留后续输入、深浅色隔离、重载保持、高对比度跟随宿主；同明暗跟随宿主、不同明暗使用内置默认基础色且用户覆盖优先，提示与恢复标签准确；文档底色与界面表面独立，Source 原生前景保留，默认 Preview 颜色投影不重渲染、独立预设保留自身背景；五个设置标签的两栏布局、章节导航与搜索过滤、外观章节跳转、中英文窄屏控件；[配置合同](../scripts/test-ui-colors.ts)、[正式外观页](../scripts/test-ui-colors-production.ts)、[文档背景](../scripts/test-editor-background-theme.ts) |
| `meoEnhanced.preview.fontFamily`、`meoEnhanced.preview.codeFontFamily`、`meoEnhanced.preview.sourceColoring`、`meoEnhanced.preview.showComments` | 字体生效、代码着色切换、注释显隐；[菜单](../scripts/test-toolbar-menus-browser.ts)、[预览着色](../scripts/test-preview-code-highlight-layout.ts)、[注释开关](../scripts/test-preview-comment-toggle-browser.ts) |
| `meoEnhanced.appearance.strongColoring`、`meoEnhanced.appearance.boldHeadings` | 实际样式跟随设置，[外观设置](../scripts/test-appearance-settings.ts)、[标题粗细](../scripts/test-basic-capability-production-matrix.ts) |
| `meoEnhanced.appearance.fontSizeMode`、`meoEnhanced.appearance.fontSize` | 自动/自定义字号作用于正文和块内编辑且保留位置，[字号视口](../scripts/test-font-size-viewport.ts)、[嵌套字号](../scripts/test-embedded-source-font-size.ts) |
| `meoEnhanced.appearance.mouseWheelZoom` | 默认开启，独立于 VS Code 原生开关；Ctrl/Cmd + 滚轮调整并保存字号，自动模式从当前显示值转为自定义；覆盖 Live、Source、Preview、重新打开、字号边界、连续滚动与中英文深浅色设置；[滚轮字号](../scripts/test-editor-font-wheel.ts) |
| `meoEnhanced.appearance.lineHeight` | 外观页文档排版直接调节字号倍数，默认 1.5、步进 0.1、范围 1.0–2.5，可恢复默认；菜单不增加行间距入口；Live、Source 和默认 Preview 生效，独立预设保留自身排版；配置持久化、重载和严格 Protocol 校验；[配置与协议](../scripts/test-appearance-settings.ts)、[Host 初始配置](../scripts/test-panel-session-ready-init.ts)、[设置控件与 Source 行高](../scripts/test-settings-window-production.ts)、[实际预览排版](../scripts/test-preview-presets-browser.ts) |
| `meoEnhanced.outline.position`、`meoEnhanced.contentMaxWidth.visible` | 目录位置与宽度约束改变实际布局，[菜单布局](../scripts/test-toolbar-menus-browser.ts)、[Webview 视口](../scripts/test-webview-viewport.ts) |
| `meoEnhanced.table.stickyHeader` | 开关改变浮动表头行为，[表头生产交互](../scripts/test-table-body-interaction-sticky-production.ts) |
| `meoEnhanced.readingPosition.restoreOnOpen` | 开启恢复保存位置，关闭从头打开，[阅读位置启动](../scripts/test-reading-position-preview-startup.ts)；原生跨进程另验 |
| `meoEnhanced.performance.largeDocumentOptimization` | 阈值与保存模式覆盖策略生效，[大文档策略](../scripts/test-large-document-policy.ts)、[启动选项](../scripts/test-basic-capability-production-matrix.ts) |
| `meoEnhanced.gitChanges.visible`、`meoEnhanced.changes.baseline`、`meoEnhanced.changes.showBeforeContent`、`meoEnhanced.gitChanges.lineHighlights` | 概览、基线、旧内容和行高亮有效，[审阅合同](../scripts/test-changes-review.ts)、[行高亮设置](../scripts/test-git-diff-line-highlights-setting.ts) |
| `meoEnhanced.imageStorage` | 默认文档旁、按文档名分开及高级规则保存到预览目录；图片默认文档名加序号，支持日期时间、图片序号和毫秒时间戳，中文路径示例、跨格式续号、并发避让和最终文件名正确；无工作区、旧配置、无效路径、未保存文档、同名防覆盖与链接转义正确；自动保存、关闭保存、输入法和迟到响应正确。[路径与持久化](../scripts/test-image-storage.ts)、[VS Code 配置及目录选择合同](../scripts/test-vscode-image-storage.ts)、[正式设置与写盘粘贴](../scripts/test-settings-window-production.ts)、[外部资源解析](../scripts/test-webview-image-src.ts)；系统剪贴板权限和原生文件对话框另验 |
| `meoEnhanced.imageFolder` | 根目录解析和资源路径正确，[图片目录](../scripts/test-clipboard-image-root.ts)；真实剪贴板文件写入另验 |

## 公开命令与原生边界

| 命令 | 结果与证据 |
| --- | --- |
| `meoEnhanced.open`、`meoEnhanced.toggleEditor` | 文件与编辑器目标正确、过期导航无效，[Host 导航](../scripts/test-host-view-navigation-lifecycle.ts)、[VS Code 导航适配器](../scripts/test-vscode-view-navigation-adapter.ts)；安装包另验编辑器关联 |
| `meoEnhanced.toggleMode` | Live / Source 切换实际可用，Preview 经界面进入，[模式应用](../scripts/test-editor-mode-application.ts)、[生产模式运行](../scripts/test-editor-mode-runtime-browser.ts)；原生命令另验 |
| `meoEnhanced.exportHtml`、`meoEnhanced.exportPdf`、`meoEnhanced.exportDocx` | 正确格式、取消、成功与失败反馈，[导出反馈](../scripts/test-vscode-export-feedback.ts)、[导出适配器](../scripts/test-export-webview-adapter.ts)；实际保存与文件打开另验 |
| `meoEnhanced.managePreviewPresets` | 导入 / 更新、分享文件导出、移除、打开存储目录与按界面语言打开配置指南；取消不写入，[存储与原生对话框合同](../scripts/test-vscode-preview-presets.ts)；真实菜单另验 |

发布报告必须分别列出：自动化结果、最终安装包验证、未覆盖的原生操作和已知问题。OS 焦点、原生菜单、系统剪贴板、文件对话框、支持的最低 VS Code 版本不能从无头浏览器结果推断为通过。若用户报告基础功能回归，候选立即失去验收结论；保存原证据，建立失败用例后重新检查受影响范围。
