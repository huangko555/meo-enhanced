import { createEditorNoticeController } from '../webview/src/helpers/notices';

(globalThis as typeof globalThis & {
  EditorNoticeHarness?: { createEditorNoticeController: typeof createEditorNoticeController };
}).EditorNoticeHarness = { createEditorNoticeController };
