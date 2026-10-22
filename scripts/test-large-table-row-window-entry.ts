import { createEditor } from './test-editor-factory';
import { ensureMountedTableCell, mountedTableClipboardText } from '../webview/src/helpers/tables';
import { getLiveTableRowGeometry } from '../webview/src/helpers/gitDiffOverviewRuler';
import { estimateBlockWidgetHeight } from '../webview/src/editor/blockWidgetHeight';
import { applyBuiltInVisualBaseline } from '../webview/src/helpers/theme';
import { tableRowWindowFor } from '../webview/src/editor/tableRowWindow';
import { getViewportController } from '../webview/src/helpers/viewportController';
(window as any).windowMeasuredHeight = () => estimateBlockWidgetHeight({ kind: 'table', headerCells: ['A'], rows: [], measuredHeight: 75_000 });
(window as any).windowGeometry = getLiveTableRowGeometry;
(window as any).windowCell = ensureMountedTableCell;
(window as any).windowCopy = mountedTableClipboardText;
(window as any).windowRows = tableRowWindowFor;
(window as any).windowViewport = getViewportController;
(window as any).createWindowEditor = (text: string) => {
  applyBuiltInVisualBaseline('dark');
  (window as any).windowEditor = createEditor({ parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {} });
};
