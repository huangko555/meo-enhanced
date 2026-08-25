import { createEditor } from './test-editor-factory';
import { setMathRendererProbe } from '../src/shared/mathRenderer';

(globalThis as typeof globalThis & {
  RenderedBlockModeShellProductionHarness?: {
    createEditor: typeof createEditor;
    setMathRendererProbe: typeof setMathRendererProbe;
  };
}).RenderedBlockModeShellProductionHarness = {
  createEditor,
  setMathRendererProbe
};
