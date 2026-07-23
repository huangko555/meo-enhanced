import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';
import { defaultThemeSettings } from '../src/shared/themeDefaults';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-git-blame-toggle-'));

async function waitForFrames(page: Page, count = 4): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-webview-viewport-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 500, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><body><div id="app" class="editor-root">
      <div class="mode-toolbar meo-preload-toolbar"></div>
      <div class="editor-wrapper meo-preload-editor-shell"><div class="editor-host"></div></div>
    </div></body>`);
    await page.addStyleTag({ content: 'html,body,#app{height:100%;margin:0} #app{display:flex;flex-direction:column}' });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ content: `
      window.__hostMessages = [];
      window.acquireVsCodeApi = () => ({
        postMessage(message) { window.__hostMessages.push(message); },
        getState() { return undefined; },
        setState() {}
      });
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate((theme) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', text: 'first\nsecond', version: 1, diagnostics: [], mode: 'source',
        lineNumbers: true, gitChangesGutter: true, gitBlameEnabled: false,
        gitDiffLineHighlights: false, diffBaselineMode: 'current-edit', fixedBaselineActive: false,
        spellCheckEnabled: false, contentMaxWidthEnabled: false,
        vimMode: false, vimKeybindings: [], vimLeader: '\\',
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
        theme, shikiCodeBlocks: false, codeTheme: null
      }}));
    }, defaultThemeSettings);
    await page.waitForSelector('.editor-host > .cm-editor');
    await waitForFrames(page, 8);

    const fixedBaselineButton = await page.$('[data-action="fixedBaseline"]');
    if (!fixedBaselineButton) throw new Error('Toolbar did not contain the fixed baseline toggle');
    const initialFixedState = await fixedBaselineButton.evaluate((button) => ({
      pressed: button.getAttribute('aria-pressed'),
      title: button.getAttribute('title')
    }));
    if (initialFixedState.pressed !== 'false' || initialFixedState.title !== 'Pin Latest Saved Version as Baseline') {
      throw new Error(`Fixed baseline toggle did not default off: ${JSON.stringify(initialFixedState)}`);
    }
    await fixedBaselineButton.click();
    const pinMessage = await page.evaluate(() => (window as any).__hostMessages.find((message: any) => message.type === 'setFixedBaseline'));
    if (!pinMessage || pinMessage.enabled !== true) throw new Error('Fixed baseline toggle did not request pinning');
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'fixedBaselineChanged', active: true } }));
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'diffBaselineModeChanged', mode: 'git-head' }
      }));
    });
    await page.click('[aria-label="More tools"]');
    const pinnedUi = await page.evaluate(() => ({
      pressed: document.querySelector('[data-action="fixedBaseline"]')?.getAttribute('aria-pressed'),
      title: document.querySelector('[data-action="fixedBaseline"]')?.getAttribute('title'),
      modesDisabled: Array.from(document.querySelectorAll<HTMLButtonElement>('.changes-baseline-option'))
        .every((button) => button.disabled),
      activeMode: document.querySelector('.changes-baseline-option.is-active')?.getAttribute('data-baseline-mode')
    }));
    await page.click('[aria-label="More tools"]');
    if (pinnedUi.pressed !== 'true' || pinnedUi.title !== 'Release Fixed Baseline'
      || !pinnedUi.modesDisabled || pinnedUi.activeMode !== 'current-edit') {
      throw new Error(`Fixed baseline active UI was incorrect: ${JSON.stringify(pinnedUi)}`);
    }
    await fixedBaselineButton.click();
    const releaseMessage = await page.evaluate(() => (window as any).__hostMessages
      .filter((message: any) => message.type === 'setFixedBaseline').at(-1));
    if (!releaseMessage || releaseMessage.enabled !== false) throw new Error('Fixed baseline toggle did not request release');
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'fixedBaselineChanged', active: false } }));
    });

    const closedMoreAppearance = await page.$eval('[aria-label="More tools"]', (button) => {
      const reference = document.createElement('span');
      reference.style.color = 'var(--vscode-editor-foreground)';
      document.body.appendChild(reference);
      const appearance = {
        color: getComputedStyle(button).color,
        opacity: getComputedStyle(button).opacity,
        foreground: getComputedStyle(reference).color
      };
      reference.remove();
      return appearance;
    });
    await page.click('[aria-label="More tools"]');
    const openMoreAppearance = await page.$eval('[aria-label="More tools"]', (button) => ({
      color: getComputedStyle(button).color,
      opacity: getComputedStyle(button).opacity
    }));
    await page.click('[aria-label="More tools"]');
    if (
      closedMoreAppearance.opacity !== '1' ||
      openMoreAppearance.opacity !== '1' ||
      closedMoreAppearance.color !== closedMoreAppearance.foreground ||
      openMoreAppearance.color !== closedMoreAppearance.foreground
    ) {
      throw new Error(`More button did not keep the toolbar foreground: ${JSON.stringify({ closedMoreAppearance, openMoreAppearance })}`);
    }

    const blameButton = await page.$('[data-action="gitBlame"]');
    if (!blameButton) throw new Error('More tools did not contain the line author toggle');
    const initialButtonState = await blameButton.evaluate((button) => ({
      checked: button.getAttribute('aria-checked'),
      insideMore: Boolean(button.closest('.more-tools-panel'))
    }));
    if (initialButtonState.checked !== 'false' || !initialButtonState.insideMore) {
      throw new Error(`Line author toggle did not default off inside More: ${JSON.stringify(initialButtonState)}`);
    }

    const hoverPoint = await page.evaluate(() => {
      const gutter = document.querySelector<HTMLElement>('.cm-gutter.meo-git-gutter')!;
      const line = document.querySelector<HTMLElement>('.cm-content .cm-line')!;
      const gutterRect = gutter.getBoundingClientRect();
      const lineRect = line.getBoundingClientRect();
      return { x: gutterRect.left + 1, y: (lineRect.top + lineRect.bottom) / 2 };
    });
    await page.mouse.move(hoverPoint.x, hoverPoint.y);
    await waitForFrames(page, 2);
    const disabledRequests = await page.evaluate(() => (window as any).__hostMessages.filter((message: any) => message.type === 'requestGitBlame').length);
    if (disabledRequests !== 0) throw new Error('Disabled line authors still requested Git blame');

    await page.click('[aria-label="More tools"]');
    await blameButton.click();
    await page.click('[aria-label="More tools"]');
    const enabledState = await blameButton.evaluate((button) => button.getAttribute('aria-checked'));
    if (enabledState !== 'true') throw new Error('Line author toggle did not become enabled');
    const settingMessage = await page.evaluate(() => (window as any).__hostMessages.find((message: any) => message.type === 'setGitBlame'));
    if (!settingMessage || settingMessage.enabled !== true) throw new Error('Enabling line authors did not persist the setting');

    await page.mouse.move(hoverPoint.x + 100, hoverPoint.y);
    await page.mouse.move(hoverPoint.x, hoverPoint.y);
    await page.waitForFunction(() => (window as any).__hostMessages.some((message: any) => message.type === 'requestGitBlame'));
    const request = await page.evaluate(() => (window as any).__hostMessages.find((message: any) => message.type === 'requestGitBlame'));
    await page.evaluate((message) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'gitBlameResult', requestId: message.requestId, lineNumber: message.lineNumber,
        localEditGeneration: message.localEditGeneration,
        result: { kind: 'commit', commit: '1234567890abcdef', shortCommit: '12345678', author: 'Example Author', authorTimeUnix: 1_700_000_000, summary: 'Example commit' }
      }}));
    }, request);
    await page.waitForFunction(() => document.querySelector('.meo-git-blame-tooltip')?.textContent?.includes('Example Author'));

    await page.click('[aria-label="More tools"]');
    await blameButton.click();
    const disabledState = await blameButton.evaluate((button) => button.getAttribute('aria-checked'));
    const tooltipHidden = await page.$eval('.meo-git-blame-tooltip', (tooltip) => (tooltip as HTMLElement).hidden);
    if (disabledState !== 'false' || !tooltipHidden) throw new Error('Disabling line authors did not immediately hide the tooltip');
    await page.evaluate(() => { (window as any).__hostMessages = []; });
    await page.mouse.move(hoverPoint.x + 100, hoverPoint.y);
    await page.mouse.move(hoverPoint.x, hoverPoint.y);
    await waitForFrames(page, 2);
    const requestsAfterDisable = await page.evaluate(() => (window as any).__hostMessages.filter((message: any) => message.type === 'requestGitBlame').length);
    if (requestsAfterDisable !== 0) throw new Error('Disabling line authors did not stop later Git blame requests');

    console.log('git blame toggle checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
