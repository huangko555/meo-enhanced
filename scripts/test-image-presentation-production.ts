import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-image-presentation-production-'));

async function main(): Promise<void> {
  const collectTypeScript = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectTypeScript(target);
      return entry.isFile() && entry.name.endsWith('.ts') ? [target] : [];
    });
  const productionTree = collectTypeScript(path.join(repoRoot, 'webview', 'src'))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  const editorSource = fs.readFileSync(path.join(repoRoot, 'webview', 'src', 'editor.ts'), 'utf8');
  const imageSource = fs.readFileSync(path.join(repoRoot, 'webview', 'src', 'helpers', 'images.ts'), 'utf8');
  const tableSource = fs.readFileSync(path.join(repoRoot, 'webview', 'src', 'helpers', 'tables.ts'), 'utf8');
  assert.equal((editorSource.match(/createImagePresentationResourcePool\(/g) ?? []).length, 1);
  assert.equal((editorSource.match(/createImagePresentationFactory\(/g) ?? []).length, 1);
  assert.equal(
    (productionTree.match(/from ['"].*imagePresentationAdapter['"]/g) ?? []).length,
    1,
    'only Editor Bootstrap may import the concrete image presentation factory/Adapter'
  );
  assert.equal((productionTree.match(/createImagePresentationApplication\(\);/g) ?? []).length, 1);
  assert.equal((productionTree.match(/createImagePresentationRuntime\(\{/g) ?? []).length, 1);
  assert.equal((productionTree.match(/createCodeMirrorDomImagePresentationAdapter\(\{/g) ?? []).length, 1);
  assert.equal(editorSource.includes('imagePresentationFactoryFacet.of(imagePresentationFactory)'), true);
  assert.equal(editorSource.includes('imagePresentationFactory.externalDocumentPresented()'), true);
  assert.equal(editorSource.includes('imagePresentationResourcePool.dispose()'), true);
  const viewDisposeAt = editorSource.indexOf('view.destroy();');
  const factoryDisposeAt = editorSource.indexOf('imagePresentationFactory.dispose();');
  const poolDisposeAt = editorSource.indexOf('imagePresentationResourcePool.dispose();');
  assert.ok(
    viewDisposeAt >= 0 && viewDisposeAt < factoryDisposeAt && factoryDisposeAt < poolDisposeAt,
    'Editor dispose must destroy Widgets, close the factory handles, then dispose the shared Pool'
  );
  assert.equal(
    tableSource.includes('disposeImagePresentations(previewEl)'),
    true,
    'nested table images must dispose their presentation handles before DOM replacement'
  );
  assert.equal(imageSource.includes("from '../adapters/imagePresentationRuntime'"), false);
  assert.equal(imageSource.includes("from '../editor/imagePresentationAdapter'"), false);
  for (const legacyOwner of [
    'preloadImage',
    'setImageSource',
    'showLoadedImage',
    'pendingImageResolvers',
    'pendingImageLoads',
    'activeImageLoads',
    'queuedImageLoads',
    'imageSrcCache',
    'loadedImages',
    'failedImages'
  ]) {
    assert.equal(imageSource.includes(legacyOwner), false, `${legacyOwner} must not return to production`);
  }

  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-table-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><div id="app"></div><button id="keyboard-end">Keyboard end</button>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    await page.evaluate(() => {
      const harness = (window as any).TableStabilityHarness;
      const svg = (label: string, color: string) => (
        `data:image/svg+xml,${encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="${color}"/><text x="8" y="42">${label}</text></svg>`
        )}`
      );
      harness.setImageSrcResolver((url: string) => svg(url, '#68a'));
      (window as any).__imageHoverEditor = harness.createEditor({
        parent: document.getElementById('app')!,
        text: '![first](first.png) ![second](second.png)',
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await page.waitForSelector('.meo-md-image-controls');

    const readHoverState = () => page.$$eval('.meo-md-image', (images) => images.map((image) => {
      const controls = image.querySelector<HTMLElement>('.meo-md-image-controls');
      return {
        hovered: image.matches(':hover'),
        opacity: Number.parseFloat(getComputedStyle(controls!).opacity)
      };
    }));
    const settleControlAnimations = () => page.$$eval('.meo-md-image-controls', async (controls) => {
      const animations = controls.flatMap((control) => control.getAnimations({ subtree: true }));
      await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
    });
    const hoverPoints = await page.$$eval('.meo-md-image', (images) => images.map((image) => {
      const imageRect = image.querySelector<HTMLElement>('.meo-md-image-img')!.getBoundingClientRect();
      const controlsRect = image.querySelector<HTMLElement>('.meo-md-image-controls')!.getBoundingClientRect();
      return {
        image: { x: imageRect.left + 8, y: imageRect.bottom - 8 },
        controls: { x: controlsRect.left + controlsRect.width / 2, y: controlsRect.top + controlsRect.height / 2 }
      };
    }));
    const readImagePoint = (index: number) => page.$$eval('.meo-md-image-img', (images, targetIndex) => {
      const rect = images[targetIndex]!.getBoundingClientRect();
      return { x: rect.left + 8, y: rect.bottom - 8 };
    }, index);

    assert.deepEqual(await readHoverState(), [
      { hovered: false, opacity: 0 },
      { hovered: false, opacity: 0 }
    ], 'loaded Live image controls should start hidden');

    await page.mouse.move(hoverPoints[0].image.x, hoverPoints[0].image.y);
    await settleControlAnimations();
    assert.deepEqual(await readHoverState(), [
      { hovered: true, opacity: 1 },
      { hovered: false, opacity: 0 }
    ], 'only the currently hovered image should expose controls');

    await page.mouse.move(hoverPoints[0].controls.x, hoverPoints[0].controls.y);
    await settleControlAnimations();
    assert.deepEqual(await readHoverState(), [
      { hovered: true, opacity: 1 },
      { hovered: false, opacity: 0 }
    ], 'moving from an image into its controls should keep that toolbar visible');

    await page.focus('#keyboard-end');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
    const keyboardFocusedControl = await page.evaluate(() => ({
      label: document.activeElement?.getAttribute('aria-label') ?? '',
      isImageControl: document.activeElement?.classList.contains('meo-md-image-control-btn') ?? false
    }));
    assert.deepEqual(keyboardFocusedControl, {
      label: 'Fullscreen image',
      isImageControl: true
    }, 'Shift+Tab should reach the last image control through the browser focus order');

    const focusedImagePoint = await readImagePoint(1);
    await page.mouse.move(focusedImagePoint.x, focusedImagePoint.y);
    await settleControlAnimations();
    assert.deepEqual(await readHoverState(), [
      { hovered: false, opacity: 0 },
      { hovered: true, opacity: 1 }
    ], 'keyboard focus should not change the toolbar shown by a real image Hover');

    await page.mouse.move(1, 1);
    await settleControlAnimations();
    assert.deepEqual(await readHoverState(), [
      { hovered: false, opacity: 0 },
      { hovered: false, opacity: 0 }
    ], 'leaving the image and controls should hide the toolbar even while its control retains focus');

    const competingImagePoint = await readImagePoint(0);
    await page.mouse.move(competingImagePoint.x, competingImagePoint.y);
    await settleControlAnimations();
    assert.deepEqual(await readHoverState(), [
      { hovered: true, opacity: 1 },
      { hovered: false, opacity: 0 }
    ], 'keyboard focus on another image must not compete with the current mouse Hover owner');

    await page.evaluate(() => {
      (window as any).__imageHoverEditor.destroy();
      document.getElementById('app')!.replaceChildren();
    });

    const result = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const svg = (label: string, color: string) => (
        `data:image/svg+xml,${encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="${color}"/><text x="8" y="42">${label}</text></svg>`
        )}`
      );
      const pending = new Map<string, (value: string) => void>();
      const resolutions = new Map<string, number>();
      harness.setImageSrcResolver((url: string) => {
        resolutions.set(url, (resolutions.get(url) ?? 0) + 1);
        if (url.includes('missing')) return '';
        if (url.includes('late')) {
          return new Promise<string>((resolve) => pending.set(url, resolve));
        }
        return svg(url, '#68a');
      });

      const editor = harness.createEditor({
        parent: document.getElementById('app')!,
        text: 'before\n![old](late-old.png)\nafter',
        initialMode: 'live',
        onApplyChanges() {}
      });
      const settle = async () => {
        for (let index = 0; index < 12; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      await settle();
      const initialFallbacks = document.querySelectorAll('.meo-md-image-fallback').length;

      editor.setText('before\n![new](new.png) ![new again](new.png)\n![missing](missing.png)\nafter');
      pending.get('late-old.png')?.(svg('late-old', '#a66'));
      await settle();
      const afterExternal = {
        text: editor.getText(),
        images: Array.from(document.querySelectorAll<HTMLImageElement>('.meo-md-image-img'))
          .map((image) => image.getAttribute('src') ?? ''),
        fallbacks: Array.from(document.querySelectorAll<HTMLElement>('.meo-md-image-fallback'))
          .map((node) => node.textContent ?? ''),
        controls: document.querySelectorAll('.meo-md-image-controls').length,
        sharedResolutionCount: resolutions.get('new.png') ?? 0
      };

      editor.setText(editor.getText());
      await settle();

      editor.setMode('source');
      const sourceVisibleImages = document.querySelectorAll('.meo-md-image-img').length;
      editor.setMode('live');
      await settle();
      const afterModeRoundTrip = {
        text: editor.getText(),
        imageCount: document.querySelectorAll('.meo-md-image-img').length,
        fallbackCount: document.querySelectorAll('.meo-md-image-fallback').length
      };

      const lateEmbedded = '<div><img src="late-html.png" alt="html"></div>\n\n| Media |\n| --- |\n| ![table](late-table.png) |';
      editor.setText(lateEmbedded);
      editor.view.dispatch({ selection: { anchor: lateEmbedded.indexOf('\n') + 1 } });
      await settle();
      const nextEmbedded = '<div><img src="html.png" alt="html"></div>\n\n| Media |\n| --- |\n| ![table](table.png) |';
      editor.setText(nextEmbedded);
      editor.view.dispatch({ selection: { anchor: nextEmbedded.indexOf('\n') + 1 } });
      pending.get('late-html.png')?.(svg('late-html', '#a66'));
      pending.get('late-table.png')?.(svg('late-table', '#a66'));
      await settle();
      const embedded = {
        htmlImages: document.querySelectorAll('.meo-md-html-image .meo-md-image-img').length,
        tableImages: document.querySelectorAll(
          '.meo-md-html-table-cell-preview .meo-md-image-img'
        ).length,
        sources: Array.from(document.querySelectorAll<HTMLImageElement>('.meo-md-image-img'))
          .map((image) => image.getAttribute('src') ?? '')
      };

      const lateModeTable = '| Media |\n| --- |\n| ![table](late-mode-table.png) |';
      editor.setText(lateModeTable);
      editor.view.dispatch({ selection: { anchor: lateModeTable.indexOf('![table]') } });
      await settle();
      const detachedTableImage = document.querySelector<HTMLElement>(
        '.meo-md-html-table-cell-preview .meo-md-image'
      );
      if (!detachedTableImage?.classList.contains('meo-md-image-fallback')) {
        throw new Error('pending table image fallback was not mounted before Widget destruction');
      }
      const detachedTableHtmlBefore = detachedTableImage?.innerHTML ?? '';
      editor.setMode('source');
      await settle();
      const resolveLateModeTable = pending.get('late-mode-table.png');
      if (!resolveLateModeTable) throw new Error('pending table image resolution was not started');
      resolveLateModeTable(svg('late-mode-table', '#a66'));
      await settle();
      const detachedTableHtmlAfter = detachedTableImage?.innerHTML ?? '';

      editor.setMode('live');
      await settle();
      editor.setText('![destroy](late-destroy.png)');
      await settle();
      const resolveLateDestroy = pending.get('late-destroy.png');
      if (!resolveLateDestroy) throw new Error('pending image resolution was not started before Editor destroy');
      editor.destroy();
      resolveLateDestroy(svg('late-destroy', '#6a6'));
      await settle();

      return {
        initialFallbacks,
        afterExternal,
        sourceVisibleImages,
        afterModeRoundTrip,
        embedded,
        detachedTableImageStable: (
          detachedTableHtmlBefore === detachedTableHtmlAfter
          && !detachedTableHtmlAfter.includes('meo-md-image-img')
        ),
        editorDomAfterDestroy: document.querySelectorAll('.cm-editor').length,
        imageDomAfterDestroy: document.querySelectorAll('.meo-md-image-img').length
      };
    });

    assert.equal(result.initialFallbacks, 1, 'unresolved image should expose the Markdown fallback');
    assert.equal(result.afterExternal.text, 'before\n![new](new.png) ![new again](new.png)\n![missing](missing.png)\nafter');
    assert.equal(result.afterExternal.images.length, 2, 'external presentation should expose only the new images');
    assert.equal(result.afterExternal.images.some((src) => src.includes('late-old')), false);
    assert.deepEqual(result.afterExternal.fallbacks, ['![missing](missing.png)']);
    assert.equal(result.afterExternal.controls, 2, 'each loaded image should retain its Widget-owned controls');
    assert.equal(result.afterExternal.sharedResolutionCount, 1, 'same-source widgets should share resource resolution');
    assert.equal(result.sourceVisibleImages, 0, 'Source mode should not expose rendered image widgets');
    assert.deepEqual(result.afterModeRoundTrip, {
      text: 'before\n![new](new.png) ![new again](new.png)\n![missing](missing.png)\nafter',
      imageCount: 2,
      fallbackCount: 1
    });
    assert.equal(result.embedded.htmlImages, 1, 'HTML image should use the production presentation factory');
    assert.equal(result.embedded.tableImages, 1, 'table image should use the production presentation factory');
    assert.equal(result.embedded.sources.some((src) => src.includes('late-')), false);
    assert.equal(
      result.detachedTableImageStable,
      true,
      'destroyed table Widgets must reject late nested image projection'
    );
    assert.equal(result.editorDomAfterDestroy, 0);
    assert.equal(result.imageDomAfterDestroy, 0, 'late image completion must not recreate visible DOM after destroy');
    console.log('image presentation production characterization passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
