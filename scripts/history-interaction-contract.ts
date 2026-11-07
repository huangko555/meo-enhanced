import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { assertNoDirectionReversal } from './product-frame-observation';

type Range = { anchor: number; head: number };
type Focus = { kind: 'document' | 'table' | 'other'; row: string | null; col: string | null;
  from: number | null; to: number | null; direction: string | null; value: string | null; sourceLine: number | null };
type Witness = { id: number; classes: string; top: number; height: number };
export type HistoryInteractionState = { text: string; ranges: Range[]; mainIndex: number; nativeRanges: Range[] | null;
  focus: Focus; scroll: number; visible: boolean; shellTop: number; witness: Witness | null };
export type HistoryInteractionTrace = { documents: string[]; samples: Array<Omit<HistoryInteractionState, 'text'> & { document: number }> };
type Surface = { witness: string | null; editor?: string };

// This function is serialized into the owning product page. It observes the
// actual editor; it neither dispatches edits nor reconstructs its presentation.
function readProductState(options: Surface, includeText: boolean, beforeClick?: string): any {
  const scope = window as any;
  const root = document.querySelector(options.editor ?? '.editor-host .cm-editor') as HTMLElement | null;
  const view = (root?.querySelector('.cm-content') as any)?.cmTile?.root?.view;
  if (!view) throw new Error('History contract: missing owning editor');
  const read = () => {
    const registry = scope.__historyContract ??= { nodes: new WeakMap(), sequence: 0, doc: null, text: '' };
    if (registry.doc !== view.state.doc) { registry.doc = view.state.doc; registry.text = view.state.doc.toString(); }
    const active = document.activeElement;
    const table = active instanceof HTMLTextAreaElement && !!active.closest('.meo-md-html-table-shell');
    const selection = view.state.selection;
    const bounds = view.scrollDOM.getBoundingClientRect();
    const caret = table ? active.getBoundingClientRect() : view.coordsAtPos(selection.main.head);
    const shell = document.querySelector('.mode-toolbar');
    if (!shell) throw new Error('History contract: missing menu-shell witness');
    const native = document.getSelection();
    let nativeRanges: Range[] | null = null;
    if (active === view.contentDOM && native?.anchorNode && native.focusNode
      && view.contentDOM.contains(native.anchorNode) && view.contentDOM.contains(native.focusNode)) {
      nativeRanges = [{ anchor: view.posAtDOM(native.anchorNode, native.anchorOffset), head: view.posAtDOM(native.focusNode, native.focusOffset) }];
    }
    let witness: Witness | null = null;
    if (options.witness !== null) {
      const lines = [...view.contentDOM.querySelectorAll('.cm-line')].filter((line: any) => line.textContent.includes(options.witness));
      if (lines.length !== 1) throw new Error('History contract: unchanged witness must be uniquely mounted');
      const node = lines[0] as HTMLElement;
      if (!registry.nodes.has(node)) registry.nodes.set(node, ++registry.sequence);
      const rect = node.getBoundingClientRect();
      witness = { id: registry.nodes.get(node), classes: node.className, top: rect.top, height: rect.height };
    }
    const state = { ranges: selection.ranges.map((range: any) => ({ anchor: range.anchor, head: range.head })), mainIndex: selection.mainIndex, nativeRanges,
      focus: { kind: table ? 'table' : active === view.contentDOM ? 'document' : 'other',
        row: table ? active.dataset.tableRow ?? null : null, col: table ? active.dataset.tableCol ?? null : null,
        from: table ? active.selectionStart : null, to: table ? active.selectionEnd : null,
        direction: table ? active.selectionDirection : null,
        value: table ? active.value : null, sourceLine: table ? view.state.doc.lineAt(selection.main.head).number : null },
      scroll: view.scrollDOM.scrollTop, visible: !!caret && caret.top >= bounds.top && caret.bottom <= bounds.bottom,
      shellTop: shell.getBoundingClientRect().top, witness };
    return { state, text: registry.text, doc: view.state.doc };
  };
  if (beforeClick) {
    const node = document.querySelector(beforeClick);
    if (!node) throw new Error('History contract: missing command boundary');
    const boundary = scope.__historyAction = { node, listener: null, state: null };
    boundary.listener = () => { const value = read(); boundary.state = { ...value.state, text: value.text }; };
    node.addEventListener('click', boundary.listener, { capture: true, once: true });
    return;
  }
  if (includeText) { const value = read(); return { ...value.state, text: value.text }; }
  const documents: string[] = [], samples: any[] = [];
  let lastDoc: unknown;
  scope.__historyTrace = { documents, samples };
  const sample = () => {
    try {
      const value = read();
      if (value.doc !== lastDoc) { documents.push(value.text); lastDoc = value.doc; }
      samples.push({ ...value.state, document: documents.length - 1 });
    } catch (error) { scope.__historyTrace.error = String(error); }
    scope.__historyFrame = requestAnimationFrame(sample);
  };
  sample();
}

export async function captureHistoryInteraction(page: Page, surface: Surface): Promise<HistoryInteractionState> {
  return page.evaluate(readProductState, surface, true);
}

/** Capture the actual pre-handler state, after focus borrowing and any earlier
 * input commit. A timer cannot race a snapshot taken in a previous event turn. */
