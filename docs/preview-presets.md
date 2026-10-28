# Preview 预设

Preview 的“预设”入口依次提供 **默认**、**GitHub README**、**Typora Newsprint**、**Typora Whitey** 和 **Obsidian Minimal**。两个 Typora 预设相邻，均使用 Typora 应用图标；Minimal 使用 Obsidian 应用标识，菜单与当前选择均显示。图标随扩展打包，离线可用，来源记录在 `THIRD_PARTY_NOTICES.md`。独立预览在工具栏显示，分屏预览在右侧“更多”菜单中显示；两处使用同一组控件和状态。

三个阅读风格预设统一使用 MEO Markdown 渲染：Newsprint 为暖灰纸面与衬线正文，仅提供浅色；Whitey 采用居中标题与细分隔线，和 Minimal 一样支持自动 / 浅色 / 深色。字体初始为“预设字体”，选择其他字体后覆盖正文，代码字体保持独立。字体与主题按预设记忆，并随现有 Webview 状态恢复；默认预设继续使用 Host 的字体设置，其他预设的字体调整不会修改它。预设字体使用本地回退，不加载远程字体。

预设选择保存在扩展的 globalState 中，重启或打开新文档时使用上次选择；文档已有的字体与主题偏好继续恢复。被移除或禁用的自定义预设回退到默认。所有预设的正文字号统一跟随软件现有基础字号（未提供时为 14px），标题、代码正文和语言标签按比例派生，覆盖自定义 CSS 的正文字号。

Preview 与 Source 分栏的正文滚动条和回到顶部按钮使用预览文档的配色，随预设和预览主题更新。Source 分栏的光标对应位置标记也从预览实际正文与背景色派生，不受编辑器主题影响；左上角两个按钮、选项面板和下拉菜单同样随预览配色更新。分割线上的手动对齐胶囊使用外观设置的 UI 配色，与两侧文档配色独立。独立 Preview 的工具栏与菜单继续使用编辑器主题，气泡提示在所有位置保持统一样式。代码行不再依赖零字号容器；若第三方 CSS 仍使代码字号或行高变成零或无效值，Preview 恢复可读字号与行高，并在预设说明气泡提示。此保护针对字号与行高，不替代任意 CSS 的视觉验证。

