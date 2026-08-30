import './test-live-embedded-input-viewport-entry';
import { estimateBlockWidgetHeight } from '../webview/src/editor/blockWidgetHeight';

(window as typeof window & {
  BlockWidgetHeightHarness?: { estimate: typeof estimateBlockWidgetHeight };
}).BlockWidgetHeightHarness = { estimate: estimateBlockWidgetHeight };
