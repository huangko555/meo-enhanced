import type { EditorCommandId, InputAssistance } from '../../../src/foundation/editingPreferences';
import type { UiLanguage } from '../../../src/foundation/uiLanguage';
export type SettingsTab = 'general' | 'typing' | 'shortcuts';
export const settingsText = (language: UiLanguage, chinese: string, english: string) => language === 'zh-CN' ? chinese : english;
export const typingSections = ['symbols', 'structure', 'paste', 'candidates'] as const;
export type TypingSection = typeof typingSections[number];
export const sectionTitles = {
  display: ['文档显示', 'Document display'], opening: ['打开文档时', 'Opening documents'], interface: ['界面设置', 'Interface'],
  symbols: ['符号与选区', 'Symbols and selections'], structure: ['列表与结构', 'Lists and structure'], paste: ['粘贴', 'Pasting'], candidates: ['输入候选', 'Suggestions'],
  document: ['文档与编辑', 'Document and editing'], format: ['文字格式', 'Text formatting'], blocks: ['段落与块', 'Paragraphs and blocks'],
  table: ['表格', 'Tables'], selection: ['选择与光标', 'Selections and cursors'], lines: ['行操作', 'Line operations'], navigation: ['模式与导航', 'Modes and navigation']
} as const;
export const typingCatalog: readonly { key: keyof InputAssistance; section: TypingSection; title: readonly [string, string]; description: readonly [string, string] }[] = [
  { key: 'selectionToolbar', section: 'symbols', title: ['选区工具栏', 'Selection toolbar'], description: ['选中文字后显示常用格式工具栏。', 'Show common formatting actions when text is selected.'] },
  { key: 'wrapSelection', section: 'symbols', title: ['选中文字后包裹符号', 'Wrap selected text'], description: ['支持 () [] {} <>、引号、* _ ~ $ ^ =、` 和 ``，以及（）【】“”‘’《》「」『』。= 输入两次形成高亮。反引号长度会避开选中内容中的反引号。', 'Supports () [] {} <>, quotes, * _ ~ $ ^ =, ` and ``, plus Chinese brackets and quotes. Press = twice for highlight. Backtick length adapts to the selected text.'] },
  { key: 'pairMode', section: 'symbols', title: ['自动补全符号', 'Complete symbol pairs'], description: ['输入左符号或 <!-- 时补出闭合标记，光标留在中间。', 'Complete an opening symbol or <!-- and leave the cursor inside.'] },
  { key: 'skipMode', section: 'symbols', title: ['跳过已有右符号', 'Skip an existing closing symbol'], description: ['右侧已有匹配符号时，决定移动光标还是插入新符号。', 'Choose whether typing a matching closing symbol moves the cursor or inserts another symbol.'] },
  { key: 'deleteMode', section: 'symbols', title: ['退格删除空符号对', 'Backspace in an empty pair'], description: ['决定退格时删除一对符号还是一个字符。', 'Choose whether Backspace deletes the empty pair or a single character.'] },
  { key: 'lists', section: 'structure', title: ['自动续写列表', 'Continue lists automatically'], description: ['Enter 续写列表和任务项；空项再按 Enter 退出。', 'Enter continues lists and tasks. Enter on an empty item exits the list.'] },
  { key: 'convertTables', section: 'paste', title: ['将电子表格粘贴为表格', 'Paste spreadsheet cells as a table'], description: ['CSV 文本请使用“转换选中表格文本”命令。', 'For CSV text, use “Convert selected table text”.'] },
  { key: 'pasteUrl', section: 'paste', title: ['粘贴网址生成链接', 'Turn a pasted URL into a link'], description: ['选中文字后粘贴网址，以选中文字作为链接名称。代码中保持原样。', 'Paste a URL over selected text to use it as the link label. Code remains literal.'] },
  { key: 'pasteHtml', section: 'paste', title: ['粘贴时保留常用格式', 'Keep supported formatting when pasting'], description: ['将网页或文档的标题、列表和文字格式转换为 Markdown。纯文本粘贴跳过转换。', 'Convert headings, lists and common text styles from HTML to Markdown. Plain text paste bypasses conversion.'] },
  { key: 'documentSuggestions', section: 'candidates', title: ['文档、路径和标题候选', 'Document, path and heading suggestions'], description: ['输入链接或双链时显示候选，选择后插入。', 'Show suggestions while writing a link or wiki link. Choose one to insert it.'] },
  { key: 'slash', section: 'candidates', title: ['斜杠命令', 'Slash commands'], description: ['在正文输入 / 搜索命令；/table3x4 插入 3 数据行 × 4 列的表格。', 'Type / in prose to search commands. /table3x4 inserts 3 data rows × 4 columns.'] },
  { key: 'emoji', section: 'candidates', title: ['表情名称候选', 'Emoji name suggestions'], description: ['输入 :名称 并选择候选后插入表情；未选择时保留原文。', 'Type :name and choose a suggestion to insert an emoji. Unselected text stays literal.'] }
];
export const tablePasteContexts = [
  { title: ['正文', 'Prose'], description: ['开启时将 Excel 等复制的单元格转换为表格，关闭时保留文本。', 'When enabled, convert cells copied from Excel and other spreadsheets to a table. Otherwise, keep the text.'] },
  { title: ['已有表格', 'Existing table'], description: ['从当前单元格覆盖并按需扩展，可能替换已有内容；不受这个开关影响。', 'Fill from the current cell and expand as needed. This can overwrite existing content and applies regardless of this switch.'] },
  { title: ['代码', 'Code'], description: ['代码块和行内代码保留文本，不做格式转换。', 'Code blocks and inline code keep the text without format conversion.'] }
] as const;
export const shortcutDescriptions: Partial<Record<EditorCommandId, readonly [string, string]>> = {
  copy: ['表格多格选区按行列复制，可粘贴到 Excel 等电子表格。', 'Copy selected table cells as rows and columns for pasting into spreadsheets such as Excel.'],
  plain: ['跳过富格式转换；合法 Markdown 仍按当前模式显示。', 'Bypass rich format conversion. Valid Markdown still displays according to the current mode.'],
  tableNav: ['在表格内切换单元格；正文中按缩进规则处理。', 'Move between cells in a table. In prose, follow the indentation rules.'],
  lineComment: ['注释当前行或选区涉及的完整行；在注释内执行可取消。', 'Comment the current line or all selected lines. Run inside a comment to remove its markers.'],
  selectionComment: ['注释所选文字；未选择时插入空注释。', 'Comment the selected text, or insert an empty comment at the cursor.'],
  copyCsv: ['复制选区或当前表格的单元格源码，以 CSV 编码。', 'Copy the cell source from the selection or current table, encoded as CSV.']
};
export function modeOptions(key: 'pairMode' | 'skipMode' | 'deleteMode', language: UiLanguage) {
  const labels = key === 'pairMode' ? [['按上下文补全', 'Complete where appropriate'], ['始终补全', 'Always complete'], ['不自动补全', 'Do not complete']]
    : key === 'skipMode' ? [['只跳过自动补出的右符号', 'Skip only automatically inserted symbols'], ['跳过所有匹配的右符号', 'Skip every matching symbol'], ['始终插入新符号', 'Always insert another symbol']]
    : [['只删除自动补出的空符号对', 'Delete only automatically inserted empty pairs'], ['删除所有空符号对', 'Delete every empty pair'], ['只删除一个字符', 'Delete one character']];
  return (['smart', 'always', 'off'] as const).map((value, index) => ({ value, label: settingsText(language, labels[index][0], labels[index][1]) }));
}
export const shortcutSections: Readonly<Record<string, readonly EditorCommandId[]>> = {
  document: ['save', 'undo', 'redo', 'find', 'replace', 'all', 'copy', 'cut', 'paste', 'plain'],
  format: ['bold', 'italic', 'inlineCode', 'strike', 'highlight', 'underline', 'kbd', 'link', 'wikiLink', 'image', 'inlineMath', 'blockMath'],
  blocks: ['heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'headingUp', 'headingDown', 'bullet', 'ordered', 'taskList', 'taskDone', 'quote', 'codeBlock', 'rule', 'indent'],
  table: ['insertTable', 'tableNav', 'cellBreak', 'rowAbove', 'rowBelow', 'rowDelete', 'columnBefore', 'columnAfter', 'columnDelete', 'moveRowUp', 'moveRowDown', 'moveColumnLeft', 'moveColumnRight', 'alignLeft', 'alignCenter', 'alignRight', 'copyMarkdown', 'copyCsv', 'convert'],
  selection: ['selection', 'home', 'expandSelection', 'shrinkSelection', 'nextOccurrence', 'skipOccurrence', 'addCursor', 'splitCursors'],
  lines: ['lineComment', 'selectionComment', 'moveUp', 'moveDown', 'copyUp', 'copyDown', 'deleteLine', 'blankAbove', 'blankBelow'],
  navigation: ['mode', 'preview', 'enter', 'tab', 'escape', 'delete']
};
export const commandTitles: Record<EditorCommandId, readonly [string, string]> = {
  save: ['保存', 'Save'], undo: ['撤销', 'Undo'], redo: ['重做', 'Redo'], find: ['查找', 'Find'], replace: ['替换', 'Replace'], all: ['全选', 'Select all'], copy: ['复制', 'Copy'], cut: ['剪切', 'Cut'], paste: ['粘贴', 'Paste'], plain: ['粘贴为纯文本', 'Paste as plain text'],
  bold: ['粗体', 'Bold'], italic: ['斜体', 'Italic'], inlineCode: ['行内代码', 'Inline code'], strike: ['删除线', 'Strikethrough'], highlight: ['高亮', 'Highlight'], underline: ['下划线', 'Underline'], kbd: ['按键样式', 'Keyboard style'], link: ['链接', 'Link'], wikiLink: ['双链', 'Wiki link'], image: ['图片', 'Image'], inlineMath: ['行内公式', 'Inline math'], blockMath: ['块公式', 'Math block'],
  heading1: ['一级标题', 'Heading 1'], heading2: ['二级标题', 'Heading 2'], heading3: ['三级标题', 'Heading 3'], heading4: ['四级标题', 'Heading 4'], heading5: ['五级标题', 'Heading 5'], heading6: ['六级标题', 'Heading 6'], headingUp: ['提升标题级别', 'Promote heading'], headingDown: ['降低标题级别', 'Demote heading'], bullet: ['无序列表', 'Bullet list'], ordered: ['有序列表', 'Numbered list'], taskList: ['任务列表', 'Task list'], taskDone: ['切换任务完成状态', 'Toggle task completion'], quote: ['引用', 'Blockquote'], codeBlock: ['代码块', 'Code block'], rule: ['分割线', 'Horizontal rule'], indent: ['缩进与取消缩进', 'Indent and outdent'],
  insertTable: ['插入表格', 'Insert table'], tableNav: ['单元格导航', 'Cell navigation'], cellBreak: ['单元格内换行', 'Line break in a cell'], rowAbove: ['上方插入行', 'Insert row above'], rowBelow: ['下方插入行', 'Insert row below'], rowDelete: ['删除行', 'Delete row'], columnBefore: ['左侧插入列', 'Insert column before'], columnAfter: ['右侧插入列', 'Insert column after'], columnDelete: ['删除列', 'Delete column'], moveRowUp: ['上移行', 'Move row up'], moveRowDown: ['下移行', 'Move row down'], moveColumnLeft: ['左移列', 'Move column left'], moveColumnRight: ['右移列', 'Move column right'], alignLeft: ['左对齐', 'Align left'], alignCenter: ['居中对齐', 'Align center'], alignRight: ['右对齐', 'Align right'], copyMarkdown: ['复制为 Markdown 表格', 'Copy as Markdown table'], copyCsv: ['复制为 CSV', 'Copy as CSV'], convert: ['转换选中表格文本', 'Convert selected table text'],
  selection: ['扩展文本选区', 'Extend text selection'], home: ['行首与行尾', 'Line start and end'], expandSelection: ['扩大语义选区', 'Expand syntax selection'], shrinkSelection: ['缩小语义选区', 'Shrink syntax selection'], nextOccurrence: ['选择下一处相同内容', 'Select next occurrence'], skipOccurrence: ['跳过当前匹配', 'Skip current occurrence'], addCursor: ['向下添加光标', 'Add cursor below'], splitCursors: ['为选中各行添加光标', 'Add cursors to selected lines'],
  lineComment: ['切换行注释', 'Toggle line comment'], selectionComment: ['切换选区注释', 'Toggle selection comment'],
  moveUp: ['上移当前行或块', 'Move line or block up'], moveDown: ['下移当前行或块', 'Move line or block down'], copyUp: ['向上复制行或块', 'Copy line or block above'], copyDown: ['向下复制行或块', 'Copy line or block below'], deleteLine: ['删除当前行或块', 'Delete line or block'], blankAbove: ['上方插入空行', 'Insert blank line above'], blankBelow: ['下方插入空行', 'Insert blank line below'], mode: ['切换实时与源码', 'Toggle Live and Source'], preview: ['切换预览', 'Toggle Preview'], enter: ['换行与续写', 'Newline and continuation'], tab: ['导航与缩进', 'Navigation and indentation'], escape: ['关闭当前操作', 'Dismiss current interaction'], delete: ['删除内容', 'Delete content']
};
export function commandTitle(command: EditorCommandId, language: UiLanguage): string { const [zh, en] = commandTitles[command]; return settingsText(language, zh, en); }

type SearchKeywords = readonly [string, string];
/** Search aliases belong to the setting, and are indexed in both languages. */
export const generalSearchKeywords = {
  lineNumbers: ['行号 行数 行编号 边栏', 'line numbers numbering gutter'],
  foldCode: ['代码折叠 收起代码 展开代码 长代码', 'code folding collapse expand long code'],
  width: ['内容宽度 页面宽度 最大宽度 限宽 版心 阅读宽度', 'content width page width max width reading width wrap'],
  strongColor: ['粗体颜色 加粗颜色 强调色 粗体着色', 'bold color strong emphasis coloring'],
  boldHeadings: ['标题加粗 标题字重 标题粗细', 'heading bold weight title thickness'],
  stickyHeader: ['表头固定 冻结表头 表头吸顶 表格滚动', 'sticky header freeze pin table header scrolling'],
  restorePosition: ['恢复位置 记住位置 继续阅读 阅读进度 上次位置', 'restore remember position resume reading progress last location'],
  largeDocument: ['大文件 长文档 启动速度 打开速度 性能 源码优先', 'large file long document startup performance speed source first'],
  theme: ['主题 外观 配色 颜色 深色 暗色 夜间 浅色 亮色 跟随系统 自动', 'theme appearance color colour dark night light system automatic'],
  language: ['语言 中文 英文 英语 简体 翻译 本地化 自动', 'language Chinese English translation localization locale automatic'],
  fontSize: ['字号 字体大小 文字大小 放大 缩小 缩放 自动字号 自定义字号', 'font size text size zoom scale larger smaller auto custom']
} as const satisfies Record<string, SearchKeywords>;
export const typingSearchKeywords: Readonly<Record<keyof InputAssistance, SearchKeywords>> = {
  selectionToolbar: ['浮动工具栏 选中工具条 格式工具栏 选区菜单', 'floating toolbar selection menu formatting popover'],
  wrapSelection: ['符号包裹 环绕选区 成对包围 括号 引号 中文符号 高亮', 'surround selection enclosing brackets quotes Chinese pairs highlight'],
  pairMode: ['括号补全 引号补全 自动闭合 配对符号 成对输入 智能补全', 'auto close auto-close autocomplete bracket quote pairing smart completion'],
  skipMode: ['跳过括号 跳过引号 跳出符号 右括号 覆盖输入', 'skip closing bracket quote overtype overwrite jump'],
  deleteMode: ['成对删除 配对删除 一起删除 空括号 退格', 'paired deletion delete together empty brackets backspace'],
  lists: ['列表续写 自动列表 自动编号 有序 无序 任务 清单 回车', 'list continuation auto numbering ordered unordered bullet tasks checklist enter'],
  convertTables: ['电子表格 Excel 表格转换 单元格 矩阵 多行多列 制表符', 'spreadsheet Excel cells table conversion tab separated TSV matrix'],
  pasteUrl: ['网址粘贴 贴链接 超链接 网络地址 地址栏', 'paste URL hyperlink web address selected text link'],
  pasteHtml: ['网页粘贴 富文本 保留格式 样式转换 HTML Markdown', 'paste rich text formatting HTML webpage Markdown conversion'],
  documentSuggestions: ['自动完成 文件候选 路径补全 标题补全 双向链接 双链 维基链接 锚点', 'autocomplete file path heading completion wiki link backlink anchor suggestions'],
  slash: ['斜线 斜杠 快速插入 命令菜单 命令面板 /table', 'slash quick insert command menu command palette /table'],
  emoji: ['表情符号 颜文字 小黄脸 图标 笑脸 冒号', 'emoji emoticon smiley face colon shortcode suggestions']
};
export const imageLocationSearchKeywords: SearchKeywords = [
  '图片保存位置 图片存储 截图保存 自动保存图片 文档旁的文件夹（默认） 文档旁，按文档名分开 自定义路径（高级） 文件夹名称 图片目录或路径规则 选择文件夹… 图片目录 图片文件夹 自定义路径 高级路径 相对路径 绝对路径 文档旁 文档名 扩展名 路径变量 ${fileDirname} ${fileBasename} ${fileBasenameNoExtension} ${fileExtname} assets images',
  'Image save location Beside document (default) Beside document, by name Custom path (advanced) Folder name Image folder or path rule Choose folder… storage pasted screenshot save folder directory custom advanced path relative absolute beside document file name extension variables assets images'
];
export const shortcutSearchKeywords: Readonly<Record<EditorCommandId, SearchKeywords>> = {
  save: ['存盘 写入文件', 'persist write file disk'],
  undo: ['撤回 回退 上一步', 'revert rollback previous edit'],
  redo: ['恢复撤销 下一步', 'repeat undone edit restore'],
  find: ['搜索 检索 查找文字', 'search locate text'],
  replace: ['查找替换 批量替换', 'search substitute replace all'],
  all: ['选择全部 全文选中', 'select entire document everything'],
  copy: ['剪贴板 复制单元格 复制选区', 'clipboard duplicate selected cells'],
  cut: ['剪贴板 剪下 移走选区', 'clipboard remove selected text'],
  paste: ['剪贴板 贴上 插入复制内容', 'clipboard insert copied text'],
  plain: ['无格式粘贴 纯文本粘贴 清除粘贴格式', 'paste unformatted text without formatting'],
  bold: ['加粗 黑体 字重', 'strong heavy weight'],
  italic: ['倾斜 斜字 强调', 'italics emphasis slanted'],
  inlineCode: ['反引号 等宽 行内源码', 'backtick monospace code span'],
  strike: ['划掉 删去 中划线', 'strike through strike-through crossed out'],
  highlight: ['标记 荧光 背景色 双等号', 'mark marker background fluorescent =='],
  underline: ['下划 横线 底线', 'underlined bottom line'],
  kbd: ['键盘 按键 快捷键标签', 'keyboard keycap key label'],
  link: ['超链接 网址 网站地址', 'hyperlink URL web address'],
  wikiLink: ['双向链接 内部链接 维基链接', 'wikilink wiki-link backlink internal link'],
  image: ['插入图片 插图 照片 截图', 'insert picture photo screenshot img'],
  inlineMath: ['行内数学 行内公式 LaTeX TeX 美元符号', 'inline equation mathematics LaTeX TeX dollar'],
  blockMath: ['独立公式 显示公式 数学块 LaTeX TeX', 'display equation mathematics LaTeX TeX block'],
  heading1: ['标题1 H1 大标题', 'h1 level 1 title'],
  heading2: ['标题2 H2 二级标题', 'h2 level 2 title'],
  heading3: ['标题3 H3 三级标题', 'h3 level 3 title'],
  heading4: ['标题4 H4 四级标题', 'h4 level 4 title'],
  heading5: ['标题5 H5 五级标题', 'h5 level 5 title'],
  heading6: ['标题6 H6 六级标题', 'h6 level 6 title'],
  headingUp: ['升级标题 增大标题', 'raise heading level increase title'],
  headingDown: ['降级标题 减小标题', 'lower heading level decrease title'],
  bullet: ['项目符号 无序清单 圆点列表', 'unordered list bullets'],
  ordered: ['编号列表 数字列表 自动编号', 'ordered list numbering numbered'],
  taskList: ['待办 复选框 勾选 清单', 'todo to-do checkbox checklist'],
  taskDone: ['完成任务 打勾 取消勾选', 'check uncheck done complete task'],
  quote: ['引用块 引文 摘录', 'quote citation quoted block'],
  codeBlock: ['代码围栏 程序源码 代码片段', 'fenced code source snippet programming'],
  rule: ['分隔线 水平线 横线', 'separator divider horizontal line'],
  indent: ['缩进 反缩进 减少缩进 增加缩进 Tab', 'indentation unindent tab dedent'],
  insertTable: ['新建表格 添加表格 行列', 'create add new table rows columns'],
  tableNav: ['表格导航 下个单元格 上个单元格', 'table cell next previous navigation tab'],
  cellBreak: ['表格换行 单元格回车', 'table cell newline linebreak enter br'],
  rowAbove: ['前面加行 上面加行 新增行', 'add row above before'],
  rowBelow: ['后面加行 下面加行 新增行', 'add row below after'],
  rowDelete: ['移除表格行 删除整行', 'remove table row'],
  columnBefore: ['前面加列 左边加列 新增列', 'add column left before'],
  columnAfter: ['后面加列 右边加列 新增列', 'add column right after'],
  columnDelete: ['移除表格列 删除整列', 'remove table column'],
  moveRowUp: ['表格行上移 向上移动行', 'move table row up upwards'],
  moveRowDown: ['表格行下移 向下移动行', 'move table row down downwards'],
  moveColumnLeft: ['表格列左移 向左移动列', 'move table column left leftwards'],
  moveColumnRight: ['表格列右移 向右移动列', 'move table column right rightwards'],
  alignLeft: ['左边对齐 靠左', 'left aligned alignment'],
  alignCenter: ['中央对齐 水平居中', 'centered centred alignment'],
  alignRight: ['右边对齐 靠右', 'right aligned alignment'],
  copyMarkdown: ['复制表格源码 竖线表格', 'copy table source pipe Markdown'],
  copyCsv: ['导出CSV 逗号分隔 复制电子表格', 'comma separated spreadsheet export CSV'],
  convert: ['文本转表格 CSV TSV 制表符 逗号分隔', 'text to table CSV TSV delimited conversion'],
  selection: ['扩展选区 选中文字 键盘选区', 'extend selected text keyboard selection'],
  home: ['行首 行尾 开头 末尾', 'beginning start end of line'],
  expandSelection: ['语义选择 结构选区 扩大选中', 'grow syntax semantic structural selection'],
  shrinkSelection: ['语义选择 收缩选区 减小选中', 'reduce syntax semantic structural selection'],
  nextOccurrence: ['相同文字 多选 下个匹配', 'next match multiple selection same text'],
  skipOccurrence: ['忽略当前匹配 跳到下个匹配', 'skip next match occurrence'],
  addCursor: ['多光标 多重光标 竖向光标', 'multi cursor multicursor multiple carets below'],
  splitCursors: ['多光标 每行光标 拆分光标', 'multi cursor multicursor multiple carets split lines'],
  lineComment: ['行注释 取消注释 HTML注释', 'comment uncomment HTML line'],
  selectionComment: ['选区注释 取消注释 HTML注释', 'comment uncomment HTML selection'],
  moveUp: ['向上移动 换行顺序 调整段落', 'reorder move upwards line block'],
  moveDown: ['向下移动 换行顺序 调整段落', 'reorder move downwards line block'],
  copyUp: ['向上重复 克隆行 复制段落', 'duplicate clone line block above'],
  copyDown: ['向下重复 克隆行 复制段落', 'duplicate clone line block below'],
  deleteLine: ['移除当前行 删除段落', 'remove current line block paragraph'],
  blankAbove: ['上面空行 前面空行', 'blank empty line before above'],
  blankBelow: ['下面空行 后面空行', 'blank empty line after below'],
  mode: ['实时模式 源码模式 编辑模式', 'live source edit mode WYSIWYG'],
  preview: ['阅读模式 预览模式 查看渲染', 'reading preview rendered view mode'],
  enter: ['回车 新行 继续列表', 'return enter new line continue list'],
  tab: ['制表符 缩进 导航 单元格', 'tab indentation navigation cells'],
  escape: ['退出 取消 关闭 弹窗', 'escape cancel close popup dismiss'],
  delete: ['删除字符 向前删除', 'delete forward character remove']
};
export const nativeShortcutLabels: Partial<Record<EditorCommandId, string>> = {
  selection: 'Shift + ← / → / ↑ / ↓', home: 'Home / End'
};
export function normalizeSettingsSearch(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').replace(/\s*\+\s*/g, '+').trim();
}
/** Every search term must match the same item; display language does not select its keywords. */
export function settingsSearchMatches(query: string, ...parts: (string | undefined)[]): boolean {
  const terms = normalizeSettingsSearch(query).split(' ').filter(Boolean);
  const text = normalizeSettingsSearch(parts.join(' '));
  return terms.every(term => text.includes(term));
}