export async function captureHistoryAction(page: Page, surface: Surface, selector: string): Promise<HistoryInteractionState> {
  await page.evaluate(readProductState, surface, true, selector);
  try {
    await page.click(selector);
    const state = await page.evaluate(() => (window as any).__historyAction?.state);
    assert.ok(state, 'The command must deliver its observed click');
    return state;
  } finally {
    await page.evaluate(() => {
      const scope = window as any, boundary = scope.__historyAction;
      boundary?.node.removeEventListener('click', boundary.listener, true); delete scope.__historyAction;
    });
  }
}

/** Shared assertions for every phase, including the frames before settlement. */
export function assertHistoryInteraction(trace: HistoryInteractionTrace, expected: HistoryInteractionState,
  options: { label: string; allowedTexts: readonly string[]; viewport: 'retain' | 'reveal'; witness: HistoryInteractionState['witness'] }): void {
  const { samples, documents } = trace, { label } = options;
  assert.notEqual(expected.focus.kind, 'other', label + ': expected focus owner must be an editor target');
  assert.equal(expected.visible, true, label + ': expected target must already have a valid visibility contract');
  assert.ok(samples.length >= 3, label + ': missing continuous observation');
  assert.ok(samples.every(sample => Number.isInteger(sample.document) && documents[sample.document] !== undefined
    && options.allowedTexts.includes(documents[sample.document])), label + ': history published an intermediate document');
  assert.ok(samples.every(sample => Math.abs(sample.shellTop - samples[0].shellTop) <= 1), label + ': menu shell moved');
  if (options.viewport === 'retain') assert.ok(samples.every(sample => Math.abs(sample.scroll - samples[0].scroll) <= 1), label + ': viewport jumped, including an intermediate frame');
  else assertNoDirectionReversal({ samples: samples.map((sample, frame) => ({ frame, timestamp: frame, anchor: null, metrics: { scroll: sample.scroll } })) }, sample => sample.metrics.scroll, 1);
  if (options.witness) for (const [frame, sample] of samples.entries()) {
    assert.deepEqual(sample.witness && { id: sample.witness.id, classes: sample.witness.classes, height: sample.witness.height },
      { id: options.witness.id, classes: options.witness.classes, height: options.witness.height },
      label + `: unchanged presentation was replaced or revealed as source at frame ${frame}: ${JSON.stringify({ ranges: sample.ranges, focus: sample.focus, document: sample.document })}`);
    if (options.viewport === 'retain') assert.ok(Math.abs(sample.witness!.top - options.witness.top) <= 1, label + ': unchanged content moved');
  }
  const last = samples.at(-1)!;
  assert.equal(documents[last.document], expected.text, label + ': document');
  assert.equal(last.visible, true, label + ': target is not visible');
  assert.deepEqual(last.focus, expected.focus, label + ': focus owner or native cell caret');
  if (expected.focus.kind === 'document') {
    assert.deepEqual(last.ranges, expected.ranges, label + ': logical selection');
    assert.equal(last.mainIndex, expected.mainIndex, label + ': primary selection');
    assert.deepEqual(last.nativeRanges, [expected.ranges[expected.mainIndex]], label + ': native selection');
  }
}

const completed = new Set<string>();

/** A caller supplies independently validated before/after states. Both replay
 * directions use the same focus, selection, viewport and presentation contract.
 * Component-specific readiness/assertions remain with the owning feature. */
export async function assertHistoryRoundTrip(page: Page, options: Surface & {
  label: string; before: HistoryInteractionState; after: HistoryInteractionState;
  viewport?: 'retain' | 'reveal'; settle?: (direction: 'undo' | 'redo') => Promise<void>;
  observePaint?: (action: () => Promise<void>, direction: 'undo' | 'redo') => Promise<void>;
}): Promise<void> {
  assert.notEqual(options.before.text, options.after.text, options.label + ': document mutation is required');
  assert.ok(!completed.has(options.label), options.label + ': duplicate history receipt');
  try {
    for (const direction of ['undo', 'redo'] as const) {
      const expected = direction === 'undo' ? options.before : options.after;
      await page.evaluate(readProductState, { witness: options.witness, editor: options.editor }, false);
      try {
        const replay = async () => {
          const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
          await page.keyboard.down(modifier); await page.keyboard.press(direction === 'undo' ? 'z' : 'y'); await page.keyboard.up(modifier);
          await options.settle?.(direction);
          // Include quiet-time derived publication. Component readiness remains
          // the owning feature's responsibility, separate from this window.
          await page.evaluate(async () => { for (let i = 0; i < 45; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
        };
        if (options.observePaint) await options.observePaint(replay, direction);
        else await replay();
        const trace = await page.evaluate(() => (window as any).__historyTrace) as HistoryInteractionTrace & { error?: string };
        assert.equal(trace.error, undefined, options.label + ': observer failed');
        assertHistoryInteraction(trace, expected, { label: `${options.label}/${direction}`,
          allowedTexts: [options.before.text, options.after.text], viewport: options.viewport ?? 'retain', witness: options.before.witness });
      } finally { await page.evaluate(() => { cancelAnimationFrame((window as any).__historyFrame); delete (window as any).__historyTrace; }); }
    }
    completed.add(options.label);
  } finally { await page.evaluate(() => { delete (window as any).__historyContract; }); }
}

export function assertHistoryCoverage(expected: readonly string[]): void {
  assert.deepEqual([...completed].sort(), [...new Set(expected)].sort(), 'Every declared editing case must complete both history directions');
}
