import { Text } from '@codemirror/state';
import { ViewportController } from '../webview/src/helpers/viewportController';

const uniformLineGeometry = (doc: Text, height = 20) => {
  const block = (number: number) => {
    const line = doc.line(Math.min(doc.lines, Math.max(1, number)));
    return { from: line.from, to: line.to, top: (line.number - 1) * height, bottom: line.number * height };
  };
  return {
    lineBlockAt: (position: number) => block(doc.lineAt(position).number),
    lineBlockAtHeight: (top: number) => block(Math.floor(top / height) + 1)
  };
};

const flushFrames = async (animationFrames: FrameRequestCallback[]): Promise<void> => {
  await Promise.resolve();
  while (animationFrames.length > 0) {
    animationFrames.shift()?.(0);
    await Promise.resolve();
  }
};

const runScenario = async ({ laterLayoutShift = 0, initialScrollTop = 1000 } = {}) => {
  const animationFrames: FrameRequestCallback[] = [];
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  };

  let layoutTop = initialScrollTop + 100;
  const scrollDOM = {
    scrollTop: initialScrollTop,
    scrollLeft: 0,
    scrollHeight: 5000,
    scrollWidth: 900,
    clientHeight: 500,
    clientWidth: 900,
    getBoundingClientRect: () => ({ top: 0, bottom: 500, height: 500 })
  };
  const anchorElement = {
    isConnected: true,
    getBoundingClientRect: () => ({ top: layoutTop - scrollDOM.scrollTop })
  };
  const view = {
    dom: {},
    scrollDOM,
    contentDOM: { querySelectorAll: () => [anchorElement] },
    posAtDOM: () => 42,
    lineBlockAt: (position: number) => ({ top: position === 0 ? 0 : layoutTop }),
    requestMeasure: ({ read, write }: { read: () => unknown; write: (value: unknown) => void }) => {
      write(read());
    }
  };
  const controller = new ViewportController(view as any, { attachInteractions: false });

  controller.preserveLayoutChange({
    element: {
      isConnected: true,
      getBoundingClientRect: () => initialScrollTop <= 1 ? ({ top: 50, bottom: 80 }) : ({ top: -100, bottom: 0 })
    } as any,
    from: 1,
    to: 2
  }, () => {
    layoutTop += 240;
  });
  layoutTop += laterLayoutShift;
  await flushFrames(animationFrames);

  controller.destroy();
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  return scrollDOM.scrollTop;
};

const preservedScrollTop = await runScenario({ laterLayoutShift: 40 });
if (preservedScrollTop !== 1280) {
  throw new Error(`Layout changes above the reading anchor moved the viewport: ${preservedScrollTop}`);
}

// A late block within the viewport must not hide the start of the document.
// A middle-of-viewport anchor would otherwise turn block growth into a scroll.
for (const initialScrollTop of [0, 0.5]) {
  const top = await runScenario({ laterLayoutShift: 40, initialScrollTop });
  if (top !== initialScrollTop) {
    throw new Error(`Passive layout moved the document start: ${initialScrollTop} -> ${top}`);
  }
}
const nearStart = await runScenario({ laterLayoutShift: 40, initialScrollTop: 10 });
if (nearStart !== 290) {
  throw new Error(`Reading below the top lost its layout compensation: ${nearStart}`);
}

const concurrentFrames: FrameRequestCallback[] = [];
const concurrentMeasures: Array<{
  read: () => unknown;
  write: (value: unknown) => void;
}> = [];
const originalConcurrentRequestAnimationFrame = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
  concurrentFrames.push(callback);
  return concurrentFrames.length;
};
let concurrentLayoutTop = 1100;
let crossLayoutShift = 0;
const concurrentScrollDOM = {
  scrollTop: 1000,
  scrollLeft: 0,
  scrollHeight: 5000,
  scrollWidth: 900,
  clientHeight: 500,
  clientWidth: 900,
  getBoundingClientRect: () => ({ top: 0, bottom: 500, height: 500 })
};
const concurrentLine = {
  getBoundingClientRect: () => ({
    top: concurrentLayoutTop + crossLayoutShift - concurrentScrollDOM.scrollTop
  })
};
const concurrentView = {
  dom: {},
  scrollDOM: concurrentScrollDOM,
  contentDOM: { querySelectorAll: () => [concurrentLine] },
  posAtDOM: () => 42,
  lineBlockAtHeight: () => ({ from: 10, top: 900 + crossLayoutShift }),
  lineBlockAt: (position: number) => ({
    top: position === 10 ? 900 + crossLayoutShift : concurrentLayoutTop + crossLayoutShift
  }),
  requestMeasure: (measure?: { read: () => unknown; write: (value: unknown) => void }) => {
    if (measure) concurrentMeasures.push(measure);
  }
};
const flushConcurrentCycle = async (): Promise<void> => {
  const batch = concurrentMeasures.splice(0);
  const values = batch.map((measure) => measure.read());
  batch.forEach((measure, index) => measure.write(values[index]));
  await Promise.resolve();
};
const flushConcurrentWork = async (): Promise<void> => {
  while (concurrentMeasures.length > 0 || concurrentFrames.length > 0) {
    if (concurrentMeasures.length > 0) await flushConcurrentCycle();
    while (concurrentFrames.length > 0) concurrentFrames.shift()?.(0);
    await Promise.resolve();
  }
};
const concurrentController = new ViewportController(concurrentView as any, { attachInteractions: false });
const concurrentRegion = {
  element: {
    isConnected: true,
    getBoundingClientRect: () => ({ top: -100, bottom: 0 })
  } as any,
  from: 1,
  to: 2
};
concurrentController.preserveLayoutChange(concurrentRegion, () => { concurrentLayoutTop += 240; });
await flushConcurrentCycle();
concurrentController.preserveLayoutChange(concurrentRegion, () => { concurrentLayoutTop += 100; });
await flushConcurrentWork();
if (concurrentScrollDOM.scrollTop !== 1340) {
  throw new Error(`Concurrent layout changes lost part of their compensation: ${concurrentScrollDOM.scrollTop}`);
}

concurrentScrollDOM.scrollTop = 1000;
concurrentLayoutTop = 1100;
crossLayoutShift = 0;
concurrentController.restoreDocumentAnchor({ position: 10, lineOffset: 0 });
concurrentController.preserveLayoutChange(concurrentRegion, () => { crossLayoutShift += 240; });
await flushConcurrentWork();
if (concurrentScrollDOM.scrollTop !== 1140) {
  throw new Error(`Document and layout transactions competed at ${concurrentScrollDOM.scrollTop}`);
}

concurrentScrollDOM.scrollTop = 1000;
crossLayoutShift = 0;
concurrentController.preserveScrollPosition(() => { concurrentScrollDOM.scrollTop = 1300; });
concurrentController.preserveLayoutChange(concurrentRegion, () => { crossLayoutShift += 240; });
await flushConcurrentWork();
if (concurrentScrollDOM.scrollTop !== 1240) {
  throw new Error(`Scroll preservation failed to absorb a layout change: ${concurrentScrollDOM.scrollTop}`);
}
concurrentController.destroy();
globalThis.requestAnimationFrame = originalConcurrentRequestAnimationFrame;

const documentFrames: FrameRequestCallback[] = [];
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
  documentFrames.push(callback);
  return documentFrames.length;
};
let documentBlockTop = 980;
const documentScrollDOM = {
  scrollTop: 1000,
  scrollLeft: 0,
  scrollHeight: 5000,
  scrollWidth: 900,
  clientHeight: 500,
  clientWidth: 900,
  getBoundingClientRect: () => ({ top: 0, bottom: 500, left: 0, right: 900 })
};

const runCausalFrameTrace = async <T>(root: () => void, sample: () => T): Promise<T[]> => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalQueueMicrotask = globalThis.queueMicrotask;
  const causalCallbacks = new Map<number, {
    callback: FrameRequestCallback;
    state: 'queued' | 'executing' | 'cancelled' | 'complete';
  }>();
  const ownedCausalHandles = new Set<number>();
  let nextFrame: number[] = [];
  let causalDepth = 0;
  let pendingMicrotasks = 0;
  let resolveMicrotasks: (() => void) | null = null;

  const runCausal = (callback: () => void) => {
    causalDepth += 1;
    try {
      callback();
    } finally {
      causalDepth -= 1;
    }
  };
  const waitForMicrotasks = () => pendingMicrotasks === 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => { resolveMicrotasks = resolve; });

  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    if (causalDepth === 0) return originalRequestAnimationFrame(callback);
    const handle = Object.freeze({ valueOf: () => 1 }) as unknown as number;
    causalCallbacks.set(handle, { callback, state: 'queued' });
    ownedCausalHandles.add(handle);
    nextFrame.push(handle);
    return handle;
  };
  globalThis.cancelAnimationFrame = (handle: number) => {
    const record = causalCallbacks.get(handle);
    if (!record) {
      if (ownedCausalHandles.has(handle)) return;
      originalCancelAnimationFrame(handle);
      return;
    }
    if (record.state === 'queued' || record.state === 'executing') record.state = 'cancelled';
  };
  globalThis.queueMicrotask = (callback: VoidFunction) => {
    if (causalDepth === 0) {
      originalQueueMicrotask(callback);
      return;
    }
    pendingMicrotasks += 1;
    originalQueueMicrotask(() => {
      try {
        runCausal(callback);
      } finally {
        pendingMicrotasks -= 1;
        if (pendingMicrotasks === 0) {
          resolveMicrotasks?.();
          resolveMicrotasks = null;
        }
      }
    });
  };

  try {
    runCausal(root);
    await waitForMicrotasks();
    const trace = [sample()];
    while (true) {
      const currentFrame = nextFrame.filter((handle) => {
        const record = causalCallbacks.get(handle);
        if (record?.state === 'cancelled') causalCallbacks.delete(handle);
        return record?.state === 'queued';
      });
      nextFrame = [];
      if (currentFrame.length === 0) break;
      for (const handle of currentFrame) {
        const record = causalCallbacks.get(handle);
        if (!record) continue;
        if (record.state !== 'queued') continue;
        record.state = 'executing';
        runCausal(() => record.callback(performance.now()));
        if (record.state === 'executing') record.state = 'complete';
        causalCallbacks.delete(handle);
      }
      await waitForMicrotasks();
      trace.push(sample());
    }
    if (causalCallbacks.size !== 0) {
      throw new Error(`Causal RAF handles remained after completion: ${causalCallbacks.size}`);
    }
    ownedCausalHandles.clear();
    return trace;
  } finally {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    globalThis.queueMicrotask = originalQueueMicrotask;
  }
};

let schedulerValue = 0;
const zeroCallbackTrace = await runCausalFrameTrace(() => { schedulerValue = 1; }, () => schedulerValue);
if (JSON.stringify(zeroCallbackTrace) !== '[1]') {
  throw new Error(`Zero-callback scheduler trace did not complete: ${JSON.stringify(zeroCallbackTrace)}`);
}
const oneCallbackTrace = await runCausalFrameTrace(() => {
  schedulerValue = 1;
  requestAnimationFrame(() => { schedulerValue = 2; });
}, () => schedulerValue);
if (JSON.stringify(oneCallbackTrace) !== '[1,2]') {
  throw new Error(`One-callback scheduler trace did not drain: ${JSON.stringify(oneCallbackTrace)}`);
}
const continuationTrace = await runCausalFrameTrace(() => {
  schedulerValue = 0;
  requestAnimationFrame(() => {
    schedulerValue = 1;
    queueMicrotask(() => {
      requestAnimationFrame(() => { schedulerValue = 2; });
      requestAnimationFrame(() => { schedulerValue = 3; });
    });
  });
}, () => schedulerValue);
if (JSON.stringify(continuationTrace) !== '[0,1,3]') {
  throw new Error(`Callback continuation scheduler trace was incomplete: ${JSON.stringify(continuationTrace)}`);
}
const longSettlementTrace = await runCausalFrameTrace(() => {
  schedulerValue = 1888;
  const scheduleFrame = (frame: number) => requestAnimationFrame(() => {
    if (frame === 9) schedulerValue = 1885;
    if (frame === 10) schedulerValue = 1888;
    if (frame < 10) scheduleFrame(frame + 1);
  });
  scheduleFrame(1);
}, () => schedulerValue);
const longSettlementUnstableFrame = longSettlementTrace.findIndex((value) => value !== 1888);
if (
  longSettlementUnstableFrame !== 9 ||
  longSettlementTrace.length !== 11 ||
  longSettlementTrace.at(-1) !== 1888
) {
  throw new Error(
    `Long settlement trace did not expose frame 9 before final drain: ${JSON.stringify(longSettlementTrace)}`
  );
}
const originalUnrelatedRequestAnimationFrame = globalThis.requestAnimationFrame;
let unrelatedFrameRequests = 0;
globalThis.requestAnimationFrame = () => {
  unrelatedFrameRequests += 1;
  return 10_000 + unrelatedFrameRequests;
};
const cancelledTrace = await runCausalFrameTrace(() => {
  schedulerValue = 7;
  const cancelled = requestAnimationFrame(() => { schedulerValue = -1; });
  cancelAnimationFrame(cancelled);
  void Promise.resolve().then(() => requestAnimationFrame(() => { schedulerValue = -2; }));
}, () => schedulerValue);
globalThis.requestAnimationFrame = originalUnrelatedRequestAnimationFrame;
if (JSON.stringify(cancelledTrace) !== '[7]' || unrelatedFrameRequests !== 1) {
  throw new Error(
    `Cancelled or unrelated RAF changed scheduler completion: ${JSON.stringify({ cancelledTrace, unrelatedFrameRequests })}`
  );
}
const originalCollisionRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCollisionCancelAnimationFrame = globalThis.cancelAnimationFrame;
let unrelatedCollisionCancels = 0;
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = (callbackId: number) => {
  if (callbackId === 1) unrelatedCollisionCancels += 1;
};
const unrelatedNativeHandle = requestAnimationFrame(() => { schedulerValue = -3; });
let selfCancellingHandle = 0;
const selfCancellingTrace = await runCausalFrameTrace(() => {
  schedulerValue = 9;
  selfCancellingHandle = requestAnimationFrame(() => cancelAnimationFrame(selfCancellingHandle));
}, () => schedulerValue);
const collisionCancelsBeforeNativeCancel = unrelatedCollisionCancels;
cancelAnimationFrame(unrelatedNativeHandle);
globalThis.requestAnimationFrame = originalCollisionRequestAnimationFrame;
globalThis.cancelAnimationFrame = originalCollisionCancelAnimationFrame;
if (
  JSON.stringify(selfCancellingTrace) !== '[9,9]' ||
  collisionCancelsBeforeNativeCancel !== 0 ||
  unrelatedCollisionCancels !== 1
) {
  throw new Error(
    `RAF identity routing failed: ${JSON.stringify({
      selfCancellingTrace,
      collisionCancelsBeforeNativeCancel,
      unrelatedCollisionCancels
    })}`
  );
}

const documentView = {
  dom: {},
  scrollDOM: documentScrollDOM,
  state: { doc: { length: 4999 } },
  coordsAtPos: () => ({
    top: documentBlockTop - documentScrollDOM.scrollTop,
    bottom: documentBlockTop + 20 - documentScrollDOM.scrollTop
  }),
  lineBlockAtHeight: () => ({ from: 42, top: documentBlockTop }),
  lineBlockAt: () => ({ from: 42, top: documentBlockTop }),
  requestMeasure: ({ read, write }: { read: () => unknown; write: (value: unknown) => void }) => write(read())
};
const documentController = new ViewportController(documentView as any, { attachInteractions: false });
const documentAnchor = documentController.captureDocumentAnchor();
if (documentAnchor.position !== 42 || documentAnchor.lineOffset !== 20) {
  throw new Error(`Document anchor capture returned ${JSON.stringify(documentAnchor)}`);
}
documentBlockTop = 1200;
documentController.restoreDocumentAnchor({ ...documentAnchor, position: 84 });
await flushFrames(documentFrames);
if (documentScrollDOM.scrollTop !== 1220) {
  throw new Error(`Mapped document anchor restored to ${documentScrollDOM.scrollTop}`);
}
documentController.preserveDocumentAnchorWhileMutation(() => {
  documentBlockTop = 1450;
});
await flushFrames(documentFrames);
if (documentScrollDOM.scrollTop !== 1470) {
  throw new Error(`Layout refresh moved the document anchor to ${documentScrollDOM.scrollTop}`);
}
// A newer layout operation supersedes an older retained cell/toolbar position.
// They must never alternate between two scroll targets during settlement.
let retainedElementTop = 4000;
const retainedElement = {
  isConnected: true,
  ownerDocument: { defaultView: {} },
  getBoundingClientRect: () => ({ top: retainedElementTop - documentScrollDOM.scrollTop })
};
documentController.retainElementTopWhileMutation(retainedElement as any, () => retainedElement as any, () => {});
documentController.preserveDocumentAnchorWhileMutation(() => {
  documentBlockTop += 100;
  retainedElementTop += 700;
});
await flushFrames(documentFrames);
if (documentScrollDOM.scrollTop !== 1570) {
  throw new Error(`An obsolete element anchor overrode the newer layout operation: ${documentScrollDOM.scrollTop}`);
}

documentBlockTop = 1750;
documentController.restoreDocumentAnchor({ position: 42, lineOffset: 20 });
const selectionOnlyNavigation = documentController.beginNavigationReveal();
await flushFrames(documentFrames);
if (!selectionOnlyNavigation() || documentScrollDOM.scrollTop !== 1770) {
  throw new Error(
    `Selection-only navigation cancelled layout settling: ${JSON.stringify({
      current: selectionOnlyNavigation(),
      scrollTop: documentScrollDOM.scrollTop
    })}`
  );
}
documentBlockTop = 1850;
documentController.restoreDocumentAnchor({ position: 42, lineOffset: 20 });
const visibleNavigation = documentController.beginNavigationReveal();
documentController.revealPosition(42, { y: 'nearest' }, visibleNavigation);
await flushFrames(documentFrames);
if (!visibleNavigation() || documentScrollDOM.scrollTop !== 1870) {
  throw new Error(
    `Visible navigation cancelled layout settling: ${JSON.stringify({
      current: visibleNavigation(),
      scrollTop: documentScrollDOM.scrollTop
    })}`
  );
}
documentController.destroy();
globalThis.requestAnimationFrame = originalRequestAnimationFrame;

const renderedDocument = {
  length: 999,
  lines: 10,
  line: (lineNumber: number) => ({
    from: (lineNumber - 1) * 100,
    to: lineNumber * 100 - 1,
    number: lineNumber
  })
};
const renderedBlock = {
  dataset: {
    meoRenderedBlockStartLine: '5',
    meoRenderedBlockEndLine: '8'
  },
  getBoundingClientRect: () => ({ top: 40, bottom: 360 })
};
const renderedController = new ViewportController({
  dom: {},
  state: { doc: renderedDocument },
  scrollDOM: {
    scrollTop: 1000,
    getBoundingClientRect: () => ({ top: 100, bottom: 600, height: 500 })
  },
  contentDOM: { querySelectorAll: () => [renderedBlock] },
  lineBlockAtHeight: () => ({ from: 300, top: 980 })
} as any, { attachInteractions: false });
const renderedAnchor = renderedController.captureDocumentAnchor();
if (renderedAnchor.position !== 400 || renderedAnchor.lineOffset !== 60) {
  throw new Error(`Rendered block anchor lost source position or visual offset: ${JSON.stringify(renderedAnchor)}`);
}
renderedController.destroy();

const wheelFrames: FrameRequestCallback[] = [];
const originalWheelRequestAnimationFrame = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
  wheelFrames.push(callback);
  return wheelFrames.length;
};

