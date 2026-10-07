import '../webview/src/index';
import { createPreviewSearchController, previewSearchStyles } from '../webview/src/helpers/previewSearch';

// Exercise the production controller lifecycle on a large rendered text node.
(window as any).PreviewSearchHarness = { createPreviewSearchController, previewSearchStyles };
