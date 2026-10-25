import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import { findMermaidOpening, setMermaidLayout } from './history-mermaid-chromium';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-mermaid-partial-line-input-'));

async function waitForFrames(page: import('puppeteer-core').Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function runNewlineMode(
  page: import('puppeteer-core').Page,
  mode: 'stacked' | 'side-by-side',
  fixture: { name: string; before: string; prefix: string; payload?: string },
  appearance: 'light' | 'dark'
): Promise<void> {
  await page.setViewport({ width: 1100, height: 700, deviceScaleFactor: 1 });
  const openingLine = fixture.before.split('\n').length;
  const continuedPrefix = fixture.prefix + (fixture.payload?.match(/^[\t ]*/)?.[0] ?? '');
  const text = fixture.before + ['```mermaid', 'graph TD', fixture.payload ?? 'A --> B', '```']
    .map(line => fixture.prefix + line).join('\n') + '\n\nAfter';
  await page.evaluate(({ text, appearance }) => {
    (window as any).__mermaidPartialLineEditor?.destroy();
    document.getElementById('app')!.replaceChildren();
    document.documentElement.dataset.editorAppearance = appearance;
    (window as any).MermaidEditingHarness.applyUiTheme(appearance, false);
    (window as any).__mermaidPartialLineEditor = (window as any).MermaidEditingHarness.createEditor({
      parent: document.getElementById('app')!,
      text,
      initialMode: 'live', onApplyChanges() {}
    });
  }, { text, appearance });
  await setMermaidLayout(page, '__mermaidPartialLineEditor', openingLine, mode);
  await page.evaluate((lineNumber) => {
    const view = (window as any).__mermaidPartialLineEditor.view;
    view.dispatch({ selection: { anchor: view.state.doc.line(lineNumber).to } });
    view.focus();
  }, openingLine + 2);
  await waitForFrames(page);
  const baseline = await page.evaluate(({ lineNumber, prefixLength }) => {
    const view = (window as any).__mermaidPartialLineEditor.view;
    const line = view.state.doc.line(lineNumber);
    const node = view.domAtPos(line.to).node;
    const element = (node.nodeType === Node.TEXT_NODE ? node.parentElement! : node as HTMLElement).closest('.cm-line')!;
    const style = getComputedStyle(element);
    return { left: view.coordsAtPos(line.from + prefixLength)!.left, font: style.font,
      paddingRight: style.paddingRight, scrollTop: view.scrollDOM.scrollTop };
  }, { lineNumber: openingLine + 2, prefixLength: fixture.prefix.length });
  const startTrace = () => page.evaluate((prefixLength) => {
    const view = (window as any).__mermaidPartialLineEditor.view;
    const trace: Array<{ left: number | null; text: string; code: boolean; focused: boolean;
      font: string; paddingRight: string; scrollTop: number; numbered: boolean }> = [];
    (window as any).__mermaidNewlineTrace = trace;
    let frames = 0;
    const sample = () => {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      const dom = view.domAtPos(line.to).node;
      const element = (dom.nodeType === Node.TEXT_NODE ? dom.parentElement! : dom as HTMLElement).closest('.cm-line')!;
      const style = getComputedStyle(element);
      trace.push({ left: view.coordsAtPos(Math.min(line.to, line.from + prefixLength))?.left ?? null, text: line.text,
        code: element.classList.contains('meo-md-code-block'), focused: view.hasFocus,
        font: style.font, paddingRight: style.paddingRight, scrollTop: view.scrollDOM.scrollTop,
        numbered: !!view.dom.querySelector('[data-meo-code-line-number]') });
      if (++frames < 24) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, fixture.prefix.length);
  const assertTrace = async (action: string) => {
    await waitForFrames(page, 26);
    const trace = await page.evaluate(() => (window as any).__mermaidNewlineTrace as Array<{
      left: number | null; text: string; code: boolean; focused: boolean; font: string;
      paddingRight: string; scrollTop: number; numbered: boolean
    }>);
    assert.ok(trace.length >= 24, 'The input trace must cover deferred presentation');
    const bad = trace.filter(sample => sample.left === null || Math.abs(sample.left - baseline.left) > 1
      || !sample.code || !sample.focused || sample.font !== baseline.font || sample.numbered
      || sample.paddingRight !== baseline.paddingRight || Math.abs(sample.scrollTop - baseline.scrollTop) > 1);
    assert.deepEqual(bad, [], `${fixture.name}/${mode}/${appearance}: ${action} must keep source geometry in every frame: ${JSON.stringify({ baseline, bad })}`);
  };
  await startTrace();
  await page.keyboard.press('Enter');
  await assertTrace('Enter after the source payload');
  assert.equal(await page.evaluate(() => {
    const view = (window as any).__mermaidPartialLineEditor.view;
    return view.state.doc.lineAt(view.state.selection.main.head).text;
  }), continuedPrefix, `${fixture.name}: Enter retains the source row indentation`);
  await startTrace();
  await page.keyboard.type('B --> C\nC --> D', { delay: 5 });
  await assertTrace('Enter and continuous input');
  const read = () => page.evaluate(() => (window as any).__mermaidPartialLineEditor.getText() as string);
  const expected = text.replace(fixture.prefix + '```\n\nAfter',
    continuedPrefix + 'B --> C\n' + continuedPrefix + 'C --> D\n' + fixture.prefix + '```\n\nAfter');
  assert.equal(await read(), expected, `${fixture.name}: input must preserve real Markdown prefixes`);
  await startTrace();
  await page.keyboard.down('Control');
  await page.keyboard.press('z');
  await page.keyboard.up('Control');
  await assertTrace('Undo');
  assert.notEqual(await read(), expected, 'Undo must restore an earlier source revision');
  await startTrace();
  await page.keyboard.down('Control');
  await page.keyboard.press('y');
  await page.keyboard.up('Control');
  await assertTrace('Redo');
  assert.equal(await read(), expected);
  if (fixture.name === 'plain') {
    fs.mkdirSync('.local/mermaid-input-acceptance', { recursive: true });
    const caretStyle = await page.addStyleTag({ content:
      '.cm-editor{--meo-caret-color:#ff00ff!important}.cm-content{caret-animation:manual}' });
    await waitForFrames(page, 3);
    const before = await page.evaluate(() => {
      const view = (window as any).__mermaidPartialLineEditor.view;
      const caret = view.coordsAtPos(view.state.selection.main.head)!;
      return { top: caret.top, bottom: caret.bottom };
    });
    const client = await page.createCDPSession();
    const paints: string[] = [];
    client.on('Page.screencastFrame', event => {
      paints.push(event.data);
      void client.send('Page.screencastFrameAck', { sessionId: event.sessionId });
    });
    await client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    try {
      // No coordsAtPos or editor measurement during these delivered paints.
      await page.keyboard.press('Enter');
      await waitForFrames(page, 24);
    } finally {
      await client.send('Page.stopScreencast');
      await client.detach();
    }
    const paintedCarets = await page.evaluate(async paints => {
      const carets: Array<{ left: number; right: number; top: number; bottom: number; pixels: number }> = [];
      for (const paint of paints) {
        const image = new Image(); image.src = 'data:image/png;base64,' + paint; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let left = image.width, right = 0, top = image.height, bottom = 0, count = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index] < 245 || pixels[index + 1] > 10 || pixels[index + 2] < 245) continue;
          const x = (index / 4) % image.width, y = Math.floor(index / 4 / image.width);
          left = Math.min(left, x); right = Math.max(right, x);
          top = Math.min(top, y); bottom = Math.max(bottom, y); count++;
        }
        if (count >= 5) carets.push({ left, right, top, bottom, pixels: count });
      }
      return carets;
    }, paints);
    const newRowCarets = paintedCarets.filter(caret => caret.top >= before.bottom - 2);
    if (!newRowCarets.length) paints.forEach((paint, index) => fs.writeFileSync(
      `.local/mermaid-input-acceptance/missing-${mode}-${appearance}-${index}.png`, Buffer.from(paint, 'base64')));
    assert.ok(newRowCarets.length, `${mode}/${appearance}: compositor must deliver a painted new-row caret: ${JSON.stringify({ before, paintedCarets, frames: paints.length })}`);
    const unstable = newRowCarets.filter(caret => Math.abs(caret.left - baseline.left) > 2
      || Math.abs(caret.right - baseline.left) > 2);
    if (unstable.length) paints.forEach((paint, index) => fs.writeFileSync(
      `.local/mermaid-input-acceptance/failed-${mode}-${appearance}-${index}.png`, Buffer.from(paint, 'base64')));
    assert.deepEqual(unstable, [], `${mode}/${appearance}: native caret paint must retain the source inset`);
    await caretStyle.evaluate(style => style.remove());
    await page.screenshot({ path: `.local/mermaid-input-acceptance/${mode}-${appearance}.png` });
  }
}