class FakeEventTarget {
  private readonly listeners = new Map<string, Array<{ listener: EventListener; capture: boolean }>>();

  addEventListener(type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void {
    const listeners = this.listeners.get(type) ?? [];
    const capture = typeof options === 'boolean' ? options : options?.capture ?? false;
    if (!listeners.some(entry => entry.listener === listener && entry.capture === capture)) {
      listeners.push({ listener, capture });
    }
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener, options?: boolean | EventListenerOptions): void {
    const capture = typeof options === 'boolean' ? options : options?.capture ?? false;
    this.listeners.set(type, (this.listeners.get(type) ?? [])
      .filter(entry => entry.listener !== listener || entry.capture !== capture));
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }

  dispatch(type: string, event: unknown): void {
    // At the event target, capture listeners precede non-capture listeners even
    // when the latter were registered first, as CodeMirror's scroll observer is.
    for (const capture of [true, false]) {
      for (const entry of [...this.listeners.get(type) ?? []]) {
        if (entry.capture === capture) entry.listener(event as Event);
      }
    }
  }
}

const dragFrames: FrameRequestCallback[] = [];
const originalDragRequestAnimationFrame = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
  dragFrames.push(callback);
  return dragFrames.length;
};
const dragDocument = new FakeEventTarget();
const dragDom = new FakeEventTarget();
let dragLayoutTop = 2100;
const dragScrollDOM = Object.assign(new FakeEventTarget(), {
  ownerDocument: dragDocument,
  scrollTop: 1000,
  scrollLeft: 0,
  scrollHeight: 5000,
  scrollWidth: 900,
  clientHeight: 500,
  clientWidth: 900,
  clientTop: 0, clientLeft: 0, offsetWidth: 910,
  getBoundingClientRect: () => ({ top: 0, bottom: 500, height: 500, left: 0, right: 910 })
});
const dragAnchorElement = {
  isConnected: true,
  getBoundingClientRect: () => ({ top: dragLayoutTop - dragScrollDOM.scrollTop })
};
const dragView = {
  dom: dragDom,
  scrollDOM: dragScrollDOM,
  contentDOM: { querySelectorAll: () => [dragAnchorElement] },
  posAtDOM: () => 42,
  lineBlockAt: () => ({ top: dragLayoutTop }),
  requestMeasure: (measure?: { read: () => unknown; write: (value: unknown) => void }) => {
    if (measure) measure.write(measure.read());
  }
};
const dragController = new ViewportController(dragView as any);
const dragRegion = {
  element: {
    isConnected: true,
    getBoundingClientRect: () => ({ top: -100, bottom: 0 })
  } as any,
  from: 1,
  to: 2
};

dragScrollDOM.dispatch('pointerdown', { button: 0, target: dragScrollDOM });
dragScrollDOM.scrollTop = 2000;
dragController.preserveLayoutChange(dragRegion, () => { dragLayoutTop += 240; });
await flushFrames(dragFrames);
if (dragScrollDOM.scrollTop !== 2000) {
  throw new Error(`Scrollbar drag was pulled back to ${dragScrollDOM.scrollTop}`);
}

dragDocument.dispatch('pointerup', {});
dragController.preserveLayoutChange(dragRegion, () => { dragLayoutTop += 100; });
await flushFrames(dragFrames);
if (dragScrollDOM.scrollTop !== 2100) {
  throw new Error(`Layout preservation did not resume after scrollbar release: ${dragScrollDOM.scrollTop}`);
}
// Deferred row measurements can leave the actual thumb at the track edge while
// scrollTop is short of the new range. Preserve that explicit navigation intent.
dragScrollDOM.dispatch('pointerdown', { button: 0, target: dragScrollDOM, clientX: 905, clientY: 12 });
dragScrollDOM.scrollTop = 4400;
dragDocument.dispatch('pointerup', { type: 'pointerup', clientY: 499 });
if (dragScrollDOM.scrollTop !== 4500) throw new Error('Thumb release lost the requested document end');
dragScrollDOM.scrollHeight += 300;
dragController.reconcileAfterEditorUpdate();
if (dragScrollDOM.scrollTop !== 4800) throw new Error('Late row height publication lost the native document end');
dragScrollDOM.dispatch('pointerdown', { button: 0, target: dragScrollDOM, clientX: 905, clientY: 480 });
dragScrollDOM.scrollTop = 30;
dragDocument.dispatch('pointerup', { type: 'pointerup', clientY: 1 });
dragScrollDOM.scrollTop = 70;
dragScrollDOM.dispatch('scroll', {});
if (dragScrollDOM.scrollTop !== 0) throw new Error('Late browser anchoring lost the native document start');
dragController.markInteraction();
dragScrollDOM.scrollTop = 2000;
dragController.reconcileAfterEditorUpdate();
if (dragScrollDOM.scrollTop !== 2000) throw new Error('A newer navigation did not release the native boundary');
dragScrollDOM.dispatch('pointerdown', { button: 0, target: dragScrollDOM, clientX: 905, clientY: 12 });
dragScrollDOM.scrollTop = 3000;
dragDocument.dispatch('pointercancel', { type: 'pointercancel', clientY: 499 });
dragController.reconcileAfterEditorUpdate();
if (dragScrollDOM.scrollTop !== 3000) throw new Error('A canceled thumb gesture invented a boundary');
dragScrollDOM.dispatch('pointerdown', { button: 0, target: dragScrollDOM, clientX: 905, clientY: 499 });
dragDocument.dispatch('pointerup', { type: 'pointerup', clientY: 499 });
if (dragScrollDOM.scrollTop !== 3000) throw new Error('A stationary track click invented a boundary');
dragScrollDOM.dispatch('pointerdown', { button: 0, target: dragScrollDOM, clientX: 100, clientY: 12 });
dragDocument.dispatch('pointerup', { type: 'pointerup', clientY: 499 });
if (dragScrollDOM.scrollTop !== 3000) throw new Error('A content-margin gesture invented a native boundary');
dragController.destroy();
globalThis.requestAnimationFrame = originalDragRequestAnimationFrame;

type NavigationAnchorBoundary = 'schedule' | 'read' | 'write' | 'current';

const runNavigationAnchorStaleBoundary = async (
  boundary: NavigationAnchorBoundary
): Promise<{ scrollTop: number; writes: number[] }> => {
  const frames: FrameRequestCallback[] = [];
  const measures: Array<{
    read: () => unknown;
    write: (value: unknown) => void;
  }> = [];
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  };

  const dom = new FakeEventTarget();
  const ownerDocument = new FakeEventTarget();
  const writes: number[] = [];
  let scrollTop = 1000;
  let anchorTop = 1000;
  let elementRectReads = 0;
  const scrollDOM = Object.assign(new FakeEventTarget(), {
    ownerDocument,
    scrollLeft: 0,
    scrollHeight: 5000,
    scrollWidth: 900,
    clientHeight: 500,
    clientWidth: 900,
    getBoundingClientRect: () => ({ top: 0, bottom: 500, left: 0, right: 900 })
  });
  Object.defineProperty(scrollDOM, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
      writes.push(value);
    }
  });
  const navigationElement = {
    isConnected: true,
    getBoundingClientRect: () => {
      elementRectReads += 1;
      if (boundary === 'read' && elementRectReads === 1) {
        dom.dispatch('beforeinput', { inputType: 'insertText' });
      }
      return {
        top: 1800 - scrollTop,
        bottom: 1840 - scrollTop,
        left: 0,
        right: 200
      };
    }
  };
  const view = {
    dom,
    scrollDOM,
    state: { doc: { length: 4999 } },
    lineBlockAt: () => ({ top: anchorTop }),
    requestMeasure: (measure?: { read: () => unknown; write: (value: unknown) => void }) => {
      if (measure) measures.push(measure);
    }
  };
  const controller = new ViewportController(view as any);
  const flushMeasure = async (
    beforeWrite?: () => void
  ): Promise<void> => {
    const measure = measures.shift();
    if (!measure) throw new Error(`Missing ${boundary} navigation measure`);
    const value = measure.read();
    beforeWrite?.();
    measure.write(value);
    await Promise.resolve();
  };
  const flushAll = async (): Promise<void> => {
    while (measures.length > 0 || frames.length > 0) {
      while (measures.length > 0) await flushMeasure();
      const frameBatch = frames.splice(0);
      frameBatch.forEach((frame) => frame(0));
      await Promise.resolve();
    }
  };

  controller.restoreDocumentAnchor({ position: 10, lineOffset: 0 });
  await flushMeasure();
  writes.length = 0;

  const isCurrent = controller.beginNavigationReveal();
  controller.revealElement(navigationElement as any, isCurrent);
  if (boundary === 'schedule') dom.dispatch('beforeinput', { inputType: 'insertText' });
  if (boundary === 'read') await flushMeasure();
  if (boundary === 'write') {
    await flushMeasure(() => dom.dispatch('beforeinput', { inputType: 'insertText' }));
  }
  anchorTop += 100;
  await flushAll();

  const result = { scrollTop, writes: [...writes] };
  controller.destroy();
  globalThis.requestAnimationFrame = previousRequestAnimationFrame;
  return result;
};

const navigationAnchorBoundaryFailures: string[] = [];
for (const boundary of ['schedule', 'read', 'write'] as const) {
  const result = await runNavigationAnchorStaleBoundary(boundary);
  if (result.scrollTop !== 1100 || result.writes.some((value) => value > 1100)) {
    navigationAnchorBoundaryFailures.push(`${boundary}:${JSON.stringify(result)}`);
  }
}
if (navigationAnchorBoundaryFailures.length > 0) {
  throw new Error(
    `Stale element reveals cancelled or overrode active anchors: ${navigationAnchorBoundaryFailures.join(', ')}`
  );
}
const currentNavigationAnchorResult = await runNavigationAnchorStaleBoundary('current');
if (
  currentNavigationAnchorResult.scrollTop !== 1340 ||
  currentNavigationAnchorResult.writes.some((value) => value > 1340)
) {
  throw new Error(
    `A current element reveal did not adopt at its first non-zero write: ${JSON.stringify(currentNavigationAnchorResult)}`
  );
}

const originalWheelEvent = globalThis.WheelEvent;
(globalThis as typeof globalThis & { WheelEvent: typeof WheelEvent }).WheelEvent = class {
  static readonly DOM_DELTA_PIXEL = 0;
  static readonly DOM_DELTA_LINE = 1;
  static readonly DOM_DELTA_PAGE = 2;
} as typeof WheelEvent;

const wheelDom = new FakeEventTarget();
const wheelDocument = new FakeEventTarget();
const wheelScrollDOM = Object.assign(new FakeEventTarget(), {
  ownerDocument: wheelDocument,
  scrollTop: 1000,
  scrollLeft: 0,
  scrollHeight: 5000,
  scrollWidth: 2000,
  clientHeight: 500,
  clientWidth: 900,
  getBoundingClientRect: () => ({ top: 0, bottom: 500, left: 0, right: 900, height: 500, width: 900 })
});
const wheelView = {
  dom: wheelDom,
  scrollDOM: wheelScrollDOM,
  defaultLineHeight: 20,
  lineBlockAtHeight: (height: number) => ({ from: 42, top: height }),
  lineBlockAt: () => ({ top: 1000 }),
  coordsAtPos: () => null,
  requestMeasure: ({ read, write }: { read: () => unknown; write: (value: unknown) => void }) => write(read())
};
const wheelController = new ViewportController(wheelView as any, { getMode: () => 'source' });
let defaultPrevented = false;
const dispatchWheel = (deltaY: number) => wheelScrollDOM.dispatch('wheel', {
  deltaX: 0,
  deltaY,
  deltaMode: 0,
  ctrlKey: false,
  preventDefault: () => { defaultPrevented = true; }
});

const firstNavigationReveal = wheelController.beginNavigationReveal();
const measuredNavigation = wheelController.captureNavigationCurrentness();
const secondMeasurement = wheelController.captureNavigationCurrentness();
if (!firstNavigationReveal() || !measuredNavigation() || !secondMeasurement()) {
  throw new Error('A fresh navigation reveal was not current');
}
const secondNavigationReveal = wheelController.beginNavigationReveal();
if (firstNavigationReveal() || measuredNavigation() || secondMeasurement() || !secondNavigationReveal()) {
  throw new Error('A newer navigation reveal did not replace the older intent');
}
const inputMeasurement = wheelController.captureNavigationCurrentness();
wheelDom.dispatch('beforeinput', { inputType: 'insertText' });
if (secondNavigationReveal() || inputMeasurement()) {
  throw new Error('Beforeinput did not invalidate a delayed navigation reveal');
}
const keyNavigationReveal = wheelController.beginNavigationReveal();
const keyMeasurement = wheelController.captureNavigationCurrentness();
wheelDom.dispatch('keydown', { key: 'ArrowDown', ctrlKey: false, metaKey: false, isComposing: false });
if (keyNavigationReveal() || keyMeasurement()) {
  throw new Error('A newer key interaction did not invalidate a delayed navigation reveal');
}
const pointerNavigationReveal = wheelController.beginNavigationReveal();
wheelScrollDOM.dispatch('pointerdown', { button: 0, target: wheelScrollDOM });
if (pointerNavigationReveal()) {
  throw new Error('A newer pointer interaction did not invalidate a delayed navigation reveal');
}
wheelDocument.dispatch('pointerup', {});
const wheelNavigationReveal = wheelController.beginNavigationReveal();
const wheelMeasurement = wheelController.captureNavigationCurrentness();
dispatchWheel(-80);
if (wheelNavigationReveal() || wheelMeasurement()) {
  throw new Error('A newer wheel interaction did not invalidate a delayed navigation reveal');
}

let liveWheelScrollTop = 1000;
const liveWheelWrites: number[] = [];
const liveWheelLine = {
  classList: { contains: () => false },
  closest: () => null,
  getBoundingClientRect: () => ({
    top: 1200 - liveWheelScrollTop,
    bottom: 1220 - liveWheelScrollTop
  })
};
const liveWheelScrollDOM = Object.assign(new FakeEventTarget(), {
  ownerDocument: new FakeEventTarget(),
  scrollLeft: 0,
  scrollHeight: 5000,
  scrollWidth: 900,
  clientHeight: 500,
  clientWidth: 900,
  getBoundingClientRect: () => ({ top: 0, bottom: 500, left: 0, right: 900, height: 500, width: 900 })
});
Object.defineProperty(liveWheelScrollDOM, 'scrollTop', {
  configurable: true,
  get: () => liveWheelScrollTop,
  set: (value: number) => {
    liveWheelScrollTop = value;
    liveWheelWrites.push(value);
  }
});
const liveWheelController = new ViewportController({
  dom: new FakeEventTarget(),
  scrollDOM: liveWheelScrollDOM,
  contentDOM: { querySelectorAll: () => [liveWheelLine] },
  posAtDOM: () => 42,
  coordsAtPos: () => ({
    top: 1200 - liveWheelScrollTop,
    bottom: 1220 - liveWheelScrollTop
  }),
  lineBlockAt: () => ({ top: 1200 }),
  requestMeasure: ({ read, write }: { read: () => unknown; write: (value: unknown) => void }) => write(read())
} as any, { getMode: () => 'live' });
liveWheelScrollDOM.dispatch('wheel', {
  deltaX: 0,
  deltaY: 120,
  deltaMode: 0,
  ctrlKey: false,
  preventDefault() {}
});
// The wheel listener runs before Chromium applies the native scroll. With no
// intervening layout change, the controller must not overwrite that movement.
liveWheelScrollDOM.scrollTop = 1120;
liveWheelWrites.length = 0;
await flushFrames(wheelFrames);
if (liveWheelScrollTop !== 1120 || liveWheelWrites.length > 0) {
  throw new Error(
    `Live wheel movement was pulled back by viewport stabilization: ${JSON.stringify({
      scrollTop: liveWheelScrollTop,
      writes: liveWheelWrites
    })}`
  );
}
liveWheelController.destroy();

