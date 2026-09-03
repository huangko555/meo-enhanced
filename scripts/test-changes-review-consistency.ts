import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-changes-review-consistency-'));

async function waitForFrames(page: Page, count = 4): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function assertCountsMatchMarkers(page: Page, label: string): Promise<void> {
  const projection = await page.evaluate(() => ({
    counts: document.querySelector('.changes-review-trigger .changes-review-counts')?.textContent,
    markers: document.querySelectorAll('.meo-git-gutter-marker.is-modified').length
  }));
  if (projection.counts !== '+1−1' || projection.markers !== 1) {
    throw new Error(`${label} desynchronized counts and markers: ${JSON.stringify(projection)}`);
  }
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
    await page.setViewport({ width: 900, height: 520, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><body class="vscode-dark"><div id="app" class="editor-root">
      <div class="mode-toolbar meo-preload-toolbar" role="presentation" aria-hidden="true"></div>
      <div class="editor-wrapper meo-preload-editor-shell" role="presentation" aria-hidden="true">
        <div class="editor-host"></div>
      </div>
    </div></body>`);
    await page.addStyleTag({
      content: ':root{--vscode-editor-background:#24292e;--vscode-editor-foreground:#e6edf3;--vscode-sideBar-background:#1f2428;--vscode-panel-border:#474b50;--vscode-toolbar-hoverBackground:#343b43}html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}'
    });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ content: `
      window.__hostMessages = [];
      window.acquireVsCodeApi = () => ({
        postMessage(message) { window.__hostMessages.push(message); },
        getState() { return window.__webviewState; },
        setState(state) { window.__webviewState = state; }
      });
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const currentText = 'first\nnew value\nlast';
    const baselineText = 'first\nold value\nlast';
    await page.evaluate((text) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', documentId: 'file:///changes.md', text, version: 1,
        savedRevision: { version: 1, text }, diagnostics: [], mode: 'source',
        uiLanguage: 'zh-CN', sourceLineNumbers: 'on', previewAppearance: 'dark',
        previewFontFamily: '', previewSourceColoring: true, editorAppearance: 'dark',
        editorFontSizeMode: 'auto', editorFontSize: 14,
        gitChangesGutter: true, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
        diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
        contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null
      }}));
    }, currentText);
    await page.waitForSelector('.editor-host > .cm-editor');

    await page.evaluate((baseText) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'gitBaselineChanged', version: 1,
        payload: {
          available: true, tracked: true, mode: 'current-edit', generation: 1, baseText
        }
      }}));
    }, baselineText);
    await waitForFrames(page);
    await assertCountsMatchMarkers(page, 'Current disk baseline');

    await page.evaluate((baseText) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'diffBaselineModeChanged', mode: 'recent-save'
      }}));
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'gitBaselineChanged', version: 1,
        payload: {
          available: true, tracked: true, mode: 'recent-save', generation: 2, baseText
        }
      }}));
    }, baselineText);
    await waitForFrames(page);
    await assertCountsMatchMarkers(page, 'Before Agent edits baseline');

    await page.evaluate((baseText) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'diffBaselineModeChanged', mode: 'git-head'
      }}));
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'gitBaselineChanged', version: 1,
        payload: {
          available: true, tracked: true, mode: 'git-head', generation: 3,
          headOid: 'abc123', baseText
        }
      }}));
    }, baselineText);
    await waitForFrames(page);
    await assertCountsMatchMarkers(page, 'Git HEAD baseline');

    await page.evaluate((baseText) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'fixedBaselineChanged', pinned: true, active: true, updatedAt: 1_000
      }}));
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'gitBaselineChanged', version: 1,
        payload: {
          available: true, tracked: true, mode: 'fixed', generation: 4, baseText
        }
      }}));
    }, baselineText);
    await waitForFrames(page);
    await assertCountsMatchMarkers(page, 'Manual snapshot baseline');

    await page.click('.changes-review-trigger');
    const changesMenuGeometry = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('.changes-review-panel')!;
      const header = panel.querySelector<HTMLElement>('.changes-review-header')!;
      const displaySection = panel.querySelectorAll<HTMLElement>('.changes-review-section')[1]!;
      const panelRect = panel.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      const sectionRect = displaySection.getBoundingClientRect();
      const headerDivider = getComputedStyle(header, '::after');
      const sectionDivider = getComputedStyle(displaySection, '::before');
      const children = Array.from(header.children, (child) => child.getBoundingClientRect());
      const contentTop = Math.min(...children.map((rect) => rect.top));
      const contentBottom = Math.max(...children.map((rect) => rect.bottom));
      return {
        panelLeft: panelRect.left,
        panelRight: panelRect.right,
        headerDividerLeft: headerRect.left + (Number.parseFloat(headerDivider.left) || 0),
        headerDividerRight: headerRect.right - (Number.parseFloat(headerDivider.right) || 0),
        sectionDividerLeft: sectionRect.left + (Number.parseFloat(sectionDivider.left) || 0),
        sectionDividerRight: sectionRect.right - (Number.parseFloat(sectionDivider.right) || 0),
        headerContentCenterOffset: (contentTop + contentBottom) / 2 - (headerRect.top + headerRect.height / 2)
      };
    });
    await page.click('.changes-review-trigger');
    await page.click('.more-tools-wrapper > button');
    const settingsMenuGeometry = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('.more-tools-panel')!;
      const separator = panel.querySelector<HTMLElement>('.more-tools-separator')!;
      const panelRect = panel.getBoundingClientRect();
      const separatorRect = separator.getBoundingClientRect();
      return {
        leftInset: separatorRect.left - panelRect.left,
        rightInset: panelRect.right - separatorRect.right
      };
    });
    const expectedLeft = changesMenuGeometry.panelLeft + settingsMenuGeometry.leftInset;
    const expectedRight = changesMenuGeometry.panelRight - settingsMenuGeometry.rightInset;
    if (
      Math.abs(changesMenuGeometry.headerDividerLeft - expectedLeft) > 0.5 ||
      Math.abs(changesMenuGeometry.headerDividerRight - expectedRight) > 0.5 ||
      Math.abs(changesMenuGeometry.sectionDividerLeft - expectedLeft) > 0.5 ||
      Math.abs(changesMenuGeometry.sectionDividerRight - expectedRight) > 0.5 ||
      Math.abs(changesMenuGeometry.headerContentCenterOffset + 1) > 0.25
    ) {
      throw new Error(`Changes menu alignment did not match Settings: ${JSON.stringify({
        changesMenuGeometry,
        settingsMenuGeometry
      })}`);
    }

    console.log('changes review consistency checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
