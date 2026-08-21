import { createEditor } from './test-editor-factory';
import { setImageSrcResolver } from '../webview/src/helpers/images';

(globalThis as typeof globalThis & {
  SourceLightweightImageHarness?: {
    createEditor: typeof createEditor;
    setImageSrcResolver: typeof setImageSrcResolver;
  };
}).SourceLightweightImageHarness = {
  createEditor,
  setImageSrcResolver
};
