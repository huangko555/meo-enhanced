import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-outline-scroll-sync-'));

async function waitForFrames(page: Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

function createDocument(): string {
  const lines = Array.from({ length: 240 }, (_, index) => `content line ${index + 1}`);
  for (let section = 0; section < 24; section += 1) {
    const start = section * 10;
    lines[start] = `# Heading ${section + 1}`;
    lines[start + 2] = `## Child ${section + 1}`;
    lines[start + 4] = `### Grandchild ${section + 1}`;
  }
  return lines.join('\n');
}

async function assertOutlineViewportStability(page: Page, mode: 'source' | 'live'): Promise<void> {
  await page.evaluate(({ text, nextMode }) => {
    (window as any).__outlineEditor?.destroy?.();
    const root = document.getElementById('app')!;
    root.replaceChildren();
    const editorWrapper = document.createElement('div');
    editorWrapper.className = 'editor-wrapper';
    editorWrapper.style.height = '100%';
    const editorHost = document.createElement('div');
    editorHost.className = 'editor-host';
    editorHost.style.height = '100%';
    const outlineButton = document.createElement('button');
    root.appendChild(editorWrapper);
    editorWrapper.appendChild(editorHost);
    const editor = (window as any).EditorStabilityHarness.createEditor({
      parent: editorHost,
      text,
      initialMode: nextMode,
      initialGitGutter: false,
      onApplyChanges() {}
    });
    const outline = (window as any).EditorStabilityHarness.createOutlineController({
      root,
      editorWrapper,
      outlineButton,
      getEditor: () => editor
    });
    editorWrapper.appendChild(outline.sidebar);
    outline.setMode('fixed');
    outline.setVisible(true);
    (window as any).__outlineEditor = editor;
    (window as any).__outlineController = outline;
  }, {
    nextMode: mode,
    text: [
      '# Heading 1',
      ...Array.from({ length: 180 }, (_, index) => (
        index % 12 === 0
          ? `# Heading ${index / 12 + 2}`
          : `long paragraph ${index + 1} ${'word '.repeat(18)}`
      ))
    ].join('\n')
  });
  await waitForFrames(page, 16);

  const jumpTrace = await page.evaluate(async () => {
    const editor = (window as any).__outlineEditor;
    const outline = (window as any).__outlineController;
    editor.scrollToLine(1, 'top');
    for (let frame = 0; frame < 12; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const target = Array.from(outline.sidebar.querySelectorAll<HTMLButtonElement>('.outline-item')).at(-2)!;
    const heading = editor.getHeadings().find((candidate: { text: string }) => candidate.text === target.title);
    if (!heading) throw new Error(`Missing outline target: ${target.title}`);
    const position = editor.view.state.doc.line(heading.line).from;
    const offsets: number[] = [];
    target.click();
    for (let frame = 0; frame < 12; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const coords = editor.view.coordsAtPos(position);
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      if (coords) offsets.push(coords.top - viewport.top);
    }
    return { title: target.title, offsets };
  });
  if (
    jumpTrace.offsets.length < 2 ||
    jumpTrace.offsets.some((offset) => offset < -1 || offset > 20) ||
    Math.max(...jumpTrace.offsets) - Math.min(...jumpTrace.offsets) > 1
  ) {
    throw new Error(`Outline heading jump painted more than one target position in ${mode}: ${JSON.stringify(jumpTrace)}`);
  }

  for (const scenario of ['hidden-to-fixed', 'floating-to-fixed'] as const) {
    const layoutTrace = await page.evaluate(async (kind) => {
      const editor = (window as any).__outlineEditor;
      const outline = (window as any).__outlineController;
      if (kind === 'hidden-to-fixed') {
        outline.setMode('fixed');
        outline.setVisible(false);
      } else {
        outline.setMode('floating');
        outline.setVisible(true);
      }
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      editor.scrollToLine(90, 'top');
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const topVisibleBefore = editor.getTopVisiblePosition();
      const position = editor.view.state.doc.line(topVisibleBefore.line).from;
      const viewportBefore = editor.view.scrollDOM.getBoundingClientRect();
      const before = editor.view.coordsAtPos(position)?.top ?? null;
      if (before === null) throw new Error('Missing layout anchor before outline transition');
      const expectedOffset = before - viewportBefore.top;
      if (expectedOffset < -100 || expectedOffset > 20) {
        throw new Error(`Outline layout anchor was not positioned at the viewport top: ${expectedOffset}`);
      }
      const offsets: Array<number | null> = [];
      if (kind === 'hidden-to-fixed') outline.setVisible(true);
      else outline.setMode('fixed');
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const viewport = editor.view.scrollDOM.getBoundingClientRect();
        const top = editor.view.coordsAtPos(position)?.top ?? null;
        offsets.push(top === null ? null : top - viewport.top);
      }
      return { kind, expectedOffset, topVisibleBefore, topVisibleAfter: editor.getTopVisiblePosition(), offsets };
    }, scenario);
    if (
      layoutTrace.offsets.some((offset) => offset === null) ||
      layoutTrace.offsets.some((offset) => Math.abs((offset ?? 0) - layoutTrace.expectedOffset) > 2)
    ) {
      throw new Error(`Outline ${scenario} exposed an intermediate document position in ${mode}: ${JSON.stringify(layoutTrace)}`);
    }
  }
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-editor-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 500, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}#app{display:flex}</style><div id="app" class="editor-root"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: '.outline-sidebar{height:300px!important}.outline-content{height:250px!important;overflow-y:auto!important}' });
    await page.addStyleTag({ content: ':root{--meo-background:#24292e;--meo-foreground:#e6edf3;--meo-font-live:Arial;--meo-font-source:monospace;--meo-font-live-size:16px;--meo-font-source-size:14px;--meo-line-height-live:1.5;--meo-line-height-source:1.5;--meo-semantic-mutedForeground:#7d8794;--meo-semantic-headingForeground:#79b8ff}' });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate((text) => { (window as any).__outlineDocument = text; }, createDocument());

    for (const mode of ['source', 'live'] as const) {
      await page.evaluate((nextMode) => {
        const root = document.getElementById('app')!;
        root.replaceChildren();
        const editorWrapper = document.createElement('div');
        editorWrapper.className = 'editor-wrapper';
        editorWrapper.style.height = '100%';
        const editorHost = document.createElement('div');
        editorHost.className = 'editor-host';
        editorHost.style.height = '100%';
        const outlineButton = document.createElement('button');
        root.appendChild(editorWrapper);
        editorWrapper.appendChild(editorHost);
        const editor = (window as any).EditorStabilityHarness.createEditor({
          parent: editorHost,
          text: (window as any).__outlineDocument,
          initialMode: nextMode,
          initialGitGutter: false,
          onApplyChanges() {}
        });
        const outline = (window as any).EditorStabilityHarness.createOutlineController({
          root,
          editorWrapper,
          outlineButton,
          getEditor: () => editor
        });
        editorWrapper.appendChild(outline.sidebar);
        outline.setVisible(true);
        (window as any).__outlineEditor = editor;
      }, mode);
      await waitForFrames(page, 12);

      const initialHeading = await page.$eval('.outline-item.is-visible-first', (element) => element.textContent?.trim() ?? '');
      await page.evaluate(() => (window as any).__outlineEditor.scrollToLine(121, 'top'));
      await waitForFrames(page, 12);
      const scrolledHeading = await page.$eval('.outline-item.is-visible-first', (element) => element.textContent?.trim() ?? '');
      if (initialHeading === scrolledHeading || scrolledHeading !== 'Heading 13') {
        throw new Error(`Outline did not follow ${mode} scrolling: ${JSON.stringify({ initialHeading, scrolledHeading })}`);
      }

      await page.evaluate(() => (window as any).__outlineEditor.scrollToLine(1, 'top'));
      await waitForFrames(page, 8);
      const outlineOperation = await page.evaluate(() => {
        const content = document.querySelector<HTMLElement>('.outline-content')!;
        content.scrollTop = Math.min(520, content.scrollHeight - content.clientHeight - 20);
        const before = content.scrollTop;
        const foldButtons = Array.from(content.querySelectorAll<HTMLButtonElement>(
          '.outline-fold-button[data-outline-key]'
        ));
        const foldButton = foldButtons[Math.min(foldButtons.length - 1, 30)];
        if (!foldButton || before <= 0) throw new Error(`Missing a scrollable outline fold fixture: ${JSON.stringify({ before, buttons: foldButtons.length, clientHeight: content.clientHeight, scrollHeight: content.scrollHeight, overflowY: getComputedStyle(content).overflowY })}`);
        foldButton.click();
        return {
          before,
          after: content.scrollTop,
          active: document.querySelector('.outline-item.is-visible-first')?.textContent?.trim() ?? ''
        };
      });
      if (Math.abs(outlineOperation.after - outlineOperation.before) > 2) {
        throw new Error(`Outline-only folding changed sidebar scroll position: ${JSON.stringify(outlineOperation)}`);
      }

      await page.click('.outline-header [data-action="collapse-top2"]');
      const collapsedLevels = await page.$$eval('.outline-item', (items) => items.map((item) => (
        Array.from(item.classList).find((name) => name.startsWith('outline-level-'))
      )));
      if (collapsedLevels.length !== 24 || collapsedLevels.some((level) => level !== 'outline-level-1')) {
        throw new Error(`Global outline collapse must leave only H1 headings: ${JSON.stringify(collapsedLevels)}`);
      }
      await page.evaluate(() => {
        const firstH1 = document.querySelector<HTMLElement>('.outline-item.outline-level-1');
        const foldButton = firstH1?.closest('.outline-row')?.querySelector<HTMLButtonElement>(
          '.outline-fold-button[data-outline-key]'
        );
        if (!foldButton) throw new Error('Missing the first H1 fold button after global collapse');
        foldButton.click();
      });
      const firstExpandedLevels = await page.$$eval('.outline-item', (items) => items.map((item) => (
        Array.from(item.classList).find((name) => name.startsWith('outline-level-'))
      )));
      if (
        !firstExpandedLevels.includes('outline-level-2')
        || firstExpandedLevels.some((level) => !['outline-level-1', 'outline-level-2'].includes(level ?? ''))
      ) {
        throw new Error(`Global outline collapse must recursively fold every descendant: ${JSON.stringify(firstExpandedLevels)}`);
      }

      await page.evaluate(() => {
        const editor = (window as any).__outlineEditor;
        editor.getVisibleDocumentRange = () => ({ from: 12, to: 18, fromLine: 2, toLine: 2 });
        editor.getViewportAnchorOffset = () => 12;
        editor.getScrollElement().dispatchEvent(new Event('scroll'));
      });
      await waitForFrames(page, 4);
      const fallbackHeading = await page.$eval('.outline-item.is-visible-first', (element) => (
        element.textContent?.trim() ?? ''
      ));
      if (fallbackHeading !== 'Heading 1') {
        throw new Error(`A one-line rendered block must retain its owning heading: ${fallbackHeading}`);
      }
    }

    for (const mode of ['source', 'live'] as const) {
      await assertOutlineViewportStability(page, mode);
    }

    console.log('outline scroll sync checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
