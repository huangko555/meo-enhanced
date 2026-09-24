import { createEditorNoticeController } from '../webview/src/helpers/notices';
import { createFailureNoticeManager } from '../webview/src/helpers/errors';
import { applyBuiltInVisualBaseline } from '../webview/src/helpers/theme';

(globalThis as typeof globalThis & {
  EditorNoticeHarness?: {
    createEditorNoticeController: typeof createEditorNoticeController;
    createFailureNoticeManager: typeof createFailureNoticeManager;
    applyBuiltInVisualBaseline: typeof applyBuiltInVisualBaseline;
  };
}).EditorNoticeHarness = {
  createEditorNoticeController,
  createFailureNoticeManager,
  applyBuiltInVisualBaseline
};
