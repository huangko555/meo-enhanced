import { createPreviewController } from '../webview/src/helpers/preview';

const controller = createPreviewController({ vscode: { postMessage() {} } });
document.body.append(controller.host);
controller.setVisible(true);
(window as typeof window & { __previewController?: typeof controller }).__previewController = controller;
