import { StateField, Transaction, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { renderLatexMathToHtml } from './math';
import { collectDocumentMathRanges, getDisplayMathCopySource, getDisplayMathSource } from './displayMathBlocks';
import { createCopyCodeButton, createSelectAllCodeButton } from './codeBlockControls';
import { uiLanguageFacet } from '../editor/uiLanguage';
import { isLiveInputDerivedWorkRefresh, isMappedLiveInputRefresh, shouldDeferLiveInputDerivedWork, usesLargeDocumentDerivedWorkBudget } from '../editor/liveInputDerivedWork';
import { getLivePresentationBand, livePresentationBandChanged } from './liveViewportPresentation';

/** Formula editing belongs to the document selection, including both delimiters. */
export function isDisplayMathEditing(state: EditorState, startLine: number, endLine: number): boolean {
  return state.selection.ranges.some(range => {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.empty ? range.to : range.to - 1).number;
    return first <= endLine && last >= startLine;
  });
}

type ValidResult = { from: number; to: number; html: string };

function mapValidResults(previous: readonly ValidResult[], transaction: Transaction): ValidResult[] {
  return previous.filter(result => {
    let deleted = false;
    transaction.changes.iterChangedRanges((from, to) => {
      if (from <= result.from && to >= result.to) deleted = true;
    });
    return !deleted;
  }).map(result => ({ ...result, from: transaction.changes.mapPos(result.from, 1), to: transaction.changes.mapPos(result.to, -1) }));
}

function collectValidResults(state: EditorState, previous: readonly ValidResult[], transaction?: Transaction): ValidResult[] {
  const mapped = transaction ? mapValidResults(previous, transaction) : previous;
  const ranges = collectDocumentMathRanges(state);
  const band = getLivePresentationBand(state);
  const current = ranges.filter(range => !band || range.to >= band.from && range.from <= band.to
    || state.selection.ranges.some(selection => selection.head <= range.to && selection.head >= range.from));
  const candidates = new Set(current.map(range => `${range.from}:${range.to}`));
  const remaining = new Set(ranges.map(range => `${range.from}:${range.to}`));
  const results: ValidResult[] = band ? mapped.filter(result => remaining.has(`${result.from}:${result.to}`)
    && !candidates.has(`${result.from}:${result.to}`)) : [];
  for (const range of current) {
    if (!range.fencedDisplay || !range.content.trim()) continue;
    const html = renderLatexMathToHtml(range.content, 'display');
    const valid = html && !html.includes('class="katex-error"') ? html : mapped.find(result => result.from === range.from && result.to === range.to)?.html;
    if (valid) results.push({ from: range.from, to: range.to, html: valid });
  }
  let bytes = results.reduce((sum, result) => sum + result.html.length * 2 + 64, 0);
  while (bytes > 2 * 1024 * 1024 && results.length > 1) {
    const oldest = results.shift()!; bytes -= oldest.html.length * 2 + 64;
  }
  return results;
}

// Retain a valid result across incomplete input, but never carry it to a replaced block.
export const displayMathResultField = StateField.define<readonly ValidResult[]>({
  create: state => collectValidResults(state, []),
  update(value, transaction) {
    const largeDocument = usesLargeDocumentDerivedWorkBudget(transaction.state);
    if (largeDocument && !transaction.docChanged && shouldDeferLiveInputDerivedWork(transaction)) return value;
    if (largeDocument && isMappedLiveInputRefresh(transaction)) return value;
    if (largeDocument && isLiveInputDerivedWorkRefresh(transaction)) return collectValidResults(transaction.state, value);
    if (!transaction.docChanged) return largeDocument && (livePresentationBandChanged(transaction) || transaction.selection)
      ? collectValidResults(transaction.state, value) : value;
    if (largeDocument && shouldDeferLiveInputDerivedWork(transaction)) {
      let touchesKnownFormula = false;
      transaction.changes.iterChangedRanges((from, to) => {
        if (value.some(result => from <= result.to && to >= result.from)) touchesKnownFormula = true;
      });
      // Ordinary prose edits only map the last valid formula positions. Edits
      // inside a known formula still capture every valid intermediate result.
      if (!touchesKnownFormula) return mapValidResults(value, transaction);
    }
    return collectValidResults(transaction.state, value, transaction);
  }
});

