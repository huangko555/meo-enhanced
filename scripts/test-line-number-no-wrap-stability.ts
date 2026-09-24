import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-line-number-no-wrap-'));
const documentArgument = process.argv.find((argument) => argument.startsWith('--document='));
const lines = documentArgument
  ? fs.readFileSync(documentArgument.slice('--document='.length), 'utf8').split(/\r?\n/)
  : Array.from({ length: 170 }, (_, index) => `普通段落 ${index + 1}`);
if (!documentArgument) {
  const blocks = new Map<number, string>([
    [95, '## HTML blocks'], [96, ''], [97, '<p>'],
    [98, '  <strong>Bold</strong>, <em>italic</em>,'],
    [99, '  <code>inline</code>, <mark>highlight</mark>,'],
    [100, '  <kbd>Ctrl</kbd> + <kbd>Shift</kbd>,'],
    [101, '  H<sub>2</sub>O and x<sup>2</sup>.'],
    [102, '</p>'], [103, ''],
    [110, '<p><img src="assets/missing.png" alt="test" width="240"></p>'], [111, ''],
    [120, '<details open>'], [121, '  <summary>Summary</summary>'],
    [122, '  <p>Visible detail line</p>'], [123, '</details>'], [124, '']
  ]);
  for (const [lineNumber, value] of blocks) lines[lineNumber - 1] = value;
}
lines[93] = '5'.repeat(30);
const fixture = lines.join('\n');

