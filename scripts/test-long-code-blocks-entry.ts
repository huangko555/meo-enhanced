import { createEditor } from './test-editor-factory';
import { estimateBlockWidgetHeight } from '../webview/src/editor/blockWidgetHeight';

(globalThis as typeof globalThis & {
  LongCodeBlocksHarness?: {
    createEditor: typeof createEditor;
    estimateBlockWidgetHeight: typeof estimateBlockWidgetHeight;
  };
}).LongCodeBlocksHarness = { createEditor, estimateBlockWidgetHeight };