// A height-map correction can arrive after the native wheel scroll has already
// settled for several frames. Preserve the newly visible line, without replaying
// the wheel distance or keeping an obsolete anchor after another interaction.
const readingFrames: FrameRequestCallback[] = [];
const originalReadingNow = performance.now;
let readingNow = 0;
performance.now = () => readingNow;
globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
  readingFrames.push(callback);
  return readingFrames.length;
};
const readingDom = new FakeEventTarget();
const readingScroller = Object.assign(new FakeEventTarget(), {
  ownerDocument: new FakeEventTarget(),
  scrollTop: 1000,
  scrollLeft: 0,
  scrollHeight: 5000,
  scrollWidth: 900,
  clientHeight: 500,
  clientWidth: 900,
  getBoundingClientRect: () => ({ top: 40, bottom: 540, height: 500 })
});
let readingLineTop = 1200;
let readingHeightMapTop = -1400;
const readingLine = {
  getBoundingClientRect: () => ({ top: 40 + readingLineTop - readingScroller.scrollTop })
};
let afterReadingMeasure: (() => void) | null = null;
const readingView = {
  dom: readingDom,
  state: { doc: Text.of(['x'.repeat(2000)]) },
  scrollDOM: readingScroller,
  contentDOM: { querySelectorAll: () => [readingLine] },
  coordsAtPos: () => readingLine.getBoundingClientRect(),
  posAtDOM: () => 42,
  // A rendered widget may share an aggregate height-map block with this line.
  lineBlockAt: () => ({ from: 42, top: readingHeightMapTop }),
  lineBlockAtHeight: () => ({ from: 42, top: readingHeightMapTop }),
  requestMeasure: ({ read, write }: { read: () => unknown; write: (value: unknown) => void }) => {
    write(read());
    afterReadingMeasure?.();
  }
};
const readingController = new ViewportController(readingView as any);
const nativeReadingWheel = (deltaY: number) => {
  readingScroller.dispatch('wheel', { deltaX: 0, deltaY, ctrlKey: false });
  readingScroller.scrollTop = Math.max(0, Math.min(
    readingScroller.scrollHeight - readingScroller.clientHeight, readingScroller.scrollTop + deltaY
  ));
  readingScroller.dispatch('scroll', {});
};
const readingFrame = async () => {
  readingNow += 16;
  for (const callback of readingFrames.splice(0)) callback(readingNow);
  await Promise.resolve();
};
try {
  // One native gesture can continue scrolling across frames without another
  // wheel event. Layout retention must not pin it to its first scroll frame.
  for (const direction of [1, -1]) {
    readingScroller.scrollTop = 1000;
    readingScroller.dispatch('wheel', { deltaX: 0, deltaY: direction * 120, ctrlKey: false });
    for (const progress of [3, 17, 43, 77, 120]) {
      const expected = 1000 + direction * progress;
      readingScroller.scrollTop = expected;
      readingScroller.dispatch('scroll', {});
      await readingFrame();
      if (Math.abs(readingScroller.scrollTop - expected) > 1) {
        throw new Error(`Reading retention blocked native gesture progress: ${JSON.stringify({
          direction, progress, expected, actual: readingScroller.scrollTop
        })}`);
      }
    }
  }
  const beforeMeasureGap = readingScroller.scrollTop;
  afterReadingMeasure = () => {
    afterReadingMeasure = null;
    readingScroller.scrollTop += 14;
  };
  await readingFrame();
  if (Math.abs(readingScroller.scrollTop - beforeMeasureGap - 14) > 1) {
    throw new Error('A queued reading measurement overwrote newer native scroll progress');
  }
  readingScroller.scrollTop = 1000;
  readingScroller.dispatch('wheel', { deltaX: 0, deltaY: 120, ctrlKey: false });
  readingScroller.scrollTop = 1003;
  readingScroller.dispatch('scroll', {});
  await readingFrame();
  readingScroller.scrollTop += 14;
  readingScroller.dispatch('scroll', {});
  readingLineTop += 19.5;
  readingScroller.scrollHeight += 19.5;
  readingController.reconcileAfterEditorUpdate();
  await readingFrame();
  if (Math.abs(readingScroller.scrollTop - 1036.5) > 1) {
    throw new Error('Late layout compensation discarded concurrent native scroll progress');
  }
  readingScroller.scrollTop += 26;
  readingScroller.dispatch('scroll', {});
  await readingFrame();
  if (Math.abs(readingScroller.scrollTop - 1062.5) > 1) {
    throw new Error('Layout compensation was replayed during the next native frame');
  }
  readingLineTop = 1200;
  readingScroller.scrollTop = 1000;
  nativeReadingWheel(-120);
  for (let frame = 0; frame < 6; frame += 1) await readingFrame();
  const nativeTop = readingLine.getBoundingClientRect().top;
  // CodeMirror may already anchor the native offset when its height map grows.
  // The controller must compensate only the drift left after that anchoring.
  readingLineTop += 19.5;
  readingScroller.scrollHeight += 19.5;
  readingHeightMapTop += 19.5;
  readingScroller.scrollTop += 19.5;
  readingController.reconcileAfterEditorUpdate();
  await readingFrame();
  if (Math.abs(readingLine.getBoundingClientRect().top - nativeTop) > 1) {
    throw new Error('Reading retention compensated a height-map shift twice');
  }
  readingLineTop += 19.5;
  readingScroller.scrollHeight += 19.5;
  readingHeightMapTop += 6;
  readingScroller.scrollTop += 6;
  readingController.reconcileAfterEditorUpdate();
  await readingFrame();
  if (Math.abs(readingLine.getBoundingClientRect().top - nativeTop) > 1) {
    throw new Error('Reading retention failed to compensate the remainder of a height-map shift');
  }
  readingLineTop += 19.5;
  readingScroller.scrollHeight += 19.5;
  readingController.reconcileAfterEditorUpdate();
  await readingFrame();
  if (Math.abs(readingLine.getBoundingClientRect().top - nativeTop) > 1) {
    throw new Error(`Late virtual height moved the native reading anchor: ${JSON.stringify({
      nativeTop, actualTop: readingLine.getBoundingClientRect().top, scrollTop: readingScroller.scrollTop
    })}`);
  }
  nativeReadingWheel(20);
  await readingFrame();
  if (Math.abs(readingLine.getBoundingClientRect().top - (nativeTop - 20)) > 1) {
    throw new Error('A new wheel delta reused the previous reading anchor');
  }
  for (const direction of [-1, 1]) {
    for (const correction of ['full', 'partial', 'clamped']) {
      readingController.markInteraction();
      readingScroller.scrollHeight = 5000;
      readingScroller.scrollTop = 4000;
      readingLineTop = 4200;
      readingHeightMapTop = 2000;
      nativeReadingWheel(direction * 20);
      await readingFrame();
      const adoptedTop = readingScroller.scrollTop;
      const contraction = correction === 'clamped' ? 1000 : 300;
      readingLineTop -= contraction;
      readingHeightMapTop -= contraction;
      readingScroller.scrollHeight -= contraction;
      // The nominal height-map delta need not be the correction actually applied to the DOM.
      readingScroller.scrollTop = correction === 'clamped'
        ? readingScroller.scrollHeight - readingScroller.clientHeight
        : adoptedTop - (correction === 'full' ? contraction : 120);
      readingScroller.dispatch('scroll', {});
      readingController.reconcileAfterEditorUpdate();
      for (let frame = 0; frame < 20; frame++) await readingFrame();
      const expected = adoptedTop - contraction;
      if (Math.abs(readingScroller.scrollTop - expected) > 1) {
        throw new Error(`Reading layout used a nominal rather than applied correction (${direction}, ${correction}): ${readingScroller.scrollTop} instead of ${expected}`);
      }
    }
  }
  for (const distance of [0, 4, 5]) {
    for (const delta of [-300, 300]) {
      readingController.markInteraction();
      readingScroller.scrollHeight = 5000;
      const adoptedTop = 4500 - distance;
      readingScroller.scrollTop = adoptedTop - 20;
      readingLineTop = adoptedTop + 200;
      readingHeightMapTop = 2000;
      nativeReadingWheel(20);
      await readingFrame();
      // Content below the reading line changes the boundary, not this line's geometry.
      readingScroller.scrollHeight += delta;
      readingScroller.scrollTop = delta > 0
        ? adoptedTop : readingScroller.scrollHeight - readingScroller.clientHeight;
      readingScroller.dispatch('scroll', {});
      readingController.reconcileAfterEditorUpdate();
      for (let frame = 0; frame < 20; frame++) await readingFrame();
      const expected = Math.min(adoptedTop, readingScroller.scrollHeight - readingScroller.clientHeight);
      if (Math.abs(readingScroller.scrollTop - expected) > 1) {
        throw new Error(`Bottom layout discarded adopted reading or chased an unreachable target (${distance}, ${delta}): ${readingScroller.scrollTop} instead of ${expected}`);
      }
    }
  }
  for (const nearBoundary of [false, true]) {
    for (const rangeDelta of [-300, 300]) {
      for (const direction of [-1, 1]) {
        readingController.markInteraction();
        readingScroller.scrollHeight = 5000;
        const adoptedTop = nearBoundary ? 4400 : 1000;
        readingScroller.scrollTop = adoptedTop - direction * 20;
        readingLineTop = adoptedTop + 200;
        readingHeightMapTop = 2000;
        nativeReadingWheel(direction * 20);
        await readingFrame();
        readingScroller.scrollHeight += rangeDelta;
        const boundaryTop = Math.min(adoptedTop, readingScroller.scrollHeight - readingScroller.clientHeight);
        const expected = Math.max(0, Math.min(readingScroller.scrollHeight - readingScroller.clientHeight,
          boundaryTop + direction * 17));
        // The same native gesture advances after a range change, without another wheel receipt.
        readingScroller.scrollTop = expected;
        readingScroller.dispatch('scroll', {});
        readingController.reconcileAfterEditorUpdate();
        for (let frame = 0; frame < 20; frame++) await readingFrame();
        if (Math.abs(readingScroller.scrollTop - expected) > 1) {
          throw new Error(`Range change discarded continuing native progress (${nearBoundary}, ${rangeDelta}, ${direction}): ${readingScroller.scrollTop} instead of ${expected}`);
        }
      }
    }
  }
  readingScroller.scrollHeight = 5000;
  for (const direction of [-1, 1]) {
    for (const phase of ['before-wheel', 'before-native-scroll', 'after-native-scroll']) {
      readingController.markInteraction();
      readingLineTop = 1200;
      readingHeightMapTop = -1400;
      readingScroller.scrollTop = 1000;
      const receiveWheel = () => readingScroller.dispatch('wheel', { deltaX: 0, deltaY: direction * 20, ctrlKey: false });
      if (phase !== 'before-wheel') receiveWheel();
      if (phase === 'after-native-scroll') {
        readingScroller.scrollTop += direction * 20;
        readingScroller.dispatch('scroll', {});
      }
      const handle = readingController.captureDocumentPresentationAnchorToken('editor');
      let completePresentation!: () => void;
      const presentation = readingController.runAnchorTransaction(handle, 'editor', async () => {
        await new Promise<void>(resolve => { completePresentation = resolve; });
        readingController.runDocumentPresentation(() => {
          // A virtual gap contracts while native scroll adoption is still in flight.
          readingLineTop -= 40;
          readingHeightMapTop -= 40;
          readingScroller.scrollHeight -= 40;
          readingScroller.scrollTop -= 40;
          readingController.reconcileAfterEditorUpdate();
        });
      });
      if (phase === 'before-wheel') receiveWheel();
      readingScroller.scrollTop += direction * 20;
      readingScroller.dispatch('scroll', {});
      completePresentation();
      await presentation;
      for (let frame = 0; frame < 20; frame++) await readingFrame();
      const expected = 960 + direction * (phase === 'after-native-scroll' ? 40 : 20);
      if (Math.abs(readingScroller.scrollTop - expected) > 1) {
        throw new Error(`Document presentation discarded native scroll (${phase}, ${direction}): ${readingScroller.scrollTop} instead of ${expected}`);
      }
    }
  }
  for (const direction of [-1, 1]) {
    for (const phase of ['before-wheel', 'before-native-scroll', 'after-native-scroll']) {
      readingController.markInteraction();
      readingLineTop = 1200;
      readingHeightMapTop = -1400;
      readingScroller.scrollTop = 1000;
      const receiveWheel = () => readingScroller.dispatch('wheel', { deltaX: 0, deltaY: direction * 20, ctrlKey: false });
      if (phase !== 'before-wheel') receiveWheel();
      if (phase === 'after-native-scroll') {
        readingScroller.scrollTop += direction * 20;
        readingScroller.dispatch('scroll', {});
      }
      let presented = false;
      readingController.runDocumentPresentation(() => {
        presented = true;
        readingLineTop -= 40;
        readingHeightMapTop -= 40;
        readingScroller.scrollHeight -= 40;
        readingScroller.scrollTop -= 40;
        readingController.reconcileAfterEditorUpdate();
      });
      if (!presented) throw new Error('Standalone presentation skipped its Document update');
      if (phase === 'before-wheel') receiveWheel();
      readingScroller.scrollTop += direction * 20;
      readingScroller.dispatch('scroll', {});
      for (let frame = 0; frame < 20; frame++) await readingFrame();
      const expected = 960 + direction * (phase === 'after-native-scroll' ? 40 : 20);
      if (Math.abs(readingScroller.scrollTop - expected) > 1) {
        throw new Error(`Standalone presentation discarded native scroll (${phase}, ${direction}): ${readingScroller.scrollTop} instead of ${expected}`);
      }
    }
  }
  nativeReadingWheel(20);
  if (!readingController.captureAnchorToken('editor')) {
    throw new Error('An explicit viewport action must still supersede native reading');
  }
  for (const direction of [-1, 1]) {
    for (const adopted of [false, true]) {
      readingController.markInteraction();
      readingLineTop = 1200;
      readingHeightMapTop = -1400;
      readingScroller.scrollTop = 1000;
      readingScroller.dispatch('wheel', { deltaX: 0, deltaY: direction * 20, ctrlKey: false });
      if (adopted) {
        readingScroller.scrollTop += direction * 20;
        readingScroller.dispatch('scroll', {});
      }
      // Standalone bulk edits are explicit intentions, unlike background presentation scopes.
      readingController.runDocumentChange(() => {
        readingLineTop -= 40;
        readingHeightMapTop -= 40;
        readingScroller.scrollHeight -= 40;
        readingScroller.scrollTop -= 40;
        readingController.reconcileAfterEditorUpdate();
      });
      if (!readingController.captureDocumentPresentationAnchorToken('editor')) {
        throw new Error(`Standalone Document change retained the old native reading owner (${direction}, ${adopted})`);
      }
      for (let frame = 0; frame < 20; frame++) await readingFrame();
    }
  }
  readingDom.dispatch('beforeinput', { inputType: 'insertCompositionText' });
  readingScroller.scrollTop = 600;
  readingLineTop += 40;
  readingController.reconcileAfterEditorUpdate();
  for (let frame = 0; frame < 20; frame += 1) await readingFrame();
  if (readingScroller.scrollTop !== 600) {
    throw new Error('An obsolete reading anchor overrode the next interaction');
  }
  nativeReadingWheel(-20);
  for (let frame = 0; frame < 20; frame += 1) await readingFrame();
  const idleScrollTop = readingScroller.scrollTop;
  readingLineTop += 40;
  readingController.reconcileAfterEditorUpdate();
  await readingFrame();
  if (readingScroller.scrollTop !== idleScrollTop) {
    throw new Error('An idle wheel gesture retained a reading anchor');
  }
  readingLineTop = 120;
  nativeReadingWheel(-10_000);
  await readingFrame();
  readingLineTop += 40;
  readingController.reconcileAfterEditorUpdate();
  await readingFrame();
  if (readingScroller.scrollTop !== 0) {
    throw new Error(`Late reading layout hid the document start: ${readingScroller.scrollTop}`);
  }
} finally {
  readingController.destroy();
  performance.now = originalReadingNow;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    wheelFrames.push(callback);
    return wheelFrames.length;
  };
}

wheelScrollDOM.scrollTop = 1000;
let elementScrollIntoViewCalls = 0;
let navigationElementTop = 1800;
const navigationElement = {
  isConnected: true,
  getBoundingClientRect: () => ({
    top: navigationElementTop - wheelScrollDOM.scrollTop,
    bottom: navigationElementTop + 40 - wheelScrollDOM.scrollTop,
    left: 0,
    right: 200
  }),
  scrollIntoView: () => {
    elementScrollIntoViewCalls += 1;
    wheelScrollDOM.scrollTop = 1340;
  }
};
const elementReveal = wheelController.beginNavigationReveal();
wheelController.revealElement(navigationElement as any, elementReveal);
wheelScrollDOM.scrollTop = 0;
wheelDom.dispatch('beforeinput', { inputType: 'insertText' });
await Promise.resolve();
await flushFrames(wheelFrames);
if (elementScrollIntoViewCalls !== 0 || wheelScrollDOM.scrollTop !== 0) {
  throw new Error(
    `Element reveal escaped the Controller or outlived currentness: ${JSON.stringify({
      elementScrollIntoViewCalls,
      scrollTop: wheelScrollDOM.scrollTop
    })}`
  );
}
wheelScrollDOM.scrollTop = 1000;
const currentElementReveal = wheelController.beginNavigationReveal();
wheelController.revealElement(navigationElement as any, currentElementReveal);
navigationElementTop += 100;
await Promise.resolve();
await flushFrames(wheelFrames);
if (elementScrollIntoViewCalls !== 0 || wheelScrollDOM.scrollTop !== 1440) {
  throw new Error(
    `Current element reveal did not own settled scrolling: ${JSON.stringify({
      elementScrollIntoViewCalls,
      scrollTop: wheelScrollDOM.scrollTop
    })}`
  );
}

const revealScrollDOM = Object.assign(new FakeEventTarget(), {
  ownerDocument: new FakeEventTarget(),
  scrollTop: 100,
  scrollLeft: 0,
  scrollHeight: 2000,
  scrollWidth: 900,
  clientHeight: 500,
  clientWidth: 900,
  getBoundingClientRect: () => ({ top: 0, bottom: 500, left: 0, right: 900 })
});
const revealController = new ViewportController({
  dom: new FakeEventTarget(),
  scrollDOM: revealScrollDOM,
  state: { doc: { length: 1999 } },
  coordsAtPos: (position: number) => ({
    top: position - revealScrollDOM.scrollTop,
    bottom: position - revealScrollDOM.scrollTop + 20
  }),
  lineBlockAt: (position: number) => ({ top: position, bottom: position + 20, height: 20 }),
  requestMeasure: ({ read, write }: { read: () => unknown; write: (value: unknown) => void }) => write(read())
} as any, { attachInteractions: false });

let navigationAnchorTop = 1816.390625;
const navigationAnchorScrollDOM = Object.assign(new FakeEventTarget(), {
  ownerDocument: new FakeEventTarget(),
  scrollTop: 1816,
  scrollLeft: 0,
  scrollHeight: 3000,
  scrollWidth: 900,
  clientHeight: 500,
  clientWidth: 900,
  getBoundingClientRect: () => ({ top: 0, bottom: 500, left: 0, right: 900 })
});
const navigationAnchorController = new ViewportController({
  dom: new FakeEventTarget(),
  scrollDOM: navigationAnchorScrollDOM,
  state: { doc: { length: 1999 } },
  coordsAtPos: () => ({
    top: navigationAnchorTop - navigationAnchorScrollDOM.scrollTop + 3,
    bottom: navigationAnchorTop - navigationAnchorScrollDOM.scrollTop + 23
  }),
  lineBlockAt: () => ({ top: navigationAnchorTop, bottom: navigationAnchorTop + 24, height: 24 }),
  requestMeasure: ({ read, write }: { read: () => unknown; write: (value: unknown) => void }) => write(read())
} as any, { attachInteractions: false });
const exactNavigationAnchor = navigationAnchorController.beginNavigationReveal();
navigationAnchorController.revealPosition(760, { y: 'nearest' }, exactNavigationAnchor);
const navigationAnchorHandle = navigationAnchorController.captureAnchorToken('editor');
if (!navigationAnchorHandle) throw new Error('Visible navigation target did not produce an Editor anchor');
navigationAnchorTop = 1888.390625;
const navigationAnchorTrace = await runCausalFrameTrace(
  () => navigationAnchorController.restoreAnchorToken(navigationAnchorHandle, 'editor'),
  () => navigationAnchorScrollDOM.scrollTop
);
const unstableNavigationFrame = navigationAnchorTrace.findIndex((scrollTop) => scrollTop !== 1888);
if (unstableNavigationFrame >= 0) {
  throw new Error(
    `Navigation target moved during settlement at frame ${unstableNavigationFrame}: ${JSON.stringify(navigationAnchorTrace)}`
  );
}
if (navigationAnchorScrollDOM.scrollTop !== 1888) {
  throw new Error(
    `Navigation target mixed text and line-box offsets: ${navigationAnchorScrollDOM.scrollTop}`
  );
}
navigationAnchorController.destroy();

