import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-rendered-gutter-'));
const build = await Bun.build({
  entrypoints: [path.join(repoRoot, 'scripts/test-line-number-typing-stability-entry.ts')],
  outdir, target: 'browser', format: 'iife', naming: 'bundle.js'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const minimalKind = process.argv.find((argument) => argument.startsWith('--minimal='))?.split('=')[1];
const editLine = minimalKind ? 20 : 1156;
const fixture = minimalKind ? [
  ...Array.from({ length: editLine - 1 }, (_, index) => `前置行 ${index + 1}`),
  '2'.repeat(30), '',
  ...(minimalKind === 'math' ? ['$$', '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}', '$$'] : ['```mermaid', 'graph LR', '  A[列表项] --> B[Mermaid]', '```']),
  ...Array.from({ length: 60 }, (_, index) => `后置行 ${index + 1}`)
].join('\n') : [
  ...Array.from({ length: 1155 }, (_, index) => `前置行 ${index + 1}`),
  '**' + '2'.repeat(30), '222', '',
  '| Markdown | Example |', '| --- | --- |',
  '| Inline code | `const x = 1` |', '| Link | [example](https://example.com) |',
  '| Strike | ~~old value~~ |', '| Bold + italic | **bold** and *italic* |',
  '| Tag | #table/tag |',
  '- 一级列表：Mermaid 应保持相同缩进。', '',
  '  ```mermaid', '  graph LR', '    A[列表项] --> B[Mermaid]', '  ```',
  '- 一级列表：块级公式应保持相同缩进。', '',
  '  $$', '  \\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}', '  $$', '',
  '  - 二级列表：代码块', '',
  '    ```javascript', "    const item = '二级列表';", '    console.log(item);', '    ```', '',
  ...Array.from({ length: 60 }, (_, index) => `后置行 ${index + 1}`)
].join('\n');

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1068, height: 1000, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div class="editor-host" id="app"></div>');
  await page.addStyleTag({ path: path.join(repoRoot, 'webview/src/styles.css') });
  await page.addStyleTag({ content: ':root { --meo-background:#24292e; --meo-foreground:#e6edf3; --meo-semantic-markdownSyntax:#8b949e; --meo-semantic-mutedForeground:#8b949e; --meo-font-live:Arial; --meo-font-live-weight:400; --meo-font-live-size:16px; }' });
  await page.addScriptTag({ path: path.join(repoRoot, 'node_modules/mermaid/dist/mermaid.min.js') });
  const katexDirectory = path.join(repoRoot, 'node_modules/katex/dist');
  const katexStyles = fs.readFileSync(path.join(katexDirectory, 'katex.min.css'), 'utf8')
    .replace(/url\(([^)]+)\)/g, (_match, fontPath) => `url(data:font/woff2;base64,${fs.readFileSync(path.join(katexDirectory, fontPath)).toString('base64')})`);
  await page.addStyleTag({ content: katexStyles });
  await page.addScriptTag({ path: path.join(outdir, 'bundle.js') });
  await page.evaluate(async ({ text, line }) => {
    const editor = (window as any).LineNumberTypingHarness.createEditor({
      parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
    });
    (window as any).__editor = editor;
    (window as any).__editLine = line;
    editor.scrollToLine(line, 'top');
    const view = editor.view;
    view.dispatch({ selection: { anchor: view.state.doc.line(line).to } });
    view.focus();
    for (let index = 0; index < 30; index++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, { text: fixture, line: editLine });
  await page.waitForFunction((kind) => kind === 'math'
    || Boolean(document.querySelector('.meo-mermaid-svg-wrapper svg')), {}, minimalKind);
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (let index = 0; index < 8; index++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await page.evaluate(() => {
    const view = (window as any).__editor.view;
    const blockNodes = Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.meo-rendered-block-preview'));
    const read = () => ({
      scrollTop: view.scrollDOM.scrollTop,
      editedText: view.state.doc.line((window as any).__editLine).text,
      editedHeight: view.lineBlockAt(view.state.doc.line((window as any).__editLine).from).height,
      gutters: Array.from(view.dom.querySelectorAll<HTMLElement>(':scope > .cm-scroller > .cm-gutters > .cm-lineNumbers > .cm-gutterElement, .meo-md-html-table-line-number'))
        .filter((element) => /^\d+$/.test(element.textContent?.trim() ?? '') && element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== 'hidden')
        .map((element) => ({ line: element.textContent!.trim(), top: element.getBoundingClientRect().top, height: element.getBoundingClientRect().height })),
      blocks: Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.meo-rendered-block-preview'))
        .map((element, index) => ({ top: element.getBoundingClientRect().top, height: element.getBoundingClientRect().height, sameNode: element === blockNodes[index] }))
    });
    (window as any).__baseline = read();
    (window as any).__samples = [];
    const sample = () => {
      (window as any).__samples.push(read());
      (window as any).__sampleFrame = requestAnimationFrame(sample);
    };
    (window as any).__sampleFrame = requestAnimationFrame(sample);
  });
  for (const operation of ['2', 'Backspace']) {
    for (let key = 0; key < 8; key++) {
      await page.keyboard.press(operation);
      await page.evaluate(async () => {
        for (let frame = 0; frame < 6; frame++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
    }
  }
  const result = await page.evaluate(() => {
    cancelAnimationFrame((window as any).__sampleFrame);
    const baseline = (window as any).__baseline;
    const samples = (window as any).__samples;
    const drifted: unknown[] = [];
    const changedBlocks: unknown[] = [];
    for (const [frame, sample] of samples.entries()) {
      if (sample.blocks.length !== baseline.blocks.length || sample.blocks.some((block: any, index: number) =>
        Math.abs(block.top - baseline.blocks[index].top) > 1 || Math.abs(block.height - baseline.blocks[index].height) > 1)) {
        changedBlocks.push({ frame, blocks: sample.blocks });
      }
      if (Math.abs(sample.scrollTop - baseline.scrollTop) > 1 || Math.abs(sample.editedHeight - baseline.editedHeight) > 1) {
        throw new Error(`Unexpected scroll or wrap during no-wrap test: ${JSON.stringify({ frame, sample })}`);
      }
      for (const expected of baseline.gutters) {
        const actual = sample.gutters.find((item: any) => item.line === expected.line);
        if (!actual || Math.abs(actual.top - expected.top) > 1 || Math.abs(actual.height - expected.height) > 1) {
          drifted.push({ frame, expected, actual, scrollTop: sample.scrollTop, editedHeight: sample.editedHeight, blocks: sample.blocks });
        }
      }
    }
    const editor = (window as any).__editor;
    if (Math.max(...samples.map((sample: any) => sample.editedText.length)) !== baseline.editedText.length + 8
      || editor.view.state.doc.line((window as any).__editLine).text !== baseline.editedText) {
      throw new Error('Typing/deletion did not modify and restore the target text');
    }
    return { baseline: { gutters: baseline.gutters.length, blocks: baseline.blocks.length }, frames: samples.length,
      driftCount: drifted.length, drifted: drifted.slice(0, 12), changedBlocks: changedBlocks.slice(0, 3) };
  });
  const expectedBlocks = minimalKind ? 1 : 2;
  if (result.baseline.blocks !== expectedBlocks) throw new Error(`Missing rendered preview: ${JSON.stringify(result)}`);
  if (result.baseline.gutters < 10 || result.frames < 80) throw new Error(`Insufficient visible-frame coverage: ${JSON.stringify(result)}`);
  if (result.changedBlocks.length) throw new Error(`Unchanged preview blocks moved: ${JSON.stringify(result)}`);
  if (result.driftCount) throw new Error(`Rendered-block gutter moved during no-wrap input: ${JSON.stringify(result)}`);

  if (minimalKind !== 'mermaid') {
    const changed = await page.evaluate(async () => {
      const view = (window as any).__editor.view;
      const before = view.contentDOM.querySelector<HTMLElement>('.meo-rendered-block-preview[data-meo-rendered-block-kind="math"]')!;
      const oldHeight = before.getBoundingClientRect().height;
      const oldNextLine = Number(before.dataset.meoRenderedBlockEndLine) + 1;
      const oldGutter = Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement'))
        .find((element) => element.textContent?.trim() === String(oldNextLine))!;
      const alignmentOffset = oldGutter.getBoundingClientRect().top
        - view.coordsAtPos(view.state.doc.line(oldNextLine).from)!.top;
      const fromLine = Number(before.dataset.meoRenderedBlockStartLine);
      const sourceLine = view.state.doc.line(fromLine + 1);
      const indent = sourceLine.text.match(/^\s*/)?.[0] ?? '';
      view.dispatch({ changes: { from: sourceLine.from, to: sourceLine.to,
        insert: indent + '\\begin{matrix}1\\\\2\\\\3\\\\4\\end{matrix}' } });
      for (let frame = 0; frame < 12; frame++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const after = view.contentDOM.querySelector<HTMLElement>('.meo-rendered-block-preview[data-meo-rendered-block-kind="math"]')!;
      const nextLine = Number(after.dataset.meoRenderedBlockEndLine) + 1;
      const gutter = Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement'))
        .find((element) => element.textContent?.trim() === String(nextLine))!;
      const contentTop = view.coordsAtPos(view.state.doc.line(nextLine).from)!.top;
      return { oldHeight, newHeight: after.getBoundingClientRect().height,
        gutterTop: gutter.getBoundingClientRect().top, contentTop, alignmentOffset };
    });
    if (Math.abs(changed.newHeight - changed.oldHeight) < 10 || Math.abs(changed.gutterTop - changed.contentTop - changed.alignmentOffset) > 1) {
      throw new Error(`Changed formula retained stale preview geometry: ${JSON.stringify(changed)}`);
    }
    console.log('Changed formula remeasured its preview and downstream gutter');
  }

  console.log(`Rendered-block gutter stayed stable through ${result.frames} typing/deletion frames`);
} finally {
  await browser.close();
  fs.rmSync(outdir, { recursive: true, force: true });
}
