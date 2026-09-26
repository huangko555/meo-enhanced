import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const root = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-font-viewport-'));
const build = await Bun.build({
  entrypoints: [path.join(root, 'scripts/test-webview-viewport-entry.ts')],
  outdir: tempDir,
  target: 'browser',
  format: 'iife',
  naming: 'bundle.js'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 520 });
  await page.setContent('<!doctype html><body class="vscode-light"><div id="app" class="editor-root"><div class="mode-toolbar meo-preload-toolbar" role="presentation" aria-hidden="true"></div><div class="editor-wrapper meo-preload-editor-shell" role="presentation" aria-hidden="true"><div class="editor-host"></div></div></div></body>');
  await page.addStyleTag({ content: ':root{--vscode-editor-background:#fff;--vscode-editor-foreground:#24292f;--vscode-sideBar-background:#f6f8fa;--vscode-panel-border:#d0d7de;--vscode-toolbar-hoverBackground:#eaeef2}html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}' });
  await page.addStyleTag({ path: path.join(root, 'webview/src/styles.css') });
  await page.addScriptTag({ content: 'window.__hostMessages=[];window.acquireVsCodeApi=()=>({postMessage(message){window.__hostMessages.push(message)},getState(){return null},setState(){}})' });
  await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
  const lines = Array.from({ length: 220 }, (_, index) => `stable line ${index + 1}`);
  lines.splice(70, 0,
    '', '| Name | Value |', '| --- | --- |',
    ...Array.from({ length: 30 }, (_, index) => `| Row ${index + 1} | ${index === 18 ? 'Wrapped value '.repeat(20) : `Value ${index + 1}`} |`),
    '', '```typescript',
    ...Array.from({ length: 30 }, (_, index) => `const value${index + 1} = ${index + 1};`),
    '```', ''
  );
  const text = lines.join('\n');
  await page.evaluate((documentText) => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'init', documentId: 'file:///font.md', text: documentText, version: 1,
    savedRevision: { version: 1, text: documentText }, diagnostics: [], mode: 'source',
    uiLanguage: 'zh-CN', sourceLineNumbers: 'on', previewAppearance: 'light',
    previewFontFamily: '', previewSourceColoring: true, editorAppearance: 'light',
    gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
    diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
    contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
    outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null
  } })), text);
  await page.waitForSelector('.editor-host > .cm-editor');
  await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('.editor-host .cm-scroller')!;
    scroller.scrollTop = 1400;
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  await page.click('.more-tools-wrapper > button');
  await page.click('[data-editor-font-size-mode="custom"]');
  await page.evaluate(async () => { for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame); });
  const captureStep = () => page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('.editor-host .cm-scroller')!;
    const viewport = scroller.getBoundingClientRect();
    const table = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table-shell'))
      .find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.top <= viewport.top && rect.bottom > viewport.top;
      });
    const tableRow = table && Array.from(table.querySelectorAll<HTMLElement>('tr'))
      .find((candidate) => candidate.getBoundingClientRect().bottom > viewport.top);
    const line = tableRow ?? Array.from(document.querySelectorAll<HTMLElement>('.editor-host .cm-line, .editor-host [data-meo-rendered-block-start-line]'))
      .find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > viewport.top + 10 && rect.top < viewport.bottom;
      })!;
    const result: Array<{ top: number; scroll: number; font: string }> = [];
    const record = () => result.push({
      top: line.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
      scroll: scroller.scrollTop,
      font: getComputedStyle(scroller.closest('.cm-editor')!).fontSize
    });
    record();
    document.querySelector<HTMLButtonElement>('.editor-font-size-stepper-button:last-child')!.click();
    record();
    for (let i = 0; i < 8; i++) { await new Promise(requestAnimationFrame); record(); }
    return { line: line.textContent?.slice(0, 40), result };
  });
  for (const mode of ['source', 'live'] as const) {
    if (mode === 'live') {
      await page.click('[data-mode="live"]');
      await page.waitForSelector('.editor-host .meo-mode-live');
      await page.evaluate(async () => {
        document.querySelector<HTMLElement>('.editor-host .cm-scroller')!.scrollTop = 1400;
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      if (await page.$eval('.more-tools-panel', (panel) => (panel as HTMLElement).hidden)) {
        await page.click('.more-tools-wrapper > button');
      }
    }
    const samples = await captureStep();
    const initialTop = samples.result[0].top;
    const maxDisplacement = Math.max(...samples.result.map((sample) => Math.abs(sample.top - initialTop)));
    if (maxDisplacement > 8) {
      throw new Error(`${mode} font size step flashed the reading line (${maxDisplacement}px): ${JSON.stringify(samples)}`);
    }
  }
  await page.evaluate(async () => {
    document.querySelector<HTMLElement>('.editor-host .cm-scroller')!.scrollTop += 500;
    for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
  });
  const tableRowSamples = await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('.editor-host .cm-scroller')!;
    const viewport = scroller.getBoundingClientRect();
    const row = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table-shell tr'))
      .find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      })!;
    const record = () => ({
      scroll: scroller.scrollTop,
      top: row.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
      connected: row.isConnected
    });
    const samples = [record()];
    document.querySelector<HTMLButtonElement>('.editor-font-size-stepper-button:last-child')!.click();
    samples.push(record());
    for (let i = 0; i < 8; i++) { await new Promise(requestAnimationFrame); samples.push(record()); }
    return { row: row.textContent?.trim(), samples };
  });
  const tableRowTop = tableRowSamples.samples[0].top;
  if (tableRowSamples.samples.some((sample) => !sample.connected || Math.abs(sample.top - tableRowTop) > 8)) {
    throw new Error(`Live table row flashed during font size change: ${JSON.stringify(tableRowSamples)}`);
  }
  await page.evaluate(async () => { for (let i = 0; i < 20; i++) await new Promise(requestAnimationFrame); });
  await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('.editor-host .cm-scroller')!;
    const start = document.querySelector<HTMLElement>('.meo-md-code-block-start')!;
    scroller.scrollTop += start.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40;
    for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
    const placeholder = document.querySelector<HTMLElement>('.meo-md-long-code-placeholder')!;
    scroller.scrollTop += placeholder.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 15;
    for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
    if (Math.abs(placeholder.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 15) > 20) {
      scroller.scrollTop += placeholder.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 15;
      for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
    }
  });
  const codeSamples = await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('.editor-host .cm-scroller')!;
    const selector = '.meo-md-long-code-placeholder';
    const original = document.querySelector<HTMLElement>(selector);
    const record = () => {
      const element = document.querySelector<HTMLElement>(selector);
      const rect = element?.getBoundingClientRect();
      return {
        scroll: scroller.scrollTop,
        top: rect ? rect.top - scroller.getBoundingClientRect().top : null,
        height: rect?.height ?? null,
        sameNode: element === original
      };
    };
    const samples = [record()];
    document.querySelector<HTMLButtonElement>('.editor-font-size-stepper-button:last-child')!.click();
    samples.push(record());
    for (let i = 0; i < 8; i++) { await new Promise(requestAnimationFrame); samples.push(record()); }
    return samples;
  });
  const codeTop = codeSamples[0].top;
  if (codeTop === null || codeSamples.some((sample) => !sample.sameNode || sample.top === null || Math.abs(sample.top - codeTop) > 8)) {
    throw new Error(`Live long code block flashed during font size change: ${JSON.stringify(codeSamples)}`);
  }
  await page.click('[data-mode="preview"]');
  await page.waitForFunction(() => window.__hostMessages.some((message: { type: string }) => message.type === 'requestPreviewRender'));
  const renderPreview = (requestId: string, size: number) => page.evaluate(({ id, fontSize }) => {
    const html = Array.from({ length: 220 }, (_, index) => `<p data-source-line="${index + 1}">stable line ${index + 1}</p>`).join('');
    const styles = `html,body{margin:0}.meo-export-doc{font-size:${fontSize}px;line-height:1.5}p{margin:0}`;
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'previewRenderResult', requestId: id,
      result: { ok: true, value: { html, hasMermaid: false, styles: { light: styles, dark: styles } } }
    } }));
  }, { id: requestId, fontSize: size });
  const latestPreviewRequest = () => page.evaluate(() => {
    const request = window.__hostMessages.findLast((message: { type: string }) => message.type === 'requestPreviewRender');
    return { id: request.requestId as string, size: request.environment?.editorFontSizePx as number };
  });
  const initialRequest = await latestPreviewRequest();
  await renderPreview(initialRequest.id, initialRequest.size);
  await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('[data-source-line="75"]'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const settledRequest = await latestPreviewRequest();
  if (settledRequest.id !== initialRequest.id) await renderPreview(settledRequest.id, settledRequest.size);
  await page.evaluate(async () => { for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame); });
  await page.evaluate(() => { document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop = 1400; });
  const previewFrameRect = await page.$eval('.preview-frame', (frame) => frame.getBoundingClientRect().toJSON());
  await page.mouse.move(previewFrameRect.x + previewFrameRect.width / 2, previewFrameRect.y + previewFrameRect.height / 2);
  await page.mouse.wheel({ deltaY: 8 });
  await page.evaluate(async () => { for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame); });
  await page.click('.more-tools-wrapper > button');
  const previewBefore = await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const anchor = Array.from(doc.querySelectorAll<HTMLElement>('[data-source-line]'))
      .find((element) => element.getBoundingClientRect().bottom > 0)!;
    return { line: anchor.dataset.sourceLine, top: anchor.getBoundingClientRect().top, scroll: doc.scrollingElement!.scrollTop };
  });
  await page.click('.editor-font-size-stepper-button:last-child');
  await page.waitForFunction((previous) => window.__hostMessages.findLast((message: { type: string; requestId?: string }) => message.type === 'requestPreviewRender')?.requestId !== previous, {}, settledRequest.id);
  const nextRequest = await latestPreviewRequest();
  await renderPreview(nextRequest.id, nextRequest.size);
  const previewAfter = await page.evaluate(async (line) => {
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return {
      top: doc.querySelector<HTMLElement>(`[data-source-line="${line}"]`)!.getBoundingClientRect().top,
      scroll: doc.scrollingElement!.scrollTop,
      fontSize: getComputedStyle(doc.querySelector<HTMLElement>('.meo-export-doc')!).fontSize
    };
  }, previewBefore.line);
  if (previewAfter.fontSize !== `${nextRequest.size}px` || Math.abs(previewAfter.top - previewBefore.top) > 12) {
    const requests = await page.evaluate(() => window.__hostMessages.filter((message: { type: string }) => message.type === 'requestPreviewRender').map((message: { requestId: string; text?: string; environment?: { editorFontSizePx?: number } }) => ({ id: message.requestId, length: message.text?.length, size: message.environment?.editorFontSizePx })));
    throw new Error(`Preview font size step moved the reading line: ${JSON.stringify({ previewBefore, previewAfter, requests })}`);
  }
  await page.evaluate(() => {
    document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop = 0;
  });
  await page.click('.editor-font-size-stepper-button:last-child');
  await page.waitForFunction((previous) => window.__hostMessages.findLast((message: { type: string; requestId?: string }) => message.type === 'requestPreviewRender')?.requestId !== previous, {}, nextRequest.id);
  const topRequest = await latestPreviewRequest();
  await renderPreview(topRequest.id, topRequest.size);
  await page.evaluate(async () => { for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame); });
  const jumpedTop = await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const anchor = doc.querySelector<HTMLElement>('[data-source-line="13"]')!;
    doc.scrollingElement!.scrollTop += anchor.getBoundingClientRect().top - 50;
    return anchor.getBoundingClientRect().top;
  });
  await page.click('.editor-font-size-stepper-button:last-child');
  await page.waitForFunction((previous) => window.__hostMessages.findLast((message: { type: string; requestId?: string }) => message.type === 'requestPreviewRender')?.requestId !== previous, {}, topRequest.id);
  const jumpRequest = await latestPreviewRequest();
  await renderPreview(jumpRequest.id, jumpRequest.size);
  const jumpedAfter = await page.evaluate(async () => {
    for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame);
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return { top: doc.querySelector<HTMLElement>('[data-source-line="13"]')!.getBoundingClientRect().top,
      scroll: doc.scrollingElement!.scrollTop };
  });
  if (Math.abs(jumpedAfter.top - jumpedTop) > 12) {
    throw new Error(`Preview jumped back after a font change: ${JSON.stringify({ jumpedTop, jumpedAfter })}`);
  }
  console.log('font size viewport checks passed');
} finally {
  await browser.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