const visibleReveal = revealController.beginNavigationReveal();
revealController.revealPosition(200, { y: 'nearest' }, visibleReveal);
await Promise.resolve();
await flushFrames(wheelFrames);
if (revealScrollDOM.scrollTop !== 100) {
  throw new Error(`An already-visible target scrolled to ${revealScrollDOM.scrollTop}`);
}
const visibleCenterIfOutside = revealController.beginNavigationReveal();
revealController.revealPosition(200, { y: 'center-if-outside' }, visibleCenterIfOutside);
await Promise.resolve();
await flushFrames(wheelFrames);
if (revealScrollDOM.scrollTop !== 100) {
  throw new Error(`Center-if-outside moved an already-visible target to ${revealScrollDOM.scrollTop}`);
}
const offscreenCenterIfOutside = revealController.beginNavigationReveal();
revealController.revealPosition(900, { y: 'center-if-outside' }, offscreenCenterIfOutside);
await Promise.resolve();
await flushFrames(wheelFrames);
if (revealScrollDOM.scrollTop !== 660) {
  throw new Error(`Center-if-outside reached ${revealScrollDOM.scrollTop} instead of 660`);
}
revealScrollDOM.scrollTop = 100;
const offscreenReveal = revealController.beginNavigationReveal();
revealController.revealPosition(900, { y: 'nearest' }, offscreenReveal);
await Promise.resolve();
await flushFrames(wheelFrames);
if (revealScrollDOM.scrollTop !== 420) {
  throw new Error(`Nearest reveal reached ${revealScrollDOM.scrollTop} instead of 420`);
}
revealScrollDOM.scrollTop = 100;
const contextualBelowReveal = revealController.beginNavigationReveal();
revealController.revealPosition(900, { y: 'nearest', yMargin: 40 }, contextualBelowReveal);
await Promise.resolve();
await flushFrames(wheelFrames);
if (revealScrollDOM.scrollTop !== 460) {
  throw new Error(`Contextual nearest reveal below reached ${revealScrollDOM.scrollTop} instead of 460`);
}
revealScrollDOM.scrollTop = 700;
const contextualAboveReveal = revealController.beginNavigationReveal();
revealController.revealPosition(200, { y: 'nearest', yMargin: 40 }, contextualAboveReveal);
await Promise.resolve();
await flushFrames(wheelFrames);
if (revealScrollDOM.scrollTop !== 160) {
  throw new Error(`Contextual nearest reveal above reached ${revealScrollDOM.scrollTop} instead of 160`);
}
revealScrollDOM.scrollTop = 180;
const contextualVisibleReveal = revealController.beginNavigationReveal();
revealController.revealPosition(200, { y: 'nearest', yMargin: 40 }, contextualVisibleReveal);
await Promise.resolve();
await flushFrames(wheelFrames);
if (revealScrollDOM.scrollTop !== 180) {
  throw new Error(`Contextual nearest reveal moved an already-visible target to ${revealScrollDOM.scrollTop}`);
}
revealScrollDOM.scrollTop = 660;
const preInputViewportReveal = revealController.beginNavigationReveal();
revealController.revealPosition(900, {
  y: 'nearest',
  yMargin: 40,
  originScrollTop: 1000
}, preInputViewportReveal);
await Promise.resolve();
await flushFrames(wheelFrames);
if (revealScrollDOM.scrollTop !== 860) {
  throw new Error(`Input auto-scroll was not corrected to the original nearest edge: ${revealScrollDOM.scrollTop}`);
}
revealScrollDOM.scrollTop = 660;
const preInputVisibleReveal = revealController.beginNavigationReveal();
revealController.revealPosition(900, {
  y: 'nearest',
  yMargin: 40,
  originScrollTop: 700
}, preInputVisibleReveal);
await Promise.resolve();
await flushFrames(wheelFrames);
if (revealScrollDOM.scrollTop !== 700) {
  throw new Error(`Input auto-scroll moved a caret that was visible before input: ${revealScrollDOM.scrollTop}`);
}
revealScrollDOM.scrollTop = 100;
const occludedBoundsReveal = revealController.beginNavigationReveal();
revealController.revealVerticalBounds(
  () => ({
    top: 110 - revealScrollDOM.scrollTop,
    bottom: 130 - revealScrollDOM.scrollTop
  }),
  occludedBoundsReveal,
  { yMargin: 20, readViewportBounds: () => ({ top: 50, bottom: 500 }) }
);
await Promise.resolve();
await flushFrames(wheelFrames);
if (revealScrollDOM.scrollTop !== 40) {
  throw new Error(`Occluded caret bounds were not revealed below fixed chrome: ${revealScrollDOM.scrollTop}`);
}
revealScrollDOM.scrollTop = 100;
const lineBlockContextReveal = revealController.beginNavigationReveal();
revealController.revealPosition(900, {
  geometry: 'line-block',
  marginMode: 'comfort-band',
  y: 'nearest',
  yMargin: 40
}, lineBlockContextReveal);
await Promise.resolve();
await flushFrames(wheelFrames);
if (revealScrollDOM.scrollTop !== 460) {
  throw new Error(`Line-block contextual reveal reached ${revealScrollDOM.scrollTop} instead of 460`);
}
revealScrollDOM.scrollTop = 420;
const staleReveal = revealController.beginNavigationReveal();
revealController.revealPosition(1500, { y: 'nearest', schedule: 'next-frame' }, staleReveal);
revealController.markInteraction();
await Promise.resolve();
await flushFrames(wheelFrames);
if (revealScrollDOM.scrollTop !== 420) {
  throw new Error(`A stale reveal moved the viewport to ${revealScrollDOM.scrollTop}`);
}

type GeometryShiftInterruption = 'none' | 'stale-frame' | 'destroy' | 'late-measure' | 'editor-update-overwrite' | 'editor-update-layout' | 'read-write-layout' | 'font-read-write-layout' | 'layout-preservation' | 'overlap-layout-preservation';

const runGeometryShiftReveal = async (
  kind: 'ordinary' | 'settled' | 'bounds' | 'retained' | 'initially-stable' | 'retained-stable',
  interruption: GeometryShiftInterruption = 'none'
) => {
  const frames: FrameRequestCallback[] = [];
  const measures: Array<{
    read: () => unknown;
    write: (value: unknown) => void;
  }> = [];
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  };

  let targetTop = kind === 'initially-stable' ? 1240 : kind === 'retained-stable' ? 1350 : 1600;
  let readingLineTop = 1500;
  let scrollTop = 1000;
  const writes: number[] = [];
  const scrollDOM = {
    get scrollTop() { return scrollTop; },
    set scrollTop(value: number) {
      scrollTop = value;
      writes.push(value);
    },
    scrollLeft: 0,
    scrollHeight: 5000,
    scrollWidth: 900,
    clientHeight: 500,
    clientWidth: 900,
    getBoundingClientRect: () => ({ top: 0, bottom: 500, left: 0, right: 900 })
  };
  const controller = new ViewportController({
    dom: new FakeEventTarget(),
    scrollDOM,
    contentDOM: {
      querySelectorAll: () => [{ getBoundingClientRect: () => ({ top: readingLineTop - scrollTop }) }]
    },
    posAtDOM: () => 100,
    state: { doc: { length: 4999 } },
    coordsAtPos: () => ({
      top: targetTop - scrollTop,
      bottom: targetTop + 20 - scrollTop
    }),
    lineBlockAt: (position: number) => {
      const top = position === 100 ? readingLineTop : targetTop;
      return { top, bottom: top + 20, height: 20 };
    },
    requestMeasure: (measure?: { read: () => unknown; write: (value: unknown) => void }) => {
      if (measure) measures.push(measure);
    }
  } as any, { attachInteractions: false });
  const flushMeasure = (beforeWrite?: () => void) => {
    const batch = measures.splice(0);
    const results = batch.map((measure) => measure.read());
    beforeWrite?.();
    batch.forEach((measure, index) => measure.write(results[index]));
  };
  const flushAll = async () => {
    while (measures.length > 0 || frames.length > 0) {
      while (measures.length > 0) flushMeasure();
      frames.splice(0).forEach((frame) => frame(0));
      await Promise.resolve();
    }
  };

  try {
    const isCurrent = controller.beginNavigationReveal();
    if (kind === 'retained' || kind === 'retained-stable') controller.retainPositionTop(1600, 350, isCurrent);
    else if (kind === 'ordinary') controller.revealPosition(1600, { y: 'center' }, isCurrent);
    else if (kind === 'bounds') controller.revealVerticalBounds(
      () => ({ top: targetTop - scrollTop, bottom: targetTop + 20 - scrollTop }),
      isCurrent
    );
    else controller.revealPositionUntilStable(1600, { y: 'center' }, isCurrent);

    if (interruption === 'font-read-write-layout') {
      flushMeasure(() => { targetTop += 40; });
      await Promise.resolve();
      if (scrollTop !== 1040) throw new Error('An initially stable measurement painted a later font offset before retaining it');
      await flushAll();
      return { scrollTop, writes, targetVisible: true };
    } else if (interruption === 'read-write-layout') {
      // CodeMirror redraws and changes the height map between requestMeasure's
      // read and write phases. No stale absolute target may reach the scroller.
      flushMeasure(() => { targetTop += 600; scrollTop += 600; });
      await flushAll();
    } else if (interruption === 'late-measure') {
      flushMeasure(() => { controller.beginNavigationReveal(); });
    } else {
      flushMeasure();
      await Promise.resolve();
      if (interruption === 'editor-update-layout') {
        targetTop += 600;
        scrollTop += 200;
        controller.reconcileAfterEditorUpdate();
        // The input owner receives this completed geometry receipt before the
        // browser paints, while the next measure request is still queued.
        controller.retainPositionTop(1600, 350, isCurrent, true);
        await Promise.resolve();
        if (targetTop - scrollTop !== 350) {
          throw new Error(`Retained caret used an old absolute offset after measurement: ${targetTop - scrollTop}`);
        }
        await flushAll();
        return { scrollTop, writes, targetVisible: targetTop >= scrollTop && targetTop + 20 <= scrollTop + 500 };
      }
      if (interruption === 'layout-preservation' || interruption === 'overlap-layout-preservation') {
        if (interruption === 'overlap-layout-preservation') {
          // The same navigation can request another reveal after adopting its
          // target. Its no-op completion must not finish the pending reveal.
          controller.revealPositionUntilStable(1600, { y: 'center' }, isCurrent);
          flushMeasure();
          await Promise.resolve();
        }
        // A late block between the visible reading line and navigation target
        // must settle the explicit target rather than reserve that older line.
        controller.preserveLayoutChange({
          element: { isConnected: true, getBoundingClientRect: () => ({ top: 100, bottom: 200 }) } as any,
          from: 1200,
          to: 1201
        }, () => { targetTop += 600; });
        await flushAll();
        const targetVisible = targetTop >= scrollTop && targetTop + 20 <= scrollTop + 500;
        const navigationResult = { scrollTop, writes: [...writes], targetVisible };
        if (interruption === 'overlap-layout-preservation') {
          // After both reveals finish, passive layout must again preserve the
          // visible reading line rather than retain a completed navigation.
          readingLineTop = scrollTop + 190;
          controller.preserveLayoutChange({
            element: { isConnected: true, getBoundingClientRect: () => ({ top: 50, bottom: 100 }) } as any,
            from: 50,
            to: 51
          }, () => { readingLineTop += 40; targetTop += 40; });
          await flushAll();
          if (scrollTop !== navigationResult.scrollTop + 40) {
            throw new Error(`Completed overlapping reveals blocked reading preservation: ${scrollTop}`);
          }
        }
        return navigationResult;
      }
      if (interruption === 'editor-update-overwrite') {
        scrollTop = 1000;
        controller.reconcileAfterEditorUpdate();
        await flushAll();
        const targetVisible = targetTop >= scrollTop && targetTop + 20 <= scrollTop + 500;
        return { scrollTop, writes, targetVisible };
      }
      targetTop += 600;
      if (interruption === 'stale-frame') controller.beginNavigationReveal();
      if (interruption === 'destroy') controller.destroy();
      await flushAll();
    }

    const targetVisible = targetTop >= scrollTop && targetTop + 20 <= scrollTop + 500;
    return { scrollTop, writes, targetVisible };
  } finally {
    controller.destroy();
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
  }
};

const initiallyStableReveal = await runGeometryShiftReveal('initially-stable');
if (!initiallyStableReveal.targetVisible || JSON.stringify(initiallyStableReveal.writes) !== '[1600]')
  throw new Error(`An initially stable reveal missed the following layout receipt: ${JSON.stringify(initiallyStableReveal)}`);
const cancelledStableReveal = await runGeometryShiftReveal('initially-stable', 'stale-frame');
if (cancelledStableReveal.writes.length !== 0)
  throw new Error('A newer interaction must cancel an initially stable reveal before it adopts scrolling');
await runGeometryShiftReveal('initially-stable', 'font-read-write-layout');
await runGeometryShiftReveal('retained-stable', 'font-read-write-layout');

for (const kind of ['settled', 'bounds'] as const) {
  const result = await runGeometryShiftReveal(kind, 'read-write-layout');
  const expected = kind === 'bounds' ? '[1720]' : '[1960]';
  if (!result.targetVisible || JSON.stringify(result.writes) !== expected) {
    throw new Error(`Reveal wrote geometry captured before redraw (${kind}): ${JSON.stringify(result)}`);
  }
}

const ordinaryGeometryReveal = await runGeometryShiftReveal('ordinary');
if (
  ordinaryGeometryReveal.targetVisible ||
  JSON.stringify(ordinaryGeometryReveal.writes) !== '[1360]'
) {
  throw new Error(`One-shot reveal did not expose the layout overwrite: ${JSON.stringify(ordinaryGeometryReveal)}`);
}
const retainedGeometryReveal = await runGeometryShiftReveal('retained', 'editor-update-layout');
if (!retainedGeometryReveal.targetVisible || JSON.stringify(retainedGeometryReveal.writes) !== '[1250,1250,1850]') {
  throw new Error(`Measured layout changed a retained caret's viewport offset: ${JSON.stringify(retainedGeometryReveal)}`);
}
const settledGeometryReveal = await runGeometryShiftReveal('settled');
if (
  !settledGeometryReveal.targetVisible ||
  JSON.stringify(settledGeometryReveal.writes) !== '[1360,1960]'
) {
  throw new Error(`Settled reveal did not restore the shifted target: ${JSON.stringify(settledGeometryReveal)}`);
}
const reconciledGeometryReveal = await runGeometryShiftReveal('settled', 'editor-update-overwrite');
if (
  !reconciledGeometryReveal.targetVisible ||
  JSON.stringify(reconciledGeometryReveal.writes) !== '[1360,1360]'
) {
  throw new Error(
    `Editor measurement overrode an active reveal: ${JSON.stringify(reconciledGeometryReveal)}`
  );
}
const layoutPreservedGeometryReveal = await runGeometryShiftReveal('settled', 'layout-preservation');
if (
  !layoutPreservedGeometryReveal.targetVisible ||
  JSON.stringify(layoutPreservedGeometryReveal.writes) !== '[1360,1960]'
) {
  throw new Error(`Late block layout replaced the navigation target: ${JSON.stringify(layoutPreservedGeometryReveal)}`);
}
const overlappingGeometryReveal = await runGeometryShiftReveal('settled', 'overlap-layout-preservation');
if (
  !overlappingGeometryReveal.targetVisible ||
  JSON.stringify(overlappingGeometryReveal.writes) !== '[1360,1960]'
) {
  throw new Error(`An overlapping reveal released the pending navigation target: ${JSON.stringify(overlappingGeometryReveal)}`);
}
for (const interruption of ['stale-frame', 'destroy', 'late-measure'] as const) {
  const interruptedReveal = await runGeometryShiftReveal('settled', interruption);
  const expectedWrites = interruption === 'late-measure' ? '[]' : '[1360]';
  if (JSON.stringify(interruptedReveal.writes) !== expectedWrites) {
    throw new Error(`A ${interruption} settled reveal wrote after invalidation: ${JSON.stringify(interruptedReveal)}`);
  }
}
// History can finish its finite reveal before CodeMirror's later height-map
// measurement. Keep the target through that receipt, but yield to new intent.
for (const initialTargetTop of [1400, 1600])
for (const interruption of ['none', 'input', 'scroll', 'navigation', 'destroy'] as const) {
  let targetTop = initialTargetTop;
  const scroll = Object.assign(new FakeEventTarget(), {
    scrollTop: 1000, scrollLeft: 0, scrollHeight: 5000, scrollWidth: 900,
    clientHeight: 500, clientWidth: 900,
    getBoundingClientRect: () => ({ top: 0, bottom: 500, left: 0, right: 900 })
  });
  const controller = new ViewportController({
    dom: new FakeEventTarget(), scrollDOM: scroll, state: { doc: { length: 4999 } },
    lineBlockAt: () => ({ top: targetTop, bottom: targetTop + 20, height: 20 }),
    requestMeasure: ({ read, write }: any) => write(read())
  } as any, { attachInteractions: false });
  try {
    const current = controller.beginNavigationReveal();
    controller.revealPositionUntilStable(1600, {
      geometry: 'line-block', marginMode: 'comfort-band', yMargin: 40,
      retainOnLayout: true
    }, current);
    if (interruption === 'scroll') {
      await Promise.resolve();
      while ([...(controller as any).activeNavigationReveals][0]?.phase !== 'idle' && wheelFrames.length) {
        wheelFrames.shift()?.(0);
        await Promise.resolve();
      }
    } else await flushFrames(wheelFrames);
    if (targetTop + 20 > scroll.scrollTop + 460) throw new Error('Initial history target was not revealed');
    if (interruption === 'input') controller.markInteraction();
    if (interruption === 'navigation') controller.beginNavigationReveal();
    if (interruption === 'destroy') controller.destroy();
    if (interruption === 'scroll') {
      scroll.scrollTop -= 200;
      (controller as any).onScroll();
    }
    if (interruption !== 'none' && scroll.listenerCount('meo-viewport-layout-change') !== 0) {
      throw new Error(`History listener survived ${interruption}`);
    }
    // Same ordering as EditorView.measure: height-map scroll compensation,
    // finished geometry receipt, then the browser scroll event.
    targetTop += 260;
    scroll.scrollTop += 70;
    const beforeReceipt = scroll.scrollTop;
    scroll.dispatch('meo-viewport-layout-change', {});
    (controller as any).onScroll();
    await Promise.resolve();
    await flushFrames(wheelFrames);
    if (interruption === 'none') {
      if (targetTop + 20 > scroll.scrollTop + 460) throw new Error('Late measured history target escaped the viewport');
    } else if (scroll.scrollTop !== beforeReceipt) {
      throw new Error(`History retention survived ${interruption}`);
    }
    controller.destroy();
    if (scroll.listenerCount('meo-viewport-layout-change') !== 0) throw new Error('History layout listener leaked');
  } finally { controller.destroy(); }
}

const tallScrollDOM = Object.assign(new FakeEventTarget(), {
  ownerDocument: new FakeEventTarget(),
  scrollTop: 1000,
  scrollLeft: 0,
  scrollHeight: 3000,
  scrollWidth: 900,
  clientHeight: 500,
  clientWidth: 900,
  getBoundingClientRect: () => ({ top: 0, bottom: 500, left: 0, right: 900 })
});
const tallController = new ViewportController({
  dom: new FakeEventTarget(),
  scrollDOM: tallScrollDOM,
  state: { doc: { length: 1999 } },
  coordsAtPos: () => ({
    top: 1520 - tallScrollDOM.scrollTop,
    bottom: 1540 - tallScrollDOM.scrollTop
  }),
  lineBlockAt: () => ({ top: 600, bottom: 1800, height: 1200 }),
  requestMeasure: ({ read, write }: { read: () => unknown; write: (value: unknown) => void }) => write(read())
} as any, { attachInteractions: false });
const tallNearestReveal = tallController.beginNavigationReveal();
tallController.revealPosition(900, { y: 'nearest' }, tallNearestReveal);
await flushFrames(wheelFrames);
if (tallScrollDOM.scrollTop !== 1040) {
  throw new Error(`Tall wrapped nearest reveal moved to ${tallScrollDOM.scrollTop} instead of 1040`);
}
tallScrollDOM.scrollTop = 1000;
const tallCenterReveal = tallController.beginNavigationReveal();
tallController.revealPosition(900, { y: 'center' }, tallCenterReveal);
await flushFrames(wheelFrames);
if (tallScrollDOM.scrollTop !== 1280) {
  throw new Error(`Tall wrapped center reveal moved to ${tallScrollDOM.scrollTop} instead of 1280`);
}
tallController.destroy();
const isolatedWheelReveal = wheelController.beginNavigationReveal();
const isolatedReveal = revealController.beginNavigationReveal();
wheelController.markInteraction();
if (isolatedWheelReveal() || !isolatedReveal()) {
  throw new Error('Navigation reveal currentness leaked across editors');
}
revealController.destroy();
if (isolatedReveal()) {
  throw new Error('Destroy left a navigation reveal current');
}

wheelScrollDOM.scrollTop = 500;
const retainedNavigation = wheelController.beginNavigationReveal();
wheelController.retainScrollTop(500, retainedNavigation);
if (!retainedNavigation()) {
  throw new Error('Retaining scroll superseded its navigation intent');
}
wheelScrollDOM.scrollTop = 476;
wheelController.reconcileAfterEditorUpdate();
if (wheelScrollDOM.scrollTop !== 500) {
  throw new Error(`Editor measurement overrode a retained viewport: ${wheelScrollDOM.scrollTop}`);
}
wheelScrollDOM.scrollTop = 476;
await flushFrames(wheelFrames);
if (wheelScrollDOM.scrollTop !== 500) {
  throw new Error(`Retained presentation drifted to ${wheelScrollDOM.scrollTop}`);
}
wheelController.markInteraction();
wheelScrollDOM.scrollTop = 450;
await flushFrames(wheelFrames);
if (wheelScrollDOM.scrollTop !== 450) {
  throw new Error(`A user interaction did not cancel retained scroll: ${wheelScrollDOM.scrollTop}`);
}

