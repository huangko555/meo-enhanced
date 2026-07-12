import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-stability-'));

function findBrowserExecutable(): string {
  const candidates = [
    process.env.MEO_TEST_BROWSER,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    throw new Error('No supported browser found. Set MEO_TEST_BROWSER to a Chrome or Edge executable.');
  }
  return executable;
}

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-table-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) {
    throw new Error(build.logs.map(String).join('\n'));
  }

  const browser = await puppeteer.launch({
    executablePath: findBrowserExecutable(),
    headless: true,
    args: ['--no-sandbox']
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><button id="outside">outside</button><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: ':root { --meo-background:#202223; --meo-foreground:#e6edf3; --meo-caret:#e6edf3; --meo-semantic-tableBorder:#474b50; --meo-semantic-tableSelectionBorder:#79b8ff; --meo-semantic-searchMatchForeground:#202223; --meo-semantic-searchMatchBackground:#ffe600; --meo-semantic-searchMatchBorder:#ffe600; --meo-semantic-searchMatchActiveForeground:#202223; --meo-semantic-searchMatchActiveBackground:#ff8c00; --meo-semantic-searchMatchActiveBorder:#ff8c00; }' });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const result = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      const waitFrames = async (count = 3) => {
        for (let index = 0; index < count; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      const create = async (text: string) => {
        app.replaceChildren();
        const editor = harness.createEditor({
          parent: app,
          text,
          initialMode: 'live',
          onApplyChanges() {}
        });
        await waitFrames();
        return editor;
      };

      const editingEditor = await create('| A |\n| --- |\n| asd |');
      editingEditor.setSearchQuery('asd');
      editingEditor.findNext('asd', { focusEditor: false });
      await waitFrames();
      const editingInput = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      editingInput.focus();
      editingInput.value = 'asdx';
      editingInput.setSelectionRange(4, 4);
      editingInput.dispatchEvent(new Event('input', { bubbles: true }));
      await waitFrames(1);
      const editingPreviewText = editingInput.parentElement?.querySelector('.meo-md-html-table-cell-preview')?.textContent ?? '';
      editingEditor.destroy();

      const positionEditor = await create('| A |\n| --- |\n| value |');
      const lineBefore = document.querySelector('.meo-md-html-table-line-number')?.textContent ?? '';
      positionEditor.view.dispatch({ changes: { from: 0, insert: 'intro\n' } });
      await waitFrames();
      const lineAfter = document.querySelector('.meo-md-html-table-line-number')?.textContent ?? '';
      const regularLineNumber = Array.from(document.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement'))
        .find((item) => item.textContent?.trim() === '1');
      const tableLineNumber = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table-line-number'))
        .find((item) => item.textContent?.trim() === '2');
      const textRight = (element: HTMLElement): number => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect().right;
      };
      const lineNumberRightDelta = regularLineNumber && tableLineNumber
        ? textRight(tableLineNumber) - textRight(regularLineNumber)
        : null;
      const lineNumberNodeBeforeScroll = document.querySelector('.meo-md-html-table-line-number');
      positionEditor.view.scrollDOM.dispatchEvent(new Event('scroll'));
      await waitFrames();
      const lineNumberNodeAfterScroll = document.querySelector('.meo-md-html-table-line-number');
      const lineNumberNodeReused = lineNumberNodeBeforeScroll === lineNumberNodeAfterScroll;
      positionEditor.destroy();

      const interactionEditor = await create('| A |\n| --- |\n| old |');
      const interactionInput = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      interactionInput.focus();
      interactionInput.value = 'new';
      interactionInput.dispatchEvent(new Event('input', { bubbles: true }));
      (document.getElementById('outside') as HTMLButtonElement).focus();
      await waitFrames();
      const interactionActive = interactionEditor.view.dom.classList.contains('meo-table-interaction-active');
      interactionEditor.destroy();

      const borderlessEditor = await create('A | B\n--- | ---\nasd | value');
      borderlessEditor.setSearchQuery('asd');
      borderlessEditor.findNext('asd', { focusEditor: false });
      await waitFrames();
      const borderlessActiveMatch = Boolean(document.querySelector('tbody .meo-search-match-active'));
      borderlessEditor.destroy();

      const alignmentEditor = await create('| A | B |\n| --- | --- |\n| one | two |');
      document.querySelector<HTMLTextAreaElement>('tbody textarea')!.focus();
      await waitFrames(1);
      document.querySelector<HTMLButtonElement>('button[title="Align selected column left"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      await waitFrames();
      const alignmentBeforeShift = document.querySelector<HTMLTableCellElement>('thead th')?.style.textAlign ?? '';
      alignmentEditor.view.dispatch({ changes: { from: 0, insert: 'intro\n' } });
      await waitFrames();
      const alignmentAfterShift = document.querySelector<HTMLTableCellElement>('thead th')?.style.textAlign ?? '';
      alignmentEditor.destroy();

      const performanceEditor = await create(Array.from({ length: 800 }, (_, index) => `line ${index} asd`).join('\n'));
      const originalToLocaleLowerCase = String.prototype.toLocaleLowerCase;
      let fullDocumentScans = 0;
      String.prototype.toLocaleLowerCase = function (...args: Parameters<String['toLocaleLowerCase']>) {
        if (String(this).length > 1_000) fullDocumentScans += 1;
        return originalToLocaleLowerCase.apply(String(this), args);
      };
      performanceEditor.setSearchQuery('asd');
      await waitFrames();
      const scansAfterQuery = fullDocumentScans;
      for (let index = 0; index < 12; index += 1) {
        performanceEditor.findNext('asd', { focusEditor: false });
      }
      await waitFrames();
      const navigationScans = fullDocumentScans - scansAfterQuery;
      String.prototype.toLocaleLowerCase = originalToLocaleLowerCase;
      performanceEditor.destroy();

      return {
        editingPreviewText,
        lineBefore,
        lineAfter,
        lineNumberRightDelta,
        lineNumberNodeReused,
        interactionActive,
        borderlessActiveMatch,
        alignmentBeforeShift,
        alignmentAfterShift,
        navigationScans
      };
    });

    const failures: string[] = [];
    if (result.editingPreviewText !== 'asdx') failures.push(`editing preview remained ${JSON.stringify(result.editingPreviewText)}`);
    if (result.lineBefore !== '1' || result.lineAfter !== '2') failures.push(`table line number stayed ${result.lineBefore} -> ${result.lineAfter}`);
    if (result.lineNumberRightDelta === null || Math.abs(result.lineNumberRightDelta) > 0.5) {
      failures.push(`table line number right edge was offset by ${result.lineNumberRightDelta}px`);
    }
    if (!result.lineNumberNodeReused) failures.push('table line number DOM was recreated during scroll');
    if (result.interactionActive) failures.push('table interaction remained active after keyboard focus exit');
    if (!result.borderlessActiveMatch) failures.push('borderless table did not render the active search match');
    if (result.alignmentBeforeShift !== 'left' || result.alignmentAfterShift !== 'left') {
      failures.push(`manual header alignment changed after line shift: ${result.alignmentBeforeShift} -> ${result.alignmentAfterShift}`);
    }
    if (result.navigationScans > 0) failures.push(`search navigation rescanned the full document ${result.navigationScans} times`);
    if (failures.length) throw new Error(failures.join('\n'));
    console.log('table stability checks passed');
  } finally {
    await browser.close();
  }
}

main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
