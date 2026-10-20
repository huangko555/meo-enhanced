import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-image-layout-'));

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-table-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  let releaseImage!: () => void;
  const heldImage = new Promise<void>(resolve => { releaseImage = resolve; });
  const imageServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
    await heldImage;
    return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#73c"/></svg>',
      { headers: { 'content-type': 'image/svg+xml' } });
  } });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root { --meo-background:#24292e; --meo-foreground:#e6edf3; --meo-caret:#e6edf3; --meo-semantic-imageBackground:#2a3a52; --meo-semantic-imageBorder:#474b50; --meo-semantic-imageFallbackForeground:#e6edf3; }'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    // Header dimensions must reserve the first presentation, even while URL
    // resolution itself is pending (no previously decoded image in the pool).
    await page.evaluate(() => {
      const harness = (window as any).TableStabilityHarness;
      harness.setImageSrcResolver(() => new Promise<string>(resolve => {
        (window as any).__releaseFirstImage = () => resolve('data:image/svg+xml,' + encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#73c"/></svg>'));
      }));
      (window as any).__firstImageEditor = harness.createEditor({ parent: document.getElementById('app'),
        text: 'Before first image\n\n![First image](first-arrival.png)\n\nFirst image target', initialMode: 'live',
        initialImageIntrinsicSizes: [{ src: 'first-arrival.png', width: 640, height: 360 }], onApplyChanges() {} });
    });
    await page.waitForSelector('.meo-md-image-fallback');
    const firstBefore = await page.evaluate(() => {
      const image = document.querySelector('.meo-md-image')!.getBoundingClientRect();
      const line = [...document.querySelectorAll('.cm-line')].find(line => line.textContent === 'First image target')!;
      return { width: image.width, height: image.height, lineTop: line.getBoundingClientRect().top };
    });
    assert.ok(Math.abs(firstBefore.height - 240) <= 1,
      `first arrival must reserve its constrained image box before URL resolution: ${JSON.stringify(firstBefore)}`);
    await page.evaluate(() => (window as any).__releaseFirstImage());
    await page.waitForSelector('.meo-md-image-img');
    const firstAfter = await page.evaluate(async () => {
      for (let index = 0; index < 4; index++) await new Promise(requestAnimationFrame);
      const image = document.querySelector('.meo-md-image')!.getBoundingClientRect();
      const line = [...document.querySelectorAll('.cm-line')].find(line => line.textContent === 'First image target')!;
      const result = { width: image.width, height: image.height, lineTop: line.getBoundingClientRect().top };
      (window as any).__firstImageEditor.destroy();
      return result;
    });
    for (const key of ['width', 'height', 'lineTop'] as const) assert.ok(Math.abs(firstBefore[key] - firstAfter[key]) <= 1,
      `first decoding changed ${key}: ${JSON.stringify({ firstBefore, firstAfter })}`);

    for (const authored of ['', '|120', '|120x80']) {
      const reserved = await page.evaluate(async authored => {
        const harness = (window as any).TableStabilityHarness;
        let resolveCalls = 0;
        harness.setImageSrcResolver(() => {
          resolveCalls++;
          return new Promise<string>(resolve => { (window as any).__releaseSizedImage = () => resolve('data:image/svg+xml,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"/>')); });
        });
        const editor = (window as any).__sizedImageEditor = harness.createEditor({ parent: document.getElementById('app'),
          text: `Before\n\n![[sized.png${authored}]]\n\nSized target`, initialMode: 'live', onApplyChanges() {} });
        for (let index = 0; index < 4; index++) await new Promise(requestAnimationFrame);
        editor.setImageIntrinsicSizes([{ src: 'meo-wiki-image:sized.png', width: 640, height: 360 }]);
        for (let index = 0; index < 4; index++) await new Promise(requestAnimationFrame);
        const image = document.querySelector('.meo-md-image')!.getBoundingClientRect();
        const line = [...document.querySelectorAll('.cm-line')].find(line => line.textContent === 'Sized target')!;
        return { width: image.width, height: image.height, lineTop: line.getBoundingClientRect().top, resolveCalls };
      }, authored);
      assert.equal(reserved.resolveCalls, 1, 'late metadata must not restart URL resolution');
      assert.ok(Math.abs(reserved.height - (authored === '|120x80' ? 80 : authored === '|120' ? 67.5 : 240)) <= 1,
        `late dimensions must respect authored Wiki size ${authored}: ${JSON.stringify(reserved)}`);
      await page.evaluate(() => (window as any).__releaseSizedImage());
      await page.waitForSelector('.meo-md-image-img');
      const loaded = await page.evaluate(async () => {
        for (let index = 0; index < 4; index++) await new Promise(requestAnimationFrame);
        const image = document.querySelector('.meo-md-image')!.getBoundingClientRect();
        const line = [...document.querySelectorAll('.cm-line')].find(line => line.textContent === 'Sized target')!;
        const result = { width: image.width, height: image.height, lineTop: line.getBoundingClientRect().top };
        (window as any).__sizedImageEditor.destroy();
        return result;
      });
      for (const key of ['width', 'height', 'lineTop'] as const) assert.ok(Math.abs(reserved[key] - loaded[key]) <= 1,
        `Wiki image decoding changed ${key}: ${JSON.stringify({ authored, reserved, loaded })}`);
    }

    // A cached resource is cloned into display DOM. Its replacement URL is
    // deliberately held so decoding cannot supply geometry before this check.
    await page.evaluate(url => {
      const harness = (window as any).TableStabilityHarness;
      const source = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#73c" id="held-clone-fixture"/></svg>');
      harness.setImageSrcResolver(() => source);
      const clone = HTMLImageElement.prototype.cloneNode;
      (window as any).__restoreImageClone = () => { HTMLImageElement.prototype.cloneNode = clone; };
      HTMLImageElement.prototype.cloneNode = function(deep?: boolean) {
        const result = clone.call(this, deep) as HTMLImageElement;
        if (this.src.includes('held-clone-fixture')) result.src = url;
        return result;
      };
      (window as any).__coldImageEditor = harness.createEditor({ parent: document.getElementById('app'),
        text: 'Before image\n\n![Held image](held-clone.png)\n\nAfter image target', initialMode: 'live', onApplyChanges() {} });
    }, new URL('/held.svg', imageServer.url).href);
    await page.waitForSelector('.meo-md-image-img');
    const beforeDecode = await page.evaluate(async () => {
      for (let index = 0; index < 4; index++) await new Promise(requestAnimationFrame);
      const image = document.querySelector<HTMLImageElement>('.meo-md-image-img')!;
      const line = [...document.querySelectorAll<HTMLElement>('.cm-line')].find(line => line.textContent === 'After image target')!;
      const bounds = image.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height, lineTop: line.getBoundingClientRect().top, naturalWidth: image.naturalWidth };
    });
    assert.equal(beforeDecode.naturalWidth, 0, 'the display clone must still be undecoded in this fixture');
    assert.ok(beforeDecode.height > 0, 'known resource dimensions must reserve the display clone before its load event');
    releaseImage();
    await page.waitForFunction(() => (document.querySelector('.meo-md-image-img') as HTMLImageElement)?.naturalWidth > 0);
    const afterDecode = await page.evaluate(async () => {
      for (let index = 0; index < 4; index++) await new Promise(requestAnimationFrame);
      const image = document.querySelector<HTMLImageElement>('.meo-md-image-img')!;
      const line = [...document.querySelectorAll<HTMLElement>('.cm-line')].find(line => line.textContent === 'After image target')!;
      const bounds = image.getBoundingClientRect();
      const lineTop = line.getBoundingClientRect().top;
      (window as any).__restoreImageClone();
      (window as any).__coldImageEditor.destroy();
      return { width: bounds.width, height: bounds.height, lineTop };
    });
    assert.ok(Math.abs(beforeDecode.height - afterDecode.height) <= 1 && Math.abs(beforeDecode.width - afterDecode.width) <= 1,
      'decoding a resource clone must not resize an already projected image');
    assert.ok(Math.abs(beforeDecode.lineTop - afterDecode.lineTop) <= 1,
      `late clone decoding must not move the next editable line: ${JSON.stringify({ beforeDecode, afterDecode })}`);

    // pointerdown runs before CodeMirror's mousedown hit test. Replacing the
    // previously active image source at that point moves the clicked glyph.
    for (const large of [false, true]) {
      const point = await page.evaluate(async large => {
        const harness = (window as any).TableStabilityHarness;
        harness.setImageSrcResolver(() => 'data:image/svg+xml,' + encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#73c"/></svg>'));
        const source = 'Intro\n\n![Active](wide.png)\n\nTarget below picture\n\nTail\n' + (large ? '\nOrdinary line.\n'.repeat(22_000) : '');
        const editor = harness.createEditor({ parent: document.getElementById('app'), text: source, initialMode: 'live', onApplyChanges() {} });
        (window as any).__pointerImageEditor = editor;
        editor.view.dispatch({ selection: { anchor: source.indexOf('Active') + 1 } });
        editor.view.focus();
        for (let frame = 0; frame < 15; frame++) await new Promise(requestAnimationFrame);
        const locate = () => {
          const line = [...document.querySelectorAll('.cm-line')].find(line => line.textContent === 'Target below picture')!;
          const range = document.createRange();
          range.setStart(line.firstChild!, 3); range.setEnd(line.firstChild!, 4);
          const rect = range.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        };
        const before = locate();
        (window as any).__pointerImageGeometry = { before, source };
        document.addEventListener('mousedown', () => { (window as any).__pointerImageGeometry.atHit = locate(); }, { capture: true, once: true });
        return before;
      }, large);
      await page.mouse.click(point.x, point.y);
      const after = await page.evaluate(async () => {
        for (let frame = 0; frame < 6; frame++) await new Promise(requestAnimationFrame);
        const editor = (window as any).__pointerImageEditor;
        const geometry = (window as any).__pointerImageGeometry;
        return { before: geometry.before, atHit: geometry.atHit,
          line: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).text };
      });
      assert.ok(after.atHit && Math.abs(after.atHit.y - after.before.y) <= 1,
        `${large ? 'large' : 'ordinary'} Live pointerdown moved text before the initial hit: ${JSON.stringify(after.atHit)}`);
      assert.equal(after.line, 'Target below picture', 'the initial click must reach its glyph beside an active image');
      await page.keyboard.type('Q');
      const typed = await page.evaluate(async () => {
        const editor = (window as any).__pointerImageEditor;
        const line = editor.view.state.doc.lineAt(editor.view.state.selection.main.head).text;
        await editor.undo();
        const restored = editor.getText() === (window as any).__pointerImageGeometry.source;
        editor.destroy();
        return { line, restored };
      });
      assert.equal(typed.line.replace('Q', ''), 'Target below picture', 'typing after the click must edit the clicked line');
      assert.ok(typed.restored, 'undo after an image-adjacent click must restore exact source');
    }

    const initial = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const svg = (color: string, width: number, height: number) => (
        `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${color}"/></svg>`)}`
      );
      harness.setImageSrcResolver((url: string) => {
        if (url.includes('missing')) return '';
        if (url.includes('wide')) return Promise.resolve(svg('#c33', 800, 450));
        return svg('#73c', 256, 256);
      });
      const editor = harness.createEditor({
        parent: document.getElementById('app')!,
        text: 'before\n![missing](missing.jpg) [![wide](wide.avif)](#after-target)![logo](logo.png)\nafter target',
        initialMode: 'live',
        onApplyChanges() {}
      });
      (window as any).__imageLayoutEditor = editor;
      const openedLinks: string[] = [];
      editor.view.dom.addEventListener('meo-open-link', (event: Event) => {
        const href = (event as CustomEvent<{ href?: string }>).detail?.href;
        if (href) openedLinks.push(href);
      });
      for (let index = 0; index < 12; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const loaded = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-image-img'));
      const wide = loaded.find((image) => image.getBoundingClientRect().width > image.getBoundingClientRect().height);
      if (!wide) throw new Error('Wide image did not render in the reproduction fixture');
      const openLink = wide.closest<HTMLElement>('.meo-md-image')
        ?.querySelector<HTMLButtonElement>('button[data-tooltip-link-href="#after-target"]');
      if (!openLink) throw new Error('Linked image did not render its document jump button');
      openLink.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      const rect = wide.getBoundingClientRect();
      return {
        imageCount: loaded.length,
        fallbackCount: document.querySelectorAll('.meo-md-image-fallback').length,
        openedLinks,
        widePoint: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      };
    });

    await page.mouse.click(initial.widePoint.x, initial.widePoint.y);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const expanded = await page.evaluate(() => {
      const editor = (window as any).__imageLayoutEditor;
      const lines = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'));
      const sourceLine = lines.find((line) => line.textContent?.includes('![missing]'));
      const afterLine = lines.find((line) => line.textContent?.includes('after target'));
      if (!sourceLine || !afterLine) throw new Error('Expected source and following line were not rendered');
      const afterRect = afterLine.getBoundingClientRect();
      const x = afterRect.left + Math.min(40, Math.max(4, afterRect.width / 2));
      const y = afterRect.top + afterRect.height / 2;
      const target = document.elementFromPoint(x, y) as HTMLElement | null;
      const mappedPosition = editor.view.posAtCoords({ x, y });
      return {
        afterPoint: { x, y },
        hitClass: target?.className ?? '',
        hitText: target?.textContent ?? '',
        mappedLine: mappedPosition === null ? null : editor.view.state.doc.lineAt(mappedPosition).number,
        domLine: editor.view.state.doc.lineAt(editor.view.posAtDOM(afterLine)).number,
        sourceRect: sourceLine.getBoundingClientRect().toJSON(),
        afterRect: afterRect.toJSON(),
        widgetRects: Array.from(document.querySelectorAll<HTMLElement>('.meo-md-image')).map((element) => {
          const rect = element.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, fallback: element.classList.contains('meo-md-image-fallback') };
        })
      };
    });

    await page.mouse.click(expanded.afterPoint.x, expanded.afterPoint.y);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterClick = await page.evaluate(() => {
      const editor = (window as any).__imageLayoutEditor;
      return {
        selectedLine: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number,
        sourceStillExpanded: Array.from(document.querySelectorAll('.cm-line'))
          .some((line) => line.textContent?.includes('wide.avif'))
      };
    });

    const imageHistory = await page.evaluate(async () => {
      const editor = (window as any).__imageLayoutEditor;
      const view = editor.view;
      const line = view.state.doc.line(2);
      const marker = ' IMAGE_HISTORY_TARGET';
      view.dispatch({
        changes: { from: line.to, insert: marker },
        selection: { anchor: line.to + marker.length }
      });
      view.focus();
      const states: Array<{
        direction: 'undo' | 'redo';
        markerPresent: boolean;
        lineNumber: number;
        targetVisible: boolean;
        scrollTop: number;
      }> = [];
      for (const direction of ['undo', 'redo'] as const) {
        const applied = direction === 'undo' ? await editor.undo() : await editor.redo();
        if (!applied) throw new Error(`${direction} beside an image was not applied`);
        for (let frame = 0; frame < 10; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        const head = view.state.selection.main.head;
        const coords = view.coordsAtPos(head);
        const viewport = view.scrollDOM.getBoundingClientRect();
        states.push({
          direction,
          markerPresent: view.state.doc.toString().includes(marker),
          lineNumber: view.state.doc.lineAt(head).number,
          targetVisible: Boolean(coords && coords.top >= viewport.top && coords.bottom <= viewport.bottom),
          scrollTop: view.scrollDOM.scrollTop
        });
      }
      return states;
    });

    const failures: string[] = [];
    if (initial.imageCount !== 2 || initial.fallbackCount !== 1) {
      failures.push(`fixture rendered ${initial.imageCount} images and ${initial.fallbackCount} fallbacks`);
    }
    if (initial.openedLinks.length !== 1 || initial.openedLinks[0] !== '#after-target') {
      failures.push(`linked image opened ${JSON.stringify(initial.openedLinks)} instead of #after-target`);
    }
    if (afterClick.selectedLine !== 3 || afterClick.sourceStillExpanded) {
      failures.push(
        `click below images hit ${JSON.stringify(expanded.hitClass)} ${JSON.stringify(expanded.hitText.slice(0, 40))}; `
        + `coords mapped to line ${expanded.mappedLine}, DOM mapped to line ${expanded.domLine}, `
        + `selection stayed on line ${afterClick.selectedLine}; source=${JSON.stringify(expanded.sourceRect)}, `
        + `after=${JSON.stringify(expanded.afterRect)}, rects=${JSON.stringify(expanded.widgetRects)}`
      );
    }
    if (imageHistory.some((state) => (
      state.markerPresent !== (state.direction === 'redo') ||
      state.lineNumber !== 2 ||
      !state.targetVisible
    ))) {
      failures.push(`history did not use a visible source boundary beside an atomic image: ${JSON.stringify(imageHistory)}`);
    }
    if (failures.length) throw new Error(failures.join('\n'));

    const beforeViewer = await page.evaluate(() => {
      const editor = (window as any).__imageLayoutEditor;
      editor.view.dispatch({ selection: { anchor: 0 } });
      return editor.view.state.doc.toString();
    });
    const openViewer = '.meo-md-image button[data-tooltip="Fullscreen image"]';
    await page.waitForSelector(openViewer);
    const expectedSrc = await page.$eval(openViewer, button =>
      button.closest('.meo-md-image')!.querySelector<HTMLImageElement>('img')!.src);
    await page.click(openViewer);
    await page.waitForSelector('.meo-md-image-fullscreen-img');
    assert.equal(await page.$eval('.meo-md-image-fullscreen-img', image => (image as HTMLImageElement).src), expectedSrc);
    const transform = () => page.$eval('.meo-md-image-fullscreen-img', image => {
      const matrix = new DOMMatrix(getComputedStyle(image).transform);
      return { zoom: matrix.a, x: matrix.e, y: matrix.f };
    });
    await page.click('.meo-md-image-fullscreen button[data-tooltip="Zoom in"]');
    assert.equal((await transform()).zoom, 1.5);
    const viewerPoint = await page.$eval('.meo-md-image-fullscreen-img', image => {
      const rect = image.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(viewerPoint.x, viewerPoint.y);
    await page.mouse.down();
    await page.mouse.move(viewerPoint.x + 40, viewerPoint.y + 25, { steps: 4 });
    await page.mouse.up();
    assert.deepEqual(await transform(), { zoom: 1.5, x: 40, y: 25 });
    await page.mouse.wheel({ deltaY: 120 });
    await page.waitForFunction(() =>
      new DOMMatrix(getComputedStyle(document.querySelector('.meo-md-image-fullscreen-img')!).transform).a === 1.25);
    await page.click('.meo-md-image-fullscreen button[data-tooltip="Reset zoom"]');
    assert.deepEqual(await transform(), { zoom: 1, x: 0, y: 0 });
    await page.keyboard.press('Escape');
    assert.equal(await page.$('.meo-md-image-fullscreen-scrim'), null);
    await page.click(openViewer);
    await page.click('.meo-md-image-fullscreen button[data-tooltip="Exit fullscreen"]');
    assert.equal(await page.$('.meo-md-image-fullscreen-scrim'), null);
    assert.equal(await page.evaluate(() => (window as any).__imageLayoutEditor.view.state.doc.toString()), beforeViewer);
    console.log('image layout checks passed');
  } finally {
    releaseImage();
    imageServer.stop(true);
    await browser.close();
  }
}

main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