wheelController.lockScrollTop(200);
dispatchWheel(-80);
wheelScrollDOM.scrollTop = 0;
wheelFrames.shift()?.(0);
if (wheelScrollDOM.scrollTop !== 0) {
  throw new Error(`A newer wheel interaction was pulled back to ${wheelScrollDOM.scrollTop}`);
}

let historyRestoreCurrent = false;
wheelController.lockScrollTop(300, () => historyRestoreCurrent);
if (wheelScrollDOM.scrollTop !== 0 || wheelFrames.length !== 0) {
  throw new Error('A stale history restore scheduled a viewport lock');
}
historyRestoreCurrent = true;
wheelController.lockScrollTop(300, () => historyRestoreCurrent);
historyRestoreCurrent = false;
wheelScrollDOM.scrollTop = 0;
wheelFrames.shift()?.(0);
if (wheelScrollDOM.scrollTop !== 0 || wheelFrames.length !== 0) {
  throw new Error('A stale history restore continued its viewport lock');
}

dispatchWheel(-80);
wheelScrollDOM.scrollTop = 920;
wheelScrollDOM.dispatch('scroll', {});
await Promise.resolve();
await flushFrames(wheelFrames);

wheelController.markInteraction();
wheelScrollDOM.scrollTop = 1000;
dispatchWheel(-80);
wheelScrollDOM.scrollTop = 920;
wheelScrollDOM.dispatch('scroll', {});
wheelScrollDOM.scrollTop = 840;
wheelScrollDOM.dispatch('scroll', {});
await flushFrames(wheelFrames);
if (wheelScrollDOM.scrollTop !== 840) {
  throw new Error(`Native upward momentum rebounded to ${wheelScrollDOM.scrollTop}`);
}

wheelScrollDOM.scrollTop = 1300;
dispatchWheel(-80);
wheelScrollDOM.scrollTop = 1220;
wheelScrollDOM.dispatch('scroll', {});
await Promise.resolve();
await flushFrames(wheelFrames);

if (defaultPrevented) {
  throw new Error('Viewport controller prevented native wheel scrolling');
}
if (wheelScrollDOM.scrollTop !== 1220) {
  throw new Error(`Viewport controller overrode native wheel scrolling: ${wheelScrollDOM.scrollTop}`);
}

const readingWheelDom = new FakeEventTarget();
const readingWheelDocument = new FakeEventTarget();
let readingAnchorDocumentTop = 1200;
let readingCaretOffset = 0;
let readingEstimatedOffset = 0;
const readingWheelScrollDOM = Object.assign(new FakeEventTarget(), {
  ownerDocument: readingWheelDocument,
  scrollTop: 1000,
  scrollLeft: 0,
  scrollHeight: 5000,
  scrollWidth: 900,
  clientHeight: 500,
  clientWidth: 900,
  getBoundingClientRect: () => ({ top: 0, bottom: 500, left: 0, right: 900, height: 500, width: 900 })
});
const readingWheelLine = {
  classList: { contains: () => false },
  closest: () => null,
  getBoundingClientRect: () => ({
    top: readingAnchorDocumentTop - readingWheelScrollDOM.scrollTop,
    bottom: readingAnchorDocumentTop - readingWheelScrollDOM.scrollTop + 20
  })
};
const readingWheelView = {
  dom: readingWheelDom,
  defaultLineHeight: 20,
  scrollDOM: readingWheelScrollDOM,
  contentDOM: { querySelectorAll: () => [readingWheelLine] },
  posAtDOM: () => 42,
  lineBlockAt: () => ({ from: 42, top: readingAnchorDocumentTop + readingEstimatedOffset }),
  lineBlockAtHeight: () => ({ from: 42, top: readingAnchorDocumentTop + readingEstimatedOffset }),
  coordsAtPos: () => ({
    top: readingAnchorDocumentTop + readingCaretOffset - readingWheelScrollDOM.scrollTop,
    bottom: readingAnchorDocumentTop - readingWheelScrollDOM.scrollTop + 20
  }),
  requestMeasure: ({ read, write }: { read: () => unknown; write: (value: unknown) => void }) => write(read())
};
let pendingScrollMeasurement: { layoutDelta: number; estimateDelta: number } | null = null;
// CodeMirror installs this non-capture observer before the viewport controller.
// It can synchronously measure and reconcile inside the native scroll event.
readingWheelScrollDOM.addEventListener('scroll', () => {
  if (!pendingScrollMeasurement) return;
  const { layoutDelta, estimateDelta } = pendingScrollMeasurement;
  pendingScrollMeasurement = null;
  readingAnchorDocumentTop += layoutDelta;
  readingEstimatedOffset += estimateDelta;
  readingWheelScrollDOM.scrollTop += layoutDelta + estimateDelta;
  readingWheelController.reconcileAfterEditorUpdate();
});
const readingWheelController = new ViewportController(readingWheelView as any);
for (const progress of [-21.375, 23.5]) {
  for (const layoutDelta of [-48.25, 0, 78.75]) {
    readingWheelController.markInteraction();
    readingAnchorDocumentTop = 1200;
    readingEstimatedOffset = 0;
    readingWheelScrollDOM.scrollTop = 1000;
    readingWheelScrollDOM.dispatch('wheel', { deltaX: 0, deltaY: Math.sign(progress) * 120, ctrlKey: false });
    readingWheelScrollDOM.scrollTop += Math.sign(progress) * 20;
    readingWheelScrollDOM.dispatch('scroll', {});
    readingWheelScrollDOM.scrollTop += progress;
    const nativeTop = readingWheelScrollDOM.scrollTop;
    pendingScrollMeasurement = { layoutDelta, estimateDelta: 27.5 };
    readingWheelScrollDOM.dispatch('scroll', {});
    const expected = nativeTop + layoutDelta;
    if (Math.abs(readingWheelScrollDOM.scrollTop - expected) > 0.01) {
      throw new Error(`Scroll-event measurement discarded native progress: ${JSON.stringify({
        progress, layoutDelta, nativeTop, expected, actual: readingWheelScrollDOM.scrollTop
      })}`);
    }
  }
}
readingWheelController.markInteraction();
readingAnchorDocumentTop = 1200;
readingEstimatedOffset = 0;
readingWheelScrollDOM.scrollTop = 1000;
readingWheelScrollDOM.dispatch('wheel', { deltaX: 0, deltaY: -100, ctrlKey: false });
readingWheelScrollDOM.scrollTop = 970;
readingWheelScrollDOM.dispatch('scroll', {});
// Font/token changes can move caret rectangles inside a stable line box.
readingCaretOffset = 18;
readingWheelScrollDOM.scrollTop = 920;
readingWheelController.reconcileAfterEditorUpdate();
if (readingWheelScrollDOM.scrollTop !== 920) {
  throw new Error(`Caret geometry interrupted native reading progress: ${readingWheelScrollDOM.scrollTop}`);
}
readingWheelScrollDOM.dispatch('scroll', {});
readingAnchorDocumentTop += 48;
readingWheelScrollDOM.scrollTop += 48;
readingWheelController.reconcileAfterEditorUpdate();
if (readingWheelScrollDOM.scrollTop !== 968) {
  throw new Error(`Measured line growth was compensated twice: ${readingWheelScrollDOM.scrollTop}`);
}
readingEstimatedOffset = 27;
readingWheelScrollDOM.scrollTop += 27;
readingWheelController.reconcileAfterEditorUpdate();
if (readingWheelScrollDOM.scrollTop !== 968) {
  throw new Error(`Height-map-only correction moved stable reading content: ${readingWheelScrollDOM.scrollTop}`);
}
readingWheelController.markInteraction();
readingEstimatedOffset = 0;
readingCaretOffset = 0;
readingWheelScrollDOM.scrollTop = 820;
readingWheelScrollDOM.dispatch('wheel', {
  deltaX: 0,
  deltaY: -180,
  deltaMode: 0,
  ctrlKey: false
});
wheelFrames.shift()?.(0);
readingAnchorDocumentTop += 14;
readingWheelScrollDOM.scrollHeight += 14;
await flushFrames(wheelFrames);
if (readingWheelScrollDOM.scrollTop !== 820) {
  throw new Error(
    `A positive height correction overrode native reading scroll: ${readingWheelScrollDOM.scrollTop}`
  );
}
readingWheelScrollDOM.scrollTop = 654;
readingAnchorDocumentTop = 854;
readingWheelScrollDOM.dispatch('wheel', {
  deltaX: 0,
  deltaY: -180,
  deltaMode: 0,
  ctrlKey: false
});
wheelFrames.shift()?.(0);
readingAnchorDocumentTop -= 20;
readingWheelScrollDOM.scrollHeight -= 20;
await flushFrames(wheelFrames);
if (readingWheelScrollDOM.scrollTop !== 654) {
  throw new Error(
    `A negative height correction overrode native reading scroll: ${readingWheelScrollDOM.scrollTop}`
  );
}
// Smooth scrolling continues well after its last wheel event. Late virtual
// height-map anchoring must not become a visible backward step during its tail.
const originalMomentumNow = performance.now;
let momentumNow = 0;
performance.now = () => momentumNow;
try {
  readingWheelController.markInteraction();
  readingAnchorDocumentTop = 1200;
  readingEstimatedOffset = 0;
  readingWheelScrollDOM.scrollTop = 1000;
  readingWheelScrollDOM.dispatch('wheel', { deltaX: 0, deltaY: -1200, ctrlKey: false });
  for (const [time, top] of [[100, 970], [300, 930], [450, 900]]) {
    momentumNow = time;
    readingWheelScrollDOM.scrollTop = top;
    readingWheelScrollDOM.dispatch('scroll', {});
    const pendingFrames = wheelFrames.splice(0);
    for (const frame of pendingFrames) frame(time);
    await Promise.resolve();
  }
  momentumNow = 500;
  readingEstimatedOffset = 100;
  readingWheelScrollDOM.scrollTop += 100;
  readingWheelController.reconcileAfterEditorUpdate();
  if (readingWheelScrollDOM.scrollTop !== 900) {
    throw new Error(`Late height-map anchoring rebounded during native smooth progress: ${readingWheelScrollDOM.scrollTop}`);
  }
  momentumNow = 1500;
  for (let n = 0; n < 5; n++) {
    const pendingFrames = wheelFrames.splice(0);
    for (const frame of pendingFrames) frame(momentumNow);
    await Promise.resolve();
  }
  readingEstimatedOffset += 90;
  readingWheelScrollDOM.scrollTop += 90;
  readingWheelController.reconcileAfterEditorUpdate();
  if (readingWheelScrollDOM.scrollTop !== 900) {
    throw new Error(`Idle reading lost its anchor before a deferred block measurement: ${readingWheelScrollDOM.scrollTop}`);
  }
} finally {
  readingWheelController.markInteraction();
  performance.now = originalMomentumNow;
}
readingWheelController.destroy();
if (readingWheelScrollDOM.listenerCount('scroll') !== 1 || readingWheelScrollDOM.listenerCount('wheel') !== 0) {
  throw new Error('Destroy must detach the capture scroll listener and leave other observers intact');
}

// A viewport can contain only a rendered table or a diagram, without a normal
// CodeMirror line. Delayed height-map receipts still need a visual reading owner.
for (const kind of ['table', 'mermaid']) {
  const document = new FakeEventTarget();
  const scroller = Object.assign(new FakeEventTarget(), {
    ownerDocument: document, scrollTop: 1000, scrollLeft: 0,
    scrollHeight: 5000, scrollWidth: 900, clientHeight: 500, clientWidth: 900,
    getBoundingClientRect: () => ({ top: 0, bottom: 500, height: 500 })
  });
  const source = Text.of(Array.from({ length: 80 }, () => 'source'));
  const position = source.line(42).from;
  let estimateDelta = 0;
  const block = {
    dataset: kind === 'table' ? { sourceLineNumber: '42' }
      : { meoRenderedBlockStartLine: '42', meoRenderedBlockKind: kind },
    getBoundingClientRect: () => ({
      top: 800 - scroller.scrollTop,
      bottom: 2000 - scroller.scrollTop
    })
  };
  const view = {
    dom: new FakeEventTarget(), scrollDOM: scroller, state: { doc: source },
    contentDOM: { querySelectorAll: (selector: string) => {
      if (selector === ':scope > .cm-line') return [];
      return selector.includes(kind === 'table' ? 'data-source-line-number' : 'data-meo-rendered-block')
        ? [block] : [];
    } },
    posAtDOM: () => position,
    lineBlockAt: () => ({ from: position, top: 800 + estimateDelta }),
    requestMeasure: ({ read, write }: any) => write(read())
  };
  const controller = new ViewportController(view as any);
  scroller.dispatch('wheel', { deltaX: 0, deltaY: -120, ctrlKey: false });
  scroller.scrollTop = 900;
  scroller.dispatch('scroll', {});
  estimateDelta = 90;
  scroller.scrollTop += 90;
  controller.reconcileAfterEditorUpdate();
  if (scroller.scrollTop !== 900) {
    throw new Error(`A ${kind}-only viewport rebounded after delayed measurement: ${scroller.scrollTop}`);
  }
  controller.destroy();
}

wheelController.markInteraction();
wheelScrollDOM.scrollTop = 1000;
wheelScrollDOM.dispatch('touchstart', { touches: [{ clientX: 0, clientY: 300 }] });
wheelScrollDOM.dispatch('touchmove', { touches: [{ clientX: 0, clientY: 220 }] });
wheelScrollDOM.scrollTop = 1080;
wheelScrollDOM.dispatch('scroll', {});
wheelScrollDOM.scrollTop = 1280;
wheelController.reconcileAfterEditorUpdate();
if (wheelScrollDOM.scrollTop !== 1280) {
  throw new Error(`Viewport controller overrode native touch scrolling: ${wheelScrollDOM.scrollTop}`);
}
wheelScrollDOM.dispatch('touchend', { touches: [] });
await flushFrames(wheelFrames);

wheelController.markInteraction();
wheelScrollDOM.scrollTop = 1000;
wheelScrollDOM.scrollLeft = 40;
wheelController.preserveScrollPosition(() => {
  wheelScrollDOM.scrollTop = 1400;
  wheelScrollDOM.scrollLeft = 120;
});
await flushFrames(wheelFrames);
if (wheelScrollDOM.scrollTop !== 1000 || wheelScrollDOM.scrollLeft !== 40) {
  throw new Error(`Mutation moved the viewport to ${wheelScrollDOM.scrollTop}, ${wheelScrollDOM.scrollLeft}`);
}

wheelController.navigateBy({ top: -200, left: 10 });
if (wheelScrollDOM.scrollTop !== 800 || wheelScrollDOM.scrollLeft !== 50) {
  throw new Error(`Explicit navigation reached ${wheelScrollDOM.scrollTop}, ${wheelScrollDOM.scrollLeft}`);
}

const interactionMeasurement = wheelController.captureNavigationCurrentness();
wheelController.markInteraction();
if (interactionMeasurement()) throw new Error('Interaction must cancel deferred caret measurement');
const destroyedMeasurement = wheelController.captureNavigationCurrentness();
wheelController.destroy();
if (destroyedMeasurement()) throw new Error('Destroy must cancel deferred caret measurement');
globalThis.requestAnimationFrame = originalWheelRequestAnimationFrame;
(globalThis as typeof globalThis & { WheelEvent: typeof WheelEvent }).WheelEvent = originalWheelEvent;

const anchorFrames: FrameRequestCallback[] = [];
const originalAnchorRequestAnimationFrame = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
  anchorFrames.push(callback);
  return anchorFrames.length;
};
const anchorScrollDOM = {
  scrollTop: 225,
  scrollLeft: 0,
  scrollHeight: 5000,
  scrollWidth: 900,
  clientHeight: 500,
  clientWidth: 900
};
const anchorDocument = {
  length: 999,
  lines: 10,
  line: (lineNumber: number) => ({
    from: (lineNumber - 1) * 100,
    to: lineNumber * 100 - 1,
    number: lineNumber
  }),
  lineAt: (position: number) => ({
    from: Math.floor(position / 100) * 100,
    to: Math.floor(position / 100) * 100 + 99,
    number: Math.floor(position / 100) + 1
  })
};
const previewProjections: Array<{
  line: number;
  lineOffset: number;
  isCurrent: () => boolean;
}> = [];
let previewCapture = { line: 7, lineOffset: 18 };
const anchorView = {
  dom: {},
  scrollDOM: anchorScrollDOM,
  state: { doc: anchorDocument },
  lineBlockAtHeight: () => ({ from: 200, top: 200 }),
  lineBlockAt: (position: number) => ({ from: position, top: position }),
  requestMeasure: ({ read, write }: { read: () => unknown; write: (value: unknown) => void }) => write(read())
};
const anchorController = new ViewportController(anchorView as any, {
  attachInteractions: false,
  previewSurface: {
    captureTopVisiblePosition: () => previewCapture,
    restoreTopVisiblePosition(position, isCurrent) {
      previewProjections.push({ ...position, isCurrent });
    }
  }
});

const oldDocument = Text.of([
  'old-1',
  'old-2',
  'old-3',
  'old-4',
  'old-5',
  'old-6',
  'semantic seventh line remains visible',
  'old-8'
]);
const changedDocument = Text.of([
  'expanded-header-1',
  'expanded-header-2',
  'new-3',
  'new-4',
  'new-5',
  'new-6',
  'semantic seventh line remains visible',
  'old-8'
]);
const documentChangeProjections: Array<{ line: number; lineOffset: number }> = [];
const documentChangeView = {
  ...anchorView,
  dom: {},
  state: { doc: oldDocument },
  lineBlockAtHeight: () => ({ from: changedDocument.line(3).from, top: 200 })
};
const documentChangeController = new ViewportController(documentChangeView as any, {
  attachInteractions: false,
  previewSurface: {
    captureTopVisiblePosition: () => ({ line: 7, lineOffset: 18 }),
    restoreTopVisiblePosition(position) {
      documentChangeProjections.push(position);
    }
  }
});
const documentChangeHandle = documentChangeController.captureAnchorToken('preview');
documentChangeController.runAnchorTransaction(documentChangeHandle, 'preview', () => {
  documentChangeView.state.doc = changedDocument;
});
if (
  documentChangeProjections.length !== 1 ||
  documentChangeProjections[0]?.line !== 7 ||
  documentChangeProjections[0]?.lineOffset !== 18
) {
  throw new Error(
    `A Preview token was remapped from its hidden Editor anchor: ${JSON.stringify(documentChangeProjections)}`
  );
}
documentChangeController.destroy();

const delayedDocumentChangeProjections: Array<{ line: number; lineOffset: number }> = [];
const delayedDocumentChangeView = {
  ...anchorView,
  dom: {},
  state: { doc: oldDocument }
};
const delayedDocumentChangeController = new ViewportController(delayedDocumentChangeView as any, {
  attachInteractions: false,
  previewSurface: {
    captureTopVisiblePosition: () => ({ line: 7, lineOffset: 18 }),
    restoreTopVisiblePosition(position) {
      delayedDocumentChangeProjections.push(position);
    }
  }
});
const delayedDocumentChangeHandle = delayedDocumentChangeController.captureAnchorToken('preview');
let finishDelayedDocumentChange!: () => void;
const delayedDocumentChange = delayedDocumentChangeController.runAnchorTransaction(
  delayedDocumentChangeHandle,
  'preview',
  async () => {
    await new Promise<void>((resolve) => { finishDelayedDocumentChange = resolve; });
    delayedDocumentChangeController.runDocumentChange(() => {
      delayedDocumentChangeView.state.doc = changedDocument;
    });
  }
);
delayedDocumentChangeController.markInteraction();
finishDelayedDocumentChange();
await delayedDocumentChange;
if (delayedDocumentChangeProjections.length !== 0) {
  throw new Error(
    `A newer interaction allowed a delayed Document projection: ${JSON.stringify(delayedDocumentChangeProjections)}`
  );
}
if (delayedDocumentChangeView.state.doc !== changedDocument) {
  throw new Error('A stale async transaction suppressed its awaited Document mutation');
}

