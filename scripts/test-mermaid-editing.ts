import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-mermaid-editing-'));

function findBrowserExecutable(): string {
  const candidates = [
    process.env.MEO_TEST_BROWSER,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    throw new Error('No supported browser found. Set MEO_TEST_BROWSER to a Chrome or Edge executable.');
  }
  return executable;
}

async function waitForFrames(page: puppeteer.Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-mermaid-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await puppeteer.launch({
    executablePath: findBrowserExecutable(),
    headless: true,
    args: ['--no-sandbox']
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 720, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root { --meo-background:#202223; --meo-foreground:#e6edf3; --meo-code-background:#292d31; --meo-semantic-mutedForeground:#8b949e; --meo-semantic-codeCopyForeground:#79b8ff; --meo-semantic-codeCopyBackground:transparent; --meo-semantic-codeCopyHoverForeground:#79b8ff; --meo-semantic-codeCopyHoverBackground:#343a40; --vscode-editor-font-family:monospace; --vscode-editor-font-size:14px; --vscode-editor-line-height:20px; }'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    await page.evaluate(() => {
      (window as any).mermaid = {
        initialize() {},
        async render(_id: string, text: string) {
          return { svg: `<svg viewBox="0 0 320 120"><text x="10" y="30">${text.length}</text></svg>` };
        }
      };
      const lines = Array.from({ length: 24 }, (_, index) => `node${index + 1} --> node${index + 2}`);
      const text = ['```mermaid', 'graph TD', ...lines, '```', '', 'after'].join('\n');
      (window as any).__mermaidEditingEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await waitForFrames(page);

    const defaultMode = await page.evaluate(() => ({
      preview: Boolean(document.querySelector('.meo-mermaid-block')),
      editing: Boolean(document.querySelector('.meo-mermaid-editing-block')),
      buttonLabel: document.querySelector('.meo-mermaid-mode-btn')?.getAttribute('aria-label')
    }));
    if (!defaultMode.preview || defaultMode.editing || defaultMode.buttonLabel !== 'Edit Mermaid in split view') {
      throw new Error(`Unexpected default Mermaid mode: ${JSON.stringify(defaultMode)}`);
    }

    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    const splitMode = await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block.is-split')!;
      const source = block?.querySelector<HTMLElement>('.meo-mermaid-source-pane')!;
      const preview = block?.querySelector<HTMLElement>('.meo-mermaid-preview-shell')!;
      const sticky = block?.querySelector<HTMLElement>('.meo-mermaid-preview-sticky')!;
      const scroller = block?.querySelector<HTMLElement>('.meo-mermaid-source-editor .cm-scroller')!;
      return {
        sourceText: block?.querySelector('.meo-mermaid-source-editor')?.textContent ?? '',
        heightDelta: source && preview ? Math.abs(source.getBoundingClientRect().height - preview.getBoundingClientRect().height) : null,
        stickyPosition: sticky ? getComputedStyle(sticky).position : null,
        hasInternalVerticalScroll: Boolean(scroller && scroller.scrollHeight > scroller.clientHeight + 1),
        nextLabel: document.querySelector('.meo-mermaid-mode-btn')?.getAttribute('aria-label')
      };
    });
    if (!splitMode.sourceText.includes('node24 --> node25') || splitMode.heightDelta === null || splitMode.heightDelta > 1) {
      throw new Error(`Split mode did not show equal-height complete source: ${JSON.stringify(splitMode)}`);
    }
    if (splitMode.hasInternalVerticalScroll || splitMode.stickyPosition !== 'sticky' || splitMode.nextLabel !== 'Show Mermaid code only') {
      throw new Error(`Unexpected split mode controls or scrolling: ${JSON.stringify(splitMode)}`);
    }

    await page.click('.meo-mermaid-source-editor .cm-content');
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.type('node25 --> node26');
    await waitForFrames(page);
    const editedText = await page.evaluate(() =>
      (window as any).__mermaidEditingEditor.view.state.doc.toString()
    );
    if (!editedText.includes('node25 --> node26')) {
      throw new Error('Editing split source did not update the outer Markdown document');
    }
    await page.evaluate(() => (window as any).__mermaidEditingEditor.undo());
    await waitForFrames(page);
    const undoText = await page.evaluate(() =>
      (window as any).__mermaidEditingEditor.view.state.doc.toString()
    );
    if (undoText.includes('node25 --> node26')) {
      throw new Error('Outer editor undo did not revert Mermaid source editing');
    }
    await page.evaluate(() => (window as any).__mermaidEditingEditor.redo());
    await waitForFrames(page);
    const redoText = await page.evaluate(() =>
      (window as any).__mermaidEditingEditor.view.state.doc.toString()
    );
    if (!redoText.includes('node25 --> node26')) {
      throw new Error('Outer editor redo did not restore Mermaid source editing');
    }

    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    const codeMode = await page.evaluate(() => ({
      code: Boolean(document.querySelector('.meo-mermaid-editing-block.is-source')),
      preview: Boolean(document.querySelector('.meo-mermaid-preview-shell')),
      nextLabel: document.querySelector('.meo-mermaid-mode-btn')?.getAttribute('aria-label')
    }));
    if (!codeMode.code || codeMode.preview || codeMode.nextLabel !== 'Show Mermaid preview') {
      throw new Error(`Unexpected Mermaid code mode: ${JSON.stringify(codeMode)}`);
    }

    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    await page.evaluate(() => {
      const editor = (window as any).__mermaidEditingEditor;
      editor.setSearchQuery('node24');
      editor.findNext('node24', { focusEditor: false });
    });
    await waitForFrames(page);
    if (!(await page.$('.meo-mermaid-editing-block.is-split')) || !(await page.$('.meo-mermaid-source-editor .meo-search-match-active'))) {
      throw new Error('Search match did not temporarily reveal Mermaid split mode');
    }

    await page.evaluate(() => {
      const editor = (window as any).__mermaidEditingEditor;
      editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
    });
    await waitForFrames(page);
    if (!(await page.$('.meo-mermaid-block')) || (await page.$('.meo-mermaid-editing-block'))) {
      throw new Error('Moving the selection away did not restore Mermaid preview mode');
    }

    await page.evaluate(() => (window as any).__mermaidEditingEditor.findNext('node24', { focusEditor: false }));
    await waitForFrames(page);
    if (!(await page.$('.meo-mermaid-editing-block.is-split'))) {
      throw new Error('Search navigation did not reapply temporary Mermaid split mode');
    }

    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    if (!(await page.$('.meo-mermaid-editing-block.is-source')) || (await page.$('.meo-mermaid-preview-shell'))) {
      throw new Error('Manual mode change did not override temporary Mermaid split mode');
    }

    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    if (!(await page.$('.meo-mermaid-block')) || (await page.$('.meo-mermaid-editing-block'))) {
      throw new Error('Manual preview mode remained overridden by the previous search match');
    }

    await page.evaluate(() => (window as any).__mermaidEditingEditor.setSearchQuery(''));
    await waitForFrames(page);
    if (!(await page.$('.meo-mermaid-block')) || (await page.$('.meo-mermaid-editing-block'))) {
      throw new Error('Closing search did not restore Mermaid preview mode');
    }

    await page.setViewport({ width: 700, height: 720, deviceScaleFactor: 1 });
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    const narrowLayout = await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block.is-split')!;
      const source = block?.querySelector<HTMLElement>('.meo-mermaid-source-pane')!;
      const preview = block?.querySelector<HTMLElement>('.meo-mermaid-preview-shell')!;
      return {
        columns: block ? getComputedStyle(block).gridTemplateColumns.split(' ').length : 0,
        previewBelowSource: Boolean(source && preview && preview.getBoundingClientRect().top >= source.getBoundingClientRect().bottom - 1),
        stickyPosition: preview
          ? getComputedStyle(preview.querySelector<HTMLElement>('.meo-mermaid-preview-sticky')!).position
          : null
      };
    });
    if (narrowLayout.columns !== 1 || !narrowLayout.previewBelowSource || narrowLayout.stickyPosition !== 'relative') {
      throw new Error(`Unexpected narrow Mermaid split layout: ${JSON.stringify(narrowLayout)}`);
    }

    console.log('Mermaid editing checks passed');
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
