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

    const precedingText = `<a href="./markdown-render-test.md#html-jump-target" title="打开当前文件并跳转">相对文件锚点</a>`;
    const currentText = `first\n${precedingText}\nnew value ${'long-source-path/'.repeat(20)}\nlast`;
    const baselineText = `first\n${precedingText}\nold value ${'old-source-path/'.repeat(20)}\nlast`;
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
        headerContentCenterOffset: (contentTop + contentBottom) / 2
          - (panelRect.top + Number.parseFloat(getComputedStyle(panel).borderTopWidth)
            + headerRect.bottom - Number.parseFloat(headerDivider.height)) / 2,
        headerFont: getComputedStyle(header).fontSize,
        optionFont: getComputedStyle(panel.querySelector('.changes-review-option')!).fontSize
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
      Math.abs(changesMenuGeometry.headerContentCenterOffset) > 0.25 ||
      changesMenuGeometry.headerFont !== changesMenuGeometry.optionFont
    ) {
      throw new Error(`Changes menu alignment did not match Settings: ${JSON.stringify({
        changesMenuGeometry,
        settingsMenuGeometry
      })}`);
    }

    await page.click('.more-tools-wrapper > button');
    await page.click('.changes-review-trigger');
    await page.click('[data-toggle="before-content"]');
    await waitForFrames(page, 4);
    await page.click('[data-baseline="none"]');
    await waitForFrames(page, 4);
    const assertComparisonOff = async () => {
      const projection = await page.evaluate(() => ({
        counts: document.querySelector('.changes-review-trigger .changes-review-counts')?.textContent,
        rows: document.querySelectorAll('.meo-git-diff-original-line, .meo-diff-changed-line, .meo-diff-added-line').length,
        toggleChecked: document.querySelector('[data-toggle="before-content"]')?.getAttribute('aria-checked'),
        toggleDisabled: document.querySelector<HTMLButtonElement>('[data-toggle="before-content"]')?.disabled,
        selected: document.querySelector('[data-baseline="none"]')?.getAttribute('aria-checked')
      }));
      if (projection.counts !== '不比较' || projection.rows || projection.toggleChecked !== 'true'
        || !projection.toggleDisabled || projection.selected !== 'true') {
        throw new Error(`Comparison off did not clear the projection while retaining preferences: ${JSON.stringify(projection)}`);
      }
    };
    await assertComparisonOff();
    await page.evaluate((baseText) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'gitBaselineChanged', version: 1,
        payload: { available: true, tracked: true, mode: 'fixed', generation: 5, baseText }
      }}));
    }, baselineText);
    await waitForFrames(page, 4);
    await assertComparisonOff();
    await page.click('[data-action="select-snapshot"]');
    await page.evaluate((baseText) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'gitBaselineChanged', version: 1,
        payload: { available: true, tracked: true, mode: 'fixed', generation: 6, baseText }
      }}));
    }, baselineText);
    await waitForFrames(page, 4);
    await assertCountsMatchMarkers(page, 'Reenabled snapshot baseline');
    if (await page.$eval('[data-toggle="before-content"]', (button) => (button as HTMLButtonElement).disabled)) {
      throw new Error('Original-content preference did not reactivate with comparison');
    }
    await page.click('.changes-review-trigger');
    await page.setViewport({ width: 1400, height: 520, deviceScaleFactor: 1 });
    await waitForFrames(page, 12);
    await page.click('.more-tools-wrapper > button');
    // Assert each transition, including number-only changes that rewrap the
    // preceding line without resizing the full-width scroll container.
    for (const action of ['contentMaxWidth', 'sourceLineNumbers', 'sourceLineNumbers', 'contentMaxWidth',
      'sourceLineNumbers', 'contentMaxWidth', 'sourceLineNumbers', 'contentMaxWidth', 'contentMaxWidth']) {
      await page.click(`[data-action="${action}"]`);
      await waitForFrames(page, 8);
      const layout = await page.evaluate(() => (['original', 'current'] as const).map((kind) => {
        const row = document.querySelector<HTMLElement>(`.meo-git-diff-${kind}-line`)!.getBoundingClientRect();
        const gutter = document.querySelector<HTMLElement>(`.meo-git-diff-sign-gutter-cell.is-${kind}`)!.getBoundingClientRect();
        return { kind, top: row.top - gutter.top, height: row.height - gutter.height };
      }));
      if (layout.some((row) => Math.abs(row.top) > 1 || Math.abs(row.height) > 1)) {
        throw new Error(`Settings ${action} toggle left stale diff gutter heights: ${JSON.stringify(layout)}`);
      }
    }

    console.log('changes review consistency checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