delayedDocumentChangeView.state.doc = oldDocument;
const awaitedCurrentHandle = delayedDocumentChangeController.captureAnchorToken('preview');
await delayedDocumentChangeController.runAnchorTransaction(
  awaitedCurrentHandle,
  'preview',
  async () => {
    await Promise.resolve();
    delayedDocumentChangeController.runDocumentChange(() => {
      delayedDocumentChangeView.state.doc = changedDocument;
    });
  }
);
if (
  delayedDocumentChangeProjections.length !== 1 ||
  delayedDocumentChangeProjections[0]?.line !== 7 ||
  delayedDocumentChangeView.state.doc !== changedDocument
) {
  throw new Error(
    `An awaited current Document change escaped its handle (${JSON.stringify(delayedDocumentChangeProjections)})`
  );
}
delayedDocumentChangeController.destroy();

const editorHandle = anchorController.captureAnchorToken('editor');
if (!editorHandle) throw new Error('Editor semantic anchor token was not captured');
anchorController.restoreAnchorToken(editorHandle, 'preview');
anchorController.restoreAnchorToken(editorHandle, 'preview');
if (
  previewProjections.length !== 1 ||
  previewProjections[0]?.line !== 3 ||
  previewProjections[0]?.lineOffset !== 25 ||
  !previewProjections[0].isCurrent()
) {
  throw new Error(`Editor token was not projected exactly once: ${JSON.stringify(previewProjections)}`);
}

const stalePreviewHandle = anchorController.captureAnchorToken('preview');
if (!stalePreviewHandle) throw new Error('Preview semantic anchor token was not captured');
const currentPreviewHandle = anchorController.captureAnchorToken('preview');
anchorController.restoreAnchorToken(stalePreviewHandle, 'editor');
await flushFrames(anchorFrames);
if (anchorScrollDOM.scrollTop !== 225) {
  throw new Error(`A replaced Preview token moved the Editor to ${anchorScrollDOM.scrollTop}`);
}

anchorController.restoreAnchorToken(currentPreviewHandle!, 'editor');
await flushFrames(anchorFrames);
if (anchorScrollDOM.scrollTop !== 618) {
  throw new Error(`The current Preview token restored the Editor to ${anchorScrollDOM.scrollTop}`);
}

previewCapture = { line: 4, lineOffset: 9 };
const transactionHandle = anchorController.captureAnchorToken('preview');
if (!transactionHandle) throw new Error('Preview transaction token was not captured');
let transactionWasCurrent = false;
anchorController.runAnchorTransaction(transactionHandle, 'editor', (isCurrent) => {
  transactionWasCurrent = isCurrent();
  anchorController.markInteraction();
});
await flushFrames(anchorFrames);
if (!transactionWasCurrent || anchorScrollDOM.scrollTop !== 309) {
  throw new Error(`The programmatic transaction invalidated itself at ${anchorScrollDOM.scrollTop}`);
}

const interactionHandle = anchorController.captureAnchorToken('preview');
anchorController.markInteraction();
anchorController.restoreAnchorToken(interactionHandle!, 'editor');
await flushFrames(anchorFrames);
if (anchorScrollDOM.scrollTop !== 309) {
  throw new Error(`A newer interaction allowed stale projection to ${anchorScrollDOM.scrollTop}`);
}

let crossControllerPreviewWrites = 0;
const crossScrollDOM = {
  ...anchorScrollDOM,
  scrollTop: 111
};
const crossControllerView = {
  ...anchorView,
  dom: {},
  scrollDOM: crossScrollDOM,
  state: { doc: oldDocument }
};
const crossController = new ViewportController(crossControllerView as any, {
  attachInteractions: false,
  previewSurface: {
    captureTopVisiblePosition: () => ({ line: 2, lineOffset: 3 }),
    restoreTopVisiblePosition: () => { crossControllerPreviewWrites += 1; }
  }
});
const foreignHandle = anchorController.captureAnchorToken('preview');
let crossTokenWasCurrent = true;
crossController.runAnchorTransaction(foreignHandle, 'preview', (isCurrent) => {
  crossTokenWasCurrent = isCurrent();
  crossController.runDocumentChange(() => {
    crossControllerView.state.doc = changedDocument;
  });
});
await flushFrames(anchorFrames);
if (
  crossTokenWasCurrent ||
  crossControllerPreviewWrites !== 0 ||
  crossScrollDOM.scrollTop !== 111 ||
  crossControllerView.state.doc !== changedDocument
) {
  throw new Error('A cross-Controller token suppressed its mutation or produced a viewport write');
}

crossControllerView.state.doc = oldDocument;
crossScrollDOM.scrollTop = 111;
let nullTokenWasCurrent = true;
crossController.runAnchorTransaction(null, 'editor', (isCurrent) => {
  nullTokenWasCurrent = isCurrent();
  crossController.runDocumentChange(() => {
    crossControllerView.state.doc = changedDocument;
  });
});
await flushFrames(anchorFrames);
if (
  nullTokenWasCurrent ||
  crossScrollDOM.scrollTop !== 111 ||
  crossControllerView.state.doc !== changedDocument
) {
  throw new Error('A null token suppressed its mutation or produced a viewport write');
}

crossControllerView.state.doc = oldDocument;
crossScrollDOM.scrollTop = 111;
const staleHandle = crossController.captureAnchorToken('editor');
crossController.captureAnchorToken('editor');
crossController.runAnchorTransaction(staleHandle, 'editor', () => {
  crossController.runDocumentChange(() => {
    crossControllerView.state.doc = changedDocument;
  });
});
await flushFrames(anchorFrames);
if (crossScrollDOM.scrollTop !== 111 || crossControllerView.state.doc !== changedDocument) {
  throw new Error('A stale token suppressed its mutation or produced a viewport write');
}

crossControllerView.state.doc = oldDocument;
const duplicateHandle = crossController.captureAnchorToken('editor');
crossController.runAnchorTransaction(duplicateHandle, 'editor', () => undefined);
await flushFrames(anchorFrames);
crossScrollDOM.scrollTop = 111;
crossController.runAnchorTransaction(duplicateHandle, 'editor', () => {
  crossController.runDocumentChange(() => {
    crossControllerView.state.doc = changedDocument;
  });
});
await flushFrames(anchorFrames);
if (crossScrollDOM.scrollTop !== 111 || crossControllerView.state.doc !== changedDocument) {
  throw new Error('A duplicate target suppressed its mutation or produced a viewport write');
}

const failedTargetHandle = crossController.captureAnchorToken('editor');
let failedTargetThrew = false;
try {
  crossController.runAnchorTransaction(failedTargetHandle, 'preview', () => {
    throw new Error('target mutation failed');
  });
} catch {
  failedTargetThrew = true;
}
if (!failedTargetThrew || crossControllerPreviewWrites !== 0) {
  throw new Error('A failed target projected an anchor');
}

crossControllerView.state.doc = oldDocument;
crossScrollDOM.scrollTop = 111;
crossController.runDocumentChange(() => {
  crossControllerView.state.doc = changedDocument;
});
await flushFrames(anchorFrames);
if (crossScrollDOM.scrollTop === 111 || crossControllerView.state.doc !== changedDocument) {
  throw new Error('A thrown transaction leaked its scope into the next standalone Document change');
}

crossControllerView.state.doc = oldDocument;
crossScrollDOM.scrollTop = 111;
let rejectedMutationRan = false;
let rejectedMutationPropagated = false;
try {
  await crossController.runAnchorTransaction(null, 'editor', async () => {
    await Promise.resolve();
    crossController.runDocumentChange(() => {
      rejectedMutationRan = true;
      crossControllerView.state.doc = changedDocument;
    });
    throw new Error('async target mutation rejected');
  });
} catch (error) {
  rejectedMutationPropagated = error instanceof Error && error.message === 'async target mutation rejected';
}
await flushFrames(anchorFrames);
if (
  !rejectedMutationRan ||
  !rejectedMutationPropagated ||
  crossScrollDOM.scrollTop !== 111 ||
  crossControllerView.state.doc !== changedDocument
) {
  throw new Error('A rejected suppressed transaction changed its mutation, failure, or viewport contract');
}

crossControllerView.state.doc = oldDocument;
crossController.runDocumentChange(() => {
  crossControllerView.state.doc = changedDocument;
});
await flushFrames(anchorFrames);
if (crossScrollDOM.scrollTop === 111) {
  throw new Error('A rejected transaction leaked its scope into the next standalone Document change');
}

crossControllerView.state.doc = oldDocument;
crossScrollDOM.scrollTop = 111;
const suppressedNestedHandle = crossController.captureAnchorToken('editor');
let suppressedNestedWasCurrent = true;
crossController.runAnchorTransaction(null, 'preview', () => {
  crossController.runAnchorTransaction(suppressedNestedHandle, 'editor', (isCurrent) => {
    suppressedNestedWasCurrent = isCurrent();
    crossController.runDocumentChange(() => {
      crossController.markInteraction();
      crossControllerView.state.doc = changedDocument;
    });
  });
});
await flushFrames(anchorFrames);
if (
  suppressedNestedWasCurrent ||
  crossScrollDOM.scrollTop !== 111 ||
  crossControllerPreviewWrites !== 0 ||
  crossControllerView.state.doc !== changedDocument
) {
  throw new Error('A current transaction escaped a suppressed parent scope');
}

crossControllerView.state.doc = oldDocument;
crossScrollDOM.scrollTop = 111;
let currentParentWasCurrent = false;
let suppressedChildWasCurrent = true;
const currentParentHandle = crossController.captureAnchorToken('preview');
crossController.runAnchorTransaction(currentParentHandle, 'preview', (isParentCurrent) => {
  currentParentWasCurrent = isParentCurrent();
  crossController.runAnchorTransaction(null, 'editor', (isChildCurrent) => {
    suppressedChildWasCurrent = isChildCurrent();
    crossController.runDocumentChange(() => {
      crossController.markInteraction();
      crossControllerView.state.doc = changedDocument;
    });
  });
});
await flushFrames(anchorFrames);
if (
  !currentParentWasCurrent ||
  suppressedChildWasCurrent ||
  crossControllerPreviewWrites !== 0 ||
  crossScrollDOM.scrollTop !== 111 ||
  crossControllerView.state.doc !== changedDocument
) {
  throw new Error('A suppressed child escaped or corrupted its current parent scope');
}

crossControllerView.state.doc = oldDocument;
crossScrollDOM.scrollTop = 111;
crossController.runDocumentChange(() => {
  crossControllerView.state.doc = changedDocument;
});
await flushFrames(anchorFrames);
if (crossScrollDOM.scrollTop === 111) {
  throw new Error('A nested suppressed scope leaked into the next standalone Document change');
}
crossController.destroy();

const unavailableScrollDOM = { ...anchorScrollDOM, scrollTop: 222 };
const unavailableView = {
  ...anchorView,
  dom: {},
  scrollDOM: unavailableScrollDOM,
  state: { doc: oldDocument }
};
const unavailableController = new ViewportController(unavailableView as any, { attachInteractions: false });
const unavailableHandle = unavailableController.captureAnchorToken('editor');
let unavailableWasCurrent = true;
unavailableController.runAnchorTransaction(unavailableHandle, 'preview', (isCurrent) => {
  unavailableWasCurrent = isCurrent();
  unavailableController.runDocumentChange(() => {
    unavailableView.state.doc = changedDocument;
  });
});
await flushFrames(anchorFrames);
if (
  unavailableWasCurrent ||
  unavailableScrollDOM.scrollTop !== 222 ||
  unavailableView.state.doc !== changedDocument
) {
  throw new Error('An unavailable Preview target suppressed its mutation or produced a viewport write');
}
unavailableController.destroy();

const nestedCurrentFrames: FrameRequestCallback[] = [];
globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
  nestedCurrentFrames.push(callback);
  return nestedCurrentFrames.length;
};
const nestedCurrentScrollDOM = { ...anchorScrollDOM, scrollTop: 333 };
const nestedCurrentView = {
  ...anchorView,
  dom: {},
  scrollDOM: nestedCurrentScrollDOM,
  state: { doc: oldDocument }
};
let nestedCurrentPreviewWrites = 0;
const nestedCurrentController = new ViewportController(nestedCurrentView as any, {
  attachInteractions: false,
  previewSurface: {
    captureTopVisiblePosition: () => ({ line: 2, lineOffset: 3 }),
    restoreTopVisiblePosition() { nestedCurrentPreviewWrites += 1; }
  }
});
const nestedCurrentHandle = nestedCurrentController.captureAnchorToken('preview');
let outerCurrent = false;
let innerCurrent = false;
nestedCurrentController.runAnchorTransaction(nestedCurrentHandle, 'preview', (isOuterCurrent) => {
  outerCurrent = isOuterCurrent();
  nestedCurrentController.runAnchorTransaction(nestedCurrentHandle, 'editor', (isInnerCurrent) => {
    innerCurrent = isInnerCurrent();
    nestedCurrentController.runDocumentChange(() => {
      nestedCurrentController.markInteraction();
      nestedCurrentView.state.doc = changedDocument;
    });
  });
});
await flushFrames(nestedCurrentFrames);
if (
  !outerCurrent ||
  !innerCurrent ||
  nestedCurrentPreviewWrites !== 1 ||
  nestedCurrentScrollDOM.scrollTop === 333 ||
  nestedCurrentView.state.doc !== changedDocument
) {
  throw new Error('Nested current scopes did not map and project their shared token atomically');
}
nestedCurrentController.destroy();

const serialView = {
  ...anchorView,
  dom: {},
  scrollDOM: { ...anchorScrollDOM, scrollTop: 444 },
  state: { doc: oldDocument }
};
let serialPreviewWrites = 0;
const serialController = new ViewportController(serialView as any, {
  attachInteractions: false,
  previewSurface: {
    captureTopVisiblePosition: () => ({ line: 3, lineOffset: 4 }),
    restoreTopVisiblePosition() { serialPreviewWrites += 1; }
  }
});
const serialHandle = serialController.captureAnchorToken('preview');
let releaseSerialTransaction!: () => void;
const serialTransaction = serialController.runAnchorTransaction(serialHandle, 'preview', async () => {
  await new Promise<void>((resolve) => { releaseSerialTransaction = resolve; });
  serialController.runDocumentChange(() => {
    serialView.state.doc = changedDocument;
  });
});
let parallelMutationRan = false;
let parallelFailure = '';
try {
  serialController.runAnchorTransaction(null, 'editor', () => {
    parallelMutationRan = true;
  });
} catch (error) {
  parallelFailure = error instanceof Error ? error.message : String(error);
}
if (
  parallelMutationRan ||
  parallelFailure !== 'Viewport anchor transactions must be awaited serially'
) {
  throw new Error(`Parallel transaction failure was not deterministic: ${parallelFailure}`);
}
releaseSerialTransaction();
await serialTransaction;
if (serialPreviewWrites !== 1 || serialView.state.doc !== changedDocument) {
  throw new Error('A rejected parallel transaction corrupted the active transaction scope');
}
serialController.destroy();

const successorView = {
  ...anchorView,
  dom: {},
  scrollDOM: { ...anchorScrollDOM, scrollTop: 555 },
  state: { doc: oldDocument }
};
let successorPreviewWrites = 0;
const successorController = new ViewportController(successorView as any, {
  attachInteractions: false,
  previewSurface: {
    captureTopVisiblePosition: () => ({ line: 3, lineOffset: 4 }),
    restoreTopVisiblePosition() { successorPreviewWrites += 1; }
  }
});
const supersededHandle = successorController.captureAnchorToken('preview');
let enterSuccessor!: () => void;
const supersededTransaction = successorController.runAnchorTransaction(
  supersededHandle,
  'preview',
  async () => {
    await new Promise<void>((resolve) => { enterSuccessor = resolve; });
    const successorHandle = successorController.captureAnchorToken('preview');
    await successorController.runAnchorTransaction(successorHandle, 'preview', async () => {
      await Promise.resolve();
      successorController.runDocumentChange(() => {
        successorView.state.doc = changedDocument;
      });
    });
  }
);
enterSuccessor();
await supersededTransaction;
if (successorPreviewWrites !== 1 || successorView.state.doc !== changedDocument) {
  throw new Error('A newly-current async successor could not reenter its superseded parent scope');
}
successorController.destroy();

const destroyView = {
  ...anchorView,
  dom: {},
  scrollDOM: { ...anchorScrollDOM, scrollTop: 555 },
  state: { doc: oldDocument }
};
let destroyPreviewWrites = 0;
const destroyController = new ViewportController(destroyView as any, {
  attachInteractions: false,
  previewSurface: {
    captureTopVisiblePosition: () => ({ line: 4, lineOffset: 5 }),
    restoreTopVisiblePosition() { destroyPreviewWrites += 1; }
  }
});
const destroyHandle = destroyController.captureAnchorToken('preview');
let releaseDestroyedTransaction!: () => void;
const destroyedTransaction = destroyController.runAnchorTransaction(destroyHandle, 'preview', async () => {
  await new Promise<void>((resolve) => { releaseDestroyedTransaction = resolve; });
  destroyController.runDocumentChange(() => {
    destroyView.state.doc = changedDocument;
  });
});
destroyController.destroy();
releaseDestroyedTransaction();
await destroyedTransaction;
if (
  destroyPreviewWrites !== 0 ||
  destroyView.scrollDOM.scrollTop !== 555 ||
  destroyView.state.doc !== changedDocument
) {
  throw new Error('Destroy suppressed the mutation or allowed a pending transaction to write');
}

const disposedHandle = anchorController.captureAnchorToken('preview');
anchorController.destroy();
anchorController.restoreAnchorToken(disposedHandle!, 'editor');
await flushFrames(anchorFrames);
if (anchorScrollDOM.scrollTop !== 309) {
  throw new Error(`A disposed Controller projected an anchor to ${anchorScrollDOM.scrollTop}`);
}
globalThis.requestAnimationFrame = originalAnchorRequestAnimationFrame;

// CodeMirror can redraw a newly opened block after the read phase, before the
// queued scroll write. No intermediate compensation may reach a painted frame.
for (const settledShift of [0, 40]) {
  const frames: FrameRequestCallback[] = [];
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  let layoutTop = 1350;
  let scrollTop = 1000;
  let firstMeasure = true;
  const writes: number[] = [];
  const scroller = {
    get scrollTop() { return scrollTop; },
    set scrollTop(value: number) { scrollTop = value; writes.push(value); },
    scrollLeft: 0,
    scrollHeight: 5000,
    scrollWidth: 900,
    clientHeight: 700,
    clientWidth: 900
  };
  const toolbar = {
    isConnected: true,
    getBoundingClientRect: () => ({ top: layoutTop - scrollTop })
  };
  const controller = new ViewportController({
    dom: {},
    scrollDOM: scroller,
    requestMeasure: ({ read, write }: { read: () => unknown; write: (value: unknown) => void }) => {
      const measurement = read();
      write(measurement);
      if (firstMeasure) {
        firstMeasure = false;
        layoutTop = 1350 + settledShift;
      }
    }
  } as any, { attachInteractions: false });
  try {
    controller.preserveElementPositionWhileMutation(
      toolbar as any,
      () => toolbar as any,
      () => { layoutTop += 22.5; },
      'immediate'
    );
    await flushFrames(frames);
    if (scrollTop !== 1000 + settledShift || writes.some((value) => value !== 1000 + settledShift)) {
      throw new Error(`Toolbar preservation painted stale geometry: ${JSON.stringify({ settledShift, writes })}`);
    }
  } finally {
    controller.destroy();
    globalThis.requestAnimationFrame = previousRaf;
  }
}