async function runMode(page: import('puppeteer-core').Page, mode: 'stacked' | 'side-by-side'): Promise<void> {
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
  const opening = await findMermaidOpening(page, '__mermaidPartialLineEditor', 'graph TD');
  await setMermaidLayout(page, '__mermaidPartialLineEditor', opening, mode);
  await waitForFrames(page, 10);

  const initial = await page.evaluate(() => {
    const editor = (window as any).__mermaidPartialLineEditor;
    const block = editor.view.contentDOM;
    const innerView = editor.view;
    const line = innerView.state.doc.line(49);
    innerView.dispatch({ selection: { anchor: line.to } });
    innerView.focus();
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
      const block = editor.view.contentDOM;
      const innerView = editor.view;
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
    const block = editor.view.contentDOM;
    const innerView = editor.view;
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
      text: innerView.state.doc.line(49).text,
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
    const fixtures = [
      { name: 'plain', before: 'Before\n\n', prefix: '' },
      { name: 'quote', before: 'Before\n\n', prefix: '> ' },
      { name: 'list', before: 'Before\n\n- Parent\n\n', prefix: '  ' },
      { name: 'nested-quote-list', before: 'Before\n\n> > - Parent\n> >\n', prefix: '> >   ' },
      { name: 'footnote', before: 'Before[^1]\n\n[^1]: Note\n\n', prefix: '    ' },
      { name: 'tab-prefix', before: 'Before\n\n- Parent\n\n', prefix: '\t', payload: '  A --> B' }
    ];
    for (const appearance of ['light', 'dark'] as const)
      for (const mode of ['stacked', 'side-by-side'] as const)
        for (const fixture of fixtures) await runNewlineMode(page, mode, fixture, appearance);
    await page.setViewport({ width: 1100, height: 360, deviceScaleFactor: 1 });
    await runMode(page, 'side-by-side');
    await runMode(page, 'stacked');
    console.log('Mermaid source input passed: 24 layout/container/theme cases, per-frame Enter, continuous typing, undo/redo and clipped-line viewport');
  } catch (error) {
    primaryError = error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
}

await main();
