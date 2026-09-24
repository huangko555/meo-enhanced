import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-html-enter-gutter-'));
const lines = Array.from({ length: 110 }, (_, index) => `普通段落 ${index + 1}`);
for (const [lineNumber, text] of new Map<number, string>([
  [94, ''], [95, '## HTML'], [96, ''],
  [97, '<p>'], [98, '  First paragraph.'], [99, '  <strong>Bold</strong> and <em>italic</em>.'],
  [100, '  <mark>Highlighted</mark> text.'], [101, '  <code>const inline = true</code>.'],
  [102, '  <kbd>Ctrl</kbd> + <kbd>Enter</kbd>.'], [103, '  Last line.'],
  [104, '</p>'], [105, ''],
  [106, '<p>'], [107, '  <strong>Second paragraph</strong>.'],
  [108, '  <em>Other text</em>.'], [109, '  Last line.'], [110, '</p>']
])) lines[lineNumber - 1] = text;

const build = await Bun.build({
  entrypoints: [path.join(repoRoot, 'scripts/test-line-number-typing-stability-entry.ts')],
  outdir, target: 'browser', format: 'iife', naming: 'bundle.js'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1150, height: 700, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: path.join(repoRoot, 'webview/src/styles.css') });
  await page.addStyleTag({ content: ':root { --meo-background:#24292e; --meo-foreground:#e6edf3; --meo-semantic-markdownSyntax:#8b949e; --meo-semantic-mutedForeground:#8b949e; --meo-font-live:Arial; --meo-font-live-weight:400; --meo-font-live-size:16px; }' });
  await page.addScriptTag({ path: path.join(outdir, 'bundle.js') });
  const setup = await page.evaluate(async (text) => {
    const editor = (window as any).LineNumberTypingHarness.createEditor({
      parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
    });
    (window as any).__editor = editor;
    editor.scrollToLine(97, 'center');
    for (let index = 0; index < 10; index++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const toggle = editor.view.dom.querySelector<HTMLButtonElement>(
      '.meo-md-html-block[data-meo-rendered-block-start-line="97"] .meo-md-html-source-toggle'
    );
    toggle?.click();
    for (let index = 0; index < 8; index++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const view = editor.view;
    const line = view.state.doc.line(101);
    view.dispatch({ selection: { anchor: line.from + line.text.indexOf('true') } });
    view.focus();
    for (let index = 0; index < 5; index++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const gutter = view.dom.querySelector('.cm-lineNumbers')!;
    const ids = new WeakMap<Element, number>();
    let nextId = 1;
    const changes: Array<{ id: number; line: string; before: number; after: number }> = [];
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type !== 'attributes' || record.attributeName !== 'style') continue;
        const row = (record.target as HTMLElement).closest<HTMLElement>('.cm-gutterElement');
        if (!row) continue;
        if (!ids.has(row)) ids.set(row, nextId++);
        const height = (style: string | null) => Number(/^height:\s*([\d.]+)px/.exec(style ?? '')?.[1]);
        const before = height(record.oldValue);
        const after = height(row.getAttribute('style'));
        if (Number.isFinite(before) && Number.isFinite(after) && Math.abs(before - after) > 1) {
          changes.push({ id: ids.get(row)!, line: row.textContent?.trim() ?? '', before, after });
        }
      }
    }).observe(gutter, { subtree: true, attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    (window as any).__gutterHeightChanges = changes;
    return { sourceVisible: Boolean(view.dom.querySelector('.meo-md-html-source-range-start')),
      selectedLine: view.state.doc.lineAt(view.state.selection.main.head).number };
  }, lines.join('\n'));
  if (!setup.sourceVisible || setup.selectedLine !== 101) {
    throw new Error(`HTML source editing setup failed: ${JSON.stringify(setup)}`);
  }

  await page.keyboard.press('Enter');
  await page.evaluate(async () => {
    for (let index = 0; index < 4; index++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  const result = await page.evaluate(() => ({
    lines: (window as any).__editor.view.state.doc.lines,
    changes: (window as any).__gutterHeightChanges as Array<{ id: number; line: string; before: number; after: number }>
  }));
  const flickers = result.changes.filter((change, index) => result.changes.slice(index + 1).some((later) => (
    later.id === change.id && later.line === change.line
      && Math.abs(later.before - change.after) < 0.5
      && Math.abs(later.after - change.before) < 0.5
  )));
  if (result.lines !== 111 || flickers.length) {
    throw new Error(`HTML Enter caused a gutter height bounce: ${JSON.stringify({
      lines: result.lines, flickers: flickers.slice(0, 5)
    })}`);
  }
  console.log('HTML source Enter kept downstream gutter heights stable');
} finally {
  await browser.close();
  fs.rmSync(outdir, { recursive: true, force: true });
}