// Rendered mode switches replace the toolbar before their final layout pass.
// Keep the replacement at the same viewport coordinate until the bounded
// retention window settles, and yield immediately to a real interaction.
{
  const frames: FrameRequestCallback[] = [];
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  let layoutTop = 1350;
  let scrollTop = 1000;
  let notifyMutation = () => {};
  class RetentionObserver {
    constructor(callback: () => void) { notifyMutation = callback; }
    observe() {}
    disconnect() {}
  }
  const makeToolbar = () => ({
    isConnected: true,
    ownerDocument: { defaultView: { MutationObserver: RetentionObserver } },
    getBoundingClientRect: () => ({ top: layoutTop - scrollTop })
  });
  const originalToolbar = makeToolbar();
  let currentToolbar = originalToolbar;
  const controller = new ViewportController({
    dom: {},
    scrollDOM: {
      get scrollTop() { return scrollTop; },
      set scrollTop(value: number) { scrollTop = value; },
      scrollLeft: 0,
      scrollHeight: 5000,
      scrollWidth: 900,
      clientHeight: 700,
      clientWidth: 900
    },
    requestMeasure: () => undefined
  } as any, { attachInteractions: false });
  try {
    controller.retainElementTopWhileMutation(
      originalToolbar as any,
      () => currentToolbar as any,
      () => {
        layoutTop += 240;
        currentToolbar = makeToolbar();
      }
    );
    if (scrollTop !== 1240) {
      throw new Error(`Replacement toolbar initially moved the viewport to ${scrollTop}`);
    }
    for (let notification = 0; notification < 30; notification++) notifyMutation();
    if (frames.length !== 1) {
      throw new Error(`Mutation bursts started parallel toolbar retention frames: ${frames.length}`);
    }
    layoutTop += 40;
    controller.reconcileAfterEditorUpdate();
    if (scrollTop !== 1280) {
      throw new Error(`Editor measurement did not retain the toolbar before paint: ${scrollTop}`);
    }
    frames.shift()?.(0);
    if (scrollTop !== 1280) {
      throw new Error(`Late replacement layout moved the toolbar at ${scrollTop}`);
    }
    controller.markInteraction();
    layoutTop += 60;
    await flushFrames(frames);
    if (scrollTop !== 1280) {
      throw new Error(`Interaction did not cancel toolbar retention at ${scrollTop}`);
    }
  } finally {
    controller.destroy();
    globalThis.requestAnimationFrame = previousRaf;
  }
}

// Split Source/Preview uses the existing controller as the sole scroll owner.
// Programmatic follower scrolls must not echo back, and Preview -> Source must
// move only the viewport (the editor selection remains untouched).
{
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
  const flushLinkedFrames = async () => {
    while (frames.size > 0) {
      const batch = [...frames.values()];
      frames.clear();
      for (const callback of batch) callback(0);
      await Promise.resolve();
    }
  };
  const doc = Text.of(Array.from({ length: 80 }, (_, index) => `line ${index + 1}`));
  const selection = { main: { anchor: 7, head: 7 } };
  const scrollDOM = {
    scrollTop: 200,
    scrollLeft: 0,
    scrollHeight: 2000,
    scrollWidth: 800,
    clientHeight: 400,
    clientWidth: 800,
    getBoundingClientRect: () => { throw new Error('Source linked scrolling must not measure the editor DOM'); }
  };
  const lineAtHeight = (height: number) => {
    const number = Math.max(1, Math.min(doc.lines, Math.floor(height / 20) + 1));
    const line = doc.line(number);
    return { from: line.from, to: line.to, top: (number - 1) * 20, bottom: number * 20 };
  };
  let previewPosition: { line: number; lineOffset: number; editorLineOffset: number;
    sourceRange?: { startLine: number; endLine: number; progress: number } } = { line: 1, lineOffset: 0, editorLineOffset: 0 };
  const previewWrites: Array<{ line: number; lineOffset: number }> = [];
  const controller = new ViewportController({
    dom: {},
    scrollDOM,
    contentDOM: { querySelectorAll: () => { throw new Error('Source linked scrolling must not scan rendered DOM'); } },
    state: { doc, selection },
    lineBlockAtHeight: lineAtHeight,
    lineBlockAt: (position: number) => lineAtHeight((doc.lineAt(position).number - 1) * 20),
    requestMeasure: ({ read, write }: { read: () => unknown; write: (value: unknown) => void }) => write(read())
  } as any, {
    attachInteractions: false,
    getMode: () => 'source',
    previewSurface: {
      captureTopVisiblePosition: () => previewPosition,
      restoreTopVisiblePosition(position, isCurrent) {
        if (isCurrent()) previewWrites.push(position);
      }
    }
  });
  try {
    controller.setLinkedPreviewEnabled(true);
    await flushLinkedFrames();
    if (previewWrites.length !== 1 || previewWrites[0].line !== 11) {
      throw new Error(`Source did not seed linked Preview: ${JSON.stringify(previewWrites)}`);
    }

    previewPosition = { line: 25, lineOffset: 3, editorLineOffset: 3 };
    controller.markPreviewInteraction();
    controller.previewViewportChanged();
    if (scrollDOM.scrollTop !== 483) {
      throw new Error(`Preview did not semantically project into Source: ${scrollDOM.scrollTop}`);
    }
    if (frames.size !== 0) {
      throw new Error(`Preview projection left ${frames.size} delayed Source correction frame(s)`);
    }
    if (selection.main.anchor !== 7 || selection.main.head !== 7) {
      throw new Error('Preview scrolling changed the Source selection');
    }
    controller.editorViewportChanged();
    await flushLinkedFrames();
    if (previewWrites.length !== 1) throw new Error('Follower scroll echoed back into Preview');

    previewPosition = { line: 25, lineOffset: 0, editorLineOffset: 0,
      sourceRange: { startLine: 25, endLine: 25, progress: .75 } };
    controller.previewViewportChanged();
    if (Number(scrollDOM.scrollTop) !== 495) throw new Error(`Preview lost progress inside a wrapped source line: ${scrollDOM.scrollTop}`);
    previewPosition = { line: 25, lineOffset: 0, editorLineOffset: 0,
      sourceRange: { startLine: 25, endLine: 28, progress: .625 } };
    controller.previewViewportChanged();
    if (Number(scrollDOM.scrollTop) !== 530) throw new Error(`Preview lost progress through a tall source block: ${scrollDOM.scrollTop}`);

    controller.markInteraction();
    scrollDOM.scrollTop = 600;
    controller.editorViewportChanged();
    await flushLinkedFrames();
    if (previewWrites.at(-1)?.line !== 31) throw new Error('Source could not retake linked scroll ownership');

    controller.setLinkedPreviewEnabled(false);
    controller.editorViewportChanged();
    await flushLinkedFrames();
    if (previewWrites.length !== 2) throw new Error('Disabled linked scrolling performed work');

    previewPosition = { line: 50, lineOffset: 3, editorLineOffset: 3 };
    controller.markPreviewInteraction();
    controller.setLinkedPreviewEnabled(true, 'last-interaction');
    if (scrollDOM.scrollTop !== 983) {
      throw new Error(`Re-enabled linked scrolling did not follow the last Preview interaction: ${scrollDOM.scrollTop}`);
    }
    controller.setLinkedPreviewEnabled(false);
  } finally {
    controller.destroy();
    globalThis.requestAnimationFrame = previousRaf;
    globalThis.cancelAnimationFrame = previousCancelRaf;
  }
}

// Cold Source height estimates can change while reverse scrolling. The same
// source character must project to the same Preview point even when its pixel
// position or its wrapped line height changes, without a full-map measurement.
{
  const doc = Text.of(Array.from({ length: 100 }, () => 'wrapped source line'));
  const scroll = { scrollTop: 1210, scrollLeft: 17, scrollHeight: 2000, clientHeight: 400 };
  const selection = { anchor: 3, head: 8 };
  let prefix = 0, wrap = 0, previewTop = 0, measurements = 0, lineReads = 0;
  const block = (number: number) => {
    const line = doc.line(number);
    const top = (number - 1) * 20 + (number > 50 ? prefix : 0) + (number > 61 ? wrap : 0);
    return { from: line.from, to: line.to, top, bottom: top + 20 + (number === 61 ? wrap : 0) };
  };
  const controller = new ViewportController({ dom: {}, state: { doc, selection }, scrollDOM: scroll,
    lineBlockAt: (position: number) => { lineReads++; return block(doc.lineAt(position).number); },
    lineBlockAtHeight: (height: number) => {
      lineReads++;
      return Array.from({ length: doc.lines }, (_, index) => block(index + 1))
        .find(line => line.bottom > height) ?? block(doc.lines);
    }
  } as any, { attachInteractions: false, getMode: () => 'source', previewSurface: {
    captureTopVisiblePosition: () => null, restoreTopVisiblePosition() {},
    readScrollTop: () => previewTop, writeScrollTop: top => { previewTop = top; },
    captureLinkedGeometry: () => { measurements++; return { maximumScrollTop: 3200,
      regions: Array.from({ length: 100 }, (_, index) => ({ startLine: index + 1, endLine: index + 1,
        top: index * 40, bottom: (index + 1) * 40 })) }; }
  } });
  try {
    controller.setLinkedPreviewEnabled(true);
    if (previewTop !== 2420) throw new Error(`Initial Source line progress was lost: ${previewTop}`);
    prefix = 90; wrap = 20; scroll.scrollHeight += 110; scroll.scrollTop = 1310;
    controller.editorViewportChanged();
    if (previewTop !== 2420) throw new Error(`Cold Source measurement became a Preview scroll: ${previewTop}`);
    scroll.scrollTop -= 10; controller.editorViewportChanged();
    if (previewTop !== 2410) throw new Error(`Reverse Source scrolling lost fractional wrapped progress: ${previewTop}`);
    controller.markPreviewInteraction(); previewTop = 2420; controller.previewViewportChanged();
    if (scroll.scrollTop !== 1310) throw new Error(`Preview follower reused estimated Source pixels: ${scroll.scrollTop}`);
    if (measurements !== 1 || lineReads > 8) throw new Error(`Linked scrolling must use bounded local geometry: ${measurements}/${lineReads}`);
    if (scroll.scrollLeft !== 17 || selection.anchor !== 3 || selection.head !== 8) throw new Error('Linked scrolling changed selection or horizontal position');
  } finally { controller.destroy(); }
}

// An image below the synchronized top can grow inside the Preview viewport.
// Source still owns that top; preserving a glyph below the image would instead
// move it upward. Independent Preview reading retains its usual reading band.
for (const owner of ['editor', 'preview'] as const) {
  const doc = Text.of(Array.from({ length: 80 }, () => 'line'));
  const scroll = { scrollTop: 600, scrollLeft: 0, scrollHeight: 2000, clientHeight: 400 };
  let previewTop = 1200, imageGrowth = 0;
  const controller = new ViewportController({ dom: {}, state: { doc }, scrollDOM: scroll,
    ...uniformLineGeometry(doc)
  } as any, { attachInteractions: false, getMode: () => 'source', previewSurface: {
    captureTopVisiblePosition: () => null, restoreTopVisiblePosition() {},
    readScrollTop: () => previewTop, writeScrollTop: top => { previewTop = top; },
    captureVisualReadingAnchor: (ratio = 0) => {
      const glyphTop = previewTop + ratio * 400, previousGrowth = imageGrowth;
      return () => {
        if (glyphTop >= 1320) previewTop += imageGrowth - previousGrowth;
        return true;
      };
    },
    captureLinkedGeometry: () => ({ maximumScrollTop: 3200 + imageGrowth,
      regions: Array.from({ length: 80 }, (_, index) => ({ startLine: index + 1, endLine: index + 1,
        top: index * 40 + (index >= 33 ? imageGrowth : 0),
        bottom: (index + 1) * 40 + (index >= 32 ? imageGrowth : 0) })) })
  } });
  try {
    controller.setLinkedPreviewEnabled(true, owner);
    controller.runPreviewPresentationTransaction(() => { imageGrowth = 100; });
    const expected = owner === 'editor' ? 1200 : 1300;
    if (previewTop !== expected || scroll.scrollTop !== 600) {
      throw new Error(`Late in-viewport image displaced ${owner} reading: ${scroll.scrollTop}/${previewTop}`);
    }
    if (owner === 'editor') {
      scroll.scrollTop += 10; controller.editorViewportChanged();
      if (previewTop !== 1220) throw new Error('Source wheel did not continue from the retained synchronized top');
    }
  } finally { controller.destroy(); }
}

// A geometry-refresh timer can beat the native scroll event. A driver that
// already moved must not be pinned to the follower's still-old position.
for (const owner of ['editor', 'preview'] as const) {
  const doc = Text.of(Array.from({ length: 80 }, () => 'line'));
  const scrollDOM = {
    scrollTop: 200, scrollLeft: 0, scrollHeight: 2000, scrollWidth: 800,
    clientHeight: 400, clientWidth: 800
  };
  let previewTop = 0;
  let previewOffset = 0;
  const controller = new ViewportController({
    dom: {}, scrollDOM, state: { doc },
    ...uniformLineGeometry(doc)
  } as any, {
    attachInteractions: false, getMode: () => 'source',
    previewSurface: {
      captureTopVisiblePosition: () => null,
      restoreTopVisiblePosition() {},
      readScrollTop: () => previewTop,
      writeScrollTop: top => { previewTop = top; },
      captureLinkedGeometry: () => ({
        maximumScrollTop: 3200,
        regions: Array.from({ length: 80 }, (_, index) => ({
          startLine: index + 1, endLine: index + 1,
          top: index * 40 + previewOffset, bottom: (index + 1) * 40 + previewOffset
        }))
      })
    }
  });
  try {
    controller.setLinkedPreviewEnabled(true);
    if (owner === 'preview') controller.markPreviewInteraction();
    if (owner === 'editor') scrollDOM.scrollTop = 600;
    else previewTop = 1200;
    controller.linkedPreviewReady();
    await new Promise(resolve => setTimeout(resolve, 400));
    if (scrollDOM.scrollTop !== 600 || Math.abs(previewTop - 1200) > 0.5) {
      throw new Error(`Geometry refresh pinned a pending ${owner} scroll to its stale follower: ${JSON.stringify({source:scrollDOM.scrollTop,preview:previewTop})}`);
    }
    // A presentation-only change still pins an already synchronized pair.
    previewOffset = 100;
    controller.linkedPreviewReady();
    await new Promise(resolve => setTimeout(resolve, 400));
    if (scrollDOM.scrollTop !== 600 || Math.abs(previewTop - 1200) > 0.5) {
      throw new Error(`Idle linked geometry moved its synchronized reading point: ${JSON.stringify({source:scrollDOM.scrollTop,preview:previewTop})}`);
    }
  } finally { controller.destroy(); }
}

// A preset can move the Preview's numerical scrollTop while preserving its
// exact glyph. Rebuilding a windowed semantic map must retain the accepted pair,
// rather than treating that layout correction as a new Preview wheel gesture.
{
  const doc = Text.of(Array.from({ length: 80 }, () => 'line'));
  const scrollDOM = { scrollTop: 1050, scrollLeft: 0, scrollHeight: 8000, scrollWidth: 800, clientHeight: 400, clientWidth: 800 };
  let previewTop = 400, progress = 0.5;
  const controller = new ViewportController({
    dom: {}, scrollDOM, state: { doc }, contentHeight: 8000,
    lineBlockAt: (position: number) => {
      const line = doc.lineAt(position);
      return { from: line.from, to: line.to, top: (line.number - 1) * 100, bottom: line.number * 100 };
    },
    lineBlockAtHeight: (height: number) => {
      const index = Math.floor(height / 100), line = doc.line(index + 1);
      return { from: line.from, to: line.to, top: index * 100, bottom: (index + 1) * 100 };
    }
  } as any, { attachInteractions: false, getMode: () => 'source', previewSurface: {
    readScrollTop: () => previewTop, writeScrollTop: value => { previewTop = value; },
    captureTopVisiblePosition: () => ({ line: 11, lineOffset: 0, sourceRange: { startLine: 11, endLine: 11, progress } }),
    restoreTopVisiblePosition() {}, captureLinkedGeometry: () => null,
    captureVisualReadingAnchor: () => () => true
  } });
  try {
    controller.markPreviewInteraction();
    controller.setLinkedPreviewEnabled(true, 'last-interaction');
    await new Promise(resolve => setTimeout(resolve, 400));
    const heldSource = scrollDOM.scrollTop;
    controller.runPreviewPresentationTransaction(() => { previewTop = 800; progress = 0.8; });
    controller.linkedPreviewReady();
    await new Promise(resolve => setTimeout(resolve, 30));
    if (scrollDOM.scrollTop !== heldSource || previewTop !== 800) throw new Error('Preset reflow was replayed as a windowed linked scroll');
    controller.markPreviewInteraction(); previewTop += 10; progress = 0.9;
    controller.previewViewportChanged();
    if (Math.abs(scrollDOM.scrollTop - heldSource - 10) > 0.01) throw new Error('The next real Preview gesture lost its rebased semantic origin');
  } finally { controller.destroy(); }
}

// An offscreen line has no DOM coordinates until CodeMirror renders it. The
// first projection must keep the reading band instead of relying on a later correction.
for (const mode of ['source', 'live'] as const) {
  for (const viewportOffset of [undefined, 0, 680 / 3]) {
    const frames: FrameRequestCallback[] = [];
    const previousRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => (frames.push(callback), frames.length);
    const scrollDOM = {
      scrollTop: 3500, scrollLeft: 0, scrollHeight: 6000, scrollWidth: 900,
      clientHeight: 680, clientWidth: 900,
      getBoundingClientRect: () => ({ top: 0, bottom: 680, height: 680 })
    };
    let coordinatesAvailable = false;
    const controller = new ViewportController({
      dom: {}, scrollDOM, state: { doc: Text.of(['x'.repeat(6000)]) },
      contentDOM: { querySelectorAll: () => [] },
      coordsAtPos: () => coordinatesAvailable
        ? { top: 1800 - scrollDOM.scrollTop, bottom: 1820 - scrollDOM.scrollTop }
        : null,
      lineBlockAt: () => ({ top: 1800, height: 20 }),
      requestMeasure: ({ read, write }: { read: () => unknown; write: (value: unknown) => void }) => write(read())
    } as any, { attachInteractions: false, getMode: () => mode });
    try {
      controller.restoreDocumentAnchor({ position: 900, lineOffset: 17, viewportOffset }, undefined, { force: true });
      await Promise.resolve();
      const expected = viewportOffset === undefined ? 1817 : 1800 - viewportOffset;
      if (Math.abs(scrollDOM.scrollTop - expected) > 0.5) {
        throw new Error(`Offscreen ${mode} first projection lost its reading band: ${scrollDOM.scrollTop}, expected ${expected}`);
      }
      coordinatesAvailable = true;
      await flushFrames(frames);
      if (Math.abs(scrollDOM.scrollTop - expected) > 0.5) {
        throw new Error(`Mounted ${mode} coordinates moved a stable reading anchor: ${scrollDOM.scrollTop}, expected ${expected}`);
      }
    } finally {
      controller.destroy();
      globalThis.requestAnimationFrame = previousRaf;
    }
  }
}

