import { CharCategory, EditorSelection, findClusterBreak, type EditorState, type Extension, type SelectionRange } from '@codemirror/state';
import { Direction, EditorView, keymap, type Command } from '@codemirror/view';

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
/** Segmentation context kept on each side of a looked-up position, in UTF-16 units. */
const contextRadius = 4096;
const maxWindows = 8;
const han = /\p{Script=Han}/u;

type WordLookup = (pos: number, bias: number) => SelectionRange | null;
type Group = { from: number; to: number };

/** CodeMirror's `groupAt` over one line's text, with a caller-defined group.
 * `member` receives the cluster on the `bias` side of `local` and returns the
 * predicate for further clusters, or null when that cluster starts no group. */
function clusterGroup(text: string, local: number, bias: number,
  member: (seed: string) => ((cluster: string) => boolean) | null): Group | null {
  if (!text.length) return null;
  if (local === 0) bias = 1;
  else if (local === text.length) bias = -1;
  let from = bias < 0 ? findClusterBreak(text, local, false) : local;
  let to = bias < 0 ? local : findClusterBreak(text, local);
  const same = member(text.slice(from, to));
  if (!same) return null;
  for (let previous; from > 0 && same(text.slice(previous = findClusterBreak(text, from, false), from));) from = previous;
  for (let next; to < text.length && same(text.slice(to, next = findClusterBreak(text, to)));) to = next;
  return { from, to };
}

/** Word lookup for one editor state. Segmentation runs on operation-local,
 * bounded slices of a single line and is shared by neighboring cursors; there
 * is no full-document projection and nothing outlives the operation.
 *
 * Chinese words come from `Intl.Segmenter`. Every other word keeps CodeMirror's
 * character-group rules, except that it ends where Chinese text begins. */
function wordLookup(state: EditorState): WordLookup {
  // Keyed by the window's anchor offset, which always lies inside its own line.
  const windows = new Map<number, { from: number; to: number; segments: Intl.Segments }>();
  const chineseWord = (line: { from: number; to: number }, at: number): Group | null => {
    const cell = line.from + Math.floor((at - line.from) / contextRadius) * contextRadius;
    let window = windows.get(cell);
    if (!window) {
      const from = Math.max(line.from, cell - contextRadius), to = Math.min(line.to, cell + 2 * contextRadius);
      window = { from, to, segments: segmenter.segment(state.sliceDoc(from, to)) };
      // A single held drag can visit arbitrarily many lines. Keep only recent
      // windows, so its temporary cache cannot grow into a document projection.
      if (windows.size === maxWindows) windows.delete(windows.keys().next().value!);
      windows.set(cell, window);
    }
    const segment = window.segments.containing(at - window.from);
    if (!segment?.isWordLike || !han.test(segment.segment)) return null;
    const from = window.from + segment.index, to = from + segment.segment.length;
    // A segment cut by the slice edge is unreliable; leave it to character groups.
    if ((from === window.from && from > line.from) || (to === window.to && to < line.to)) return null;
    return { from, to };
  };
  return (pos, bias) => {
    const line = state.doc.lineAt(pos), local = pos - line.from;
    if (!line.length) return null;
    const at = local === 0 ? pos : local === line.length || bias < 0 ? pos - 1 : pos;
    const nearby = state.sliceDoc(Math.max(line.from, at - 1), Math.min(line.to, at + 2));
    const chinese = han.test(nearby) ? chineseWord(line, at) : null;
    if (chinese) return EditorSelection.range(chinese.from, chinese.to);
    const categorize = state.charCategorizer(pos);
    const isWord = (cluster: string) => categorize(cluster) === CharCategory.Word && !han.test(cluster);
    const group = clusterGroup(line.text, local, bias, seed => isWord(seed) ? isWord : null);
    return group && EditorSelection.range(line.from + group.from, line.from + group.to);
  };
}

/** Moves `pos` out of atomic ranges, repeating until no range contains it. */
function skipAtomic(view: EditorView, pos: number, forward: boolean): number {
  for (let moved = true; moved;) {
    moved = false;
    for (const getRanges of view.state.facet(EditorView.atomicRanges)) {
      getRanges(view).between(pos, pos, (from, to) => {
        if (from < pos && pos < to) { pos = forward ? to : from; moved = true; }
      });
    }
  }
  return pos;
}

/** The grapheme cluster (or line break) next to `pos`, or null at the document edge. */
function nextCluster(state: EditorState, pos: number, forward: boolean): { to: number; text: string } | null {
  if (pos === (forward ? state.doc.length : 0)) return null;
  const line = state.doc.lineAt(pos);
  if (pos === (forward ? line.to : line.from)) return { to: pos + (forward ? 1 : -1), text: '\n' };
  const to = line.from + findClusterBreak(line.text, pos - line.from, forward);
  return { to, text: state.sliceDoc(Math.min(pos, to), Math.max(pos, to)) };
}

/** Logical word movement for one left-to-right range, like `EditorView.moveByGroup`. */
function moveWord(view: EditorView, range: SelectionRange, forward: boolean, lookup: WordLookup): SelectionRange {
  const { state } = view, categorize = state.charCategorizer(range.head);
  let pos = range.head;
  for (let next; (next = nextCluster(state, pos, forward)) && categorize(next.text) === CharCategory.Space;) pos = next.to;
  const word = lookup(pos, forward ? 1 : -1);
  return word
    ? EditorSelection.cursor(skipAtomic(view, forward ? word.to : word.from, forward))
    : view.moveByGroup(range, forward);
}

