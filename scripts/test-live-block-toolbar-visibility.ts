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
      '.meo-latex-math-toolbar'
    ];
    await page.waitForFunction((selectors) => selectors.every((selector) => (
      document.querySelector(`${selector} .meo-copy-code-btn`)
    )), {}, toolbarSelectors);

    await page.waitForFunction(() => (
      document.querySelectorAll('.meo-rendered-block-preview-actions .meo-visual-control-btn').length === 8
    ));

    for (const appearance of ['light', 'dark'] as const) {
      await page.evaluate((theme) => {
        const style = document.documentElement.style;
        document.documentElement.dataset.editorAppearance = theme;
        style.setProperty('--meo-background', theme === 'light' ? '#ffffff' : '#24292e');
        style.setProperty('--meo-foreground', theme === 'light' ? '#24292e' : '#e6edf3');
        style.setProperty('--meo-code-background', theme === 'light' ? '#f6f8fa' : '#292d31');
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
          document.querySelector(toolbarSelector)?.classList.contains('is-block-hovered') === true
        ), {}, selector);
        const buttons = await page.$$(`${selector} :is(button, [role="button"])`);
        assert.equal(buttons.length, selector === '.meo-code-block-actions' ? 2 : 7);
        const gaps = await page.evaluate((toolbarSelector) => {
          const rects = Array.from(document.querySelectorAll(`${toolbarSelector} :is(button, [role="button"])`),
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
    for (const selector of toolbarSelectors.slice(1)) {
      const layout = await page.$$eval(`${selector} button, ${selector} [role="button"]`, (buttons) => (
        buttons.map(button => ({ label: button.getAttribute('aria-label'), y: button.getBoundingClientRect().top }))
      ));
      assert.deepEqual(layout.map(button => button.label), [
        'Zoom in', 'Zoom out', 'Reset zoom', 'Fullscreen',
        'Switch to split view', 'Select all code', 'Copy code'
      ]);
      assert.equal(new Set(layout.map(button => button.y)).size, 1, `${selector} preview controls stayed on a second row`);
      const separator = await page.$eval(selector, toolbar => {
        const group = toolbar.querySelector<HTMLElement>('.meo-rendered-block-preview-actions')!;
        const line = getComputedStyle(group, '::after');
        const right = group.getBoundingClientRect().right - Number.parseFloat(line.right);
        const left = right - Number.parseFloat(line.width);
        const buttons = group.querySelectorAll('button');
        const previous = buttons[buttons.length - 1].getBoundingClientRect();
        const next = toolbar.querySelector(':scope > button')!.getBoundingClientRect();
        return { left: left - previous.right, right: next.left - right, height: group.clientHeight - Number.parseFloat(line.top) - Number.parseFloat(line.bottom) };
      });
      assert.equal(separator.left, separator.right, `${selector} separator was off-center`);
      assert.equal(separator.height, 12);

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
      await page.click(`${selector} [aria-label="Zoom in"]`);
      assert.notDeepEqual(await collectScale(), initialScale, `${selector} moved zoom control no longer changes the preview`);
      await page.click(`${selector} [aria-label="Reset zoom"]`);
      assert.deepEqual(await collectScale(), initialScale);
      await page.keyboard.press('Tab');
      await page.$eval(`${selector} [aria-label="Zoom in"]`, element => (element as HTMLElement).focus());
      await page.keyboard.press('Enter');
      assert.notDeepEqual(await collectScale(), initialScale, `${selector} keyboard zoom did not activate`);
      await page.click(`${selector} [aria-label="Reset zoom"]`);
      await page.click(`${selector} [aria-label="Fullscreen"]`);
      const fullscreenSelector = selector === '.meo-mermaid-toolbar' ? '.meo-mermaid-fullscreen-scrim' : '.meo-latex-math-fullscreen-scrim';
      await page.waitForSelector(fullscreenSelector);
      await page.keyboard.press('Escape');
      await page.waitForSelector(fullscreenSelector, { hidden: true });

      await page.$eval('#app', element => (element as HTMLElement).style.width = '240px');
      await page.waitForFunction(selector => document.querySelector(`${selector} details`)?.classList.contains('is-collapsed'), {}, selector);
      const beforeMenuPositions = await page.$$eval(`${selector} > :is(button, [role="button"])`, buttons => buttons.map(button => button.getBoundingClientRect().left));
      await page.keyboard.press('Tab');
      await page.$eval(`${selector} summary`, element => (element as HTMLElement).focus());
      await page.keyboard.press('Enter');
      await page.waitForFunction(selector => (document.querySelector(`${selector} details`) as HTMLDetailsElement)?.open, {}, selector);
      const afterMenuPositions = await page.$$eval(`${selector} > :is(button, [role="button"])`, buttons => buttons.map(button => button.getBoundingClientRect().left));
      assert.deepEqual(afterMenuPositions, beforeMenuPositions, `${selector} opening preview actions shifted the original buttons`);
      const hits = await page.$$eval(`${selector} .meo-visual-control-btn`, buttons => buttons.map(button => {
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return hit === button || button.contains(hit);
      }));
      assert.ok(hits.every(Boolean), `${selector} narrow preview controls were clipped`);
      await page.keyboard.press('Tab');
      const beforeNarrowZoom = await collectScale();
      await page.keyboard.press('Enter');
      assert.notDeepEqual(await collectScale(), beforeNarrowZoom);
      await page.keyboard.press('Escape');
      assert.equal(await page.$eval(`${selector} details`, element => (element as HTMLDetailsElement).open), false);
      await page.$eval('#app', element => (element as HTMLElement).style.width = '800px');
      await page.waitForFunction(selector => !document.querySelector(`${selector} details`)?.classList.contains('is-collapsed'), {}, selector);

      const modeSelector = selector === '.meo-mermaid-toolbar' ? '.meo-mermaid-mode-btn' : '.meo-latex-math-mode-btn';
      const editingSelector = selector === '.meo-mermaid-toolbar' ? '.meo-mermaid-editing-block' : '.meo-latex-math-editing-block';
      await page.click(modeSelector);
      await page.waitForSelector(`${editingSelector}.is-split`);
      await page.waitForFunction(selector => document.querySelectorAll(`${selector} .meo-visual-control-btn`).length === 4, {}, selector);
      await page.$eval(modeSelector, element => (element as HTMLElement).focus());
      await page.keyboard.press('Enter');
      await page.waitForSelector(`${editingSelector}.is-source`);
      await page.waitForFunction(selector => !document.querySelector(`${selector} .meo-rendered-block-preview-actions`), {}, selector);
      await page.$eval(modeSelector, element => (element as HTMLElement).focus());
      await page.keyboard.press('Enter');
      await page.waitForFunction(selector => document.querySelectorAll(`${selector} .meo-visual-control-btn`).length === 4, {}, selector);
    }
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(950, 680);

    for (const selector of toolbarSelectors) {
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
        document.querySelector(toolbarSelector)?.classList.contains('is-block-hovered') === true
      ), {}, selector);
      await page.click(`${selector} .meo-copy-code-btn`);
      await page.waitForFunction((toolbarSelector) => (
        document.querySelector(`${toolbarSelector} .meo-copy-code-btn`)?.classList.contains('copied') === true
      ), {}, selector);
      await page.mouse.move(950, 680);
      await page.waitForFunction((toolbarSelector) => (
        document.querySelector(toolbarSelector)?.classList.contains('is-block-hovered') === false
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

    for (const selector of toolbarSelectors) {
      await page.evaluate((toolbarSelector) => {
        const toolbar = document.querySelector<HTMLElement>(toolbarSelector)!;
        // Move to Copy with a real Tab event instead of inheriting the focus
        // modality of whichever control the earlier pointer checks left behind.
        toolbar.querySelector<HTMLElement>('.meo-select-all-code-btn')!.focus();
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
