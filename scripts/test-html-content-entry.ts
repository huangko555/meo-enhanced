import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createEditor } from './test-editor-factory';
import { getLiveRenderedBlocks } from '../webview/src/helpers/liveRenderedBlocks';
import { bindTooltips } from '../webview/src/adapters/tooltip';
import { applyUiTheme } from '../webview/src/helpers/uiTheme';
import { handleEditorShortcut } from '../webview/src/helpers/shortcuts';
import { effectiveShortcuts } from '../src/application/editingPreferences';
import { usesLargeDocumentDerivedWorkBudget } from '../webview/src/editor/liveInputDerivedWork';
import { enterHtmlSource, getHtmlEditingRange } from '../webview/src/helpers/htmlContent';
import { setImageSrcResolver } from '../webview/src/helpers/images';
import { undo, redo } from '@codemirror/commands';
import { resolveHtmlResources } from '../webview/src/helpers/htmlResources';

export function observeEditorTransactions(view: EditorView, records: Array<Record<string, unknown>>): void {
  let observing = false;
  view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.updateListener.of(update => {
    if (!observing) return;
    const historyDirection = update.transactions.some(transaction => transaction.isUserEvent('undo')) ? 'undo'
      : update.transactions.some(transaction => transaction.isUserEvent('redo')) ? 'redo' : null;
    records.push({ docChanged: update.docChanged, selectionSet: update.selectionSet,
      selection: update.state.selection.toJSON(), text: update.state.doc.toString(), transactionCount: update.transactions.length,
      transactionSelections: update.transactions.map(transaction => transaction.selection?.toJSON() ?? null), historyDirection });
  })) });
  observing = true;
}

(globalThis as typeof globalThis & {
  HtmlContentHarness?: {
    createEditor: typeof createEditor;
    getLiveRenderedBlocks: typeof getLiveRenderedBlocks;
    bindTooltips: typeof bindTooltips;
    applyUiTheme: typeof applyUiTheme;
    handleEditorShortcut: typeof handleEditorShortcut;
    effectiveShortcuts: typeof effectiveShortcuts;
    usesLargeDocumentDerivedWorkBudget: typeof usesLargeDocumentDerivedWorkBudget;
    enterHtmlSource: typeof enterHtmlSource;
    getHtmlEditingRange: typeof getHtmlEditingRange;
    setImageSrcResolver: typeof setImageSrcResolver;
    undo: typeof undo;
    redo: typeof redo;
    resolveHtmlResources: typeof resolveHtmlResources;
    observeEditorTransactions: typeof observeEditorTransactions;
  };
}).HtmlContentHarness = { createEditor, getLiveRenderedBlocks, bindTooltips, applyUiTheme, handleEditorShortcut, effectiveShortcuts, usesLargeDocumentDerivedWorkBudget,
  enterHtmlSource, getHtmlEditingRange, setImageSrcResolver, undo, redo, resolveHtmlResources, observeEditorTransactions };
