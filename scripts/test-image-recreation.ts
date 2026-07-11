class FakeClassList {
  add() {}
  remove() {}
}

const imageLoadsBySrc = new Map<string, number>();

class FakeElement {
  private source = '';
  children: FakeElement[] = [];
  classList = new FakeClassList();
  className = '';
  complete = false;
  isConnected = false;
  naturalWidth = 0;
  tagName: string;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  set src(value: string) {
    this.source = value;
    const loadCount = (imageLoadsBySrc.get(value) ?? 0) + 1;
    imageLoadsBySrc.set(value, loadCount);
    this.complete = loadCount === 1;
    this.naturalWidth = this.complete ? 1600 : 0;
  }

  get src() {
    return this.source;
  }

  addEventListener() {}
  append(...children: FakeElement[]) {
    this.children.push(...children);
  }
  appendChild(child: FakeElement) {
    this.children.push(child);
    return child;
  }
  replaceChildren(...children: FakeElement[]) {
    this.children = children;
  }
  setAttribute() {}
}

(globalThis as any).document = {
  createElement: (tagName: string) => new FakeElement(tagName),
  createElementNS: (_namespace: string, tagName: string) => new FakeElement(tagName),
  documentElement: { style: {} },
};
(globalThis as any).navigator = { userAgent: 'test-image-recreation' };
(globalThis as any).window = globalThis;

const { ImageWidget, setImageSrcResolver } = await import('../webview/src/helpers/images');
setImageSrcResolver((url) => url);

const flushImageLoad = async () => {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
};

const firstContainer = new ImageWidget('/large-image.png', 'large image', '').toDOM() as any;
await flushImageLoad();
const firstImage = firstContainer.children.find((child: FakeElement) => child.tagName === 'IMG');
if (!firstImage?.complete) {
  throw new Error('Initial image did not complete');
}

firstContainer.isConnected = false;
firstImage.isConnected = false;
const secondContainer = new ImageWidget('/large-image.png', 'large image', '').toDOM() as any;
const secondImage = secondContainer.children.find((child: FakeElement) => child.tagName === 'IMG');
if (!secondImage) {
  throw new Error('Cached image was not rendered');
}
if (secondImage !== firstImage && !secondImage.complete) {
  throw new Error('Cached image was recreated in an incomplete state');
}

const preloadedWidget = new ImageWidget('/preloaded-image.png', 'preloaded image', '');
await flushImageLoad();
const preloadedContainer = preloadedWidget.toDOM() as any;
const preloadedImage = preloadedContainer.children.find((child: FakeElement) => child.tagName === 'IMG');
if (!preloadedImage?.complete) {
  throw new Error('Offscreen image was not preloaded before rendering');
}

console.log('image preload and recreation checks passed');
