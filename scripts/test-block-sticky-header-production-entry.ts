import { createEditor } from './test-editor-factory';
import { bindTooltips } from '../webview/src/adapters/tooltip';
import './test-mermaid-editing-entry';

(globalThis as any).BlockStickyHeaderHarness = { createEditor, bindTooltips };
