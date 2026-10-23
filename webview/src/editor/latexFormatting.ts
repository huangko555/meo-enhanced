import { ChangeSet, Text } from '@codemirror/state';
import type { parseMathMinimal } from '@unified-latex/unified-latex-util-parse';

type Node = ReturnType<typeof parseMathMinimal>[number];
type Edit = { from: number; to: number; insert: string };
const whitespace = (node: Node) => node.type === 'whitespace' || node.type === 'parbreak';
const ampersand = (node: Node) => node.type === 'string' && node.content === '&';
const rowBreak = (node: Node) => node.type === 'macro' && ['\\', 'cr', 'newline'].includes(node.content);
const layoutEnvironments = /^(?:aligned(?:at)?|align\*?|gather(?:ed|\*)?|split|(?:[pbBvV]?|small)matrix|[dr]?cases\*?|array|equation\*?)$/;

/** Layout edits refer to the original source; commands and protected contents never pass through a printer. */
export async function formatLatexSource(source: string, offsets: readonly number[]) {
  const retain = (kind: 'unchanged' | 'boundary' | 'invalid') => ({ kind, source, offsets: [...offsets], edits: [] as Edit[] });
  const { parseMathMinimal } = await import('@unified-latex/unified-latex-util-parse');
  let nodes: Node[];
  try { nodes = parseMathMinimal(source); } catch { return retain('invalid'); }
  const edits = new Map<string, Edit>();
  let protectedContent = false, invalid = false, uncertain = false;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const set = (from: number, to: number, insert: string) => {
    if (from > to || !/^[ \t\r\n]*$/.test(source.slice(from, to))) { uncertain = true; return; }
    if (source.slice(from, to) !== insert) edits.set(`${from}:${to}`, { from, to, insert });
  };
  const gapStart = (node: Node, next: number) => node.type === 'comment' ? node.position!.end.offset
    : next - /[ \t\r\n]*$/.exec(source.slice(node.position!.start.offset, next))![0].length;
  const isCharacter = (node: Node | undefined, value: string) => node?.type === 'string' && node.content === value;
  const skipOptional = (items: Node[], start: number) => {
    if (!isCharacter(items[start], '[')) return start;
    let depth = 0;
    for (let index = start; index < items.length; index++) {
      if (isCharacter(items[index], '[')) depth++;
      if (isCharacter(items[index], ']') && --depth === 0) return index + 1;
    }
    uncertain = true;
    return start;
  };
  const layoutChildren = (items: Node[], name: string) => {
    const tokens = items.filter(child => !whitespace(child));
    let first = /^(?:aligned(?:at)?|gathered|array|smallmatrix)$/.test(name) ? skipOptional(tokens, 0) : 0;
    if (/^(?:array|alignedat)$/.test(name) && tokens[first]?.type === 'group') first++;
    const body: Node[] = [];
    for (let index = first; index < tokens.length; index++) {
      body.push(tokens[index]);
      if (rowBreak(tokens[index])) {
        let next = index + 1;
        if (isCharacter(tokens[next], '*')) next++;
        index = skipOptional(tokens, next) - 1;
      }
    }
    return body;
  };
  const visit = (items: Node[], depth: number) => {
    for (const node of items) {
      if (node.type === 'string' && /^[{}]$/.test(node.content)
        || node.type === 'macro' && /^(?:begin|end)$/.test(node.content)) { invalid = true; continue; }
      // A braced argument is opaque, including definitions and text-mode contents.
      if (node.type === 'group') continue;
      if (node.type === 'comment' || node.type === 'verb' || node.type === 'verbatim'
        || node.type === 'macro' && /^(?:[gex]?def|let|futurelet|(?:re|provide|new)command|text\w*|mbox|hbox|operatorname|href|url)$/.test(node.content)) {
        protectedContent = true;
        continue;
      }
      if (node.type !== 'environment' && node.type !== 'mathenv') continue;
      if (!layoutEnvironments.test(node.env) || !node.position) { protectedContent = true; continue; }
      const children = layoutChildren(node.content, node.env);
      if (!children.length) continue;
      if (children.some(child => !child.position)) { uncertain = true; continue; }
      const end = node.position.end.offset;
      const closing = /\\end\s*\{[^{}]*\}$/.exec(source.slice(node.position.start.offset, end));
      if (!closing) { uncertain = true; continue; }
      const closeFrom = end - closing[0].length, first = children[0].position!.start.offset;
      const openEnd = first - /[ \t\r\n]*$/.exec(source.slice(node.position.start.offset, first))![0].length;
      const indent = '  '.repeat(depth + 1);
      set(openEnd, first, newline + indent);
      const last = children.at(-1)!;
      set(gapStart(last, closeFrom), closeFrom, (last.type === 'comment' && source[last.position!.end.offset - 1] === '\n' ? '' : newline) + '  '.repeat(depth));
      for (let index = 0; index < children.length - 1; index++) {
        const child = children[index], next = children[index + 1];
        if (rowBreak(child) && next.type !== 'comment') set(gapStart(child, next.position!.start.offset), next.position!.start.offset, newline + indent);
        if (child.type === 'comment' && source[child.position!.end.offset - 1] === '\n') set(child.position!.end.offset, next.position!.start.offset, indent);
      }
      // Align only direct '&' separators. Nested environments and macro arguments own their contents.
      const rows: Node[][] = [[]];
      for (const child of children) {
        if (rowBreak(child)) { rows.push([]); continue; }
        if (child.type !== 'comment') rows.at(-1)!.push(child);
      }
      const cells = rows.map(row => {
        let start = row[0]?.position!.start.offset ?? 0;
        return row.filter(ampersand).map(amp => {
          const text = source.slice(start, amp.position!.start.offset).trim();
          const nested = row.some(child => (child.type === 'environment' || child.type === 'mathenv')
            && child.position!.start.offset >= start && child.position!.start.offset < amp.position!.start.offset);
          start = amp.position!.end.offset;
          return nested || /\r|\n/.test(text) ? null : [...text].length;
        });
      });
      const widths = cells.reduce<number[]>((max, row) => {
        row.forEach((width, col) => { if (width !== null) max[col] = Math.max(max[col] ?? 0, width); }); return max;
      }, []);
      rows.forEach((row, number) => {
        let col = 0;
        row.forEach((child, index) => {
          if (!ampersand(child)) return;
          const previous = row[index - 1], next = row[index + 1], width = cells[number][col];
          if (previous && previous.type !== 'comment') {
            const padding = width === null ? 1 : Math.max(1, 1 + (widths[col] ?? width) - width);
            set(gapStart(previous, child.position!.start.offset), child.position!.start.offset, ' '.repeat(padding));
          }
          if (next) set(child.position!.end.offset, next.position!.start.offset, ' ');
          col++;
        });
      });
      visit(children, depth + 1);
    }
  };
  visit(nodes, 0);
  if (invalid) return retain('invalid');
  if (uncertain) return retain('boundary');
  const changes = [...edits.values()].sort((a, b) => a.from - b.from || a.to - b.to);
  if (changes.some((edit, index) => index > 0 && edit.from < changes[index - 1].to)) return retain('boundary');
  const changeSet = ChangeSet.of(changes, source.length);
  const formatted = changeSet.apply(Text.of(source.split('\n'))).toString();
  if (formatted === source) return retain('unchanged');
  return { kind: protectedContent ? 'formatted-protected' as const : 'formatted' as const,
    source: formatted, offsets: offsets.map(offset => changeSet.mapPos(offset, 1)), edits: changes };
}
