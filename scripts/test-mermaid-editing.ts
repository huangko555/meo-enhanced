import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-mermaid-editing-'));

async function waitForFrames(page: Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function assertSourceClickKeepsViewport(
  page: Page,
  blockSelector: string,
  lineText: string,
  controllerProperty: '__meoMermaidEditingController' | '__meoLatexMathEditingController'
): Promise<void> {
  const before = await page.evaluate(({ selector, text }) => {
    const editor = (window as any).__mermaidEditingEditor;
    const block = document.querySelector<HTMLElement>(selector)!;
    const line = Array.from(block.querySelectorAll<HTMLElement>('.cm-line'))
      .find((candidate) => candidate.textContent === text)!;
    const property = selector.includes('latex')
      ? '__meoLatexMathEditingController'
      : '__meoMermaidEditingController';
    const innerView = (block as any)[property]?.innerView;
    const viewport = editor.view.scrollDOM.getBoundingClientRect();
    const lineRect = line.getBoundingClientRect();
    editor.view.scrollDOM.scrollTop += lineRect.top - viewport.top - viewport.height / 2;
    const positionedRect = line.getBoundingClientRect();
    return {
      scrollTop: editor.view.scrollDOM.scrollTop,
      lineTop: positionedRect.top,
      focused: innerView?.hasFocus ?? false,
      x: positionedRect.left + Math.min(24, positionedRect.width / 2),
      y: positionedRect.top + positionedRect.height / 2
    };
  }, { selector: blockSelector, text: lineText });
  await waitForFrames(page, 2);
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  await waitForFrames(page, 2);
  const afterDown = await page.evaluate(() => ({
    scrollTop: (window as any).__mermaidEditingEditor.view.scrollDOM.scrollTop,
    activeElement: document.activeElement?.className ?? null
  }));
  await page.mouse.up();
  await waitForFrames(page, 4);
  const after = await page.evaluate(({ selector, text, property }) => {
    const editor = (window as any).__mermaidEditingEditor;
    const block = document.querySelector<HTMLElement>(selector)!;
    const line = Array.from(block.querySelectorAll<HTMLElement>('.cm-line'))
      .find((candidate) => candidate.textContent === text)!;
    const innerView = (block as any)[property]?.innerView;
    const selection = innerView?.state.selection.main;
    return {
      focused: innerView?.hasFocus ?? false,
      selectedLine: selection ? innerView.state.doc.lineAt(selection.head).text : null,
      scrollTop: editor.view.scrollDOM.scrollTop,
      lineTop: line.getBoundingClientRect().top
    };
  }, { selector: blockSelector, text: lineText, property: controllerProperty });
  if (
    !after.focused ||
    after.selectedLine !== lineText ||
    Math.abs(after.scrollTop - before.scrollTop) > 1 ||
    Math.abs(after.lineTop - before.lineTop) > 1
  ) {
    throw new Error(`Clicking ${blockSelector} source moved the viewport or missed the cursor: ${JSON.stringify({ before, afterDown, after })}`);
  }
}

async function assertBlockAreaClickKeepsViewport(
  page: Page,
  blockSelector: string,
  targetSelector: string,
  verticalRatio = 0.5,
  preserveOuterSelection = true
): Promise<void> {
  const before = await page.evaluate(({ blockQuery, selector, ratio }) => {
    const editor = (window as any).__mermaidEditingEditor;
    const block = document.querySelector<HTMLElement>(blockQuery)!;
    const viewport = editor.view.scrollDOM.getBoundingClientRect();
    editor.view.scrollDOM.scrollTop += block.getBoundingClientRect().top - viewport.top - 120;
    const target = document.querySelector<HTMLElement>(selector)!;
    const targetRect = target.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    return {
      scrollTop: editor.view.scrollDOM.scrollTop,
      blockTop: blockRect.top,
      selectionHead: editor.view.state.selection.main.head,
      outerFocused: editor.view.hasFocus,
      innerFocused: Boolean(
        (block as any).__meoMermaidEditingController?.innerView?.hasFocus
        || (block as any).__meoLatexMathEditingController?.innerView?.hasFocus
      ),
      x: targetRect.left + targetRect.width / 2,
      y: Math.max(viewport.top + 24, Math.min(viewport.bottom - 24, targetRect.top + targetRect.height * ratio))
    };
  }, { blockQuery: blockSelector, selector: targetSelector, ratio: verticalRatio });
  await waitForFrames(page, 2);
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  await waitForFrames(page, 2);
  const afterDown = await page.evaluate(() => {
    const editor = (window as any).__mermaidEditingEditor;
    return {
      scrollTop: editor.view.scrollDOM.scrollTop,
      selectionHead: editor.view.state.selection.main.head
    };
  });
  await page.mouse.up();
  await new Promise((resolve) => setTimeout(resolve, 850));
  await waitForFrames(page, 2);
  const after = await page.evaluate((blockQuery) => {
    const editor = (window as any).__mermaidEditingEditor;
    const block = document.querySelector<HTMLElement>(blockQuery)!;
    return {
      scrollTop: editor.view.scrollDOM.scrollTop,
      blockTop: block.getBoundingClientRect().top,
      selectionHead: editor.view.state.selection.main.head,
      outerFocused: editor.view.hasFocus,
      innerFocused: Boolean(
        (block as any).__meoMermaidEditingController?.innerView?.hasFocus
        || (block as any).__meoLatexMathEditingController?.innerView?.hasFocus
      )
    };
  }, blockSelector);
  if (
    Math.abs(after.scrollTop - before.scrollTop) > 1 ||
    Math.abs(after.blockTop - before.blockTop) > 1 ||
    (preserveOuterSelection && after.selectionHead !== before.selectionHead) ||
    (preserveOuterSelection && before.innerFocused && !after.innerFocused)
  ) {
    throw new Error(`Clicking ${targetSelector} moved the Mermaid block: ${JSON.stringify({ before, afterDown, after })}`);
  }
}

async function assertModeButtonKeepsViewport(
  page: Page,
  buttonSelector: string,
  blockSelector: string
): Promise<void> {
  await page.evaluate((blockQuery) => {
    const editor = (window as any).__mermaidEditingEditor;
    const block = document.querySelector<HTMLElement>(blockQuery)!;
    const viewport = editor.view.scrollDOM.getBoundingClientRect();
    editor.view.scrollDOM.scrollTop += block.getBoundingClientRect().top - viewport.top - 120;
  }, blockSelector);
  const readState = () => page.evaluate((buttonQuery) => {
    const editor = (window as any).__mermaidEditingEditor;
    const button = document.querySelector<HTMLElement>(buttonQuery)!;
    return {
      scrollTop: editor.view.scrollDOM.scrollTop,
      buttonTop: button.getBoundingClientRect().top,
      label: button.getAttribute('aria-label')
    };
  }, buttonSelector);
  await waitForFrames(page, 2);
  const before = await readState();
  const buttonPoint = await page.$eval(buttonSelector, (button) => {
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(buttonPoint.x, buttonPoint.y);
  await page.mouse.down();
  await waitForFrames(page, 2);
  const afterDown = await readState();
  await page.mouse.up();
  await new Promise((resolve) => setTimeout(resolve, 850));
  await waitForFrames(page, 2);
  const after = await readState();
  if (
    Math.abs(after.scrollTop - before.scrollTop) > 1 ||
    Math.abs(after.buttonTop - before.buttonTop) > 1 ||
    after.label === before.label
  ) {
    throw new Error(`Clicking ${buttonSelector} moved the viewport or missed the mode change: ${JSON.stringify({ before, afterDown, after })}`);
  }
}

async function assertBlockBoundaryClickKeepsViewport(page: Page, lineNumber: number): Promise<void> {
  await page.evaluate((targetLineNumber) => {
    const editor = (window as any).__mermaidEditingEditor;
    const line = editor.view.state.doc.line(targetLineNumber);
    editor.view.scrollDOM.scrollTop = Math.max(0, editor.view.lineBlockAt(line.from).top - 120);
  }, lineNumber);
  await waitForFrames(page, 2);
  const before = await page.evaluate((targetLineNumber) => {
    const editor = (window as any).__mermaidEditingEditor;
    const line = editor.view.state.doc.line(targetLineNumber);
    const coords = editor.view.coordsAtPos(line.from + 1)!;
    return {
      scrollTop: editor.view.scrollDOM.scrollTop,
      lineTop: editor.view.coordsAtPos(line.from)?.top ?? null,
      x: coords.left + 2,
      y: (coords.top + coords.bottom) / 2
    };
  }, lineNumber);
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  await waitForFrames(page, 2);
  const afterDown = await page.evaluate((targetLineNumber) => {
    const editor = (window as any).__mermaidEditingEditor;
    const line = editor.view.state.doc.line(targetLineNumber);
    return {
      scrollTop: editor.view.scrollDOM.scrollTop,
      lineTop: editor.view.coordsAtPos(line.from)?.top ?? null,
      selectedLine: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number
    };
  }, lineNumber);
  await page.mouse.up();
  await new Promise((resolve) => setTimeout(resolve, 850));
  await waitForFrames(page, 2);
  const after = await page.evaluate((targetLineNumber) => {
    const editor = (window as any).__mermaidEditingEditor;
    const line = editor.view.state.doc.line(targetLineNumber);
    return {
      scrollTop: editor.view.scrollDOM.scrollTop,
      lineTop: editor.view.coordsAtPos(line.from)?.top ?? null,
      selectedLine: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number
    };
  }, lineNumber);
  if (
    after.selectedLine !== lineNumber ||
    before.lineTop === null ||
    afterDown.lineTop === null ||
    after.lineTop === null ||
    Math.abs(afterDown.scrollTop - before.scrollTop) > 1 ||
    Math.abs(afterDown.lineTop - before.lineTop) > 1 ||
    Math.abs(after.scrollTop - before.scrollTop) > 1 ||
    Math.abs(after.lineTop - before.lineTop) > 1
  ) {
    throw new Error(`Clicking block boundary line ${lineNumber} moved the viewport: ${JSON.stringify({ before, afterDown, after })}`);
  }
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

  const browser = await launchTestBrowser();
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

    const previewClickBefore = await page.evaluate(() => {
      const editor = (window as any).__mermaidEditingEditor;
      const block = document.querySelector<HTMLElement>('.meo-mermaid-block')!;
      return {
        selectionHead: editor.view.state.selection.main.head,
        scrollTop: editor.view.scrollDOM.scrollTop,
        blockTop: block.getBoundingClientRect().top
      };
    });
    const previewClickPoint = await page.$eval('.meo-mermaid-block', (block) => {
      const rect = block.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(previewClickPoint.x, previewClickPoint.y);
    await page.mouse.down();
    await waitForFrames(page, 2);
    const previewPointerDown = await page.evaluate(() => ({
      preview: Boolean(document.querySelector('.meo-mermaid-block')),
      editing: Boolean(document.querySelector('.meo-mermaid-editing-block')),
      sourceVisible: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .some((line) => line.textContent?.includes('node24 --> node25') && getComputedStyle(line).display !== 'none'),
      buttonLabel: document.querySelector('.meo-mermaid-mode-btn')?.getAttribute('aria-label')
    }));
    await page.mouse.up();
    await waitForFrames(page, 4);
    const previewClickAfter = await page.evaluate(() => {
      const editor = (window as any).__mermaidEditingEditor;
      const block = document.querySelector<HTMLElement>('.meo-mermaid-block');
      return {
        selectionHead: editor.view.state.selection.main.head,
        scrollTop: editor.view.scrollDOM.scrollTop,
        blockTop: block?.getBoundingClientRect().top ?? null,
        preview: Boolean(block),
        editing: Boolean(document.querySelector('.meo-mermaid-editing-block')),
        buttonLabel: document.querySelector('.meo-mermaid-mode-btn')?.getAttribute('aria-label')
      };
    });
    if (
      previewClickAfter.selectionHead !== previewClickBefore.selectionHead ||
      Math.abs(previewClickAfter.scrollTop - previewClickBefore.scrollTop) > 1 ||
      previewClickAfter.blockTop === null ||
      Math.abs(previewClickAfter.blockTop - previewClickBefore.blockTop) > 1 ||
      !previewClickAfter.preview ||
      previewClickAfter.editing ||
      previewClickAfter.buttonLabel !== 'Edit Mermaid in split view'
    ) {
      throw new Error(`Clicking Mermaid preview changed editor state: ${JSON.stringify({
        before: previewClickBefore,
        pointerDown: previewPointerDown,
        after: previewClickAfter
      })}`);
    }
    if (
      !previewPointerDown.preview ||
      previewPointerDown.editing ||
      previewPointerDown.sourceVisible ||
      previewPointerDown.buttonLabel !== 'Edit Mermaid in split view'
    ) {
      throw new Error(`Pressing Mermaid preview temporarily revealed source: ${JSON.stringify(previewPointerDown)}`);
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
        availablePreviewHeight: source
          ? Math.min(source.getBoundingClientRect().height, window.innerHeight - 48)
          : 0,
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
      Math.abs(splitMode.previewFrameHeight - splitMode.availablePreviewHeight) > 2
    ) {
      throw new Error(`Split preview did not use the available vertical space: ${JSON.stringify({ defaultMode, splitMode })}`);
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
      const prelude = Array.from({ length: 40 }, (_, index) => `prelude ${index + 1}`);
      (window as any).__mermaidEditingEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text: [
          ...prelude,
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
    await page.evaluate(() => (window as any).__mermaidEditingEditor.scrollToLine(42, 'center'));
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
    await assertBlockAreaClickKeepsViewport(
      page,
      '.meo-mermaid-editing-block.is-split',
      '.meo-mermaid-source-pane',
      0.9,
      false
    );
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

    await page.evaluate(() => {
      const previous = (window as any).__mermaidEditingEditor;
      previous.destroy();
      document.getElementById('app')!.replaceChildren();
      const prelude = Array.from({ length: 40 }, (_, index) => `prelude ${index + 1}`);
      (window as any).__mermaidEditingEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text: [...prelude, '$$', 'x', ...new Array(30).fill(''), '$$'].join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await waitForFrames(page);
    await page.evaluate(() => (window as any).__mermaidEditingEditor.scrollToLine(42, 'center'));
    await waitForFrames(page);
    await page.click('.meo-latex-math-mode-btn');
    await waitForFrames(page);
    const latexSplitLayout = await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-latex-math-editing-block.is-split')!;
      const source = block?.querySelector<HTMLElement>('.meo-latex-math-source-pane')!;
      const preview = block?.querySelector<HTMLElement>('.meo-latex-math-preview-shell')!;
      const sticky = block?.querySelector<HTMLElement>('.meo-latex-math-preview-sticky')!;
      const formula = sticky?.querySelector<HTMLElement>('.meo-md-math-display')!;
      const sourceRect = source?.getBoundingClientRect();
      const previewRect = preview?.getBoundingClientRect();
      const stickyRect = sticky?.getBoundingClientRect();
      const formulaRect = formula?.getBoundingClientRect();
      return {
        sourceHeight: sourceRect?.height ?? 0,
        previewHeight: previewRect?.height ?? 0,
        frameHeight: stickyRect?.height ?? 0,
        availablePreviewHeight: sourceRect
          ? Math.min(sourceRect.height, window.innerHeight - 48)
          : 0,
        formulaInsideFrame: Boolean(
          stickyRect &&
          formulaRect &&
          formulaRect.top >= stickyRect.top - 1 &&
          formulaRect.bottom <= stickyRect.bottom + 1
        )
      };
    });
    if (
      Math.abs(latexSplitLayout.sourceHeight - latexSplitLayout.previewHeight) > 1 ||
      Math.abs(latexSplitLayout.frameHeight - latexSplitLayout.availablePreviewHeight) > 2 ||
      !latexSplitLayout.formulaInsideFrame
    ) {
      throw new Error(`LaTeX split preview did not use the available vertical space: ${JSON.stringify(latexSplitLayout)}`);
    }
    await assertBlockAreaClickKeepsViewport(
      page,
      '.meo-latex-math-editing-block.is-split',
      '.meo-latex-math-preview-sticky'
    );

    await page.evaluate(() => {
      const previous = (window as any).__mermaidEditingEditor;
      previous.destroy();
      document.getElementById('app')!.replaceChildren();
      const prelude = Array.from({ length: 40 }, (_, index) => `prelude ${index + 1}`);
      const mermaidLines = Array.from({ length: 48 }, (_, index) => (
        index === 23 ? 'CLICK_MERMAID_24 --> TARGET' : `CLICK_MERMAID_${index + 1} --> NEXT_${index + 1}`
      ));
      (window as any).__mermaidEditingEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text: [
          ...prelude,
          '```mermaid',
          'graph TD',
          ...mermaidLines,
          '```',
          '',
          '## AFTER_MERMAID',
          'after mermaid content'
        ].join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await waitForFrames(page);

    await page.evaluate(() => (window as any).__mermaidEditingEditor.scrollToLine(66, 'center'));
    await waitForFrames(page);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    await assertBlockAreaClickKeepsViewport(
      page,
      '.meo-mermaid-editing-block.is-split',
      '.meo-mermaid-preview-sticky'
    );
    await assertSourceClickKeepsViewport(
      page,
      '.meo-mermaid-editing-block.is-split',
      'CLICK_MERMAID_24 --> TARGET',
      '__meoMermaidEditingController'
    );
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    await assertSourceClickKeepsViewport(
      page,
      '.meo-mermaid-editing-block.is-source',
      'CLICK_MERMAID_24 --> TARGET',
      '__meoMermaidEditingController'
    );

    await page.evaluate(() => {
      const previous = (window as any).__mermaidEditingEditor;
      previous.destroy();
      document.getElementById('app')!.replaceChildren();
      const latexLines = Array.from({ length: 32 }, (_, index) => (
        index === 17 ? 'CLICK_LATEX_18 = x^2' : `latex_${index + 1} = x_${index + 1}`
      ));
      (window as any).__mermaidEditingEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text: ['$$', ...latexLines, '$$'].join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await waitForFrames(page);
    await page.evaluate(() => (window as any).__mermaidEditingEditor.scrollToLine(20, 'center'));
    await waitForFrames(page);
    await page.click('.meo-latex-math-mode-btn');
    await waitForFrames(page);
    await assertSourceClickKeepsViewport(
      page,
      '.meo-latex-math-editing-block.is-split',
      'CLICK_LATEX_18 = x^2',
      '__meoLatexMathEditingController'
    );
    await page.click('.meo-latex-math-mode-btn');
    await waitForFrames(page);
    await assertSourceClickKeepsViewport(
      page,
      '.meo-latex-math-editing-block.is-source',
      'CLICK_LATEX_18 = x^2',
      '__meoLatexMathEditingController'
    );

    await page.evaluate(() => {
      const previous = (window as any).__mermaidEditingEditor;
      previous.destroy();
      document.getElementById('app')!.replaceChildren();
      const prelude = Array.from({ length: 146 }, (_, index) => `prelude ${index + 1}`);
      (window as any).__mermaidEditingEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text: [
          ...prelude,
          '```mermaid',
          'flowchart LR',
          '  A[Markdown Source] --> B{编辑模式}',
          '  B -->|Live| C[实时编辑]',
          '  B -->|Split| D[源码与预览]',
          '  B -->|Preview| E[只读阅读]',
          '  C --> F[一致的导出结果]',
          '  D --> F',
          '  E --> F',
          '',
          '  classDef source fill:#1E293B,stroke:#60A5FA,color:#F8FAFC',
          '  classDef output fill:#052E16,stroke:#4ADE80,color:#F0FDF4',
          '  class A source',
          '  class F output',
          '```',
          '',
          '### 6.2 布局稳定性',
          '',
          '$$',
          '\\operatorname{score}',
          '= \\alpha \\cdot \\operatorname{readability}',
          '+ \\beta \\cdot \\operatorname{stability}',
          '+ \\gamma \\cdot \\operatorname{consistency},',
          '\\qquad',
          '\\alpha + \\beta + \\gamma = 1',
          '$$',
          ...Array.from({ length: 100 }, (_, index) => `tail ${index + 1}`)
        ].join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
      const editor = (window as any).__mermaidEditingEditor;
      editor.view.dispatch({ selection: { anchor: editor.view.state.doc.line(146).from } });
    });
    await waitForFrames(page);
    await page.evaluate(() => (window as any).__mermaidEditingEditor.scrollToLine(147, 'center'));
    await waitForFrames(page);
    await assertBlockAreaClickKeepsViewport(
      page,
      '.meo-mermaid-block',
      '.meo-mermaid-block svg'
    );
    await page.evaluate(() => {
      const editor = (window as any).__mermaidEditingEditor;
      editor.view.dispatch({ selection: { anchor: editor.view.state.doc.line(164).from } });
      editor.view.scrollDOM.scrollTop = Math.max(0, editor.view.lineBlockAt(editor.view.state.doc.line(165).from).top - 120);
    });
    await waitForFrames(page);
    await assertBlockAreaClickKeepsViewport(
      page,
      '.meo-md-math-fenced-display',
      '.meo-md-math-fenced-display'
    );

    await page.evaluate(() => (window as any).__mermaidEditingEditor.scrollToLine(147, 'center'));
    await waitForFrames(page);
    await page.click('.meo-mermaid-mode-btn');
    await page.evaluate(() => (window as any).__mermaidEditingEditor.scrollToLine(165, 'center'));
    await waitForFrames(page);
    await page.click('.meo-latex-math-mode-btn');
    await waitForFrames(page);
    await assertBlockBoundaryClickKeepsViewport(page, 147);
    await assertBlockBoundaryClickKeepsViewport(page, 161);
    await assertBlockBoundaryClickKeepsViewport(page, 165);
    await assertBlockBoundaryClickKeepsViewport(page, 172);

    await page.evaluate(() => {
      const editor = (window as any).__mermaidEditingEditor;
      editor.view.dispatch({ selection: { anchor: editor.view.state.doc.line(146).from } });
    });
    await waitForFrames(page);
    for (let index = 0; index < 3; index += 1) {
      await assertModeButtonKeepsViewport(
        page,
        '.meo-mermaid-mode-btn',
        '.meo-mermaid-block, .meo-mermaid-editing-block'
      );
    }

    await page.evaluate(() => {
      const editor = (window as any).__mermaidEditingEditor;
      editor.view.dispatch({ selection: { anchor: editor.view.state.doc.line(164).from } });
    });
    await waitForFrames(page);
    for (let index = 0; index < 3; index += 1) {
      await assertModeButtonKeepsViewport(
        page,
        '.meo-latex-math-mode-btn',
        '.meo-md-math-fenced-display, .meo-latex-math-editing-block'
      );
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
