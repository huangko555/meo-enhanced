import { undoDepth } from '@codemirror/commands';
import { createEditor } from './test-editor-factory';
import { setImageSrcResolver } from '../webview/src/helpers/images';

(globalThis as typeof globalThis & {
  SourceLightweightImageHarness?: {
    createEditor: typeof createEditor;
    setImageSrcResolver: typeof setImageSrcResolver;
    historyDepth(editor: ReturnType<typeof createEditor>): number;
  };
}).SourceLightweightImageHarness = {
  createEditor,
  setImageSrcResolver,
  historyDepth(editor) {
    return undoDepth(editor.view.state);
  }
};
