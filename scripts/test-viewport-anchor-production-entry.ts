import '../webview/src/index';
import * as observation from './product-frame-observation';

(globalThis as typeof globalThis & { ProductFrameObservation?: typeof observation }).ProductFrameObservation = observation;
