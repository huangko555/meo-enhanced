import { ViewportController } from '../webview/src/helpers/viewportController';

const flushFrames = async (animationFrames: FrameRequestCallback[]): Promise<void> => {
  await Promise.resolve();
  while (animationFrames.length > 0) {
    animationFrames.shift()?.(0);
    await Promise.resolve();
  }
};

const runScenario = async ({ laterLayoutShift = 0 } = {}) => {
  const animationFrames: FrameRequestCallback[] = [];
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  };

  let layoutTop = 1100;
  const scrollDOM = {
    scrollTop: 1000,
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
    lineBlockAt: () => ({ top: layoutTop }),
    requestMeasure: ({ read, write }: { read: () => unknown; write: (value: unknown) => void }) => {
      write(read());
    }
  };
  const controller = new ViewportController(view as any, { attachInteractions: false });

  controller.preserveLayoutChange({
    element: {
      isConnected: true,
      getBoundingClientRect: () => ({ top: -100, bottom: 0 })
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
  clientWidth: 900
};
const documentView = {
  dom: {},
  scrollDOM: documentScrollDOM,
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
documentController.destroy();
globalThis.requestAnimationFrame = originalRequestAnimationFrame;

const wheelFrames: FrameRequestCallback[] = [];
const originalWheelRequestAnimationFrame = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
  wheelFrames.push(callback);
  return wheelFrames.length;
};

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as Event);
    }
  }
}

const originalWheelEvent = globalThis.WheelEvent;
(globalThis as typeof globalThis & { WheelEvent: typeof WheelEvent }).WheelEvent = class {
  static readonly DOM_DELTA_PIXEL = 0;
  static readonly DOM_DELTA_LINE = 1;
  static readonly DOM_DELTA_PAGE = 2;
} as typeof WheelEvent;

const wheelDom = new FakeEventTarget();
const wheelScrollDOM = Object.assign(new FakeEventTarget(), {
  scrollTop: 1000,
  scrollLeft: 0,
  scrollHeight: 5000,
  scrollWidth: 2000,
  clientHeight: 500,
  clientWidth: 900
});
const wheelView = {
  dom: wheelDom,
  scrollDOM: wheelScrollDOM,
  defaultLineHeight: 20,
  lineBlockAtHeight: (height: number) => ({ from: 42, top: height }),
  lineBlockAt: () => ({ top: 1000 }),
  requestMeasure: ({ read, write }: { read: () => unknown; write: (value: unknown) => void }) => write(read())
};
const wheelController = new ViewportController(wheelView as any);
let defaultPrevented = false;
const dispatchWheel = (deltaY: number) => wheelScrollDOM.dispatch('wheel', {
  deltaX: 0,
  deltaY,
  deltaMode: 0,
  ctrlKey: false,
  preventDefault: () => { defaultPrevented = true; }
});

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

wheelController.destroy();
globalThis.requestAnimationFrame = originalWheelRequestAnimationFrame;
(globalThis as typeof globalThis & { WheelEvent: typeof WheelEvent }).WheelEvent = originalWheelEvent;

console.log('viewport controller checks passed');
