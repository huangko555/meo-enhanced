import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-mermaid-partial-line-input-'));

async function waitForFrames(page: import('puppeteer-core').Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function runMode(page: import('puppeteer-core').Page, mode: 'split' | 'source'): Promise<void> {
  await page.evaluate(() => {
    (window as any).__mermaidPartialLineEditor?.destroy();
    document.getElementById('app')!.replaceChildren();
    const diagram = Array.from({ length: 18 }, (_, index) => `node${index + 1} --> node${index + 2}`);
    const text = [
      ...Array.from({ length: 40 }, (_, index) => `before ${index + 1}`),
      '',
      '```mermaid',
      'graph TD',
      ...diagram,
      '```',
      '',
      ...Array.from({ length: 40 }, (_, index) => `after ${index + 1}`)
    ].join('\n');
    (window as any).__mermaidPartialLineEditor = (window as any).MermaidEditingHarness.createEditor({
      parent: document.getElementById('app')!,
      text,
      initialMode: 'live',
      onApplyChanges() {}
    });
  });
  await page.evaluate(() => (window as any).__mermaidPartialLineEditor.scrollToLine(50, 'center'));
  await page.waitForSelector('.meo-mermaid-block svg');
  await page.click('.meo-mermaid-mode-btn');
  await page.waitForSelector('.meo-mermaid-editing-block.is-split');
  if (mode === 'source') {
    await page.click('.meo-mermaid-mode-btn');
    await page.waitForSelector('.meo-mermaid-editing-block.is-source');
  }
  await waitForFrames(page, 10);

  const initial = await page.evaluate(() => {
    const editor = (window as any).__mermaidPartialLineEditor;
    const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block')!;
    const controller = (block as any).__meoMermaidEditingController;
    const innerView = controller.innerView;
    const line = innerView.state.doc.line(7);
    innerView.dispatch({ selection: { anchor: line.to } });
    innerView.contentDOM.focus({ preventScroll: true });
    const lineElement = Array.from(block.querySelectorAll<HTMLElement>('.cm-line'))
      .find((candidate) => candidate.textContent === line.text)!;
    const viewport = editor.view.scrollDOM.getBoundingClientRect();
    const lineRect = lineElement.getBoundingClientRect();
    editor.view.scrollDOM.scrollTop += lineRect.top - (viewport.top - lineRect.height / 2);
    const positioned = lineElement.getBoundingClientRect();
    (window as any).__mermaidPartialLineBlock = block;
    return {
      scrollTop: editor.view.scrollDOM.scrollTop,
      lineTop: positioned.top,
      lineBottom: positioned.bottom,
      viewportTop: viewport.top,
      viewportBottom: viewport.bottom,
      focused: innerView.hasFocus
    };
  });
  if (
    !initial.focused ||
    initial.lineTop >= initial.viewportTop ||
    initial.lineBottom <= initial.viewportTop
  ) {
    throw new Error(`Mermaid partial-line fixture was not clipped at the top: ${JSON.stringify({ mode, initial })}`);
  }

  await page.evaluate(() => {
    const editor = (window as any).__mermaidPartialLineEditor;
    const initialBlock = (window as any).__mermaidPartialLineBlock;
    const trace: Array<{
      scrollTop: number;
      caretTop: number | null;
      sameBlock: boolean;
      focused: boolean;
    }> = [];
    (window as any).__mermaidPartialLineTrace = trace;
    let frames = 0;
    const sample = () => {
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block');
      const innerView = (block as any)?.__meoMermaidEditingController?.innerView;
      const caret = innerView?.coordsAtPos(innerView.state.selection.main.head);
      trace.push({
        scrollTop: editor.view.scrollDOM.scrollTop,
        caretTop: caret?.top ?? null,
        sameBlock: block === initialBlock,
        focused: innerView?.hasFocus ?? false
      });
      frames += 1;
      if (frames < 50) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.keyboard.type('X');
  await new Promise((resolve) => setTimeout(resolve, 500));
  await waitForFrames(page, 12);

  const result = await page.evaluate(() => {
    const editor = (window as any).__mermaidPartialLineEditor;
    const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block')!;
    const innerView = (block as any).__meoMermaidEditingController.innerView;
    const trace = (window as any).__mermaidPartialLineTrace as Array<{
      scrollTop: number;
      caretTop: number | null;
      sameBlock: boolean;
      focused: boolean;
    }>;
    const positions = [trace[0]?.scrollTop ?? editor.view.scrollDOM.scrollTop, ...trace.map((sample) => sample.scrollTop)];
    const travel = positions.slice(1).reduce(
      (total, value, index) => total + Math.abs(value - positions[index]),
      0
    );
    const displacement = Math.abs(positions.at(-1)! - positions[0]);
    const viewport = editor.view.scrollDOM.getBoundingClientRect();
    const caret = innerView.coordsAtPos(innerView.state.selection.main.head);
    return {
      text: innerView.state.doc.line(7).text,
      focused: innerView.hasFocus,
      sameBlock: trace.every((sample) => sample.sameBlock),
      focusStable: trace.every((sample) => sample.focused),
      travel,
      displacement,
      excessTravel: travel - displacement,
      scrollSpan: Math.max(...positions) - Math.min(...positions),
      scrollPositions: positions.filter((value, index) => index === 0 || Math.abs(value - positions[index - 1]) > 0.5),
      caretTop: caret?.top ?? null,
      viewportTop: viewport.top,
      viewportBottom: viewport.bottom
    };
  });
  if (
    result.text !== 'node6 --> node7X' ||
    !result.focused ||
    !result.sameBlock ||
    !result.focusStable ||
    result.excessTravel > 2 ||
    result.caretTop === null ||
    result.caretTop < result.viewportTop ||
    result.caretTop > result.viewportBottom
  ) {
    throw new Error(`Typing in a partially clipped Mermaid ${mode} line flickered: ${JSON.stringify(result)}`);
  }
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-mermaid-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  let primaryError: unknown;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 360, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#fff;--meo-foreground:#24292f;--meo-code-background:#f6f8fa;--meo-surface-background:#fff;--meo-color-base05:#0969da;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--meo-semantic-mutedForeground:#57606a;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-line-height:20px}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(() => {
      (window as any).mermaid = {
        initialize() {},
        async render(_id: string, text: string) {
          return { svg: `<svg width="640" height="240" viewBox="0 0 640 240"><text x="10" y="30">${text.length}</text></svg>` };
        }
      };
    });
    await runMode(page, 'source');
    await runMode(page, 'split');
    console.log('Mermaid partial-line typing viewport regression passed');
  } catch (error) {
    primaryError = error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
}

await main();
