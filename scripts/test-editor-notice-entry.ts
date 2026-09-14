import { createEditorNoticeController } from '../webview/src/helpers/notices';
import { createFailureNoticeManager } from '../webview/src/helpers/errors';

(globalThis as typeof globalThis & {
  EditorNoticeHarness?: {
    createEditorNoticeController: typeof createEditorNoticeController;
    createFailureNoticeManager: typeof createFailureNoticeManager;
  };
}).EditorNoticeHarness = { createEditorNoticeController, createFailureNoticeManager };
