import { EditorSelection, EditorState, StateEffect } from '@codemirror/state';
import { cursorGroupLeft, cursorGroupRight, selectGroupLeft, selectGroupRight, deleteGroupBackward, deleteGroupForward } from '@codemirror/commands';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { usesLargeDocumentDerivedWorkBudget } from '../webview/src/editor/liveInputDerivedWork';
import { createEditor } from './test-editor-factory';
import { applyBuiltInVisualBaseline } from '../webview/src/helpers/theme';

applyBuiltInVisualBaseline('dark');

Object.assign(window, {
  __createWordEditor: createEditor,
  __wordSelection: EditorSelection,
  __wordAssessment: assessLargeDocument,
  __wordOptimized: usesLargeDocumentDerivedWorkBudget,
  __nativeWordCommands: { left: cursorGroupLeft, right: cursorGroupRight, extendLeft: selectGroupLeft,
    extendRight: selectGroupRight, backspace: deleteGroupBackward, delete: deleteGroupForward },
  __makeWordEditorReadOnly() {
    const view = (window as any).__wordEditor.view;
    view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
  },
  __observeWordSegmentation() {
    const prototype = Intl.Segmenter.prototype, original = prototype.segment;
    let lengths: number[] = [];
    prototype.segment = function(input: string) {
      lengths.push(input.length);
      return original.call(this, input);
    };
    return {
      take() { const result = lengths; lengths = []; return result; },
      restore() { prototype.segment = original; }
    };
  }
});
