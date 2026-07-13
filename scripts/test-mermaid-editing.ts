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
      content: ':root { --meo-background:#202223; --meo-foreground:#e6edf3; --meo-code-background:#292d31; --meo-font-live:Arial; --meo-font-live-weight:400; --meo-font-live-size:16px; --meo-font-source:"Courier New"; --meo-font-source-weight:500; --meo-font-source-size:14px; --meo-semantic-mutedForeground:#8b949e; --meo-semantic-codeCopyForeground:#79b8ff; --meo-semantic-codeCopyBackground:transparent; --meo-semantic-codeCopyHoverForeground:#79b8ff; --meo-semantic-codeCopyHoverBackground:#343a40; --vscode-editor-font-family:monospace; --vscode-editor-font-size:14px; --vscode-editor-line-height:20px; }'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    await page.evaluate(() => {
      (window as any).mermaid = {
        initialize() {},
        async render(_id: string, text: string) {
          const height = text.includes('TALL_PREVIEW') ? 900 : 120;
          const width = text.includes('TALL_PREVIEW') ? 320 : 1200;
          const resolvedHeight = text.includes('TALL_PREVIEW') ? height : 400;
          return { svg: `<svg width="${width}" height="${resolvedHeight}" viewBox="0 0 ${width} ${resolvedHeight}"><text x="10" y="30">${text.length}</text></svg>` };
        }
      };
      (window as any).__collectMermaidCodeStyle = (blockSelector: string) => {
        const block = document.querySelector<HTMLElement>(blockSelector)!;
        const editor = block?.querySelector<HTMLElement>('.meo-mermaid-source-editor')!;
        const sourceLines = editor ? Array.from(editor.querySelectorAll<HTMLElement>('.cm-line')) : [];
        const sourceLine = sourceLines[1] ?? sourceLines[0];
        const normalLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line.meo-md-code-block'))
          .find((line) => line.textContent?.includes('normalCodeStyle'))!;
        const sourceStyle = sourceLine ? getComputedStyle(sourceLine) : null;
        const normalStyle = normalLine ? getComputedStyle(normalLine) : null;
        const firstOpaqueBackground = (element: HTMLElement | null): string | null => {
          for (let current = element; current && block?.contains(current); current = current.parentElement) {
            const background = getComputedStyle(current).backgroundColor;
            if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') {
              return background;
            }
          }
          return null;
        };
        return {
          sourceStyle: [
            firstOpaqueBackground(sourceLine),
            sourceStyle?.fontFamily ?? null,
            sourceStyle?.fontSize ?? null,
            sourceStyle?.fontWeight ?? null,
            sourceStyle?.lineHeight ?? null
          ],
          normalStyle: [
            normalStyle?.backgroundColor ?? null,
            normalStyle?.fontFamily ?? null,
            normalStyle?.fontSize ?? null,
            normalStyle?.fontWeight ?? null,
            normalStyle?.lineHeight ?? null
          ],
          sourceLayers: {
            editor: editor?.querySelector<HTMLElement>('.cm-editor')
              ? getComputedStyle(editor.querySelector<HTMLElement>('.cm-editor')!).backgroundColor
              : null,
            scroller: editor?.querySelector<HTMLElement>('.cm-scroller')
              ? getComputedStyle(editor.querySelector<HTMLElement>('.cm-scroller')!).backgroundColor
              : null,
            content: editor?.querySelector<HTMLElement>('.cm-content')
              ? getComputedStyle(editor.querySelector<HTMLElement>('.cm-content')!).backgroundColor
              : null,
            line: sourceStyle?.backgroundColor ?? null
          }
        };
      };
      const lines = Array.from({ length: 48 }, (_, index) => `node${index + 1} --> node${index + 2}`);
      const text = [
        '```mermaid',
        'graph TD',
        ...lines,
        '```',
        '',
        'after',
        '',
        '$$',
        '\\frac{a}{b}',
        '$$'
      ].join('\n');
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
      previewHeight: document.querySelector<HTMLElement>('.meo-mermaid-block')?.getBoundingClientRect().height ?? 0,
      editing: Boolean(document.querySelector('.meo-mermaid-editing-block')),
      buttonLabel: document.querySelector('.meo-mermaid-mode-btn')?.getAttribute('aria-label')
    }));
    if (!defaultMode.preview || defaultMode.editing || defaultMode.buttonLabel !== 'Edit Mermaid in split view') {
      throw new Error(`Unexpected default Mermaid mode: ${JSON.stringify(defaultMode)}`);
    }

    await page.evaluate(() => (window as any).__mermaidEditingEditor.scrollToLine(26, 'upper'));
    await waitForFrames(page);
    const lineJumpMode = await page.evaluate(() => {
      const innerView = (document.querySelector<HTMLElement>('.meo-mermaid-editing-block') as any)
        ?.__meoMermaidEditingController?.innerView;
      const selection = innerView?.state.selection.main;
      return {
        source: Boolean(document.querySelector('.meo-mermaid-editing-block.is-source')),
        selectedLine: selection ? innerView.state.doc.lineAt(selection.from).text : null
      };
    });
    if (!lineJumpMode.source || lineJumpMode.selectedLine !== 'node24 --> node25') {
      throw new Error(`Line jump did not reveal the target Mermaid source line: ${JSON.stringify(lineJumpMode)}`);
    }
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);

    await page.evaluate(() => (window as any).__mermaidEditingEditor.scrollToLine(56, 'upper'));
    await waitForFrames(page);
    const latexLineJumpMode = await page.evaluate(() => {
      const innerView = (document.querySelector<HTMLElement>('.meo-latex-math-editing-block') as any)
        ?.__meoLatexMathEditingController?.innerView;
      const selection = innerView?.state.selection.main;
      return {
        source: Boolean(document.querySelector('.meo-latex-math-editing-block.is-source')),
        selectedLine: selection ? innerView.state.doc.lineAt(selection.from).text : null
      };
    });
    if (!latexLineJumpMode.source || latexLineJumpMode.selectedLine !== '\\frac{a}{b}') {
      throw new Error(`Line jump did not reveal the target LaTeX source line: ${JSON.stringify(latexLineJumpMode)}`);
    }
    await page.click('.meo-latex-math-mode-btn');
    await page.evaluate(() => (window as any).__mermaidEditingEditor.scrollToLine(1, 'top'));
    await waitForFrames(page);

    await page.click('.meo-mermaid-toolbar .meo-select-all-code-btn');
    await waitForFrames(page);
    const selectAllMode = await page.evaluate(() => {
      const innerView = (document.querySelector<HTMLElement>('.meo-mermaid-editing-block') as any)
        ?.__meoMermaidEditingController?.innerView;
      const selection = innerView?.state.selection.main;
      return {
        source: Boolean(document.querySelector('.meo-mermaid-editing-block.is-source')),
        selectedText: selection ? innerView.state.doc.sliceString(selection.from, selection.to) : null,
        controls: Array.from(document.querySelector('.meo-mermaid-toolbar')?.children ?? [])
          .map((element) => element.getAttribute('aria-label') ?? element.textContent)
      };
    });
    if (!selectAllMode.source || !selectAllMode.selectedText?.startsWith('graph TD\nnode1 --> node2')) {
      throw new Error(`Mermaid select all did not reveal and select source: ${JSON.stringify(selectAllMode)}`);
    }
    if (selectAllMode.controls.at(-2) !== 'Select all code' || selectAllMode.controls.at(-1) !== 'Copy code') {
      throw new Error(`Unexpected Mermaid action order: ${JSON.stringify(selectAllMode.controls)}`);
    }
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);

    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    const splitMode = await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block.is-split')!;
      const source = block?.querySelector<HTMLElement>('.meo-mermaid-source-pane')!;
      const sourceSticky = block?.querySelector<HTMLElement>('.meo-mermaid-source-sticky')!;
      const preview = block?.querySelector<HTMLElement>('.meo-mermaid-preview-shell')!;
      const sticky = block?.querySelector<HTMLElement>('.meo-mermaid-preview-sticky')!;
      const previewBlock = block?.querySelector<HTMLElement>('.meo-mermaid-preview-sticky > .meo-mermaid-block')!;
      const scroller = block?.querySelector<HTMLElement>('.meo-mermaid-source-editor .cm-scroller')!;
      return {
        sourceText: block?.querySelector('.meo-mermaid-source-editor')?.textContent ?? '',
        heightDelta: source && preview ? Math.abs(source.getBoundingClientRect().height - preview.getBoundingClientRect().height) : null,
        sourceHeight: sourceSticky?.getBoundingClientRect().height ?? 0,
        sourcePaneHeight: source?.getBoundingClientRect().height ?? 0,
        sourceStickyPosition: sourceSticky ? getComputedStyle(sourceSticky).position : null,
        previewHeight: previewBlock?.getBoundingClientRect().height ?? 0,
        previewFrameHeight: sticky?.getBoundingClientRect().height ?? 0,
        stickyPosition: sticky ? getComputedStyle(sticky).position : null,
        hasInternalVerticalScroll: Boolean(scroller && scroller.scrollHeight > scroller.clientHeight + 1),
        nextLabel: document.querySelector('.meo-mermaid-mode-btn')?.getAttribute('aria-label')
      };
    });
    if (!splitMode.sourceText.includes('node24 --> node25') || splitMode.heightDelta === null || splitMode.heightDelta > 1) {
      throw new Error(`Split mode did not show equal-height complete source: ${JSON.stringify(splitMode)}`);
    }
    if (
      splitMode.hasInternalVerticalScroll ||
      splitMode.sourceStickyPosition !== 'sticky' ||
      splitMode.stickyPosition !== 'sticky' ||
      splitMode.nextLabel !== 'Show Mermaid code only'
    ) {
      throw new Error(`Unexpected split mode controls or scrolling: ${JSON.stringify(splitMode)}`);
    }
    if (
      splitMode.sourceHeight <= splitMode.previewHeight ||
      Math.abs(splitMode.sourcePaneHeight - splitMode.sourceHeight) > 1 ||
      splitMode.previewHeight >= defaultMode.previewHeight ||
      Math.abs(splitMode.previewFrameHeight - defaultMode.previewHeight) > 2
    ) {
      throw new Error(`Split mode did not preserve natural pane heights: ${JSON.stringify({ defaultMode, splitMode })}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__mermaidEditingEditor;
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block.is-split')!;
      const viewportTop = editor.view.scrollDOM.getBoundingClientRect().top;
      editor.view.scrollDOM.scrollTop += block.getBoundingClientRect().top - viewportTop + 240;
    });
    await waitForFrames(page);
    const codeTallerScroll = await page.evaluate(() => {
      const editor = (window as any).__mermaidEditingEditor;
      const viewportTop = editor.view.scrollDOM.getBoundingClientRect().top;
      const sourceTop = document.querySelector<HTMLElement>('.meo-mermaid-source-sticky')!.getBoundingClientRect().top;
      const previewTop = document.querySelector<HTMLElement>('.meo-mermaid-preview-sticky')!.getBoundingClientRect().top;
      return { viewportTop, sourceTop, previewTop };
    });
    if (
      Math.abs(codeTallerScroll.previewTop - (codeTallerScroll.viewportTop + 12)) > 3 ||
      codeTallerScroll.sourceTop >= codeTallerScroll.viewportTop - 100
    ) {
      throw new Error(`Short preview did not stay visible while source scrolled: ${JSON.stringify(codeTallerScroll)}`);
    }
    await page.evaluate(() => {
      (window as any).__mermaidEditingEditor.view.scrollDOM.scrollTop = 0;
    });
    await waitForFrames(page);

    await page.click('.meo-mermaid-source-editor .cm-content');
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.type('EDITED_NODE --> EDITED_TARGET');
    await waitForFrames(page);
    const editedText = await page.evaluate(() =>
      (window as any).__mermaidEditingEditor.view.state.doc.toString()
    );
    if (!editedText.includes('EDITED_NODE --> EDITED_TARGET')) {
      throw new Error('Editing split source did not update the outer Markdown document');
    }
    await page.evaluate(() => (window as any).__mermaidEditingEditor.undo());
    await waitForFrames(page);
    const undoText = await page.evaluate(() =>
      (window as any).__mermaidEditingEditor.view.state.doc.toString()
    );
    if (undoText.includes('EDITED_NODE --> EDITED_TARGET')) {
      throw new Error('Outer editor undo did not revert Mermaid source editing');
    }
    await page.evaluate(() => (window as any).__mermaidEditingEditor.redo());
    await waitForFrames(page);
    const redoText = await page.evaluate(() =>
      (window as any).__mermaidEditingEditor.view.state.doc.toString()
    );
    if (!redoText.includes('EDITED_NODE --> EDITED_TARGET')) {
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
        sourceStickyPosition: source
          ? getComputedStyle(source.querySelector<HTMLElement>('.meo-mermaid-source-sticky')!).position
          : null,
        stickyPosition: preview
          ? getComputedStyle(preview.querySelector<HTMLElement>('.meo-mermaid-preview-sticky')!).position
          : null
      };
    });
    if (
      narrowLayout.columns !== 1 ||
      !narrowLayout.previewBelowSource ||
      narrowLayout.sourceStickyPosition !== 'relative' ||
      narrowLayout.stickyPosition !== 'relative'
    ) {
      throw new Error(`Unexpected narrow Mermaid split layout: ${JSON.stringify(narrowLayout)}`);
    }

    await page.setViewport({ width: 1100, height: 720, deviceScaleFactor: 1 });
    await page.evaluate(() => {
      const previous = (window as any).__mermaidEditingEditor;
      previous.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__mermaidEditingEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text: [
          '```mermaid',
          'graph TD',
          'A --> B',
          '%% TALL_PREVIEW',
          '```',
          '',
          '```typescript',
          'const normalCodeStyle = true;',
          '```'
        ].join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await waitForFrames(page);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    const shortSplitLayout = await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block.is-split')!;
      const sourcePane = block?.querySelector<HTMLElement>('.meo-mermaid-source-pane')!;
      const sourceSticky = block?.querySelector<HTMLElement>('.meo-mermaid-source-sticky')!;
      const preview = block?.querySelector<HTMLElement>('.meo-mermaid-preview-shell')!;
      const previewSticky = block?.querySelector<HTMLElement>('.meo-mermaid-preview-sticky')!;
      const codeStyle = (window as any).__collectMermaidCodeStyle('.meo-mermaid-editing-block.is-split');
      return {
        blockHeight: block?.getBoundingClientRect().height ?? 0,
        sourcePaneHeight: sourcePane?.getBoundingClientRect().height ?? 0,
        sourceHeight: sourceSticky?.getBoundingClientRect().height ?? 0,
        sourceStickyPosition: sourceSticky ? getComputedStyle(sourceSticky).position : null,
        previewHeight: preview?.getBoundingClientRect().height ?? 0,
        previewNaturalHeight: previewSticky?.getBoundingClientRect().height ?? 0,
        ...codeStyle
      };
    });
    if (
      shortSplitLayout.previewNaturalHeight <= shortSplitLayout.sourceHeight ||
      Math.abs(shortSplitLayout.blockHeight - shortSplitLayout.previewNaturalHeight) > 1 ||
      Math.abs(shortSplitLayout.sourcePaneHeight - shortSplitLayout.blockHeight) > 1 ||
      shortSplitLayout.sourceStickyPosition !== 'sticky'
    ) {
      throw new Error(`Short Mermaid split mode did not preserve natural pane heights: ${JSON.stringify(shortSplitLayout)}`);
    }
    if (JSON.stringify(shortSplitLayout.sourceStyle) !== JSON.stringify(shortSplitLayout.normalStyle)) {
      throw new Error(`Mermaid split source style differs from normal code: ${JSON.stringify(shortSplitLayout)}`);
    }
    await page.evaluate(() => {
      const editor = (window as any).__mermaidEditingEditor;
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block.is-split')!;
      const viewportTop = editor.view.scrollDOM.getBoundingClientRect().top;
      editor.view.scrollDOM.scrollTop += block.getBoundingClientRect().top - viewportTop + 240;
    });
    await waitForFrames(page);
    const previewTallerScroll = await page.evaluate(() => {
      const editor = (window as any).__mermaidEditingEditor;
      const viewportTop = editor.view.scrollDOM.getBoundingClientRect().top;
      const sourceTop = document.querySelector<HTMLElement>('.meo-mermaid-source-sticky')!.getBoundingClientRect().top;
      const previewTop = document.querySelector<HTMLElement>('.meo-mermaid-preview-sticky')!.getBoundingClientRect().top;
      return { viewportTop, sourceTop, previewTop };
    });
    if (
      Math.abs(previewTallerScroll.sourceTop - (previewTallerScroll.viewportTop + 12)) > 3 ||
      previewTallerScroll.previewTop >= previewTallerScroll.viewportTop - 100
    ) {
      throw new Error(`Short source did not stay visible while preview scrolled: ${JSON.stringify(previewTallerScroll)}`);
    }
    await page.evaluate(() => {
      (window as any).__mermaidEditingEditor.view.scrollDOM.scrollTop = 0;
    });
    await waitForFrames(page);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    const shortSourceLayout = await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block.is-source')!;
      const editor = block?.querySelector<HTMLElement>('.meo-mermaid-source-editor')!;
      const codeStyle = (window as any).__collectMermaidCodeStyle('.meo-mermaid-editing-block.is-source');
      return {
        blockHeight: block?.getBoundingClientRect().height ?? 0,
        editorHeight: editor?.getBoundingClientRect().height ?? 0,
        ...codeStyle
      };
    });
    if (shortSourceLayout.blockHeight - shortSourceLayout.editorHeight > 1) {
      throw new Error(`Short Mermaid source mode contains vertical filler: ${JSON.stringify(shortSourceLayout)}`);
    }
    if (JSON.stringify(shortSourceLayout.sourceStyle) !== JSON.stringify(shortSourceLayout.normalStyle)) {
      throw new Error(`Mermaid source style differs from normal code: ${JSON.stringify(shortSourceLayout)}`);
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
