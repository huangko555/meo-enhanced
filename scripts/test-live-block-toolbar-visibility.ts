import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-live-block-toolbar-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-long-code-blocks-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 720, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body{margin:0}#app{width:800px;height:600px}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#24292e;--meo-foreground:#e6edf3;--meo-code-background:#292d31;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--meo-semantic-mutedForeground:#8b949e;--meo-semantic-codeCopyForeground:#e6edf3;--meo-semantic-codeCopyBackground:#292d31;--meo-semantic-codeCopyHoverForeground:#fff;--meo-semantic-codeCopyHoverBackground:#3a4048;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-line-height:20px}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.addScriptTag({ path: path.join(repoRoot, 'node_modules/mermaid/dist/mermaid.min.js') });
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.resolve() }
      });
      const text = [
        '```js',
        'const answer = 42;',
        '```',
        '',
        '```mermaid',
        'graph TD',
        'A-->B',
        '```',
        '',
        '$$',
        'x^2',
        '$$'
      ].join('\n');
      (window as any).__toolbarVisibilityEditor = (window as any).LongCodeBlocksHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    });

    const toolbarSelectors = [
      '.meo-code-block-actions',
      '.meo-mermaid-toolbar',
      '.meo-mermaid-preview-controls',
      '.meo-math-copy-actions'
    ];
    await page.waitForFunction((selectors) => selectors.filter(selector => selector !== '.meo-mermaid-preview-controls').every((selector) => (
      document.querySelector(`${selector} .meo-copy-code-btn`)
    )), {}, toolbarSelectors);

    await page.waitForFunction(() => (
      document.querySelectorAll('.meo-mermaid-preview-controls .meo-visual-control-btn').length === 4
      && !document.querySelector('[data-meo-mermaid-rendering="true"]')
    ));

    const settleMode = () => page.evaluate(async () => {
      for (let i = 0; i < 8; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
    const modeButton = '.meo-mermaid-toolbar .meo-mermaid-mode-btn';
    const readModeFocus = () => page.$eval(modeButton, button => {
      const style = getComputedStyle(button);
      return { focused: document.activeElement === button, visible: button.matches(':focus-visible'),
        shadow: style.boxShadow, outline: style.outlineStyle };
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      // Edit and Finish form one toggle; test keyboard focus from its stable reading state.
      await page.click(modeButton); await settleMode();
      await page.click(modeButton); await settleMode();
      const pointer = await readModeFocus();
      assert.equal(pointer.shadow, 'none', 'Mouse source-to-preview switch must not paint a focus ring: ' + JSON.stringify(pointer));
      assert.equal(pointer.outline, 'none', 'Mouse source-to-preview switch must not paint an outline');
      if (cycle === 0) {
        fs.mkdirSync(path.join(repoRoot, '.local', 'probes', 'mermaid-mode-focus'), { recursive: true });
        await (await page.$(modeButton))!.screenshot({ path: path.join(repoRoot, '.local', 'probes', 'mermaid-mode-focus', 'pointer.png') });
      }
      await page.keyboard.press('Tab');
      await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
      const keyboard = await readModeFocus();
      assert.ok(keyboard.focused && keyboard.visible, 'Keyboard return still exposes the mode button focus');
      assert.ok(keyboard.shadow !== 'none' || keyboard.outline !== 'none', 'Keyboard mode focus remains visible');
    }
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    if (process.argv.includes('--mode-focus-only')) {
      console.log('Mermaid mode pointer/keyboard focus checks passed'); return;
    }

    if (await page.$eval('.meo-mermaid-toolbar', node => node.getAttribute('data-meo-mermaid-mode') === 'edit')) { await page.click(modeButton); await settleMode(); }
    for (const appearance of ['light', 'dark'] as const) {
      await page.evaluate((theme) => {
        const style = document.documentElement.style;
        document.documentElement.dataset.editorAppearance = theme;
        style.setProperty('--meo-background', theme === 'light' ? '#ffffff' : '#24292e');
        style.setProperty('--meo-foreground', theme === 'light' ? '#24292e' : '#e6edf3');
        style.setProperty('--meo-code-background', theme === 'light' ? '#f6f8fa' : '#292d31');
        // This fixture owns its explicit palette, including the resolved action role.
        style.setProperty('--meo-code-action-hover-foreground', theme === 'light' ? '#000000' : '#ffffff');
        style.setProperty('--meo-semantic-codeCopyBackground', theme === 'light' ? '#f6f8fa' : '#292d31');
        style.setProperty('--meo-semantic-codeCopyHoverBackground', theme === 'light' ? '#eaeef2' : '#3a4048');
      }, appearance);
      for (const selector of toolbarSelectors) {
        const hoverPoint = await page.evaluate((toolbarSelector) => {
          const toolbar = document.querySelector<HTMLElement>(toolbarSelector)!;
          const block = toolbar.closest<HTMLElement>('.meo-rendered-block-preview')
            ?? toolbar.closest<HTMLElement>('.cm-line') ?? toolbar.parentElement!;
          const rect = block.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }, selector);
        await page.mouse.move(hoverPoint.x, hoverPoint.y);
        await page.waitForFunction((toolbarSelector) => (
          getComputedStyle(document.querySelector(toolbarSelector)!).opacity === '1'
        ), {}, selector);
        const buttons = await page.$$(`${selector} :is(button, [role="button"]):not([hidden])`);
        assert.equal(buttons.length, selector === '.meo-mermaid-toolbar' ? 3 : selector === '.meo-mermaid-preview-controls' ? 4 : 2);
        const gaps = await page.evaluate((toolbarSelector) => {
          const rects = Array.from(document.querySelectorAll(`${toolbarSelector} :is(button, [role="button"]):not([hidden])`),
            (button) => button.getBoundingClientRect());
          return rects.slice(0, -1).map((rect, index) => ({
            x: (rect.right + rects[index + 1].left) / 2, y: rect.top + rect.height / 2
          }));
        }, selector);
        for (const gap of gaps) {
          await page.mouse.move(gap.x, gap.y);
          const cursor = await page.evaluate(({ x, y }) => {
            const target = document.elementFromPoint(x, y)!;
            return getComputedStyle(target).cursor;
          }, gap);
          assert.equal(cursor, 'default', `${selector} button gap showed a text cursor`);
        }
        for (const button of buttons) {
          await button.hover();
          await new Promise((resolve) => setTimeout(resolve, 150));
          const state = await button.evaluate((element) => ({
            label: element.getAttribute('aria-label'),
            hovered: element.matches(':hover'),
            color: getComputedStyle(element).color,
            cursor: getComputedStyle(element).cursor,
            iconCursor: getComputedStyle(element.querySelector('svg')!).cursor
          }));
          assert.equal(state.hovered, true, `${selector} pointer missed ${state.label}`);
          assert.equal(state.color, appearance === 'light' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)');
          assert.equal(state.cursor, 'pointer', `${selector} ${state.label} lost its button cursor`);
          assert.equal(state.iconCursor, 'pointer', `${selector} ${state.label} icon showed a text cursor`);
          const clip = await button.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height };
          });
          // Element screenshots scroll their target again, which can move it
          // away from the pointer after the hover assertions have passed.
          const screenshot = await page.screenshot({ encoding: 'base64', clip, captureBeyondViewport: false });
          assert.equal(await button.evaluate((element) => element.matches(':hover')), true,
            `${selector} ${state.label} lost hover while capturing its background`);
          const backgroundPixel = await page.evaluate(async (png) => {
            const image = new Image();
            image.src = 'data:image/png;base64,' + png;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width; canvas.height = image.height;
            const context = canvas.getContext('2d')!;
            context.drawImage(image, 0, 0);
            // The middle of the left inset is inside the surface and outside the icon.
            return Array.from(context.getImageData(2, Math.floor(image.height / 2), 1, 1).data).slice(0, 3);
          }, screenshot);
          assert.deepEqual(
            backgroundPixel,
            appearance === 'light' ? [234, 238, 242] : [58, 64, 72],
            `${appearance} ${selector} ${state.label} did not paint its hover background`
          );
        }
      }
    }
    for (const selector of toolbarSelectors.filter(selector => selector === '.meo-mermaid-toolbar')) {
      const layout = await page.$$eval(`${selector} button:not([hidden]), ${selector} [role="button"]:not([hidden])`, (buttons) => (
        buttons.map(button => ({ label: button.getAttribute('aria-label'), y: button.getBoundingClientRect().top }))
      ));
      assert.deepEqual(layout.map(button => button.label), [
        'Edit', 'Copy as image', 'Copy source'
      ]);
      assert.equal(new Set(layout.map(button => button.y)).size, 1, `${selector} preview controls stayed on a second row`);
      const previewSelector = selector === '.meo-mermaid-toolbar' ? '.meo-mermaid-block' : '.meo-latex-math-viewport';
      const collectScale = () => page.$eval(previewSelector, (root) => {
        const target = root.querySelector<HTMLElement>('.meo-mermaid-svg-wrapper, .meo-latex-math-canvas')!;
        const style = getComputedStyle(target);
        const transform = new DOMMatrix(style.transform === 'none' ? undefined : style.transform);
        return { scale: transform.a, x: transform.e, y: transform.f, fontSize: style.fontSize };
      });
      await page.hover(previewSelector);
      await new Promise(resolve => setTimeout(resolve, 150));
      const initialScale = await collectScale();
      await page.click(` .meo-mermaid-preview-controls [aria-label="Zoom in"]`);
      assert.notDeepEqual(await collectScale(), initialScale, `${selector} moved zoom control no longer changes the preview`);
      await page.click('.meo-mermaid-preview-controls [aria-label="Reset zoom"]');
      assert.deepEqual(await collectScale(), initialScale);
      await page.keyboard.press('Tab');
      await page.$eval(` .meo-mermaid-preview-controls [aria-label="Zoom in"]`, element => (element as HTMLElement).focus());
      await page.keyboard.press('Enter');
      assert.notDeepEqual(await collectScale(), initialScale, `${selector} keyboard zoom did not activate`);
      await page.click('.meo-mermaid-preview-controls [aria-label="Reset zoom"]');
      await page.click('.meo-mermaid-preview-controls [aria-label="View fullscreen"]');
      const fullscreenSelector = selector === '.meo-mermaid-toolbar' ? '.meo-mermaid-fullscreen-scrim' : '.meo-latex-math-fullscreen-scrim';
      await page.waitForSelector(fullscreenSelector);
      await page.keyboard.press('Escape');
      await page.waitForSelector(fullscreenSelector, { hidden: true });

      await page.$eval('#app', element => (element as HTMLElement).style.width = '240px');
      await page.waitForSelector(previewSelector);
      await page.locator(previewSelector).hover();
      const narrowControls = '.meo-mermaid-preview-controls';
      await page.waitForSelector(narrowControls);
      const hits = await page.$$eval(`${narrowControls} .meo-visual-control-btn`, buttons => buttons.map(button => {
        const rect = button.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return hit === button || button.contains(hit);
      }));
      assert.equal(hits.length, 4); assert.ok(hits.every(Boolean), 'Narrow Mermaid viewport controls were clipped');
      await page.keyboard.press('Tab'); await page.focus(`${narrowControls} [aria-label="Zoom in"]`);
      const beforeNarrowZoom = await collectScale(); await page.keyboard.press('Enter');
      assert.notDeepEqual(await collectScale(), beforeNarrowZoom);
      await page.$eval('#app', element => (element as HTMLElement).style.width = '800px');

      const modeSelector = selector === '.meo-mermaid-toolbar' ? '.meo-mermaid-mode-btn' : '.meo-latex-math-mode-btn';
      await page.click(modeSelector);
      await page.waitForSelector('.meo-mermaid-toolbar[data-meo-mermaid-mode="edit"]');
      await page.waitForFunction(() => document.querySelectorAll('.meo-mermaid-preview-controls .meo-visual-control-btn').length === 4);
      await page.mouse.move(950, 680);
      assert.equal(await page.$eval('.meo-mermaid-preview-controls', node => getComputedStyle(node).opacity), '1', 'Editing camera controls stay visible without hover');
      await page.$eval(modeSelector, element => (element as HTMLElement).focus());
      await page.keyboard.press('Enter');
      await page.waitForSelector('.meo-mermaid-toolbar[data-meo-mermaid-mode="preview"]');
      await page.waitForFunction(() => document.querySelectorAll('.meo-mermaid-preview-controls .meo-visual-control-btn').length === 4);

    }
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(950, 680);

    for (const selector of toolbarSelectors.filter(selector => selector !== '.meo-mermaid-preview-controls')) {
      const hoverPoint = await page.evaluate((toolbarSelector) => {
        const toolbar = document.querySelector<HTMLElement>(toolbarSelector)!;
        const target = toolbar.closest<HTMLElement>('.meo-rendered-block-preview')
          ?? toolbar.closest<HTMLElement>('.cm-line')
          ?? toolbar.parentElement!;
        const rect = target.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }, selector);
      await page.mouse.move(hoverPoint.x, hoverPoint.y);
      await page.waitForFunction((toolbarSelector) => (
        getComputedStyle(document.querySelector(toolbarSelector)!).opacity === '1'
      ), {}, selector);
      await page.click(`${selector} .meo-copy-code-btn`);
      await page.waitForFunction((toolbarSelector) => (
        document.querySelector(`${toolbarSelector} .meo-copy-code-btn`)?.classList.contains('copied') === true
      ), {}, selector);
      await page.mouse.move(950, 680);
      await page.waitForFunction((toolbarSelector) => (
        getComputedStyle(document.querySelector(toolbarSelector)!).opacity === '0'
      ), {}, selector);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const stateAfterLeave = await page.evaluate((toolbarSelector) => {
        const toolbar = document.querySelector<HTMLElement>(toolbarSelector)!;
        const copy = toolbar.querySelector<HTMLElement>('.meo-copy-code-btn')!;
        return {
          opacity: getComputedStyle(toolbar).opacity,
          hovered: toolbar.classList.contains('is-block-hovered'),
          copyFocused: document.activeElement === copy,
          copied: copy.classList.contains('copied'),
          activeLabel: document.activeElement?.getAttribute('aria-label') ?? null
        };
      }, selector);
      assert.equal(stateAfterLeave.copied, true, `${selector} did not enter the copied state`);
      assert.equal(
        stateAfterLeave.opacity,
        '0',
        `${selector} stayed visible after pointer hover ended: ${JSON.stringify(stateAfterLeave)}`
      );
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    }

    for (const selector of toolbarSelectors.filter(selector => selector !== '.meo-mermaid-preview-controls')) {
      await page.evaluate((toolbarSelector) => {
        const toolbar = document.querySelector<HTMLElement>(toolbarSelector)!;
        // Move to Copy with a real Tab event instead of inheriting the focus
        // modality of whichever control the earlier pointer checks left behind.
        (toolbar.querySelector<HTMLElement>('.meo-copy-image-btn')
          ?? toolbar.querySelector<HTMLElement>('.meo-select-all-code-btn'))!.focus();
      }, selector);
      await page.keyboard.press('Tab');
      await new Promise((resolve) => setTimeout(resolve, 150));
      const keyboardState = await page.evaluate((toolbarSelector) => {
        const toolbar = document.querySelector<HTMLElement>(toolbarSelector)!;
        const copy = toolbar.querySelector<HTMLElement>('.meo-copy-code-btn')!;
        return {
          copyFocused: document.activeElement === copy,
          focusVisible: copy.matches(':focus-visible'),
          opacity: getComputedStyle(toolbar).opacity,
          hovered: toolbar.classList.contains('is-block-hovered')
        };
      }, selector);
      assert.equal(keyboardState.hovered, false, `${selector} keyboard check unexpectedly retained pointer hover`);
      assert.equal(keyboardState.copyFocused, true, `${selector} Tab did not reach Copy`);
      assert.equal(keyboardState.focusVisible, true, `${selector} did not expose keyboard-visible focus`);
      assert.equal(keyboardState.opacity, '1', `${selector} hid its keyboard-focused controls`);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    }
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('Live block toolbar hover, cursor, and visibility checks passed');
}

await main();
