import { createEditor } from '../webview/src/editor';
import { setImageSrcResolver } from '../webview/src/helpers/images';

(globalThis as typeof globalThis & {
  TableStabilityHarness?: {
    createEditor: typeof createEditor;
    setImageSrcResolver: typeof setImageSrcResolver;
  };
}).TableStabilityHarness = { createEditor, setImageSrcResolver };
