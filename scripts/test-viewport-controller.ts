import { Text } from '@codemirror/state';
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
  clientWidth: 900,
  getBoundingClientRect: () => ({ top: 0, bottom: 500, left: 0, right: 900 })
};
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
  getBoundingClientRect: () => ({ top: 0, bottom: 500, height: 500 })
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

const firstNavigationReveal = wheelController.beginNavigationReveal();
if (!firstNavigationReveal()) {
  throw new Error('A fresh navigation reveal was not current');
}
const secondNavigationReveal = wheelController.beginNavigationReveal();
if (firstNavigationReveal() || !secondNavigationReveal()) {
  throw new Error('A newer navigation reveal did not replace the older intent');
}
wheelDom.dispatch('beforeinput', { inputType: 'insertText' });
if (secondNavigationReveal()) {
  throw new Error('Beforeinput did not invalidate a delayed navigation reveal');
}
const keyNavigationReveal = wheelController.beginNavigationReveal();
wheelDom.dispatch('keydown', { key: 'ArrowDown', ctrlKey: false, metaKey: false, isComposing: false });
if (keyNavigationReveal()) {
  throw new Error('A newer key interaction did not invalidate a delayed navigation reveal');
}
const pointerNavigationReveal = wheelController.beginNavigationReveal();
wheelScrollDOM.dispatch('pointerdown', { button: 0, target: wheelScrollDOM });
if (pointerNavigationReveal()) {
  throw new Error('A newer pointer interaction did not invalidate a delayed navigation reveal');
}
wheelDocument.dispatch('pointerup', {});
const wheelNavigationReveal = wheelController.beginNavigationReveal();
dispatchWheel(-80);
if (wheelNavigationReveal()) {
  throw new Error('A newer wheel interaction did not invalidate a delayed navigation reveal');
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
const visibleReveal = revealController.beginNavigationReveal();
revealController.revealPosition(200, { y: 'nearest' }, visibleReveal);
await Promise.resolve();
await flushFrames(wheelFrames);
if (revealScrollDOM.scrollTop !== 100) {
  throw new Error(`An already-visible target scrolled to ${revealScrollDOM.scrollTop}`);
}
const offscreenReveal = revealController.beginNavigationReveal();
revealController.revealPosition(900, { y: 'nearest' }, offscreenReveal);
await Promise.resolve();
await flushFrames(wheelFrames);
if (revealScrollDOM.scrollTop !== 420) {
  throw new Error(`Nearest reveal reached ${revealScrollDOM.scrollTop} instead of 420`);
}
const staleReveal = revealController.beginNavigationReveal();
revealController.revealPosition(1500, { y: 'nearest', schedule: 'next-frame' }, staleReveal);
revealController.markInteraction();
await Promise.resolve();
await flushFrames(wheelFrames);
if (revealScrollDOM.scrollTop !== 420) {
  throw new Error(`A stale reveal moved the viewport to ${revealScrollDOM.scrollTop}`);
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
if (tallScrollDOM.scrollTop !== 1040) {
  throw new Error(`Tall wrapped nearest reveal moved to ${tallScrollDOM.scrollTop} instead of 1040`);
}
tallScrollDOM.scrollTop = 1000;
const tallCenterReveal = tallController.beginNavigationReveal();
tallController.revealPosition(900, { y: 'center' }, tallCenterReveal);
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

console.log('viewport controller checks passed');
