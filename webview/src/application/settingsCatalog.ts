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
  { key: 'pairMode', section: 'symbols', title: ['自动补全符号', 'Complete symbol pairs'], description: ['输入左符号时补出右符号，光标留在中间。', 'Insert the closing symbol and leave the cursor between the pair.'] },
  { key: 'skipMode', section: 'symbols', title: ['跳过已有右符号', 'Skip an existing closing symbol'], description: ['右侧已有匹配符号时，决定移动光标还是插入新符号。', 'Choose whether typing a matching closing symbol moves the cursor or inserts another symbol.'] },
  { key: 'deleteMode', section: 'symbols', title: ['退格删除空符号对', 'Backspace in an empty pair'], description: ['决定退格时删除一对符号还是一个字符。', 'Choose whether Backspace deletes the empty pair or a single character.'] },
  { key: 'lists', section: 'structure', title: ['自动续写列表', 'Continue lists automatically'], description: ['Enter 续写列表和任务项；空项再按 Enter 退出。', 'Enter continues lists and tasks. Enter on an empty item exits the list.'] },
  { key: 'convertTables', section: 'paste', title: ['将电子表格粘贴为表格', 'Paste spreadsheet cells as a table'], description: ['CSV 文本请使用“转换选中表格文本”命令。', 'For CSV text, use “Convert selected table text”.'] },
  { key: 'pasteUrl', section: 'paste', title: ['粘贴网址生成链接', 'Turn a pasted URL into a link'], description: ['选中文字后粘贴网址，以选中文字作为链接名称。代码中保持原样。', 'Paste a URL over selected text to use it as the link label. Code remains literal.'] },
  { key: 'pasteHtml', section: 'paste', title: ['粘贴时保留常用格式', 'Keep supported formatting when pasting'], description: ['将网页或文档的标题、列表和文字格式转换为 Markdown。纯文本粘贴跳过转换。', 'Convert headings, lists and common text styles from HTML to Markdown. Plain text paste bypasses conversion.'] },
  { key: 'documentSuggestions', section: 'candidates', title: ['文档、路径和标题候选', 'Document, path and heading suggestions'], description: ['输入链接或双链时显示候选，选择后插入。', 'Show suggestions while writing a link or wiki link. Choose one to insert it.'] },
  { key: 'slash', section: 'candidates', title: ['斜杠命令', 'Slash commands'], description: ['在空段落输入 /，快速插入标题、列表、表格等。', 'Type / in an empty paragraph to insert a heading, list, table or another block.'] },
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
  lines: ['moveUp', 'moveDown', 'copyUp', 'copyDown', 'deleteLine', 'blankAbove', 'blankBelow'],
  navigation: ['mode', 'preview', 'enter', 'tab', 'escape', 'delete']
};
export const commandTitles: Record<EditorCommandId, readonly [string, string]> = {
  save: ['保存', 'Save'], undo: ['撤销', 'Undo'], redo: ['重做', 'Redo'], find: ['查找', 'Find'], replace: ['替换', 'Replace'], all: ['全选', 'Select all'], copy: ['复制', 'Copy'], cut: ['剪切', 'Cut'], paste: ['粘贴', 'Paste'], plain: ['粘贴为纯文本', 'Paste as plain text'],
  bold: ['粗体', 'Bold'], italic: ['斜体', 'Italic'], inlineCode: ['行内代码', 'Inline code'], strike: ['删除线', 'Strikethrough'], highlight: ['高亮', 'Highlight'], underline: ['下划线', 'Underline'], kbd: ['按键样式', 'Keyboard style'], link: ['链接', 'Link'], wikiLink: ['双链', 'Wiki link'], image: ['图片', 'Image'], inlineMath: ['行内公式', 'Inline math'], blockMath: ['块公式', 'Math block'],
  heading1: ['一级标题', 'Heading 1'], heading2: ['二级标题', 'Heading 2'], heading3: ['三级标题', 'Heading 3'], heading4: ['四级标题', 'Heading 4'], heading5: ['五级标题', 'Heading 5'], heading6: ['六级标题', 'Heading 6'], headingUp: ['提升标题级别', 'Promote heading'], headingDown: ['降低标题级别', 'Demote heading'], bullet: ['无序列表', 'Bullet list'], ordered: ['有序列表', 'Numbered list'], taskList: ['任务列表', 'Task list'], taskDone: ['切换任务完成状态', 'Toggle task completion'], quote: ['引用', 'Blockquote'], codeBlock: ['代码块', 'Code block'], rule: ['分割线', 'Horizontal rule'], indent: ['缩进与取消缩进', 'Indent and outdent'],
  insertTable: ['插入表格', 'Insert table'], tableNav: ['单元格导航', 'Cell navigation'], cellBreak: ['单元格内换行', 'Line break in a cell'], rowAbove: ['上方插入行', 'Insert row above'], rowBelow: ['下方插入行', 'Insert row below'], rowDelete: ['删除行', 'Delete row'], columnBefore: ['左侧插入列', 'Insert column before'], columnAfter: ['右侧插入列', 'Insert column after'], columnDelete: ['删除列', 'Delete column'], moveRowUp: ['上移行', 'Move row up'], moveRowDown: ['下移行', 'Move row down'], moveColumnLeft: ['左移列', 'Move column left'], moveColumnRight: ['右移列', 'Move column right'], alignLeft: ['左对齐', 'Align left'], alignCenter: ['居中对齐', 'Align center'], alignRight: ['右对齐', 'Align right'], copyMarkdown: ['复制为 Markdown 表格', 'Copy as Markdown table'], copyCsv: ['复制为 CSV', 'Copy as CSV'], convert: ['转换选中表格文本', 'Convert selected table text'],
  selection: ['扩展文本选区', 'Extend text selection'], home: ['行首与行尾', 'Line start and end'], expandSelection: ['扩大语义选区', 'Expand syntax selection'], shrinkSelection: ['缩小语义选区', 'Shrink syntax selection'], nextOccurrence: ['选择下一处相同内容', 'Select next occurrence'], skipOccurrence: ['跳过当前匹配', 'Skip current occurrence'], addCursor: ['向下添加光标', 'Add cursor below'], splitCursors: ['为选中各行添加光标', 'Add cursors to selected lines'],
  moveUp: ['上移当前行或块', 'Move line or block up'], moveDown: ['下移当前行或块', 'Move line or block down'], copyUp: ['向上复制行或块', 'Copy line or block above'], copyDown: ['向下复制行或块', 'Copy line or block below'], deleteLine: ['删除当前行或块', 'Delete line or block'], blankAbove: ['上方插入空行', 'Insert blank line above'], blankBelow: ['下方插入空行', 'Insert blank line below'], mode: ['切换实时与源码', 'Toggle Live and Source'], preview: ['切换预览', 'Toggle Preview'], enter: ['换行与续写', 'Newline and continuation'], tab: ['导航与缩进', 'Navigation and indentation'], escape: ['关闭当前操作', 'Dismiss current interaction'], delete: ['删除内容', 'Delete content']
};
export function commandTitle(command: EditorCommandId, language: UiLanguage): string { const [zh, en] = commandTitles[command]; return settingsText(language, zh, en); }