/** `right` is the visual key direction, as in `cursorGroupRight`. */
function move(right: boolean, extend: boolean): Command {
  return view => {
    if (view.composing) return false;
    const { state } = view, lookup = wordLookup(state);
    const rtl = view.textDirectionAt(state.selection.main.head) === Direction.RTL;
    const forward = rtl ? !right : right;
    const selection = EditorSelection.create(state.selection.ranges.map(range => {
      if (!extend && !range.empty) return EditorSelection.cursor(forward ? range.to : range.from);
      // Embedded RTL spans also need visual movement, even in an LTR paragraph.
      const visual = rtl || view.bidiSpans(state.doc.lineAt(range.head)).some(span => (span.level & 1) !== 0);
      const target = visual ? view.moveByGroup(range, forward) : moveWord(view, range, forward, lookup);
      return extend
        ? EditorSelection.range(range.anchor, target.head, target.goalColumn, target.bidiLevel ?? undefined, target.assoc)
        : target;
    }), state.selection.mainIndex);
    if (!selection.eq(state.selection, true)) view.dispatch({ selection, scrollIntoView: true, userEvent: 'select' });
    return true;
  };
}

/** Deletion target for an empty range, following `deleteGroupBackward/Forward`:
 * a line edge deletes one line break, a single leading space is absorbed by the
 * following group, and a Chinese word ends the deletion at its boundary. */
function deletionTarget(state: EditorState, head: number, forward: boolean, lookup: WordLookup): number {
  const line = state.doc.lineAt(head), edge = forward ? line.to : line.from;
  if (head === edge) return head === (forward ? state.doc.length : 0) ? head : head + (forward ? 1 : -1);
  const categorize = state.charCategorizer(head);
  let pos = head, category: CharCategory | null = null;
  while (pos !== edge) {
    const next = nextCluster(state, pos, forward)!, nextCategory = categorize(next.text);
    if (category === null) {
      const word = lookup(pos, forward ? 1 : -1);
      if (word) return forward ? word.to : word.from;
    } else if (category !== nextCategory) break;
    if (next.text !== ' ' || pos !== head) category = nextCategory;
    pos = next.to;
  }
  return pos;
}

/** Mirrors CodeMirror's `deleteBy`, including atomic ranges and user events. */
function deleteWord(forward: boolean): Command {
  return view => {
    const { state } = view;
    if (state.readOnly || view.composing) return false;
    const lookup = wordLookup(state);
    let event = 'delete.selection';
    const changes = state.changeByRange(range => {
      let { from, to } = range;
      if (range.empty) {
        let towards = deletionTarget(state, range.head, forward, lookup);
        if (towards !== range.head) {
          event = forward ? 'delete.forward' : 'delete.backward';
          towards = skipAtomic(view, towards, forward);
        }
        from = Math.min(from, towards);
        to = Math.max(to, towards);
      } else {
        from = skipAtomic(view, from, false);
        to = skipAtomic(view, to, true);
      }
      return from === to ? { range } : { changes: { from, to }, range: EditorSelection.cursor(from, from < range.head ? -1 : 1) };
    });
    if (changes.changes.empty) return true;
    view.dispatch(state.update(changes, {
      scrollIntoView: true,
      userEvent: event,
      effects: event === 'delete.selection' ? EditorView.announce.of(state.phrase('Selection deleted')) : undefined
    }));
    return true;
  };
}

/** Double-click range: a word as above, otherwise CodeMirror's character group. */
function clickRange(state: EditorState, pos: number, bias: number, lookup: WordLookup): SelectionRange {
  const word = lookup(pos, bias);
  if (word) return word;
  const line = state.doc.lineAt(pos), categorize = state.charCategorizer(pos);
  const group = clusterGroup(line.text, pos - line.from, bias, seed => {
    const category = categorize(seed);
    return cluster => categorize(cluster) === category;
  });
  return group ? EditorSelection.range(line.from + group.from, line.from + group.to) : EditorSelection.cursor(pos);
}

/** Replaces CodeMirror's double-click style only; single and triple clicks are untouched. */
const doubleClickWordSelection = EditorView.mouseSelectionStyle.of((view, event) => {
  if (event.button !== 0 || event.detail !== 2) return null;
  let start = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false);
  let initial = view.state.selection, lookup = wordLookup(view.state);
  return {
    update(update) {
      if (update.docChanged) {
        start = { pos: update.changes.mapPos(start.pos), assoc: start.assoc };
        initial = initial.map(update.changes);
      }
      lookup = wordLookup(update.state);
    },
    get(current, extend, multiple) {
      const at = view.posAndSideAtCoords({ x: current.clientX, y: current.clientY }, false);
      let range = clickRange(view.state, at.pos, at.assoc, lookup);
      if (at.pos !== start.pos && !extend) {
        // Dragging keeps the originally double-clicked word and grows by whole words.
        const origin = clickRange(view.state, start.pos, start.assoc, lookup);
        const from = Math.min(origin.from, range.from), to = Math.max(origin.to, range.to);
        range = from < range.from ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
      }
      if (extend) return initial.replaceRange(initial.main.extend(range.from, range.to));
      return multiple ? initial.addRange(range) : EditorSelection.create([range]);
    }
  };
});

/** Same keys as CodeMirror's group commands in `standardKeymap` and `emacsStyleKeymap`. */
export const chineseWordNavigation: Extension = [
  keymap.of([
    { key: 'Mod-ArrowLeft', mac: 'Alt-ArrowLeft', run: move(false, false), shift: move(false, true) },
    { key: 'Mod-ArrowRight', mac: 'Alt-ArrowRight', run: move(true, false), shift: move(true, true) },
    { key: 'Mod-Backspace', mac: 'Alt-Backspace', run: deleteWord(false) },
    { key: 'Mod-Delete', mac: 'Alt-Delete', run: deleteWord(true) },
    { mac: 'Ctrl-Alt-h', run: deleteWord(false) }
  ]),
  doubleClickWordSelection
];
