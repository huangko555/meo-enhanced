import type { InputAssistance } from '../../../src/foundation/editingPreferences';

const htmlCommentOpen = '<!--', htmlCommentClose = '-->';
export type CommentSelection = { readonly anchor: number; readonly head: number };
export type CommentEdit = { readonly from: number; readonly to: number; readonly insert: string; readonly selections: readonly (CommentSelection & { readonly index: number })[]; readonly template?: { from: number; to: number } };
export type CommentPlan = { readonly edits: readonly CommentEdit[]; readonly blocked: boolean };

/** Offset ranges retain source whitespace. Delimiters are removed, never reformatted. */
function completeHtmlComments(text: string, code: readonly { from: number; to: number }[] = []): { from: number; to: number }[] {
  const result: { from: number; to: number }[] = [];
  for (let from = text.indexOf(htmlCommentOpen); from >= 0;) {
    if (code.some(range => from >= range.from && from < range.to)) { from = text.indexOf(htmlCommentOpen, from + 4); continue; }
    const end = text.indexOf(htmlCommentClose, from + 4);
    if (end < 0) break;
    const body = text.slice(from + 4, end);
    if (!body.includes(htmlCommentOpen) && !body.includes('--!>')) result.push({ from, to: end + 3 });
    from = text.indexOf(htmlCommentOpen, end + 3);
  }
  return result;
}

export function planHtmlCommentToggle(text: string, selections: readonly CommentSelection[], lines: boolean, code: readonly { from: number; to: number }[] = []): CommentPlan {
  const comments = completeHtmlComments(text, code);
  const areas = selections.map((original, index) => {
    const selection = { anchor: original.anchor, head: original.head, index };
    const from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head);
    const containing = comments.find(comment => from >= comment.from && to <= comment.to);
    if (containing) return { ...containing, comment: true, selections: [selection] };
    if (!lines || from === to && !text.slice(text.slice(0, from).lastIndexOf('\n') + 1, text.indexOf('\n', from) < 0 ? text.length : text.indexOf('\n', from)).trim())
      return { from, to, comment: false, selections: [selection] };
    const endAt = to > from ? to - 1 : to;
    const lineEnd = text.indexOf('\n', endAt);
    return { from: text.slice(0, from).lastIndexOf('\n') + 1, to: lineEnd < 0 ? text.length : lineEnd, comment: false, selections: [selection] };
  }).sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: typeof areas = [];
  for (const area of areas) {
    const previous = merged.at(-1);
    if (previous && area.from <= previous.to && area.comment === previous.comment) {
      previous.to = Math.max(previous.to, area.to); previous.selections.push(...area.selections);
    } else merged.push(area);
  }
  const edits: CommentEdit[] = [];
  let delta = 0;
  for (const area of merged) {
    const source = text.slice(area.from, area.to);
    const before = text.slice(0, area.from);
    if (!area.comment && (lastMarker(before, htmlCommentOpen, code) > lastMarker(before, htmlCommentClose, code) || source.includes(htmlCommentOpen) || source.includes(htmlCommentClose) || source.includes('--!>') || comments.some(comment => area.from < comment.to && area.to > comment.from)))
      return { edits: [], blocked: true };
    const insert = area.comment ? source.slice(4, -3) : htmlCommentOpen + source + htmlCommentClose;
    const map = (position: number) => area.from + delta + (area.comment ? Math.max(0, Math.min(source.length - 7, position - area.from - 4)) : position - area.from + 4);
    edits.push({ from: area.from, to: area.to, insert,
      selections: area.selections.map(selection => ({ anchor: map(selection.anchor), head: map(selection.head), index: selection.index })),
      template: !area.comment && area.from === area.to ? { from: area.from + delta + 4, to: area.from + delta + 4 } : undefined });
    delta += insert.length - (area.to - area.from);
  }
  return { edits, blocked: false };
}

function lastMarker(text: string, marker: string, code: readonly { from: number; to: number }[]): number {
  let at = text.lastIndexOf(marker);
  while (at >= 0 && code.some(range => at >= range.from && at < range.to)) {
    if (at === 0) return -1;
    at = text.lastIndexOf(marker, at - 1);
  }
  return at;
}

export type CommentInputPlan = { readonly from: number; readonly to: number; readonly insert: string; readonly caret: number; readonly pair?: { from: number; to: number; open: string; close: string } };
/** A closing marker is recognized only after its entire three-character input. */
export function planHtmlCommentInput(text: string, at: number, typed: string, preferences: InputAssistance, automatic: boolean, code: readonly { from: number; to: number }[] = []): CommentInputPlan | null {
  if (typed === '-' && text.slice(Math.max(0, at - 3), at) === '<!-' && preferences.pairMode !== 'off') {
    const from = at - 3, before = text.slice(0, from);
    if (before.endsWith('\\') || lastMarker(before, htmlCommentOpen, code) > lastMarker(before, htmlCommentClose, code)) return null;
    if (text.slice(at, at + 3) === htmlCommentClose) return { from: at, to: at, insert: '-', caret: at + 1 };
    const insert = htmlCommentOpen + htmlCommentClose;
    return { from, to: at + (text[at] === '>' && automatic ? 1 : 0), insert, caret: from + 4, pair: { from, to: from + insert.length, open: htmlCommentOpen, close: htmlCommentClose } };
  }
  if (typed === '>' && text.slice(at - 2, at) === '--' && text.slice(at, at + 3) === htmlCommentClose
    && preferences.skipMode !== 'off' && (automatic || preferences.skipMode === 'always')
    && completeHtmlComments(text).some(comment => comment.to === at + 3))
    return { from: at - 2, to: at, insert: '', caret: at + 1 };
  return null;
}

export function deleteEmptyHtmlComment(text: string, at: number, preferences: InputAssistance, automatic: boolean): boolean {
  return preferences.deleteMode !== 'off' && (automatic || preferences.deleteMode === 'always')
    && text.slice(at - 4, at) === htmlCommentOpen && text.slice(at, at + 3) === htmlCommentClose;
}