[Newsprint CSS](https://github.com/typora/typora-default-themes/blob/master/themes/newsprint.css) 没有关闭语法着色，[Whitey CSS](https://github.com/typora/typora-default-themes/blob/master/themes/whitey.css) 还调整了部分语法颜色；[Minimal 文档](https://github.com/kepano/obsidian-minimal/blob/master/docs/Plugins/Style%20Settings.md) 提供代码语法颜色设置。三个适配预设保留着色开关，使用现有 Light+／Dark+ 词法配色，代码背景与边框跟随各自主题；不复用上游编辑器的词法器。

这些是针对 MEO 文档结构独立实现的风格适配，参考 [Typora 默认主题](https://github.com/typora/typora-default-themes)和 [Obsidian Minimal](https://github.com/kepano/obsidian-minimal) 的阅读外观。CSS 按本项目 MIT 许可提供，未打包上游 CSS 或字体；Minimal 上游采用 [MIT 许可](https://github.com/kepano/obsidian-minimal/blob/master/LICENSE)。

## 控件规则

| 控件 | 默认 | GitHub README |
| --- | --- | --- |
| 字体 | 可修改 | 使用预设字体，控件禁用 |
| 预览主题 | 自动 / 浅色 / 深色 | 自动 / 浅色 / 深色 |
| 代码着色 | 开 / 关，跟随编辑器配色 | 固定开启，使用 GitHub 配色，控件禁用 |
| HTML 注释 | 显示 / 隐藏 | 固定隐藏注释，控件禁用 |
| 正文宽度 | 沿用已有布局 | 最大正文宽度 1012px，窄面板自动收缩；选择控件禁用 |
| 导出、搜索、目录、复制、导航 | 保留 | 保留 |

固定和不支持的控件保留并禁用，悬停显示原因，点击后提示继续显示，“预设说明”气泡简要说明本预设与真实 GitHub README 的显示差异。操作入口与 Host 渲染也执行预设规则。平台预设不会覆盖默认预览的字体、代码着色与注释设置；切回默认即可恢复。主题按预设记忆，选择与偏好通过 VS Code Webview 本地状态恢复。默认主题继续以 Host 设置为准，自动主题跟随编辑器的实际明暗状态。旧的“参考宽度”保存值归一到当前固定上限的响应式布局，其他偏好保留。GitHub 的容器上限为 1076px，其中左右内边距各 32px，正文上限为 1012px；窄面板内边距缩为 16px。

预设影响独立 Preview 和分屏 Preview。所有预设的 HTML、PDF 导出均沿用当前文档的预览配置及已解析的明暗主题，包括没有打开 Preview 的 Live / Source。导出快照的 `presetFontFamily` 保存独立字体覆盖，空字符串表示使用预设字体；`environment` 保留默认字体供 Word 使用。旧快照未带该字段时继续兼容。PDF 按纸张布局，长代码与宽表格换行，避免屏幕横向滚动内容被裁切；Word 保持原有固定格式。

## 定义文件

每个内置预设放在 `src/preview/presets/<id>/`。`preset.json` 引用上层的 `preset.schema.json`，包含：

- `schemaVersion`、稳定的 `id`、中英文 `name` / `description`。
- `renderer`：已有渲染行为 `meo` 或 `github-readme`。
- `styles`：需要独立样式时提供浅色和 / 或深色 CSS 文件名。
- `author`、`version`、`license`：本预设的作者、版本和许可，仅保存在文件中。
- `source`：参考或第三方样式来源；直接使用第三方样式时记录固定版本和提交，更新时用于追踪。
- `defaults`：首次使用的主题与宽度。
- `controls`：五种现有控件的 `editable`、`fixed` 或 `unsupported`。布尔控件固定时必须提供 `value`；选择控件提供允许的 `options`。
- `notes`：兼容旧定义的说明文字；新说明与相关差异统一写入 `description`。

示例可直接参照 `github-readme/preset.json`。字体固定表示由样式文件决定，不通过菜单设置字体值。

新增内置预设时，先新增定义及需要的 CSS，再在 `src/foundation/previewPresets.ts` 注册 ID 与定义。复用现有 renderer 不需要复制工具栏逻辑；只有出现新的解析行为时才增加渲染实现。用户预设通过 Host 校验配置与本地 CSS 后加入同一目录，ID 使用 `user:` 前缀；写法与导入、保存规则见 [自定义预设指南](../preview-presets/README.zh-CN.md)。脚本与远程 CSS 不支持。

自定义预设的 `base` 仍只支持 `default` / `github-readme`，只继承外观和默认代码配色，统一使用 `meo` 渲染。`controls` 独立配置 HTML 注释和代码着色；省略时可切换，固定项保留并禁用。`controls.fontFamily` 可声明 `editable` 或 `fixed`，省略时保持旧版固定字体的行为；开放后在预设 CSS 加载完毕后应用正文覆盖，选择“预设字体”可恢复。`codeTheme` 只选择配色，不锁定着色开关。单主题的主题控件保留并禁用；正文宽度交由 CSS 控制。所有预设统一显示说明入口：气泡只展示内容说明和必要的错误提示；相关差异属于说明文字，不另列规则或元数据。说明随界面语言选择中英版本，旧的单段文字在两种语言中显示相同内容；仅提供一种翻译时回退到该翻译。错误时入口变红并显示详情。内置预设的规则由扩展提供，不能被用户配置文件替换。

CSS 通过 `github-readme/styles.js` 和 `reading/styles.js` 的 Bun 文本导入打包进 `dist/export-runtime.js`，运行时无需读取源码目录。定义文件同时被 Host 与 Webview 使用，固定设置由 `resolvePreviewPresetSettings` 统一解析，样式由 `src/preview/presetStyles.ts` 适配现有 DOM。样式文件名也是维护索引；新增独立样式需要相应的静态导入，不能仅修改 JSON 就执行新的代码。

## 文档配色归属

只有内置“默认”预设保留编辑器主题配色。其他预设拥有各自固定的文档配色；自动模式只选择明暗方案，同一方案不随 VS Code 主题改变。工具栏、菜单和设置面板继续使用统一 UI 语义色，不套用文档配色。

自定义 CSS 按“固定基础样式 → common → 当前主题”加载，未覆盖的颜色由固定基础补齐。`presetStyles.ts` 只将字体、排版和布尔控件传给基础样式，不传编辑器的背景、语义色、Frontmatter 或代码调色板。预设内部可以用变量与 `color-mix()` 复用和派生颜色，页面、代码、表格、引用及分割线的颜色集中写在主题 CSS 中。

`getPreviewPresetCodeTheme` 是 Preview 与 HTML/PDF 的统一代码主题来源。自定义预设省略 `codeTheme` 时，默认基础使用 Light+／Dark+，GitHub 基础使用 GitHub 浅／深色；都不继承编辑器的语法主题或括号彩虹颜色。CSS 决定代码背景，Shiki 只负责语法颜色。旧配置继续兼容，不增加必填字段；Word 的固定格式保持原有行为。

## GitHub README 的范围

样式来自社区项目 [github-markdown-css](https://github.com/sindresorhus/github-markdown-css)，固定为 5.9.0，提交 `265b22aa79815418195f453352456d5784bb7580`。保存上游原始 CSS 与许可证，分发声明在根目录 `THIRD_PARTY_NOTICES.md`；适配规则单独存放，便于更新和比较。

本地渲染调整了普通换行、扩展标记、任务列表、顶层 Alerts、重复标题锚点、Frontmatter 表格和 HTML 样式属性。GitHub 的任务列表使用禁用的原生勾选框，脚注使用原生有序列表；跨 Markdown 块的 HTML 容器保持开闭结构，折叠内容中的 Markdown 正常渲染。GitHub 表格保留原生布局和局部横向滚动；默认预览继续使用原有压缩列宽。切换时不复用默认表格测量出的列宽，并保留源码对应的阅读位置。代码使用 Shiki 的 `github-light-default` / `github-dark-default` 主题，不使用 MEO 括号彩虹配色。系统字体回退和本地语法词法器可能产生细微差别。

校准样例保存在 `scripts/fixtures/github-readme/`，覆盖标题、换行、列表、任务、引用、五类 Alerts、表格溢出、多语言代码、图片、折叠块、脚注、公式及 Mermaid。2026-10-09 将合成样例上传至私有仓库 [meo-preview-github-baseline](https://github.com/huangko555/meo-preview-github-baseline)，基准提交 `ea13796`，未上传用户文档。读取 GitHub 实页的正文尺寸、标题字重与间距、代码色值、边框、表格内边距、任务框及脚注结构；浅色实页测量已纳入浏览器断言，深色按 GitHub 主题色值和 Shiki 官方主题验证。此基准是维护用的对照样例，不是运行时依赖。

这是常见仓库 Markdown 的本地近似预览。2026-10-12 用真实 GitHub README Preview 校准了 HTML 标签和属性清理、资源协议、自定义锚点、单波浪线删除线、自动链接、特殊 fence 大小写、emoji、原始 code 和 themed picture 等边界。212 项探针中 209 项常规语义对照通过，GeoJSON / TopoJSON / STL 专业查看器仍是明确缺口；这不是总体还原度或完整白名单等价证明。详见 [支持边界校准记录](github-readme-compatibility-audit.md)。仓库资源发布后的路径解析尚未完整模拟。预览不会把文档提交给 GitHub；文档中原有的远程图片仍按现有预览机制加载。

公式继续使用 KaTeX，默认预览的公式实现保持现状。GitHub 使用 MathJax，因此公式字体、符号间距和基线对齐可能略有不同；部分 MathJax 扩展命令（如 `\cancelto`）不受 KaTeX 支持。Mermaid 的内置版本和本地主题配置也可能使图表布局、节点尺寸和颜色与 GitHub 略有不同。界面的“预设说明”通过 `description` 简要对照真实 GitHub README：GitHub 将 GeoJSON / TopoJSON 渲染为交互地图、STL 渲染为交互 3D 模型，本预设均显示为代码块；不承诺所有场景像素一致，也不以未经测量的百分比表示还原度。

复杂样例的修复与证据见 [GitHub README 复杂文档渲染对照](github-complex-rendering-audit.md)。GitHub 分支对齐标题标点与重复锚点、HTML 删除线及公式的上下文边界；脚注内的公式和 Mermaid 保留源码或代码块。`src/preview/githubMermaid.ts` 为 Preview 与 HTML/PDF 提供同一组 GitHub 图表配置，默认图表继续使用原有配置。图表缓存区分预设和主题，防止同主题切换复用上一个预设的 SVG；复杂嵌套图仍可能存在布局差异。

## 验证

`bun run test:preview-presets` 检查渲染差异、固定能力、协议校验、实际菜单切换、代码配色、阅读位置、分屏控件、导出快照及本地状态恢复，也检查隐藏预览恢复显示后的目录范围。`scripts/test-github-preset-export-browser.ts` 验证实页测量值、宽窄窗口、完整内容可见性、实际 HTML/PDF 导出与 Word 隔离。构建后确认 CSS 已内嵌，并能用 Node 调用生成的 export runtime。

`scripts/test-preview-preset-position.ts` 使用生产 Webview 和真实预设渲染，覆盖浅色 / 深色、独立 Preview、Source 分栏同步开启 / 关闭。内置及自定义预设改变字体、行距和正文宽度时，每帧比较同一正文段落的连续阅读点，允许最多 2px 舍入偏差；保留的是正文位置，而不是旧滚动条数值。还检查快速连续切换、迟到结果不抢回用户滚动、从文档开头切换后仍在开头。这项回归纳入 quick、targeted appearance / viewport 和完整验收。

预览浏览器回归还检查导航接管后的普通链接、脚注引用及回链的蓝色和下划线，键帽边框及底部阴影、图表实际居中，以及滚动条轨道与阅读背景一致；切回默认后原有滚动条配色保持不变。HTML 导出覆盖相同的键帽、链接和图表对齐。真实滑块绘制和拖动仍须按以下原生步骤验收。

每次预设样式验收还必须在真实 VS Code 用户配置和已安装扩展环境中打开 `scripts/fixtures/github-readme/README.md`，完成以下步骤。浏览器和导出检查不能替代原生 Preview 的视觉检查。

1. 分别检查默认与 GitHub README 的浅色 / 深色、独立 Preview / 分屏 Preview。长文档右侧的正文滑块必须清晰可见；拖动滑块应实际改变阅读位置，并能到达文档开头和末尾。不能以可以滚轮滚动、CSS 色值正确或存在滚动条占位作为通过依据。
2. 打开 / 关闭目录，缩窄 / 加宽面板，切换预设及明暗主题后重复检查滚动条；同一主题下切换默认 / GitHub 时，图表应更新为对应样式，切回默认应恢复。检查 Live / Source 的滚动条没有回归。短文档无需强制出现滑块。
3. 对照真实 GitHub 页面检查普通链接、脚注引用和回链的颜色与下划线、Ctrl / Shift / P 键帽的边框和底部阴影、Mermaid 图表的实际居中位置。Preview 会接管链接导航，因此必须检查显示后的 Preview DOM，不能仅检查未接管链接的导出 HTML。
4. 导出至少三页的长文档 PDF，检查每一页的四边留白，尤其是续页顶部和底部。所有预设默认使用导出层统一提供的 20mm 页边距；显式用户页边距优先，屏幕正文内边距不叠加到纸张留白。不能仅检查第一页或是否能生成 PDF。
5. 展开折叠块，检查后续正文可见；检查表格和长代码的局部横向滚动、图片、Alerts、公式、标题间距和目录导航。对照 HTML / PDF 导出的相同内容，并确认默认预览原有样式与交互保持有效。
6. 用滚轮定位长文档中部，记住阅读中的段落，往返切换默认、GitHub 与改变字体 / 宽度的自定义预设。独立 Preview 和 Source 分栏（同步开启 / 关闭）都应继续显示同一正文位置，切换过程不先跳走再恢复；快速切换和切换后立即滚动也不能被旧结果拉回。从开头切换时仍保持开头。

验收报告应分开记录自动化、原生视觉和拖动操作的结果；存在尚未核实或未修复的基础问题时，不能继续使用此前的通过结论。

## 预设管理入口

预览下拉菜单底部固定“自定义预设…”导航动作，直接打开完整设置的“预览预设”页；命令面板入口打开同一页。只有内置“默认”预设始终显示，其他内置预设和自定义预设均可隐藏；内置预设不能移除。显示状态保存在当前扩展环境的 globalState 中，独立于逐文档的预设选择。隐藏或移除正在使用的预设时，所有已打开的 MEO 文档回到默认；隐藏保留该预设的偏好设置。导入、更新与启用不自动选择预设，更新保留显示状态。管理行的信息图标和 Preview 工具栏复用 `previewPresetInfo.ts`，列表不标记当前选择。

管理列表按预设 ID 更新：勾选只更新控件状态，添加和移除只增删对应行，更新只替换内容变化的行，诊断信息在原有信息气泡中更新。导入、指南按钮及导航保留；只有切换语言、标签、搜索条件或可见分区变化时重建页面。被移除或替换行的气泡和状态回调同时释放。

指南与示例集中在仓库根目录 `preview-presets/`，排除在 VSIX 之外。制作指南使用面板的实际语言打开 GitHub；配置 Schema 保留在包内，已有预设可离线使用。

`preview-presets/examples/` 提供五套内置风格的标准文件夹：`default`、`github-readme`、`newsprint`、`whitey`、`obsidian-minimal`，以及原有的教学示例。每个文件夹包含可直接导入的 `preset.jsonc` 与全部引用 CSS；默认和 GitHub 使用相应的 `base`，三个阅读预设包含独立的公共 CSS 与主题 CSS。内置配置含 renderer 等专用字段，示例按自定义 Schema 编写；导入后是自定义副本，基础配色与 Markdown 支持遵循自定义预设规则。

`preview-presets/preset.schema.json` 为独立 GitHub 目录中的制作辅助文件，与包内 `schemas/custom-preview-preset.schema.json` 保持一致；配置测试校验两者内容，修改字段时同步更新。
