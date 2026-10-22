import type MarkdownIt from 'markdown-it';
import { tableRowRanges } from './markdownTableBands';

type CoreState = Parameters<MarkdownIt['core']['process']>[0];
type CoreRule = (state: CoreState) => void;

/** Keep the document's block/reference context, while preparing inline content
 * only for requested roots. Each root retains the original inline rule order.
 * Headings need global IDs; contextual HTML roots need early children so
 * containers spanning roots can be partitioned without changing semantics. */
export function prepareDeferredMarkdownInline(md: MarkdownIt, source: string, environment: object,
  documentAnchors: CoreRule
) {
  const marker: CoreRule = () => {};
  md.core.ruler.before('inline', 'meo-windowed-inline-boundary', marker);
  const rules = md.core.ruler.getRules('');
  const boundary = rules.indexOf(marker);
  if (boundary < 0) throw new Error('Markdown inline preparation boundary missing');
  const state = new md.core.State(source, md, environment);
  for (const rule of rules.slice(0, boundary)) rule(state);
  const tokens = state.tokens;
  const inlineRules = rules.slice(boundary + 1).filter(rule => rule !== documentAnchors);
  const groups: Array<{ from: number; to: number; ready: boolean }> = [];
  const groupAt = new Int32Array(tokens.length);
  let from = 0, depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    depth += tokens[index]!.nesting;
    if (depth !== 0 && index + 1 !== tokens.length) continue;
    const add = (start: number, end: number) => {
      if (start >= end) return;
      groupAt.fill(groups.length, start, end);
      groups.push({ from: start, to: end, ready: false });
    };
    const table = tableRowRanges(tokens, from, index + 1);
    if (table) {
      add(from, table.bodyOpen + 1);
      for (const row of table.rows) add(row.from, row.to);
      add(table.bodyClose, index + 1);
    } else add(from, index + 1);
    from = index + 1;
  }
  let anchorsApplied = false;
  const prepare = (index: number) => {
    const group = groups[index]!;
    if (group.ready) return;
    const local = new md.core.State(state.src, md, environment);
    local.tokens = tokens.slice(group.from, group.to);
    // Global anchors are known before lazy task/list attributes. Reapply their
    // owned attributes afterwards to preserve the eager renderer's output order.
    const anchors = anchorsApplied ? local.tokens.map(node => {
      const values = node.attrs?.filter(([name]) => ['data-source-line', 'data-source-end-line', 'id'].includes(name));
      if (values?.length) node.attrs = node.attrs!.filter(attribute => !values.includes(attribute));
      return { node, values };
    }) : [];
    for (const rule of inlineRules) rule(local);
    for (const { node, values } of anchors) for (const [name, value] of values ?? []) node.attrSet(name, value);
    // These rules transform children/attributes, retaining the parsed roots.
    // A future root-rewriting plugin must join the global block phase instead.
    if (local.tokens.length !== group.to - group.from
      || local.tokens.some((node, offset) => node !== tokens[group.from + offset])) {
      throw new Error('Inline Markdown rules changed document roots');
    }
    group.ready = true;
  };
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]!;
    if (tokens.slice(group.from, group.to).some(node => node.type === 'heading_open'
      // A bare void break neither owns a container nor implicitly closes one.
      // Keep other HTML (including attributes/closing tags) conservative.
      || node.type === 'inline' && /<(?!br[ \t]*\/?>)/i.test(node.content))) prepare(index);
  }
  documentAnchors(state);
  anchorsApplied = true;
  return {
    tokens,
    prepareRange(start: number, end: number) {
      if (start >= end) return;
      for (let index = groupAt[start]!; index <= groupAt[end - 1]!; index++) prepare(index);
    },
    prepareAll() { for (let index = 0; index < groups.length; index++) prepare(index); }
  };
}
