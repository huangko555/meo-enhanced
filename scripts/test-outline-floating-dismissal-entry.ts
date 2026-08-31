import { createOutlineController } from '../webview/src/helpers/outline';

(globalThis as typeof globalThis & {
  OutlineFloatingDismissalHarness?: { createOutlineController: typeof createOutlineController };
}).OutlineFloatingDismissalHarness = { createOutlineController };
