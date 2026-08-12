export interface ProductSemanticAnchor {
  readonly key: string;
  readonly documentPosition: number;
  readonly viewportOffset: number;
}

export interface ProductFrameSample {
  readonly anchor: ProductSemanticAnchor | null;
  readonly metrics: Readonly<Record<string, number>>;
}

export interface ObservedProductFrame extends ProductFrameSample {
  readonly frame: number;
  readonly timestamp: number;
}

export interface ProductFrameTrace {
  readonly samples: readonly ObservedProductFrame[];
}

export interface ObserveContinuousFramesOptions {
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly trigger?: () => void;
  readonly stableFrameCount?: number;
  readonly maxFrameCount?: number;
  readonly tolerance?: number;
}

const DEFAULT_STABLE_FRAME_COUNT = 2;
const DEFAULT_MAX_FRAME_COUNT = 60;
const DEFAULT_TOLERANCE = 0.5;

export class FrameObservationTimeoutError extends Error {
  constructor(
    readonly trace: ProductFrameTrace,
    maxFrameCount: number
  ) {
    super(`Frame observation did not become semantically stable within ${maxFrameCount} frames`);
    this.name = 'FrameObservationTimeoutError';
  }
}

/**
 * Records every painted state until the public observation is semantically stable.
 * The frame budget is only a failure bound; callers must not use a fixed RAF count as
 * evidence that layout has settled.
 */
export async function observeContinuousFrames(
  sample: () => ProductFrameSample,
  options: ObserveContinuousFramesOptions = {}
): Promise<ProductFrameTrace> {
  const stableFrameCount = positiveInteger(options.stableFrameCount ?? DEFAULT_STABLE_FRAME_COUNT, 'stableFrameCount');
  const maxFrameCount = positiveInteger(options.maxFrameCount ?? DEFAULT_MAX_FRAME_COUNT, 'maxFrameCount');
  if (maxFrameCount < stableFrameCount) {
    throw new Error('maxFrameCount must be greater than or equal to stableFrameCount');
  }
  const tolerance = nonNegativeNumber(options.tolerance ?? DEFAULT_TOLERANCE, 'tolerance');
  const requestFrame = options.requestFrame ?? requestAnimationFrame;
  const samples: ObservedProductFrame[] = [{
    frame: 0,
    timestamp: performance.now(),
    ...copySample(sample())
  }];
  options.trigger?.();
  let stableFrames = 0;

  for (let frame = 1; frame <= maxFrameCount; frame += 1) {
    const timestamp = await nextFrame(requestFrame);
    const current: ObservedProductFrame = {
      frame,
      timestamp,
      ...copySample(sample())
    };
    const previous = samples[samples.length - 1]!;
    samples.push(current);
    stableFrames = samplesAreEquivalent(previous, current, tolerance) ? stableFrames + 1 : 0;
    if (stableFrames >= stableFrameCount) {
      return { samples };
    }
  }

  throw new FrameObservationTimeoutError({ samples }, maxFrameCount);
}

/** Detects move-then-reverse traces without assuming which direction the final layout should move. */
export function assertNoDirectionReversal(
  trace: ProductFrameTrace,
  selectValue: (sample: ObservedProductFrame) => number,
  tolerance = DEFAULT_TOLERANCE
): void {
  const allowedDrift = nonNegativeNumber(tolerance, 'tolerance');
  let direction = 0;

  for (let index = 1; index < trace.samples.length; index += 1) {
    const previous = selectedFiniteValue(trace.samples[index - 1]!, selectValue);
    const current = selectedFiniteValue(trace.samples[index]!, selectValue);
    const delta = current - previous;
    if (Math.abs(delta) <= allowedDrift) continue;
    const nextDirection = Math.sign(delta);
    if (direction !== 0 && nextDirection !== direction) {
      throw new Error(
        `Frame trace reversed direction at frame ${trace.samples[index]!.frame}: ${previous} -> ${current}`
      );
    }
    direction = nextDirection;
  }
}

/** Requires a public scalar to make no more than one significant frame-to-frame adjustment. */
export function assertAtMostOneAdjustment(
  trace: ProductFrameTrace,
  selectValue: (sample: ObservedProductFrame) => number,
  tolerance = DEFAULT_TOLERANCE
): void {
  const allowedDrift = nonNegativeNumber(tolerance, 'tolerance');
  let adjustmentCount = 0;

  for (let index = 1; index < trace.samples.length; index += 1) {
    const previous = selectedFiniteValue(trace.samples[index - 1]!, selectValue);
    const current = selectedFiniteValue(trace.samples[index]!, selectValue);
    if (Math.abs(current - previous) <= allowedDrift) continue;
    adjustmentCount += 1;
    if (adjustmentCount > 1) {
      throw new Error(
        `Frame trace adjusted more than once at frame ${trace.samples[index]!.frame}: ${previous} -> ${current}`
      );
    }
  }
}

function copySample(sample: ProductFrameSample): ProductFrameSample {
  return {
    anchor: sample.anchor ? { ...sample.anchor } : null,
    metrics: { ...sample.metrics }
  };
}

function samplesAreEquivalent(
  previous: ObservedProductFrame,
  current: ObservedProductFrame,
  tolerance: number
): boolean {
  if (!anchorsAreEquivalent(previous.anchor, current.anchor, tolerance)) return false;
  const previousMetricKeys = Object.keys(previous.metrics).sort();
  const currentMetricKeys = Object.keys(current.metrics).sort();
  if (previousMetricKeys.length !== currentMetricKeys.length) return false;
  return previousMetricKeys.every((key, index) =>
    key === currentMetricKeys[index]
    && Math.abs(previous.metrics[key]! - current.metrics[key]!) <= tolerance
  );
}

function anchorsAreEquivalent(
  previous: ProductSemanticAnchor | null,
  current: ProductSemanticAnchor | null,
  tolerance: number
): boolean {
  if (!previous || !current) return previous === current;
  return previous.key === current.key
    && previous.documentPosition === current.documentPosition
    && Math.abs(previous.viewportOffset - current.viewportOffset) <= tolerance;
}

function nextFrame(requestFrame: (callback: FrameRequestCallback) => number): Promise<number> {
  return new Promise((resolve) => requestFrame(resolve));
}

function selectedFiniteValue(
  sample: ObservedProductFrame,
  selectValue: (sample: ObservedProductFrame) => number
): number {
  const value = selectValue(sample);
  if (!Number.isFinite(value)) {
    throw new Error(`Frame ${sample.frame} selected a non-finite value`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
  return value;
}
