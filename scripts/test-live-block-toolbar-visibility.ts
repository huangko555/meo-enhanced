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

    await page.keyboard.press('Tab');
    for (const selector of toolbarSelectors) {
      await page.evaluate((toolbarSelector) => {
        const toolbar = document.querySelector<HTMLElement>(toolbarSelector)!;
        const copy = toolbar.querySelector<HTMLElement>('.meo-copy-code-btn')!;
        copy.focus();
      }, selector);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const keyboardState = await page.evaluate((toolbarSelector) => {
        const toolbar = document.querySelector<HTMLElement>(toolbarSelector)!;
        const copy = toolbar.querySelector<HTMLElement>('.meo-copy-code-btn')!;
        return {
          focusVisible: copy.matches(':focus-visible'),
          opacity: getComputedStyle(toolbar).opacity,
          hovered: toolbar.classList.contains('is-block-hovered')
        };
      }, selector);
      assert.equal(keyboardState.hovered, false, `${selector} keyboard check unexpectedly retained pointer hover`);
      assert.equal(keyboardState.focusVisible, true, `${selector} did not expose keyboard-visible focus`);
      assert.equal(keyboardState.opacity, '1', `${selector} hid its keyboard-focused controls`);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    }
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('Live block toolbar pointer visibility checks passed');
}

await main();
