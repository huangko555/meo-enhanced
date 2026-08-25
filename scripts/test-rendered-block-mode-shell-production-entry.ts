import { createEditor } from './test-editor-factory';
import { getMathRendererProbeViolation, setMathRendererProbe } from '../src/shared/mathRenderer';

(globalThis as typeof globalThis & {
  RenderedBlockModeShellProductionHarness?: {
    createEditor: typeof createEditor;
    getMathRendererProbeViolation: typeof getMathRendererProbeViolation;
    setMathRendererProbe: typeof setMathRendererProbe;
  };
}).RenderedBlockModeShellProductionHarness = {
  createEditor,
  getMathRendererProbeViolation,
  setMathRendererProbe
};