export function getPreviousDisplayMathResult(state: EditorState, from: number, to: number): string | undefined {
  return state.field(displayMathResultField, false)?.find(result => result.from === from && result.to === to)?.html;
}

export function selectedDisplayMathBody(state: EditorState) {
  const selection = state.selection.main;
  const range = collectDocumentMathRanges(state).find(range => range.fencedDisplay
    && selection.from >= state.doc.lineAt(range.from).to + 1
    && selection.to < state.doc.lineAt(range.to - 1).from);
  if (!range) return null;
  const source = getDisplayMathSource(state, range);
  return source ? { first: source.first.number, last: source.last.number, prefix: source.prefix } : null;
}

/** Literal LaTeX paste retains Markdown containers without treating TeX as prose. */
export function displayMathPasteText(view: EditorView, text: string): string | null {
  if (!view.dom.classList.contains('meo-mode-live')) return null;
  const body = selectedDisplayMathBody(view.state);
  return body ? text.replace(/\r\n?/g, '\n').replaceAll('\n', '\n' + body.prefix) : null;
}

export function indentDisplayMathSource(view: EditorView, outdent: boolean): boolean {
  if (!view.dom.classList.contains('meo-mode-live') || view.state.selection.ranges.length !== 1 || view.state.readOnly) return false;
  const body = selectedDisplayMathBody(view.state);
  if (!body) return false;
  const selection = view.state.selection.main;
  const first = Math.max(body.first, view.state.doc.lineAt(selection.from).number);
  const last = Math.min(body.last, view.state.doc.lineAt(selection.empty ? selection.to : selection.to - 1).number);
  const changes = [];
  for (let number = first; number <= last; number++) {
    const line = view.state.doc.line(number);
    const from = line.from + (line.text.startsWith(body.prefix) ? body.prefix.length : 0);
    const remove = outdent ? /^(?: {1,2}|\t)/.exec(view.state.doc.sliceString(from, line.to))?.[0].length ?? 0 : 0;
    changes.push({ from, to: from + remove, insert: outdent ? '' : '  ' });
  }
  view.dispatch({ changes, annotations: Transaction.userEvent.of('input.indent') });
  return true;
}

/** TeX operators and Markdown containers are literal while editing the body. */
export function insertDisplayMathNewline(view: EditorView): boolean {
  if (view.state.readOnly || view.state.selection.ranges.length !== 1) return false;
  const body = selectedDisplayMathBody(view.state);
  if (!body) return false;
  const { from, to } = view.state.selection.main;
  const insert = '\n' + body.prefix;
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length },
    annotations: Transaction.userEvent.of('input') });
  return true;
}

export function createDisplayMathActions(view: EditorView, anchor: () => number): HTMLSpanElement {
  const ownerDocument = view.dom.ownerDocument;
  const actions = ownerDocument.createElement('span');
  actions.className = 'meo-math-copy-actions';
  const body = () => {
    const range = collectDocumentMathRanges(view.state)
      .find(range => range.fencedDisplay && view.state.doc.lineAt(range.from).from === anchor());
    return range ? getDisplayMathCopySource(view.state, range) : null;
  };
  const language = view.state.facet(uiLanguageFacet);
  const select = createSelectAllCodeButton(() => {
    const source = body();
    if (!source) return;
    view.dispatch({ selection: { anchor: source.from, head: source.to }, scrollIntoView: true });
    view.focus();
  }, language, ownerDocument);
  const label = language === 'zh-CN' ? '全选公式源码' : 'Select formula source';
  select.dataset.tooltip = label;
  select.setAttribute('aria-label', label);
  const copy = createCopyCodeButton(() => {
    const source = body();
    if (!source) return '';
    return source.text;
  }, language, ownerDocument);
  for (const type of ['pointerdown', 'mousedown']) actions.addEventListener(type, event => {
    event.preventDefault(); event.stopPropagation();
  });
  actions.append(select, copy);
  return actions;
}