const build = await Bun.build({
  entrypoints: [path.join(repoRoot, 'scripts/test-line-number-typing-stability-entry.ts')],
  outdir, target: 'browser', format: 'iife', naming: 'bundle.js'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: path.join(repoRoot, 'webview/src/styles.css') });
  await page.addStyleTag({ content: ':root { --meo-background:#24292e; --meo-foreground:#e6edf3; --meo-semantic-markdownSyntax:#8b949e; --meo-semantic-mutedForeground:#8b949e; --meo-font-live:Arial; --meo-font-live-weight:400; --meo-font-live-size:16px; }' });
  await page.addScriptTag({ path: path.join(outdir, 'bundle.js') });
  await page.evaluate(async (text) => {
    const editor = (window as any).LineNumberTypingHarness.createEditor({
      parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
    });
    (window as any).__editor = editor;
    editor.scrollToLine(94, 'top');
    for (let index = 0; index < 8; index++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const view = editor.view;
    view.dispatch({ selection: { anchor: view.state.doc.line(94).to } });
    view.focus();
    const gutter = view.dom.querySelector('.cm-lineNumbers')!;
    const reference = Array.from(gutter.querySelectorAll<HTMLElement>('.cm-gutterElement'))
      .find((element) => element.textContent?.trim() === '95');
    (window as any).__gutterReference = reference;
    (window as any).__htmlReference = view.dom.querySelector('.meo-md-html-block');
    const mutations: Array<{ type: string; target: string; oldValue: string | null }> = [];
    new MutationObserver((records) => {
      for (const record of records) mutations.push({
        type: record.type,
        target: (record.target as HTMLElement).textContent?.trim().slice(0, 20) ?? '',
        oldValue: record.oldValue
      });
    }).observe(gutter, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
    (window as any).__gutterMutations = mutations;
  }, fixture);

  const samples: Array<{ key: number; frame: number; gutterTop: number; scrollTop: number; lineHeight: number; mutationCount: number; sameNode: boolean; sameHtmlNode: boolean }> = [];
  const sample = async (key: number, frame: number) => {
    samples.push({ key, frame, ...await page.evaluate(() => {
      const view = (window as any).__editor.view;
      const gutter = Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement'))
        .find((element) => element.textContent?.trim() === '95');
      return {
        gutterTop: gutter?.getBoundingClientRect().top ?? NaN,
        scrollTop: view.scrollDOM.scrollTop,
        lineHeight: view.lineBlockAt(view.state.doc.line(94).from).height,
        mutationCount: (window as any).__gutterMutations.length,
        sameNode: gutter === (window as any).__gutterReference,
        sameHtmlNode: view.dom.querySelector('.meo-md-html-block') === (window as any).__htmlReference
      };
    }) });
  };
  await sample(-1, 0);
  for (const [operation, offset] of [['5', 0], ['Backspace', 20]] as const) {
    for (let key = 0; key < 20; key++) {
      await page.keyboard.press(operation);
      for (let frame = 0; frame < 3; frame++) {
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        await sample(offset + key, frame);
      }
    }
  }
  const baseline = samples[0]!;
  const shifted = samples.filter((item) => Math.abs(item.gutterTop - baseline.gutterTop) > 1);
  const scrollShifted = samples.filter((item) => Math.abs(item.scrollTop - baseline.scrollTop) > 1);
  const heightChanged = samples.filter((item) => Math.abs(item.lineHeight - baseline.lineHeight) > 1);
  const gutterMutations = await page.evaluate(() => (window as any).__gutterMutations);
  const replaced = samples.filter((item) => !item.sameNode || !item.sameHtmlNode);
  if (!Number.isFinite(baseline.gutterTop) || shifted.length || scrollShifted.length
    || heightChanged.length || replaced.length || gutterMutations.length) {
    throw new Error(`Downstream gutter repainted or moved during no-wrap editing: ${JSON.stringify({
      shifted: shifted.slice(0, 3), scrollShifted: scrollShifted.slice(0, 3),
      heightChanged: heightChanged.slice(0, 3), replaced: replaced.slice(0, 3),
      mutationCount: gutterMutations.length, mutations: gutterMutations.slice(0, 6)
    })}`);
  }
  if (!documentArgument) {
    const imageResult = await page.evaluate(async () => {
      const editor = (window as any).__editor;
      editor.scrollToLine(110, 'center');
      for (let index = 0; index < 4; index++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const image = editor.view.dom.querySelector<HTMLElement>(
        '.meo-md-html-block[data-meo-rendered-block-start-line="110"] .meo-md-image'
      );
      let activated: number | null = null;
      editor.view.dom.addEventListener('meo-activate-image', (event) => {
        activated = (event as CustomEvent<{ from: number }>).detail.from;
      }, { once: true });
      image?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return { found: Boolean(image), activated, expected: editor.view.state.doc.line(110).from };
    });
    if (!imageResult.found || imageResult.activated !== imageResult.expected) {
      throw new Error(`HTML image source offset became stale: ${JSON.stringify(imageResult)}`);
    }
    const detailsResult = await page.evaluate(async () => {
      const editor = (window as any).__editor;
      editor.scrollToLine(120, 'center');
      for (let index = 0; index < 4; index++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const selector = '.meo-md-html-block[data-meo-rendered-block-start-line="120"] details';
      const before = editor.view.dom.querySelector<HTMLDetailsElement>(selector);
      if (before) before.open = false;
      for (let index = 0; index < 6; index++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const after = editor.view.dom.querySelector<HTMLDetailsElement>(selector);
      return { found: Boolean(before), rebuilt: Boolean(after && after !== before), collapsed: after?.open === false };
    });
    if (!detailsResult.found || !detailsResult.rebuilt || !detailsResult.collapsed) {
      throw new Error(`HTML details toggle did not update state: ${JSON.stringify(detailsResult)}`);
    }
    const sourceResult = await page.evaluate(async () => {
      const editor = (window as any).__editor;
      editor.scrollToLine(97, 'center');
      for (let index = 0; index < 4; index++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const button = editor.view.dom.querySelector<HTMLButtonElement>(
        '.meo-md-html-block[data-meo-rendered-block-start-line="97"] .meo-md-html-source-toggle'
      );
      button?.click();
      return {
        found: Boolean(button), selection: editor.view.state.selection.main.head,
        expected: editor.view.state.doc.line(97).from,
        sourceVisible: Boolean(editor.view.dom.querySelector('.meo-md-html-source-range-start'))
      };
    });
    if (!sourceResult.found || sourceResult.selection !== sourceResult.expected || !sourceResult.sourceVisible) {
      throw new Error(`HTML source toggle offset became stale: ${JSON.stringify(sourceResult)}`);
    }
  }
  console.log('No-wrap typing/deletion preserved the gutter and HTML widgets');
} finally {
  await browser.close();
  fs.rmSync(outdir, { recursive: true, force: true });
}
