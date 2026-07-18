import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';
import { defaultThemeSettings } from '../src/shared/themeDefaults';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-webview-viewport-'));

async function waitForFrames(page: Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

function createFixture(): string {
  const lines = Array.from({ length: 280 }, (_, index) => `stable line ${index + 1}`);
  lines[77] = '## Short Mermaid';
  lines[78] = '```mermaid';
  lines[79] = 'flowchart LR';
  lines[80] = '  Start --> Done';
  lines[81] = '```';
  lines[108] = '```mermaid';
  lines[109] = 'sequenceDiagram';
  lines[110] = '  User->>Editor: Update';
  lines[111] = '  Editor-->>User: Render';
  lines[112] = '```';
  lines[132] = '```typescript';
  for (let index = 133; index <= 220; index += 1) lines[index] = `const line${index - 132} = ${index - 132};`;
  lines[221] = '```';
  lines[230] = '## Tall Mermaid';
  lines[231] = '```mermaid';
  lines[232] = 'flowchart TD';
  lines[233] = '  Start --> Step18 --> End';
  lines[234] = '```';
  return lines.join('\n');
}

async function main() {
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
    page.on('console', (message) => console.log(message.text()));
    await page.setViewport({ width: 900, height: 520, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><body><div id="app" class="editor-root">
      <div class="mode-toolbar meo-preload-toolbar" role="presentation" aria-hidden="true"></div>
      <div class="editor-wrapper meo-preload-editor-shell" role="presentation" aria-hidden="true">
        <div class="editor-host"></div>
      </div>
    </div></body>`);
    await page.addStyleTag({ content: 'html,body,#app{height:100%;margin:0} #app{display:flex;flex-direction:column}' });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ content: `
      window.__hostMessages = [];
      window.acquireVsCodeApi = () => ({
        postMessage(message) { window.__hostMessages.push(message); },
        getState() { return window.__webviewState; },
        setState(state) { window.__webviewState = state; }
      });
      window.mermaid = {
        initialize() {},
        async render(id, source) {
          await new Promise(resolve => setTimeout(resolve, source.includes('Step18') ? 650 : source.includes('Check') ? 80 : 5));
          const height = source.includes('Step18') ? 3000 : source.includes('sequenceDiagram') ? 260 : 120;
          return { svg: '<svg width="800" height="' + height + '" viewBox="0 0 800 ' + height + '"></svg>' };
        }
      };
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const initialText = createFixture();
    await page.evaluate(({ text, theme }) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', text, version: 1, diagnostics: [], mode: 'live',
        lineNumbers: true, gitChangesGutter: false, gitDiffLineHighlights: false,
        spellCheckEnabled: false, contentMaxWidthEnabled: false,
        vimMode: false, vimKeybindings: [], vimLeader: '\\',
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
        theme, shikiCodeBlocks: false, codeTheme: null,
        restoreTopLine: 139, restoreTopLineOffset: 0
      }}));
    }, { text: initialText, theme: defaultThemeSettings });
    await page.waitForSelector('.editor-host > .cm-editor');
    await new Promise((resolve) => setTimeout(resolve, 120));
    await waitForFrames(page);
    const toolbarLayout = await page.evaluate(() => {
      const label = (element: HTMLElement): string => {
        if (element.dataset.action) return element.dataset.action;
        if (element.classList.contains('line-jump-control')) return 'line-jump';
        if (element.classList.contains('format-separator')) return 'separator';
        if (element.classList.contains('changes-controls')) return 'changes';
        if (element.classList.contains('more-tools-wrapper')) return 'more';
        return element.className;
      };
      return {
        left: Array.from(document.querySelector<HTMLElement>('.format-group')!.children).map(label),
        right: Array.from(document.querySelector<HTMLElement>('.right-group')!.children).map(label)
      };
    });
    if (
      JSON.stringify(toolbarLayout.left.slice(0, 4)) !== JSON.stringify(['outline-left', 'line-jump', 'save', 'separator']) ||
      JSON.stringify(toolbarLayout.right) !== JSON.stringify(['find', 'outline-right', 'changes', 'more'])
    ) {
      throw new Error(`Unexpected toolbar layout: ${JSON.stringify(toolbarLayout)}`);
    }
    await page.click('[aria-label="More tools"]');
    const moreToolsLayout = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('.more-tools-panel')!;
      const options = Array.from(panel.querySelectorAll<HTMLElement>(':scope > .more-tools-option'));
      return {
        labels: options.map((option) => option.querySelector('.more-tools-option-label')?.textContent),
        directChildren: options.every((option) => option.parentElement === panel),
        baselineIcons: options.slice(0, 3).map((option) => option.querySelector('.more-tools-option-icon svg')?.outerHTML),
        exportIcons: options.slice(-2).map((option) => option.querySelector('.more-tools-option-icon svg')?.outerHTML),
        separatorCount: panel.querySelectorAll(':scope > .more-tools-separator').length
      };
    });
    if (
      JSON.stringify(moreToolsLayout.labels) !== JSON.stringify([
        'Current Edits', 'Recent Save', 'Git HEAD',
        'Constrain Width', 'Line Numbers', 'Line Authors', 'Spellcheck',
        'Export HTML', 'Export PDF'
      ]) ||
      !moreToolsLayout.directChildren ||
      moreToolsLayout.separatorCount !== 2 ||
      moreToolsLayout.baselineIcons.some((icon) => !icon) ||
      moreToolsLayout.exportIcons.some((icon) => !icon) ||
      new Set(moreToolsLayout.baselineIcons).size !== 1 ||
      new Set(moreToolsLayout.exportIcons).size !== 1 ||
      moreToolsLayout.baselineIcons[0] === moreToolsLayout.exportIcons[0]
    ) {
      throw new Error(`Unexpected flat More tools layout: ${JSON.stringify(moreToolsLayout)}`);
    }
    await page.click('[aria-label="More tools"]');
    const measureToolbarStart = () => page.evaluate(() => {
      const toolbar = document.querySelector<HTMLElement>('.mode-toolbar')!;
      const firstButton = document.querySelector<HTMLElement>('.format-group > .format-button')!;
      return {
        paddingLeft: Number.parseFloat(getComputedStyle(toolbar).paddingLeft),
        firstButtonOffset: firstButton.getBoundingClientRect().left - toolbar.getBoundingClientRect().left
      };
    });
    const initialToolbarStart = await measureToolbarStart();
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'lineNumbersChanged', enabled: false } }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'contentMaxWidthChanged', enabled: true } }));
    });
    await waitForFrames(page);
    const toggledToolbarStart = await measureToolbarStart();
    const constrainedWidthState = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('[data-action="contentMaxWidth"]')!;
      return {
        active: button.classList.contains('is-active'),
        checked: button.getAttribute('aria-checked'),
        widthOverride: document.documentElement.style.getPropertyValue('--meo-content-max-width')
      };
    });
    if (
      initialToolbarStart.paddingLeft !== 10 ||
      Math.abs(initialToolbarStart.firstButtonOffset - 10) > 0.5 ||
      toggledToolbarStart.paddingLeft !== 10 ||
      Math.abs(toggledToolbarStart.firstButtonOffset - 10) > 0.5 ||
      !constrainedWidthState.active ||
      constrainedWidthState.checked !== 'true' ||
      constrainedWidthState.widthOverride !== '800px'
    ) {
      throw new Error(`Toolbar settings did not update as expected: ${JSON.stringify({ initialToolbarStart, toggledToolbarStart, constrainedWidthState })}`);
    }
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'lineNumbersChanged', enabled: true } }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'contentMaxWidthChanged', enabled: false } }));
    });
    await waitForFrames(page);
    const unconstrainedWidthState = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('[data-action="contentMaxWidth"]')!;
      return {
        active: button.classList.contains('is-active'),
        checked: button.getAttribute('aria-checked'),
        widthOverride: document.documentElement.style.getPropertyValue('--meo-content-max-width')
      };
    });
    if (
      unconstrainedWidthState.active ||
      unconstrainedWidthState.checked !== 'false' ||
      unconstrainedWidthState.widthOverride !== ''
    ) {
      throw new Error(`Disabled constrained width still changed the layout: ${JSON.stringify(unconstrainedWidthState)}`);
    }
    await page.click('[data-action="save"]');
    await waitForFrames(page, 2);
    const saveMessages = await page.evaluate(() => (
      (window as typeof window & { __hostMessages?: Array<{ type?: string }> }).__hostMessages ?? []
    ).filter((message) => message.type === 'saveDocument').length);
    if (saveMessages !== 1) {
      throw new Error(`Toolbar save did not request a save: ${saveMessages}`);
    }
    const editorScrollTopBeforePreview = await page.$eval<HTMLElement, number>(
      '.editor-host > .cm-editor .cm-scroller',
      (element) => element.scrollTop
    );
    await page.click('[data-mode="preview"]');
    let previewRequestId = await page.evaluate(() => {
      const messages = (window as typeof window & { __hostMessages?: Array<{ type?: string; requestId?: string }> }).__hostMessages ?? [];
      return messages.findLast((message) => message.type === 'requestPreviewRender')?.requestId ?? '';
    });
    if (!previewRequestId) {
      throw new Error('Preview mode did not request rendered Markdown');
    }
    await page.evaluate((requestId) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'previewRenderError', requestId, message: 'Preview test error'
      }}));
    }, previewRequestId);
    const previewError = await page.$eval('.preview-status', (element) => element.textContent);
    if (previewError !== 'Preview test error') {
      throw new Error(`Preview render error was not shown: ${previewError}`);
    }
    const stalePreviewRequestId = previewRequestId;
    await page.click('[data-mode="live"]');
    await page.$eval<HTMLElement, number>('.editor-host > .cm-editor .cm-scroller', (element, scrollTop) => {
      element.scrollTop = scrollTop;
    }, editorScrollTopBeforePreview);
    await waitForFrames(page, 2);
    await page.click('[data-mode="preview"]');
    previewRequestId = await page.evaluate(() => {
      const messages = (window as typeof window & { __hostMessages?: Array<{ type?: string; requestId?: string }> }).__hostMessages ?? [];
      return messages.findLast((message) => message.type === 'requestPreviewRender')?.requestId ?? '';
    });
    if (!previewRequestId || previewRequestId === stalePreviewRequestId) {
      throw new Error('Re-entering Preview did not create a new render request');
    }
    await page.evaluate((requestId) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'previewRendered', requestId, html: '<h1 id="stale">Stale</h1>', hasMermaid: false,
        styles: { dark: 'body{background:red}', light: 'body{background:red}' }
      }}));
    }, stalePreviewRequestId);
    await waitForFrames(page, 2);
    const stalePreviewApplied = await page.evaluate(() => (
      Boolean(document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('#stale'))
    ));
    if (stalePreviewApplied) {
      throw new Error('A stale Preview response replaced the current request');
    }
    await page.evaluate((requestId) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'previewRendered',
        requestId,
        html: '<h1 id="intro" data-source-line="1">Intro</h1><div style="height:600px"></div><h2 id="short-mermaid" data-source-line="78">Short Mermaid</h2><div style="height:900px"></div><pre id="anchor-133" data-source-line="133" data-source-end-line="222" style="height:900px">Code block</pre><div style="height:600px"></div><h2 id="tall-mermaid" data-source-line="231">Tall Mermaid</h2><div style="height:900px"></div>',
        hasMermaid: false,
        styles: {
          dark: 'html,body{margin:0;background:#20252b;color:#fff}.meo-export-doc{padding:20px}',
          light: 'html,body{margin:0;background:#fff;color:#1f2328}.meo-export-doc{padding:20px}'
        }
      }}));
    }, previewRequestId);
    await page.waitForFunction(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
      return frame?.contentDocument?.querySelector('#tall-mermaid');
    });
    const darkPreviewState = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const toggle = document.querySelector<HTMLElement>('.preview-theme-toggle')!;
      return {
        mode: document.querySelector<HTMLElement>('#app')?.dataset.mode,
        editorHidden: document.querySelector<HTMLElement>('.editor-host')?.hidden,
        previewHidden: document.querySelector<HTMLElement>('.preview-host')?.hidden,
        pressed: toggle.getAttribute('aria-pressed'),
        background: getComputedStyle(frame.contentDocument!.body).backgroundColor
      };
    });
    if (
      darkPreviewState.mode !== 'preview' ||
      !darkPreviewState.editorHidden ||
      darkPreviewState.previewHidden ||
      darkPreviewState.pressed !== 'false' ||
      darkPreviewState.background !== 'rgb(32, 37, 43)'
    ) {
      throw new Error(`Unexpected dark Preview state: ${JSON.stringify(darkPreviewState)}`);
    }
    const restoredPreviewAnchor = await page.evaluate(() => {
      const anchor = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
        .querySelector<HTMLElement>('#anchor-133')!;
      const rect = anchor.getBoundingClientRect();
      return rect.top + rect.height * ((138 - 133) / (222 - 133 + 1));
    });
    if (Math.abs(restoredPreviewAnchor) > 4) {
      throw new Error(`Preview did not restore the editor viewport: ${restoredPreviewAnchor}`);
    }
    await page.click('[data-action="outline-right"]');
    const outlineWidthBefore = await page.$eval<HTMLElement, number>('.outline-sidebar', (element) => element.getBoundingClientRect().width);
    const resizerBox = await page.$eval<HTMLElement, { x: number; y: number }>('.outline-resizer', (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + 80 };
    });
    await page.mouse.move(resizerBox.x, resizerBox.y);
    await page.mouse.down();
    await page.mouse.move(resizerBox.x - 80, resizerBox.y, { steps: 8 });
    await page.mouse.up();
    const resizedOutline = await page.evaluate(() => ({
      width: document.querySelector<HTMLElement>('.outline-sidebar')!.getBoundingClientRect().width,
      resizing: document.body.classList.contains('outline-resizing')
    }));
    if (resizedOutline.width < outlineWidthBefore + 60 || resizedOutline.resizing) {
      throw new Error(`Preview outline resize stalled over the iframe: ${JSON.stringify({ outlineWidthBefore, resizedOutline })}`);
    }
    const scrollBeforeResizeWheel = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      frame.contentDocument!.scrollingElement!.scrollTop = 300;
      return frame.contentDocument!.scrollingElement!.scrollTop;
    });
    const previewBox = await page.$eval<HTMLIFrameElement, { x: number; y: number }>('.preview-frame', (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(previewBox.x, previewBox.y);
    await page.mouse.wheel({ deltaY: 180 });
    await waitForFrames(page, 2);
    const resizeWheelState = await page.evaluate(({ x, y }) => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      return {
        scrollTop: frame.contentDocument!.scrollingElement!.scrollTop,
        pointerTarget: document.elementFromPoint(x, y)?.className ?? null,
        parentActive: document.activeElement?.className ?? null,
        frameActive: frame.contentDocument!.activeElement?.tagName ?? null
      };
    }, previewBox);
    if (resizeWheelState.scrollTop <= scrollBeforeResizeWheel) {
      throw new Error(`Preview scrolling remained stuck after resizing the outline: ${JSON.stringify(resizeWheelState)}`);
    }
    const syntheticWheelBefore = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const scrollingElement = frame.contentDocument!.scrollingElement!;
      const before = scrollingElement.scrollTop;
      frame.contentDocument!.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true }));
      return before;
    });
    await waitForFrames(page, 2);
    const syntheticWheelAfter = await page.evaluate(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
    ));
    if (syntheticWheelAfter <= syntheticWheelBefore) {
      throw new Error(`Preview wheel fallback did not recover scrolling: ${JSON.stringify({ syntheticWheelBefore, syntheticWheelAfter })}`);
    }
    await page.click('.outline-item[title="Tall Mermaid"]');
    await waitForFrames(page, 2);
    const outlineScrollTop = await page.evaluate(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
    ));
    if (outlineScrollTop <= 0) {
      throw new Error('Preview outline did not jump to the selected heading');
    }
    await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      frame.contentDocument!.querySelector<HTMLElement>('#short-mermaid')!.scrollIntoView({ block: 'start' });
      frame.contentDocument!.dispatchEvent(new Event('scroll'));
    });
    await waitForFrames(page, 2);
    const topOutlineVisible = await page.$eval('.outline-item[title="Short Mermaid"]', (element) => element.classList.contains('is-visible'));
    await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      frame.contentDocument!.scrollingElement!.scrollTop = frame.contentDocument!.scrollingElement!.scrollHeight;
      frame.contentDocument!.dispatchEvent(new Event('scroll'));
    });
    await waitForFrames(page, 2);
    const bottomOutlineVisible = await page.$eval('.outline-item[title="Tall Mermaid"]', (element) => element.classList.contains('is-visible'));
    if (!topOutlineVisible || !bottomOutlineVisible) {
      throw new Error(`Preview scrolling did not update the outline: ${JSON.stringify({ topOutlineVisible, bottomOutlineVisible })}`);
    }
    const resizedBox = await page.$eval<HTMLElement, { x: number; y: number }>('.outline-resizer', (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + 80 };
    });
    await page.mouse.move(resizedBox.x, resizedBox.y);
    await page.mouse.down();
    await page.mouse.move(resizedBox.x + 80, resizedBox.y, { steps: 8 });
    await page.mouse.up();
    await page.click('[data-action="outline-right"]');
    await page.evaluate(() => {
      const frameBody = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.body;
      frameBody.dataset.themeSwitchSentinel = 'preserve-document';
    });
    await page.click('.preview-theme-toggle');
    await page.waitForFunction(() => {
      return document.querySelector<HTMLElement>('.preview-theme-toggle')?.getAttribute('aria-pressed') === 'true';
    });
    await waitForFrames(page, 4);
    const lightPreviewBackground = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      return getComputedStyle(frame.contentDocument!.body).backgroundColor;
    });
    if (lightPreviewBackground !== 'rgb(255, 255, 255)') {
      throw new Error(`Preview light theme did not render: ${lightPreviewBackground}`);
    }
    const themeSwitchPreservedDocument = await page.evaluate(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.body.dataset.themeSwitchSentinel
    ));
    if (themeSwitchPreservedDocument !== 'preserve-document') {
      throw new Error('Preview theme switching rebuilt the iframe document');
    }
    await page.click('[data-mode="live"]');
    await waitForFrames(page, 2);
    const previewExitVisibleLine = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      const viewport = scroller.getBoundingClientRect();
      return Array.from(document.querySelectorAll<HTMLElement>('.cm-line')).some((line) => {
        const rect = line.getBoundingClientRect();
        return line.textContent === '## Tall Mermaid' && rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
    });
    if (!previewExitVisibleLine) {
      throw new Error('Leaving Preview did not preserve the visible document position');
    }
    await page.waitForFunction(() => Boolean(document.querySelector('.meo-mermaid-block svg[height="3000"]')), { timeout: 3000 });
    await page.evaluate((text) => {
      const selection = text.indexOf('const line10');
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'revealSelection', anchor: selection, head: selection, focus: false
      }}));
    }, initialText);
    await waitForFrames(page, 2);
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      const anchorCodeLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent === 'const line10 = 10;');
      if (anchorCodeLine) {
        scroller.scrollTop += anchorCodeLine.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      }
    });
    await waitForFrames(page, 2);
    await page.click('[data-action="outline-right"]');
    const readViewport = () => page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      const viewport = scroller.getBoundingClientRect();
      const visibleCodeLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .map((line) => ({ text: line.textContent ?? '', rect: line.getBoundingClientRect() }))
        .filter(({ text, rect }) => text.startsWith('const line') && rect.bottom > viewport.top && rect.top < viewport.bottom)
        .sort((left, right) => left.rect.top - right.rect.top)[0];
      return {
        text: visibleCodeLine?.text ?? null,
        top: visibleCodeLine?.rect.top ?? null,
        scrollTop: scroller.scrollTop
      };
    });

    const before = await readViewport();
    const updatedText = initialText.replace('Start --> Done', 'Start --> Check --> Done');
    await page.evaluate((text) => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'docChanged', text, version: 2 } }));
      const selection = text.indexOf('const line6');
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'revealSelection', anchor: selection, head: selection, focus: false, preserveViewport: true
      }}));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    }, updatedText);
    await page.keyboard.down('Control');
    await page.keyboard.press('s');
    await page.keyboard.up('Control');
    await waitForFrames(page, 1);
    const afterUpdate = await readViewport();

    await page.evaluate((theme) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'themeChanged', theme, codeTheme: null }
      }));
    }, {
      ...defaultThemeSettings,
      fonts: { ...defaultThemeSettings.fonts, liveFontSize: 18 }
    });
    await waitForFrames(page);
    const afterTheme = await readViewport();

    await page.mouse.move(450, 260);
    const wheelScrollTops: number[] = [];
    const wheelVisualPositions: number[] = [];
    for (let index = 0; index < 8; index += 1) {
      await page.mouse.wheel({ deltaY: -80 });
      await waitForFrames(page, 1);
      wheelScrollTops.push(await page.evaluate(() =>
        document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!.scrollTop
      ));
      wheelVisualPositions.push(await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
        const scrollerRect = scroller.getBoundingClientRect();
        const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line')).find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom;
        });
        const text = line?.textContent ?? '';
        const stableMatch = text.match(/^stable line (\d+)/);
        const codeMatch = text.match(/^const line(\d+)/);
        const documentLine = stableMatch ? Number(stableMatch[1]) : codeMatch ? 133 + Number(codeMatch[1]) : 0;
        const lineHeight = line ? Number.parseFloat(getComputedStyle(line).lineHeight) : 0;
        return documentLine > 0 && lineHeight > 0
          ? documentLine * lineHeight - line!.getBoundingClientRect().top
          : Number.NaN;
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
    await waitForFrames(page);
    const afterUpwardScroll = await readViewport();

    const lineNumber = (value: string | null): number | null => {
      const match = value?.match(/^const line(\d+)/);
      return match ? Number(match[1]) : null;
    };
    const beforeLine = lineNumber(before.text);
    const afterUpdateLine = lineNumber(afterUpdate.text);
    const afterThemeLine = lineNumber(afterTheme.text);
    const wheelMovedOnlyUp = wheelVisualPositions.every((position, index) => (
      Number.isFinite(position) && (index === 0 || position <= wheelVisualPositions[index - 1] + 1)
    ));
    if (
      beforeLine === null || afterUpdateLine === null || afterThemeLine === null ||
      beforeLine > 12 ||
      Math.abs(afterUpdateLine - beforeLine) > 1 ||
      Math.abs(afterThemeLine - afterUpdateLine) > 1 ||
      Math.abs((afterTheme.top ?? 0) - (afterUpdate.top ?? 0)) > 1 ||
      !wheelMovedOnlyUp
    ) {
      throw new Error(`Implicit webview updates moved the visual anchor: ${JSON.stringify({ before, afterUpdate, afterTheme, wheelScrollTops, wheelVisualPositions, afterUpwardScroll })}`);
    }

    const tallMermaidBefore = await page.evaluate(async () => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      scroller.scrollTop = scroller.scrollHeight;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const pending = document.querySelector<HTMLElement>('.meo-mermaid-loading')
          ?.closest<HTMLElement>('.meo-mermaid-block') ?? null;
        if (pending) {
          const viewportTop = scroller.getBoundingClientRect().top;
          scroller.scrollTop += pending.getBoundingClientRect().top - viewportTop - 80;
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const pendingBottom = pending.getBoundingClientRect().bottom;
          const anchor = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
            .find((line) => (
              line.getBoundingClientRect().top >= pendingBottom &&
              Boolean(line.textContent?.trim()) && line.textContent?.trim() !== '```'
            ));
          return {
            text: anchor?.textContent ?? null,
            top: anchor?.getBoundingClientRect().top ?? null,
            blockTop: pending.getBoundingClientRect().top
          };
        }
        scroller.scrollTop = Math.max(0, scroller.scrollTop - 120);
      }
      return null;
    });
    await new Promise((resolve) => setTimeout(resolve, 450));
    const tallMermaidWheelDelta = -20;
    const tallMermaidWheelCount = 6;
    for (let index = 0; index < tallMermaidWheelCount; index += 1) {
      await page.mouse.wheel({ deltaY: tallMermaidWheelDelta });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    await waitForFrames(page);
    const tallMermaidAfter = await page.evaluate((anchorText) => {
      const anchor = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent === anchorText);
      return {
        text: anchor?.textContent ?? null,
        top: anchor?.getBoundingClientRect().top ?? null,
        rendered: Boolean(document.querySelector('.meo-mermaid-block svg[height="3000"]'))
      };
    }, tallMermaidBefore?.text ?? null);
    if (
      !tallMermaidBefore || tallMermaidBefore.top === null ||
      !tallMermaidAfter.rendered || tallMermaidAfter.top === null ||
      Math.abs(
        tallMermaidAfter.top - tallMermaidBefore.top +
        tallMermaidWheelDelta * tallMermaidWheelCount
      ) > 1
    ) {
      throw new Error(`Tall Mermaid displaced the visible reading anchor: ${JSON.stringify({ tallMermaidBefore, tallMermaidAfter })}`);
    }
    console.log('webview viewport checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