// A retained Source-to-Preview projection can lack a rendered range without
// being whitespace. Only freshly interpolated gaps use the exact top edge.
for (const interpolatedWhitespace of [undefined, true]) {
  const projections: Array<{ line: number; viewportOffset?: number }> = [];
  const controller = new ViewportController(anchorView as any, {
    attachInteractions: false,
    previewSurface: {
      readScrollTop: () => 300,
      writeScrollTop: () => {},
      captureTopVisiblePosition: () => ({ line: 3, lineOffset: 0, viewportOffset: 0 }),
      captureReadingPosition: () => ({
        line: 7, lineOffset: 0, viewportOffset: 200, interpolatedWhitespace
      }),
      restoreTopVisiblePosition(position, isCurrent) {
        if (isCurrent()) projections.push(position);
      }
    }
  });
  try {
    controller.runPreviewPresentationTransaction(() => {});
    const expected = interpolatedWhitespace ? { line: 3, offset: 0 } : { line: 7, offset: 200 };
    if (projections.length !== 1 || projections[0].line !== expected.line
      || projections[0].viewportOffset !== expected.offset) {
      throw new Error(`Preview presentation confused a retained reading band with whitespace: ${JSON.stringify(projections)}`);
    }
  } finally { controller.destroy(); }
}

// Independent alignment measures current semantic geometry only on explicit activation.
{
  const frames: FrameRequestCallback[] = [];
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => (frames.push(callback), frames.length);
  const doc = Text.of(Array.from({ length: 100 }, () => 'line'));
  const selection = { main: { anchor: 5, head: 9 } };
  const scrollDOM = { scrollTop: 300, scrollLeft: 27, scrollHeight: 2000, scrollWidth: 900, clientHeight: 400, clientWidth: 800 };
  let previewTop = 1800;
  let geometryShift = 0;
  let measurements = 0;
  let sourceLineRendered = true;
  const deferredAlignments: Array<{ line: number; isCurrent: () => boolean }> = [];
  const view = {
    dom: {}, scrollDOM, state: { doc, selection },
    requestMeasure: ({ read, write }: { read: () => unknown; write: (value: unknown) => void }) => write(read()),
    dispatch: () => { throw new Error('View alignment must not dispatch a selection or document change'); },
    ...uniformLineGeometry(doc)
  };
  const controller = new ViewportController(view as any, {
    attachInteractions: false, getMode: () => 'source',
    previewSurface: {
      captureTopVisiblePosition: () => null,
      isSourceLineRendered: () => sourceLineRendered,
      restoreTopVisiblePosition(position, isCurrent) { deferredAlignments.push({ line: position.line, isCurrent }); },
      readScrollTop: () => previewTop, writeScrollTop: top => { previewTop = top; },
      captureLinkedGeometry: () => {
        measurements++;
        return { regions: [{ startLine: 11, endLine: 20, top: 500 + geometryShift, bottom: 600 + geometryShift }], maximumScrollTop: 2800 };
      }
    }
  });
  try {
    if (!controller.alignLinkedViewport('editor') || previewTop !== 550 || scrollDOM.scrollTop !== 300) throw new Error('Manual Source alignment ignored semantic geometry');
    if (controller.getLastViewportInteractionOwner() !== 'editor') throw new Error('Manual alignment lost its origin owner');
    scrollDOM.scrollTop = 1200;
    if (!controller.alignLinkedViewport('preview')) throw new Error('Manual Preview alignment was not accepted');
    await Promise.resolve();
    // The newly mounted Source band can receive a native height-map correction
    // after the first write. The explicit destination still owns settlement.
    scrollDOM.scrollTop += 37;
    await flushFrames(frames);
    if (scrollDOM.scrollTop !== 300 || previewTop !== 550 || scrollDOM.scrollLeft !== 27) throw new Error('Manual Preview alignment changed its origin or Source horizontal position');
    if (controller.getLastViewportInteractionOwner() !== 'preview' || view.state.selection !== selection) throw new Error('Manual alignment changed Source selection');
    const alignedMeasurements = measurements;
    if (alignedMeasurements < 3 || alignedMeasurements > 19) throw new Error('Explicit alignment must use a bounded geometry settlement');
    geometryShift = 120;
    controller.alignLinkedViewport('editor');
    if (previewTop !== 670 || measurements !== alignedMeasurements + 1) throw new Error('Manual alignment reused stale geometry');
    scrollDOM.scrollTop = 1000;
    controller.editorViewportChanged();
    controller.previewViewportChanged();
    controller.linkedPreviewReady();
    if (previewTop !== 670 || measurements !== alignedMeasurements + 1) throw new Error('One-shot alignment enabled continuous sync or background measurements');
    sourceLineRendered = false;
    controller.alignLinkedViewport('editor');
    if (deferredAlignments.length !== 1 || deferredAlignments[0].line !== 51 || !deferredAlignments[0].isCurrent()
      || previewTop !== 670 || measurements !== alignedMeasurements + 1) throw new Error('An unloaded Preview destination must prepare its window before a pixel-map jump');
    controller.setLinkedPreviewEnabled(true, 'last-interaction');
    if (deferredAlignments[0].isCurrent()) throw new Error('A newer sync intent must cancel the pending one-shot alignment');
    if (controller.alignLinkedViewport('editor')) throw new Error('Automatic sync must own linked alignment');
    controller.setLinkedPreviewEnabled(false);
  } finally { controller.destroy(); globalThis.requestAnimationFrame = previousRaf; }
  if (controller.alignLinkedViewport('editor')) throw new Error('Disposed alignment must be inert');
}

// A native Preview scrollbar owns its position until the gesture finishes.
// Resource commits must not interrupt it with semantic or pixel restoration,
// including when Preview is standalone rather than a linked Source split.
{
  let dragging = true, top = 300, captures = 0, writes = 0;
  const surface = {
    isInteracting: () => true,
    isScrollbarDragging: () => dragging,
    readScrollTop: () => top,
    writeScrollTop: (next: number) => { writes++; top = next; },
    captureTopVisiblePosition: () => { captures++; return { line: 3, lineOffset: 0 }; },
    restoreTopVisiblePosition: () => { writes++; }
  };
  const controller = new ViewportController(anchorView as any, { attachInteractions: false, previewSurface: surface });
  try {
    controller.runPreviewPresentationTransaction(() => { top = 337; });
    if (captures || writes || top !== 337) throw new Error(`Resource layout interrupted native Preview dragging: ${JSON.stringify({ captures, writes, top })}`);
    dragging = false;
    controller.runPreviewPresentationTransaction(() => {});
    if (!captures || !writes) throw new Error('Preview reading-anchor preservation must resume after thumb release, including an active wheel quiet window');
  } finally { controller.destroy(); }
}

{
  let current: (() => boolean) | undefined;
  const controller = new ViewportController(anchorView as any, { attachInteractions: false, previewSurface: {
    readScrollTop: () => 300, writeScrollTop: () => {},
    captureTopVisiblePosition: () => ({ line: 3, lineOffset: 0 }),
    restoreTopVisiblePosition: (_position, isCurrent) => { current = isCurrent; }
  } });
  try {
    controller.runPreviewPresentationTransaction(() => {});
    if (!current?.()) throw new Error('The current standalone Preview projection must be usable');
    controller.markPreviewInteraction();
    if (current()) throw new Error('A new standalone Preview gesture must invalidate an older asynchronous resource projection');
  } finally { controller.destroy(); }
}

// Switching from exact geometry to estimated large-document heights retires
// the previous proportional map; the current source anchor owns the follower.
{
  const doc = Text.of(Array.from({ length: 100 }, () => 'line'));
  let exact = true, pixelWrites = 0;
  const projected: number[] = [];
  const view = {
    dom: {}, state: { doc },
    scrollDOM: { scrollTop: 300, scrollLeft: 0, scrollHeight: 2000, clientHeight: 400 },
    lineBlockAt: (position: number) => {
      const line = doc.lineAt(position);
      return { from: line.from, top: (line.number - 1) * 20, bottom: line.number * 20 };
    },
    lineBlockAtHeight: () => ({ from: doc.line(16).from, to: doc.line(16).to, top: 300, bottom: 320 })
  };
  const controller = new ViewportController(view as any, { attachInteractions: false, previewSurface: {
    readScrollTop: () => 500, writeScrollTop: () => { pixelWrites++; },
    captureTopVisiblePosition: () => null,
    restoreTopVisiblePosition: position => { projected.push(position.line); },
    captureLinkedGeometry: () => exact ? {
      regions: [{ startLine: 11, endLine: 20, top: 400, bottom: 600 }], maximumScrollTop: 2800
    } : null
  } });
  try {
    controller.setLinkedPreviewEnabled(true);
    if (!pixelWrites) throw new Error('The initial exact linked map must be active');
    const previousWrites = pixelWrites;
    exact = false;
    controller.linkedPreviewReady();
    await new Promise(resolve => setTimeout(resolve, 20));
    if (pixelWrites !== previousWrites || projected.at(-1) !== 16) {
      throw new Error('Estimated Preview geometry must retire the stale proportional map and project the source anchor');
    }
  } finally { controller.destroy(); }
}

// Edits above a Preview reading range retain its fractional point. A line
// insertion/deletion moves its source lines, without snapping to their start.
for (const [insert, removed, expectedLine] of [['x', 0, 3], ['x\n', 0, 4], ['', 2, 2]] as const) {
  const previousText = 'a\n\nb\n\nc\n', nextText = insert + previousText.slice(removed);
  let restored: any;
  const view = { ...anchorView, state: { doc: Text.of(nextText.split('\n')) } };
  const controller = new ViewportController(view as any, { attachInteractions: false, previewSurface: {
    readScrollTop: () => 300, writeScrollTop: () => {},
    captureTopVisiblePosition: () => ({ line: 3, lineOffset: 10, viewportOffset: 0,
      sourceRange: { startLine: 3, endLine: 3, progress: 0.5 } }),
    restoreTopVisiblePosition: position => { restored = position; }
  } });
  try {
    controller.runPreviewPresentationTransaction(() => {}, { previousText, nextText });
    if (restored?.line !== expectedLine || restored.sourceRange?.startLine !== expectedLine
      || restored.sourceRange?.endLine !== expectedLine || restored.sourceRange?.progress !== 0.5) {
      throw new Error(`An upstream edit lost the Preview paragraph fraction: ${JSON.stringify(restored)}`);
    }
  } finally { controller.destroy(); }
}

// A cold linked target survives typing in the same owner while idle geometry
// cannot turn each input into navigation. A newer scroll still supersedes it.
{
  const doc = Text.of(Array.from({ length: 80 }, () => 'line'));
  const scroller = { scrollTop: 200, scrollLeft: 0, scrollHeight: 2000, clientHeight: 400 };
  const requests: Array<{ line: number; isCurrent: () => boolean }> = [];
  const controller = new ViewportController({
    dom: {}, scrollDOM: scroller, state: { doc },
    lineBlockAtHeight: (height: number) => { const line = doc.line(Math.floor(height / 20) + 1);
      return { from: line.from, to: line.to, top: Math.floor(height / 20) * 20, bottom: (Math.floor(height / 20) + 1) * 20 }; }
  } as any, { attachInteractions: false, getMode: () => 'source', previewSurface: {
    captureTopVisiblePosition: () => null,
    captureLinkedGeometry: () => null,
    readScrollTop: () => 0, writeScrollTop() {},
    restoreTopVisiblePosition: (position, isCurrent) => { requests.push({ line: position.line, isCurrent }); }
  } });
  try {
    controller.setLinkedPreviewEnabled(true);
    controller.markInteraction('editor');
    controller.editorViewportChanged();
    controller.linkedPreviewReady();
    await new Promise(resolve => setTimeout(resolve, 400));
    if (requests.length !== 1 || requests[0].line !== 11 || !requests[0].isCurrent()) {
      throw new Error('Typing and idle geometry must retain the pending cold Source target');
    }
    scroller.scrollTop = 600;
    controller.editorViewportChanged();
    if (requests.length !== 2 || requests[1].line !== 31 || requests[0].isCurrent() || !requests[1].isCurrent()) {
      throw new Error('A later position in the same drag must supersede the first cold target');
    }
    controller.markPreviewInteraction();
    if (requests[1].isCurrent()) throw new Error('Preview ownership must cancel a pending Source target');
  } finally { controller.destroy(); }
}

// Source edits, stale Preview revisions and delayed clicks share one navigation
// owner. A render completion must not manufacture or revive a scroll intention.
{
  const doc = Text.of(Array.from({ length: 80 }, () => 'line'));
  const scroll = { scrollTop: 200, scrollLeft: 0, scrollHeight: 2000, clientHeight: 400 };
  let previewTop = 0, current = true;
  const reveals: Array<{ line: number; isCurrent: () => boolean }> = [];
  const controller = new ViewportController({ dom: {}, scrollDOM: scroll, state: { doc },
    ...uniformLineGeometry(doc)
  } as any, { attachInteractions: false, getMode: () => 'source', previewSurface: {
    isCurrentDocument: () => current,
    captureTopVisiblePosition: () => null, restoreTopVisiblePosition() {},
    readScrollTop: () => previewTop, writeScrollTop: top => { previewTop = top; },
    revealSourcePosition: (line, isCurrent) => reveals.push({ line, isCurrent }),
    captureLinkedGeometry: () => ({ maximumScrollTop: 3200,
      regions: Array.from({ length: 80 }, (_, i) => ({ startLine: i + 1, endLine: i + 1, top: i * 40, bottom: (i + 1) * 40 })) })
  } });
  try {
    controller.setLinkedPreviewEnabled(true);
    const initial = previewTop;
    controller.reconcileAfterEditorUpdate(p => p);
    (controller as any).onWheel({ ctrlKey: true, deltaX: 0, deltaY: 100 });
    (controller as any).onWheel({ ctrlKey: false, deltaX: 0, deltaY: 0 });
    scroll.scrollTop = 600; controller.editorViewportChanged();
    controller.linkedPreviewReady();
    await new Promise(resolve => setTimeout(resolve, 20));
    if (previewTop !== initial) throw new Error('Source caret auto-reveal escaped its input hold');
    current = false;
    controller.markPreviewInteraction(); previewTop = 800; controller.previewViewportChanged();
    if (scroll.scrollTop !== 600) throw new Error('A stale Preview gesture used old source coordinates');
    current = true; controller.linkedPreviewReady(false);
    await new Promise(resolve => setTimeout(resolve, 350));
    if (scroll.scrollTop !== 400) throw new Error('The latest Preview gesture was lost after the matching revision arrived');
    current = false;
    controller.markInteraction('editor'); scroll.scrollTop = 700; controller.editorViewportChanged();
    controller.reconcileAfterEditorUpdate(p => p);
    current = true; controller.linkedPreviewReady(false);
    await new Promise(resolve => setTimeout(resolve, 350));
    if (previewTop !== 800) throw new Error('A later edit revived an obsolete pending Source scroll');
    current = false;
    controller.locateLinkedSourcePosition(12); controller.locateLinkedSourcePosition(16);
    if (reveals.length) throw new Error('A Source click revealed a stale Preview revision');
    current = true; controller.linkedPreviewReady(false);
    if (reveals.length !== 1 || reveals[0].line !== 16 || !reveals[0].isCurrent()) throw new Error('Only the latest Source click may reveal once');
    controller.reconcileAfterEditorUpdate(p => p);
    if (reveals[0].isCurrent()) throw new Error('Typing did not cancel a cold click destination');
    current = false; controller.locateLinkedSourcePosition(20);
    controller.markPreviewInteraction(); current = true; controller.linkedPreviewReady(false);
    if (reveals.length !== 1) throw new Error('A Preview gesture did not cancel a pending Source click');
    current = false; controller.locateLinkedSourcePosition(22); current = true;
    controller.runPreviewPresentationTransaction(() => {
      controller.linkedPreviewReady(false);
      if (reveals.length !== 1) throw new Error('onRendered applied a click before its presentation transaction finished');
      previewTop = 900;
    });
    if (reveals.length !== 2 || reveals[1].line !== 22 || !reveals[1].isCurrent()) throw new Error('A completed presentation lost its delayed click');
    current = false; controller.locateLinkedSourcePosition(24);
    controller.setLinkedPreviewEnabled(false); current = true; controller.linkedPreviewReady();
    if (reveals.length !== 2) throw new Error('Disabling sync revived a queued click');
    controller.reconcileAfterEditorUpdate(p => p); scroll.scrollTop = 950; controller.editorViewportChanged();
    if (previewTop !== 800) throw new Error('Independent Source input moved Preview');
  } finally { controller.destroy(); }
}

// Windowed Preview cannot reuse a global pixel map after a minimal click reveal.
// Both owners must continue from the same measured semantic point, including
// fractional positions inside a Source line and a delayed matching revision.
{
  const doc = Text.of(Array.from({ length: 100 }, () => 'line'));
  const scroll = { scrollTop: 200, scrollLeft: 0, scrollHeight: 2000, clientHeight: 400 };
  let previewTop = 400, current = true;
  const block = (line: number) => ({ from: doc.line(line).from, to: doc.line(line).to, top: (line - 1) * 20, bottom: line * 20 });
  const controller = new ViewportController({ dom: {}, state: { doc }, scrollDOM: scroll, contentHeight: 2000,
    lineBlockAt: (pos: number) => block(doc.lineAt(pos).number),
    lineBlockAtHeight: (height: number) => block(Math.min(100, Math.floor(height / 20) + 1))
  } as any, { attachInteractions: false, getMode: () => 'source', previewSurface: {
    isCurrentDocument: () => current, captureLinkedGeometry: () => null,
    readScrollTop: () => previewTop, writeScrollTop: top => { previewTop = top; },
    captureTopVisiblePosition: (viewportOffset = 0) => {
      const point = previewTop + viewportOffset, line = Math.floor(point / 40) + 1;
      return { line, lineOffset: 0, viewportOffset, sourceRange: { startLine: line, endLine: line, progress: point % 40 / 40 } };
    },
    restoreTopVisiblePosition: (point, isCurrent) => {
      if (isCurrent()) previewTop = (point.line - 1) * 40 + (point.sourceRange?.progress ?? 0) * 40 - (point.viewportOffset ?? 0);
    },
    revealSourcePosition: () => { previewTop = 700; }
  } });
  const wheel = (delta: number) => { (controller as any).onWheel({ ctrlKey: false, deltaX: 0, deltaY: delta });
    scroll.scrollTop += delta; controller.editorViewportChanged(); };
  try {
    controller.setLinkedPreviewEnabled(true); controller.locateLinkedSourcePosition(30);
    wheel(10);
    if (previewTop !== 720) throw new Error(`First Source wheel discarded the click origin: ${previewTop}`);
    wheel(-10);
    if (previewTop !== 700) throw new Error('A reversed Source wheel accumulated a click offset');
    controller.markPreviewInteraction(); previewTop += 20; controller.previewViewportChanged();
    if (scroll.scrollTop !== 210) throw new Error('Reverse Preview ownership discarded the shared origin');
    controller.markPreviewInteraction(); previewTop -= 20; controller.previewViewportChanged();
    if (scroll.scrollTop !== 200) throw new Error('Reverse Preview scrolling did not return to the same Source point');
    controller.reconcileAfterEditorUpdate(p => p); current = false;
    wheel(10);
    if (previewTop !== 700) throw new Error('A stale revision must retain the actual reading point');
    current = true; controller.linkedPreviewReady(false); await new Promise(resolve => setTimeout(resolve, 350));
    if (previewTop !== 720) throw new Error(`A delayed revision lost the pre-gesture origin: ${previewTop}`);
    controller.beginNavigationReveal(); scroll.scrollTop = 400; controller.editorViewportChanged();
    if (previewTop !== 800) throw new Error('Explicit Source navigation must retire a previous relative origin');
    controller.locateLinkedSourcePosition(30); controller.setLinkedPreviewEnabled(false);
    scroll.scrollTop = 300; controller.setLinkedPreviewEnabled(true);
    if (previewTop !== 600) throw new Error('Re-enabling sync must not revive an old click origin');
  } finally { controller.destroy(); }
}

console.log('viewport controller checks passed');
