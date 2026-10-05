import { createEditor } from './test-editor-factory';
import { getLiveRenderedBlocks } from '../webview/src/helpers/liveRenderedBlocks';
import { bindTooltips } from '../webview/src/adapters/tooltip';

(globalThis as typeof globalThis & {
  HtmlContentHarness?: {
    createEditor: typeof createEditor;
    getLiveRenderedBlocks: typeof getLiveRenderedBlocks;
    bindTooltips: typeof bindTooltips;
  };
}).HtmlContentHarness = { createEditor, getLiveRenderedBlocks, bindTooltips };
