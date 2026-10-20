import type { DecorationSet } from '@codemirror/view';
import { EditorState, Transaction } from '@codemirror/state';
import { createEditor } from './test-editor-factory';
import { beginLiveInputComposition, completeLiveInputComposition, hasMappedLiveInputPresentation, isLiveInputDerivedWorkPending, usesLargeDocumentDerivedWorkBudget } from '../webview/src/editor/liveInputDerivedWork';
import { getLiveRenderedBlocks } from '../webview/src/helpers/liveRenderedBlocks';
import { setHtmlEditingRangeEffect } from '../webview/src/helpers/htmlContent';
import { sourceSyntaxPreparation } from '../webview/src/helpers/sourceSyntax';
import { ensureSyntaxTree, forceParsing, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { diagnosticDataField } from '../webview/src/helpers/diagnostics';
import { replaceLocalLinkStatuses } from '../webview/src/helpers/localLinks';
import { getGitDiffSummary, getGitDiffOriginalBlocks } from '../webview/src/helpers/gitDiffGutter';
import { editorMarkdownLanguage, getLivePresentationDecorations } from '../webview/src/liveMode';
import { parseFootnotes } from '../webview/src/helpers/footnotes';
import { editorScrollIntoView } from '../webview/src/editor/scrollEffects';
import { isCompleteMarkdownStructure, markdownStructureIdentity } from '../webview/src/editor/markdownStructure';
import { assertBackgroundMarkdownPreparation } from '../webview/src/editor/backgroundMarkdownStructure';

function footnoteSnapshot(state: EditorState) {
  const parsed = parseFootnotes(state);
  return { definitions: parsed.definitions, numbers: [...parsed.numberByLabel],
    references: parsed.references.map(({ definition, ...reference }) => ({ ...reference, definitionFrom: definition?.lineFrom })) };
}

(window as any).__liveHistory = {
  create: createEditor,
  beginComposition: (editor: ReturnType<typeof createEditor>) => beginLiveInputComposition(editor.view),
  completeComposition: (editor: ReturnType<typeof createEditor>) => completeLiveInputComposition(editor.view),
  largeBudget: (editor: ReturnType<typeof createEditor>) => usesLargeDocumentDerivedWorkBudget(editor.view.state),
  sourcePreparation: (editor: ReturnType<typeof createEditor>) => !!editor.view.plugin(sourceSyntaxPreparation),
  parse: (editor: ReturnType<typeof createEditor>) => forceParsing(editor.view, editor.view.state.doc.length, 2_000),
  gitSummary: (editor: ReturnType<typeof createEditor>) => getGitDiffSummary(editor.view.state),
  originalBlocks: (editor: ReturnType<typeof createEditor>) => getGitDiffOriginalBlocks(editor.view.state),
  mapped: (editor: ReturnType<typeof createEditor>) => hasMappedLiveInputPresentation(editor.view.state),
  renderedBlocks: (editor: ReturnType<typeof createEditor>) => getLiveRenderedBlocks(editor.view.state, { includeSelectedMath: true }),
  publishedRenderedBlocks: (editor: ReturnType<typeof createEditor>) => getLiveRenderedBlocks(editor.view.state,
    { includeSelectedMath: true, tree: syntaxTree(editor.view.state) }),
  freshRenderedBlocks(editor: ReturnType<typeof createEditor>) {
    const state = EditorState.create({ doc: editor.getText(), selection: editor.view.state.selection, extensions: editorMarkdownLanguage });
    ensureSyntaxTree(state, state.doc.length, 2_000);
    return getLiveRenderedBlocks(state, { includeSelectedMath: true });
  },
  editHtml(editor: ReturnType<typeof createEditor>, from: number, to: number) {
    editor.view.dispatch({ effects: setHtmlEditingRangeEffect.of({ from, to }) });
  },
  syntaxInfo: (editor: ReturnType<typeof createEditor>) => ({ published: syntaxTree(editor.view.state).length,
    length: editor.view.state.doc.length, available: syntaxTreeAvailable(editor.view.state, editor.view.state.doc.length) }),
  markdownReady: (editor: ReturnType<typeof createEditor>) => isCompleteMarkdownStructure(syntaxTree(editor.view.state), editor.view.state.doc.length),
  markdownIdentity: (editor: ReturnType<typeof createEditor>) => markdownStructureIdentity(syntaxTree(editor.view.state)),
  parseFailure(editor: ReturnType<typeof createEditor>) {
    try { assertBackgroundMarkdownPreparation(editor.view.state); return null; }
    catch (error) { return String(error); }
  },
  syntaxPath(editor: ReturnType<typeof createEditor>, position: number) {
    const path: string[] = [];
    for (let node = syntaxTree(editor.view.state).resolveInner(position); node; node = node.parent!) path.push(node.name);
    return path;
  },
  scrollOnly(editor: ReturnType<typeof createEditor>) {
    const before = getLivePresentationDecorations(editor.view.state);
    editor.view.dispatch({ effects: editorScrollIntoView(editor.view.state.selection.main.head) });
    return getLivePresentationDecorations(editor.view.state) === before;
  },
  footnotes: (editor: ReturnType<typeof createEditor>) => footnoteSnapshot(editor.view.state),
  freshFootnotes(editor: ReturnType<typeof createEditor>) {
    const state = EditorState.create({ doc: editor.getText(), extensions: editorMarkdownLanguage });
    ensureSyntaxTree(state, state.doc.length, 2_000);
    return footnoteSnapshot(state);
  },
  positionSnapshot(editor: ReturnType<typeof createEditor>) {
    const result: unknown[] = [];
    for (const cursor = this.decorations(editor).iter(); cursor.value; cursor.next()) {
      const widget = cursor.value.spec.widget;
      const positions: Record<string, unknown> = {};
      for (const key of ['anchor', 'blockTo', 'blockFrom', 'contentFrom', 'contentTo', 'urlFrom', 'urlTo',
        'definitionFrom', 'referenceFrom', 'bracketStart', 'sourceFrom', 'from', 'to', 'startLine', 'endLine']) {
        if (typeof widget?.[key] === 'number') positions[key] = widget[key];
      }
      for (const key of ['tableData', 'block', 'range', 'items']) {
        if (!widget?.[key]) continue;
        const value = widget[key];
        positions[key] = Array.isArray(value) ? value : Object.fromEntries(['from', 'to', 'startLine', 'endLine', 'signature', 'sourceRanges']
          .filter(field => value[field] !== undefined).map(field => [field, value[field]]));
      }
      result.push([cursor.from, cursor.to, cursor.value.spec.class, cursor.value.spec.attributes,
        widget?.constructor.name, positions]);
    }
    return result;
  },
  setLocalStatuses: replaceLocalLinkStatuses,
  pending: (editor: ReturnType<typeof createEditor>) => isLiveInputDerivedWorkPending(editor.view.state),
  diagnostics: (editor: ReturnType<typeof createEditor>) => editor.view.state.field(diagnosticDataField),
  decorations(editor: ReturnType<typeof createEditor>): DecorationSet {
    return getLivePresentationDecorations(editor.view.state);
  },
  input(editor: ReturnType<typeof createEditor>, from: number, text: string, time?: number) {
    editor.view.dispatch({ changes: { from, insert: text }, selection: { anchor: from + text.length },
      annotations: [Transaction.userEvent.of('input.type'), ...(time === undefined ? [] : [Transaction.time.of(time)])] });
  }
};
