# 内容规则与样式管理

Markdown 正文和 HTML 使用共同的语义规则与基础样式。Live、Preview、导出负责各自的
呈现适配。Lezer 继续支持增量编辑，markdown-it 继续支持读取呈现；保留两个适配器
不表示可以分别决定同一个标记的含义，也不表示需要让两边产生相同 DOM。

## 所有者与入口

| 内容 | 共同来源 | 适配位置 |
| --- | --- | --- |
| 引用／列表中断、表格分隔与标题优先级 | `src/shared/markdownContentRules.ts` | `markdownContentParser.ts`、`webview/src/helpers/markdownContentGrammar.ts`，及既有表格发现路径 |
| 编辑中的列表前缀与两态任务位置 | `src/foundation/markdownListPrefix.ts` | 列表命令、Live 标记与块插入使用同一行内规则，具体行为见[列表编辑规则](list-editing.md) |
| 读取场景的 Markdown 与行内 HTML 语法配置 | `src/shared/markdownContentParser.ts` | Preview／导出和 `htmlMarkdown.ts`；资源、源行映射、数学与脚注保持各自既有所有者 |
| 强调、粗体、删除线、上下标、下划线、高亮、行内代码、段落、引用和标题基础样式 | `src/shared/markdownContentStyles.ts` | `markdownContentStyleTheme.ts` 映射 Live 标记及 HTML 标签，`exportStyles.ts` 映射读取标签 |
| HTML 标签、属性、作者样式与样式表过滤 | `src/shared/htmlPolicy.ts`、`htmlStyle.ts`、`htmlStylesheet.ts` | Live 与读取适配消费同一策略，不能另写标签或 CSS 白名单 |
| 内容配色、字体与排版输入 | `builtInVisualBaseline.ts`、`documentSurfaceRoles.ts` 及已有主题／预设配置 | 表面映射现有 CSS 变量，用户颜色变化只投影样式 |

共享样式按内容角色定义。Markdown 的格式标记和对应 HTML 标签使用同一角色，例如
粗体与 `strong`／`b`、斜体与 `em`／`i`。适配器提供选择器、主题变量及必要的呈现差异，
不重新定义基础字重、字号关系或装饰规则。作者提供的已允许 CSS 保留源码次序和级联，
公共基础样式不能通过新增 `!important` 覆盖它。

## 语义与呈现

- 引用、列表等容器的归属由共同规则决定。允许省略引用标记的正文续行；不能仅因为
  某行没有 `>` 就删掉引用样式。新的列表离开容器时，解析适配器应结束原容器。
- 独立的 `---` 保留标题下划线／分隔线语义。缺失表格分隔列的兼容处理要求显式管道符，
  不能把普通标题修成表格。代码、注释等受保护内容继续使用已解析的上下文。
- 源码显隐、选区、光标、控件、DOM、几何、资源和生命周期归各表面所有者管理。
  普通正文的可编辑行与 HTML／Preview 的阅读段落可以有不同间距和结构。
- GitHub README 方言、既有主题配色和脚注呈现位置保留显式差异。新增差异必须有产品依据；
  不用预设或布局差异解释普通 Markdown 的语义分歧。

## 后续改动与验证

先修改共同规则，再调整必要适配；切换后移除被替代的重复定义。新增语法判定保持纯函数，
解析器的 token、语法树、DOM 和 CodeMirror 对象不进入共同接口。解析扩展必须同时接入
普通编辑与现有后台语法路径，不能在输入、滚动或取色时新增同步全文扫描。

`scripts/test-content-policy-parity.ts` 保护容器结束、合法续行、标题／表格优先级、
Markdown／HTML 基础文字样式、作者 CSS 级联与模式往返，覆盖普通／优化文档及深浅色。
它接入 `test:browser` 和 rendered 定向路径。修改时先补有明确预期的最小用例，再验证
两侧实际行为；两个实现输出相同不能单独证明语义正确。按受影响内容补充既有列表、
HTML、表格、行内格式或 Preview 专项，并遵守[性能合同](editor-performance-contracts.md)
与[测试流程](testing-workflow.md)。
