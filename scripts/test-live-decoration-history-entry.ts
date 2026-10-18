import { EditorView, type DecorationSet } from '@codemirror/view';
import { Transaction } from '@codemirror/state';
import { createEditor } from './test-editor-factory';
import { beginLiveInputComposition, completeLiveInputComposition, isLiveInputDerivedWorkPending, usesLargeDocumentDerivedWorkBudget } from '../webview/src/editor/liveInputDerivedWork';
import { sourceSyntaxPreparation } from '../webview/src/helpers/sourceSyntax';
import { forceParsing } from '@codemirror/language';
import { diagnosticDataField } from '../webview/src/helpers/diagnostics';
import { replaceLocalLinkStatuses } from '../webview/src/helpers/localLinks';
import { getGitDiffSummary } from '../webview/src/helpers/gitDiffGutter';

(window as any).__liveHistory = {
  create: createEditor,
  beginComposition: (editor: ReturnType<typeof createEditor>) => beginLiveInputComposition(editor.view),
  completeComposition: (editor: ReturnType<typeof createEditor>) => completeLiveInputComposition(editor.view),
  largeBudget: (editor: ReturnType<typeof createEditor>) => usesLargeDocumentDerivedWorkBudget(editor.view.state),
  sourcePreparation: (editor: ReturnType<typeof createEditor>) => !!editor.view.plugin(sourceSyntaxPreparation),
  parse: (editor: ReturnType<typeof createEditor>) => forceParsing(editor.view, editor.view.state.doc.length, 2_000),
  gitSummary: (editor: ReturnType<typeof createEditor>) => getGitDiffSummary(editor.view.state),
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
    return editor.view.state.facet(EditorView.decorations)
      .filter((value): value is DecorationSet => typeof value !== 'function')
      .sort((left, right) => right.size - left.size)[0];
  },
  input(editor: ReturnType<typeof createEditor>, from: number, text: string, time?: number) {
    editor.view.dispatch({ changes: { from, insert: text }, selection: { anchor: from + text.length },
      annotations: [Transaction.userEvent.of('input.type'), ...(time === undefined ? [] : [Transaction.time.of(time)])] });
  }
};
