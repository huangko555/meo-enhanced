import MarkdownIt from 'markdown-it';
import { markdownHeadingCandidates } from '../../../src/application/markdownHeadingCandidates';
import type { LinkCandidate } from '../../../src/protocol/editorServices';

/** Parse only on a heading lookup; ATX and Setext headings share Preview's rules. */
export function currentMarkdownHeadings(text: string) {
  if (text.length > 2_000_000) return [];
  const tokens = new MarkdownIt({ html: true }).parse(text, {});
  const headings = tokens.flatMap((token, index) => {
    if (token.type !== 'heading_open') return [];
    const inline = tokens[index + 1];
    const label = (inline.children ?? []).map(child => ['text', 'code_inline', 'image'].includes(child.type) ? child.content : ['softbreak', 'hardbreak'].includes(child.type) ? ' ' : '').join('').replace(/\s+/g, ' ').trim();
    return [{ text: label, source: inline.content, line: (token.map?.[0] ?? 0) + 1 }];
  });
  return markdownHeadingCandidates(headings);
}

export function currentHeadingSuggestions(text: string): readonly LinkCandidate[] {
  return currentMarkdownHeadings(text).map(heading => ({ label: heading.text, insert: heading.text, anchor: heading.anchor, detail: '' }));
}
