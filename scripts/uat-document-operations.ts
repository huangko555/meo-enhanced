import MarkdownIt from 'markdown-it';

export interface DocumentOperation {
  id: string;
  kind: 'outer' | 'html' | 'table' | 'mermaid' | 'math';
  needle: string;
  marker: string;
  tableCell?: string;
}

/** Discover unique, editable targets without relying on a particular document's wording. */
export function discoverDocumentOperations(text: string) {
  const lines = text.split('\n');
  const markdown = new MarkdownIt({ html: true, linkify: true });
  const tokens = markdown.parse(text, {});
  const candidates: Array<DocumentOperation & { line: number; category: string }> = [];
  const claimed = new Set<number>();
  const unavailable: Array<{ line: number; category: string; reason: string }> = [];
  const skip = (line: number, category: string, reason: string) => unavailable.push({ line: line + 1, category, reason });
  const unique = (value: string) => value.length > 2 && text.indexOf(value) === text.lastIndexOf(value);
  const add = (line: number, category: string, kind: DocumentOperation['kind'], needle: string, tableCell?: string) => {
    if (claimed.has(line)) return;
    if (!unique(needle)) { skip(line, category, 'no unique address'); return; }
    claimed.add(line);
    const marker = `__UAT_${line + 1}__`;
    if (text.includes(marker)) throw Error(`Document already contains endurance marker at line ${line + 1}`);
    candidates.push({ id: `${category}-${line + 1}`, kind, needle, marker, tableCell, line, category });
  };
  const blocked = new Set<number>();
  for (const token of tokens) {
    if (!token.map || !['fence', 'code_block', 'html_block', 'table_open'].includes(token.type)) continue;
    const [from, to] = token.map;
    for (let line = from; line < to; line++) blocked.add(line);
    if (token.type === 'table_open') continue;
    if (token.type === 'html_block') {
      let found = false;
      for (let line = from; line < to; line++) {
        const content = [...lines[line]!.matchAll(/>([^<>]+)</g)].map(match => match[1]!.trim()).find(unique);
        if (content) { add(line, 'html', 'html', content); found = true; break; }
      }
      if (!found) skip(from, 'html', 'no unique inline text fragment');
      continue;
    }
    const language = token.info.trim().split(/\s+/)[0]?.toLowerCase();
    const bodyStart = token.type === 'fence' ? from + 1 : from;
    const bodyEnd = token.type === 'fence' ? to - 1 : to;
    const editable = Array.from({ length: Math.max(0, bodyEnd - bodyStart) }, (_, i) => bodyStart + i)
      .filter(line => unique(lines[line]!.trim()));
    if (!editable.length) skip(from, language === 'mermaid' ? 'mermaid' : 'code', 'no unique body line');
    if (language === 'mermaid' && lines[from]!.trimStart().startsWith('```mermaid')) {
      if (editable[0] !== undefined) add(editable[0], 'mermaid', 'mermaid', lines[editable[0]]!.trim());
    } else if (language === 'mermaid') {
      // The driver currently locates backtick Mermaid shells only.
      skip(from, `${language}-shell`, 'unsupported fence syntax');
    } else if (editable.length) {
      // Live treats LaTeX code fences as code; only $$ has a Formula editor.
      const line = editable[Math.floor(editable.length / 2)]!;
      add(line, 'code', 'outer', lines[line]!.trim());
    }
  }
  for (const token of tokens) {
    if (token.type !== 'tr_open' || !token.map) continue;
    const line = token.map[0];
    const rowKey = (value: string) => value.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim()).join('|');
    if (tokens.filter(other => other.type === 'tr_open' && other.map && rowKey(lines[other.map[0]]!) === rowKey(lines[line]!)).length > 1) {
      skip(line, 'table', 'duplicate rendered row values');
      continue;
    }
    // Header rows and escaped-pipe rows require different edit drivers.
    if (!lines[line - 1]?.includes('|') || /^\s*\|?\s*:?-+/.test(lines[line]!)) { skip(line, 'table', 'unsupported header row'); continue; }
    if (lines[line]!.includes('\\|')) { skip(line, 'table', 'escaped pipe needs a separate edit driver'); continue; }
    const cells = lines[line]!.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
    // Clicking rendered links activates navigation rather than the cell editor.
    const cell = [...cells].reverse().find(value => value && !/[\[<#]/.test(value)
      && !markdown.parseInline(value, {}).some(inline => inline.children?.some(child => child.type === 'link_open'))
      && cells.filter(other => other === value).length === 1);
    if (cell) add(line, 'table', 'table', lines[line]!, cell);
    else skip(line, 'table', 'no unique nonempty cell without a navigation target');
  }
  for (let line = 0; line < lines.length; line++) {
    if (blocked.has(line) || lines[line]!.trim() !== '$$') continue;
    const end = lines.findIndex((value, index) => index > line && !blocked.has(index) && value.trim() === '$$');
    if (end < 0) { skip(line, 'math', 'unclosed delimiter'); continue; }
    for (let at = line; at <= end; at++) blocked.add(at);
    const target = lines.findIndex((value, index) => index > line && index < end && unique(value.trim()));
    if (target >= 0) add(target, 'math', 'math', lines[target]!.trim());
    else skip(line, 'math', 'no unique body line');
    line = end;
  }
  for (const token of tokens) {
    if (token.type !== 'inline' || !token.map) continue;
    const [from, to] = token.map;
    for (let line = from; line < to; line++) {
      if (blocked.has(line) || !lines[line]!.trim()) continue;
      if (lines[line]!.includes('<')) { skip(line, 'text', 'inline markup needs a separate edit driver'); continue; }
      const value = lines[line]!.trim();
      const category = /^#{1,6}\s/.test(value) ? 'heading' : /^(?:[-+*>]|\d+[.)])\s/.test(value) ? 'list-quote' : 'text';
      add(line, category, 'outer', value);
    }
  }
  const categories = [...new Set(candidates.map(candidate => candidate.category))];
  const selected = categories.flatMap(category => {
    const available = candidates.filter(candidate => candidate.category === category).sort((a, b) => a.line - b.line);
    const count = Math.min(8, available.length);
    return Array.from({ length: count }, (_, i) => available[count === 1 ? 0 : Math.floor(i * (available.length - 1) / (count - 1))]!);
  }).sort((a, b) => a.line - b.line);
  if (!selected.length) throw Error('No uniquely addressable endurance edit targets in this document');
  return {
    operations: selected.map(({ line: _line, category: _category, ...operation }) => operation),
    coverage: Object.fromEntries(categories.map(category => [category, {
      available: candidates.filter(candidate => candidate.category === category).length,
      selected: selected.filter(candidate => candidate.category === category).length
    }])),
    unavailable
  };
}
