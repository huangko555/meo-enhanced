import { createCodeMirrorDomTableColumnWidthAdapter } from '../webview/src/editor/tableColumnWidthAdapter';

declare global {
  interface Window {
    TableColumnWidthLifecycleHarness?: {
      create(root: HTMLElement): ReturnType<typeof createCodeMirrorDomTableColumnWidthAdapter>['adapter'];
    };
  }
}

window.TableColumnWidthLifecycleHarness = {
  create(root) {
    return createCodeMirrorDomTableColumnWidthAdapter({ root }).adapter;
  }
};
