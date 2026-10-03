import { emptyMarkdownTable, isMarkdownTableSize } from './delimitedTable';

export type SlashCommand = {
  readonly id: string; readonly command: string; readonly label: string; readonly aliases: readonly string[];
  readonly group: 'text' | 'structure' | 'list' | 'media' | 'code' | 'data';
  readonly icon: string; readonly zh: string; readonly en: string;
  readonly scope: 'inline' | 'block' | 'heading'; readonly insert: string; readonly caret: number;
  readonly fields?: readonly (readonly [number, number])[];
  readonly parameters?: string; readonly disabled?: boolean;
};
const inline = (id: string, label: string, icon: string, zh: string, marker: string, aliases: readonly string[] = []): SlashCommand => ({ id, command: id.toLowerCase(), label, aliases, group: 'text', icon, zh, en: label, scope: 'inline', insert: marker + marker, caret: marker.length, fields: [[marker.length, marker.length]] });
const block = (id: string, label: string, group: SlashCommand['group'], icon: string, zh: string, insert: string, caret = insert.length, aliases: readonly string[] = []): SlashCommand => ({ id, command: id.toLowerCase(), label, aliases, group, icon, zh, en: label, scope: 'block', insert, caret });
const template = (id: string, label: string, icon: string, zh: string, insert: string, fields: readonly (readonly [number, number])[], aliases: readonly string[] = []): SlashCommand => ({ id, command: id.toLowerCase(), label, aliases, group: 'media', icon, zh, en: label, scope: 'inline', insert, caret: fields[0][0], fields });
const commands: readonly SlashCommand[] = [
  inline('bold', 'Bold', 'B', '粗体', '**', ['b']),
  inline('italic', 'Italic', 'I', '斜体', '*', ['i']),
  inline('boldItalic', 'Bold + Italic', 'BI', '粗斜体', '***', ['bi']),
  inline('strike', 'Strikethrough', 'S', '删除线', '~~', ['strike', 'del']),
  inline('highlight', 'Highlight', '▱', '高亮', '==', ['mark']),
  inline('subscript', 'Subscript', 'x₂', '下标', '~', ['sub']),
  inline('superscript', 'Superscript', 'x²', '上标', '^', ['sup']),
  ...Array.from({ length: 6 }, (_, i) => ({ ...block('heading' + (i + 1), 'Heading ' + (i + 1), 'structure', 'H' + (i + 1), (i + 1) + ' 级标题', '#'.repeat(i + 1) + ' ', undefined, ['h' + (i + 1), 'head' + (i + 1)]), command: 'h' + (i + 1) })),
  { ...template('headingId', 'Heading ID', '#', '为当前标题添加锚点', '<a id="anchor"></a>', [[7, 13]], ['id', 'anchor']), group: 'structure', scope: 'heading', zh: '标题锚点', en: 'Heading anchor' },
  block('quote', 'Quote', 'structure', '❯', '引用', '> ', undefined, ['blockquote']),
  block('rule', 'Divider', 'structure', '―', '分隔线', '---', undefined, ['rule', 'hr', 'horizontalrule']),
  { ...inline('lineBreak', 'Line Break', '↵', '段内换行', ''), group: 'structure', insert: '  \n', caret: 3, fields: undefined, aliases: ['br', 'break'] },
  block('ordered', 'Ordered List', 'list', '1.', '有序列表', '1. ', undefined, ['ol', 'numbered']),
  block('bullet', 'Unordered List', 'list', '•', '无序列表', '- ', undefined, ['ul', 'bullet']),
  block('task', 'Task List', 'list', '☑', '任务列表', '- [ ] ', undefined, ['todo', 'tasklist']),
  { ...block('definition', 'Definition List', 'list', '≔', '术语与定义', '<dl>\n<dt>Term</dt>\n<dd>Definition</dd>\n</dl>', 9, ['dl', 'def']), fields: [[9, 13], [23, 33]] },
  template('link', 'Link', '↗', '链接', '[text](url)', [[1, 5], [7, 10]]),
  template('linkTitle', 'Link With Title', '↗', '带提示的链接', '[text](url "title")', [[1, 5], [7, 10], [12, 17]], ['linktitle']),
  template('autoLink', 'Auto Link', '⌁', '网址或邮箱', '<https://example.com>', [[1, 20]], ['url', 'autolink']),
  template('image', 'Image', '▧', '图片', '![alt](url)', [[2, 5], [7, 10]], ['img']),
  template('imageTitle', 'Image With Title', '▧', '带提示的图片', '![alt](url "title")', [[2, 5], [7, 10], [12, 17]], ['imagetitle', 'imgtitle']),
  { ...inline('inlineCode', 'Inline Code', '</>', '行内代码', '`', ['ic', 'inline']), group: 'code' },
  block('codeBlock', 'Code Block', 'code', '{}', '代码块', '```\n\n```', 4, ['code', 'cb', 'fence']),
  { ...inline('inlineMath', 'Inline Math', '∑', '行内公式', '$', ['math']), group: 'code' },
  block('blockMath', 'Block Math', 'code', '∑', '公式块', '$$\n\n$$', 3, ['equation', 'latex']),
  { ...block('table', 'Table', 'data', '▦', '表格 · 行×列', emptyMarkdownTable()!, 2, ['tbl']), en: 'Table · rows×cols', parameters: 'NxN' }
];
const languages: readonly [string, string, readonly string[]][] = [
  ['javascript', 'JavaScript', ['js']], ['typescript', 'TypeScript', ['ts']], ['python', 'Python', ['py']],
  ['java', 'Java', []], ['go', 'Go', ['golang']], ['rust', 'Rust', ['rs']], ['shell', 'Shell', ['sh', 'bash']],
  ['json', 'JSON', []], ['sql', 'SQL', []], ['html', 'HTML', []], ['css', 'CSS', []]
];
/** Pinyin separators affect filtering only; replacement still uses the original input length. */
export function readSlashQuery(value: string): string | null {
  return value.length <= 1001 && /^\/(?:[a-z0-9×]+(?:'[a-z0-9×]*)*)?$/i.test(value) ? value.slice(1).replace(/'/g, '') : null;
}
export function slashCommandSuggestions(query: string, context: 'block' | 'inline' | 'heading'): readonly SlashCommand[] {
  const q = query.toLowerCase();
  const dimensions = /^(?:table)?([0-9]+)(?:[x×]([0-9]*))?$/i.exec(q);
  if (dimensions) {
    if (context !== 'block') return [];
    const rows = Number(dimensions[1]), cols = Number(dimensions[2]), complete = !!dimensions[2];
    const table = commands[commands.length - 1], command = 'table' + q.replace(/^table/, '').replace(/×/g, 'x');
    const insert = complete ? emptyMarkdownTable(cols, rows) : null;
    if (insert) return [{ ...table, command, parameters: undefined, insert, zh: rows + ' 数据行 × ' + cols + ' 列', en: rows + ' data rows × ' + cols + ' cols' }];
    const positive = Number.isSafeInteger(rows) && rows >= 1 && (!complete || Number.isSafeInteger(cols) && cols >= 1);
    const fits = isMarkdownTableSize(complete ? cols : 1, rows);
    // Keep a valid size prefix visible without allowing it to insert the default table.
    return [{ ...table, command, insert: '', caret: 0, disabled: true, parameters: complete ? undefined : dimensions[2] === undefined ? 'xN' : 'N',
      zh: fits ? '继续输入列数' : positive ? '表格尺寸过大' : '行列数需为正整数', en: fits ? 'Enter column count' : positive ? 'Table size is too large' : 'Use positive row/column counts' }];
  }
  if (/^(?:table)?[0-9]/.test(q) || /^(?:table)?[x×]/.test(q)) return [];
  const language = languages.find(([id, , aliases]) => [id, ...aliases].includes(q));
  if (language && context === 'block') return [{ ...block('code-' + language[0], language[1] + ' Code', 'code', '{}', language[1] + ' 代码块', '```' + language[0] + '\n\n```', language[0].length + 4), command: language[0] }];
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const rank = (item: SlashCommand) => item.aliases.includes(q) || normalize(item.label) === q ? 0 : normalize(item.label).startsWith(q) ? 1 : 2;
  return commands.filter(item => item.scope === 'inline' || item.scope === 'heading' && context === 'heading' || item.scope === 'block' && context === 'block')
    .filter(item => [item.id, item.label, ...item.aliases].some(value => normalize(value).includes(q)))
    .sort((a, b) => ['text', 'structure', 'list', 'media', 'code', 'data'].indexOf(a.group) - ['text', 'structure', 'list', 'media', 'code', 'data'].indexOf(b.group) || rank(a) - rank(b));
}
