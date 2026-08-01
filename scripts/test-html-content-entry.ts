import { createEditor } from '../webview/src/editor';
import { getLiveRenderedBlocks } from '../webview/src/helpers/liveRenderedBlocks';

(globalThis as typeof globalThis & {
  HtmlContentHarness?: {
    createEditor: typeof createEditor;
    getLiveRenderedBlocks: typeof getLiveRenderedBlocks;
  };
}).HtmlContentHarness = { createEditor, getLiveRenderedBlocks };
