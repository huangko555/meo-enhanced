import { ViewportController } from '../webview/src/helpers/viewportController';
import { Text } from '@codemirror/state';
(window as any).FractionalViewportHarness = { ViewportController, Text };
