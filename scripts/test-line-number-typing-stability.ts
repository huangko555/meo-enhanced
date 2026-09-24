import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import { createLargeDocumentFixtures } from './large-document-fixtures';

const repoRoot = path.resolve(import.meta.dir, '..');
const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-line-number-typing-'));
const build = await Bun.build({
  entrypoints: [path.join(repoRoot, 'scripts/test-line-number-typing-stability-entry.ts')],
  outdir, target: 'browser', format: 'iife', naming: 'bundle.js'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const longDocument = process.argv.includes('--long');
const targetLines = longDocument ? [80, 4_500, 8_900] : [20];
const inputCount = 105;
const shortFixture = [
  ...Array.from({ length: 19 }, (_, index) => `前置行 ${index + 1}`),
  '5'.repeat(165),
  '后续第一行',
  ...Array.from({ length: 100 }, (_, index) => `后置行 ${index + 1}`)
].join('\n');
const fixture = longDocument
  ? createLargeDocumentFixtures().find((item) => item.kind === 'lines-heavy')!.text
    .split('\n').map((line, index) => targetLines.includes(index + 1) ? '5'.repeat(165) : line).join('\n')
  : shortFixture;

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: path.join(repoRoot, 'webview/src/styles.css') });
  await page.addStyleTag({ content: ':root { --meo-background:#24292e; --meo-foreground:#e6edf3; --meo-semantic-markdownSyntax:#8b949e; --meo-semantic-mutedForeground:#8b949e; --meo-font-live:Arial; --meo-font-live-weight:400; --meo-font-live-size:16px; }' });
  await page.addScriptTag({ path: path.join(outdir, 'bundle.js') });
  await page.evaluate((text) => {
    (window as any).__editor = (window as any).LineNumberTypingHarness.createEditor({
      parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
    });
  }, fixture);
  for (const targetLine of targetLines) {
    await page.evaluate(async (lineNumber) => {
      const editor = (window as any).__editor;
      (window as any).__targetLine = lineNumber;
      editor.scrollToLine(lineNumber, 'top');
      for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const view = editor.view;
      view.dispatch({ selection: { anchor: view.state.doc.line(lineNumber).to } });
      view.focus();
    }, targetLine);

    const samples: Array<{ key: number; frame: number; gutterTop: number; contentTop: number; editedLineHeight: number; editedLineLength: number }> = [];
    const sample = async (key: number, frame: number) => {
      const value = await page.evaluate(() => {
        const view = (window as any).__editor.view;
        const gutter = Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement'))
          .find((element) => element.textContent?.trim() === String((window as any).__targetLine + 1));
        const nextLine = view.state.doc.line((window as any).__targetLine + 1);
        const editedLine = view.state.doc.line((window as any).__targetLine);
        return {
          gutterTop: gutter?.getBoundingClientRect().top ?? NaN,
          contentTop: view.coordsAtPos(nextLine.from)?.top ?? NaN,
          editedLineHeight: view.lineBlockAt(editedLine.from).height,
          editedLineLength: editedLine.length
        };
      });
      samples.push({ key, frame, ...value });
    };
    await sample(-1, 0);
    for (const [operation, keyOffset] of [['5', 0], ['Backspace', inputCount]] as const) {
      for (let key = 0; key < inputCount; key++) {
        await page.keyboard.press(operation);
        for (let frame = 0; frame < 2; frame++) {
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
          await sample(keyOffset + key, frame);
        }
      }
    }
    const baseline = samples[0]!;
    const drifted = samples.filter((entry) => !Number.isFinite(entry.gutterTop)
      || !Number.isFinite(entry.contentTop)
      || Math.abs((entry.gutterTop - entry.contentTop) - (baseline.gutterTop - baseline.contentTop)) > 2);
    const maximumHeight = Math.max(...samples.map((entry) => entry.editedLineHeight));
    if (maximumHeight < baseline.editedLineHeight + 40
      || samples.at(-1)?.editedLineLength !== baseline.editedLineLength) {
      throw new Error(`Line ${targetLine} did not cross two visual wraps and restore its text length`);
    }
    if (drifted.length) {
      throw new Error(`Line ${targetLine + 1} gutter drifted from content: ${JSON.stringify(drifted.slice(0, 8))}`);
    }
    console.log(`Line ${targetLine}: gutter stayed aligned through wrapping and deletion`);
  }
  await page.close();
} finally {
  await browser.close();
  fs.rmSync(outdir, { recursive: true, force: true });
}
