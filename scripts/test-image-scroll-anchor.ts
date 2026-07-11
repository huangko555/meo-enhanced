import { ImageWidget } from '../webview/src/helpers/images';

const runScenario = (userScroll: number, laterLayoutShift: number) => {
  const animationFrames: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  };

  let layoutTop = 1100;
  const scrollDOM = { scrollTop: 1000 };
  const anchorElement = {
    isConnected: true,
    getBoundingClientRect: () => ({ top: layoutTop - scrollDOM.scrollTop }),
  };
  const view = {
    scrollDOM,
    requestMeasure: ({ read, write }: { read: () => unknown; write: (value: unknown) => void }) => {
      write(read());
    },
  };

  const widget = new ImageWidget('', 'test', '');
  layoutTop += 240;
  (widget as any).keepViewportAnchor(view, { anchor: anchorElement, top: 100 });
  scrollDOM.scrollTop += userScroll;
  layoutTop += laterLayoutShift;
  animationFrames.shift()?.(0);
  return scrollDOM.scrollTop;
};

const layoutOnlyScrollTop = runScenario(0, 40);
if (layoutOnlyScrollTop !== 1280) {
  throw new Error(`Later image layout shift was not corrected: ${layoutOnlyScrollTop}`);
}

const userScrollTop = runScenario(-80, 0);
if (userScrollTop !== 1160) {
  throw new Error(`User scroll was overridden by anchor correction: ${userScrollTop}`);
}

console.log('image scroll anchor regression checks passed');
