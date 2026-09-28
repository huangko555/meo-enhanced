import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-fence-enter-'));

type EnterCase = {
  readonly name: string;
  readonly fence: 'opening' | 'closing';
  readonly edge: 'start' | 'end';
};

type FenceFixture = {
  readonly name: string;
  readonly lines: readonly string[];
};

type FrameSample = {
  readonly scrollTop: number;
  readonly maximumScrollTop: number;
  readonly selectionHead: number;
  readonly selectionLine: number;
  readonly fenceTop: number | null;
};

const cases: readonly EnterCase[] = [
  { name: 'opening fence at start', fence: 'opening', edge: 'start' },
  { name: 'opening fence at end', fence: 'opening', edge: 'end' },
  { name: 'closing fence at start', fence: 'closing', edge: 'start' },
  { name: 'closing fence at end', fence: 'closing', edge: 'end' }
];
const fixtures: readonly FenceFixture[] = [
  {
    name: 'language fence',
    lines: ['```ts', 'const first = 1;', 'const second = 2;', '```']
  },
  {
    name: 'language-less fence',
    lines: ['```', 'plain first', 'plain second', '```']
  },
  {
    name: 'tilde fence',
    lines: ['~~~ts', 'const first = 1;', 'const second = 2;', '~~~']
  }
];
const failures: string[] = [];

async function waitForFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

const build = await Bun.build({
  entrypoints: [path.join(repoRoot, 'scripts/test-line-number-typing-stability-entry.ts')],
  outdir,
  target: 'browser',
  format: 'iife',
  naming: 'bundle.js'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const prefix = Array.from({ length: 20 }, (_, index) => `前置段落 ${index + 1}`);
const suffix = Array.from({ length: 20 }, (_, index) => `后置段落 ${index + 1}`);

const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 860, height: 520, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: path.join(repoRoot, 'webview/src/styles.css') });
  await page.addStyleTag({
    content: ':root { --meo-background:#24292e; --meo-foreground:#e6edf3; --meo-semantic-markdownSyntax:#8b949e; --meo-semantic-mutedForeground:#8b949e; --meo-font-live:Arial; --meo-font-live-weight:400; --meo-font-live-size:16px; }'
  });
  await page.addScriptTag({ path: path.join(outdir, 'bundle.js') });

  const scenarios = fixtures.flatMap((fixture) => (
    cases.map((enterCase) => ({ fixture, enterCase }))
  ));
  for (const { fixture, enterCase } of scenarios) {
    const initialText = [...prefix, ...fixture.lines, ...suffix].join('\n');
    const openingLine = prefix.length + 1;
    const closingLine = openingLine + fixture.lines.length - 1;
    const setup = await page.evaluate(async ({ text, targetLine, edge, fence }) => {
      (window as any).__editor?.destroy();
      document.getElementById('app')!.replaceChildren();
      const editor = (window as any).LineNumberTypingHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
      (window as any).__editor = editor;
      const initialTarget = editor.view.state.doc.line(targetLine);
      editor.view.scrollDOM.scrollTop = Math.max(
        0,
        editor.view.lineBlockAt(initialTarget.from).top - editor.view.scrollDOM.clientHeight / 2
      );
      for (let index = 0; index < 10; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const view = editor.view;
      const fenceSelector = fence === 'opening'
        ? '.cm-line.meo-md-code-block-start'
        : '.cm-line.meo-md-code-block-end';
      const fenceElement = view.contentDOM.querySelector<HTMLElement>(fenceSelector);
      if (!fenceElement) throw new Error(`Missing ${fence} fence`);
      const scrollerRect = view.scrollDOM.getBoundingClientRect();
      const fenceRect = fenceElement.getBoundingClientRect();
      view.scrollDOM.scrollTop += (
        fenceRect.top + fenceRect.bottom - scrollerRect.top - scrollerRect.bottom
      ) / 2;
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const line = view.state.doc.line(targetLine);
      const insertionPosition = edge === 'start' ? line.from : line.to;
      view.dispatch({ selection: { anchor: insertionPosition } });
      view.focus();
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const readFenceTop = () => view.contentDOM.querySelector<HTMLElement>(fenceSelector)
        ?.getBoundingClientRect().top ?? null;
      const samples: FrameSample[] = [];
      let sampling = true;
      const sample = () => {
        const currentView = (window as any).__editor.view;
        const head = currentView.state.selection.main.head;
        samples.push({
          scrollTop: currentView.scrollDOM.scrollTop,
          maximumScrollTop: currentView.scrollDOM.scrollHeight - currentView.scrollDOM.clientHeight,
          selectionHead: head,
          selectionLine: currentView.state.doc.lineAt(head).number,
          fenceTop: readFenceTop()
        });
        if (sampling) requestAnimationFrame(sample);
      };
      // Arm before the trusted key event, but sample only its following frames.
      // CDP may deliver the key after an unrelated animation frame has painted.
      window.addEventListener('keydown', () => requestAnimationFrame(sample), {
        capture: true, once: true
      });
      (window as any).__fenceEnterProbe = {
        insertionPosition,
        beforeScrollTop: view.scrollDOM.scrollTop,
        beforeFenceTop: readFenceTop(),
        lineHeight: view.defaultLineHeight,
        samples,
        stop() { sampling = false; }
      };
      return { insertionPosition, targetLine };
    }, {
      text: initialText,
      targetLine: enterCase.fence === 'opening' ? openingLine : closingLine,
      edge: enterCase.edge,
      fence: enterCase.fence
    });

    // Keep a scheduling gap so pre-input frames cannot masquerade as regressions.
    await waitForFrames(page, 2);
    await page.keyboard.press('Enter');
    await waitForFrames(page, 12);
    const result = await page.evaluate(() => {
      const editor = (window as any).__editor;
      const probe = (window as any).__fenceEnterProbe;
      probe.stop();
      const head = editor.view.state.selection.main.head;
      const caret = editor.view.coordsAtPos(head);
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      return {
        text: editor.getText(),
        selectionHead: head,
        selectionLine: editor.view.state.doc.lineAt(head).number,
        activeElement: document.activeElement?.className ?? '',
        beforeScrollTop: probe.beforeScrollTop as number,
        beforeFenceTop: probe.beforeFenceTop as number | null,
        caretVisible: Boolean(caret && caret.top >= viewport.top && caret.bottom <= viewport.bottom),
        lineHeight: probe.lineHeight as number,
        samples: probe.samples as FrameSample[]
      };
    });

    const expectedText = `${initialText.slice(0, setup.insertionPosition)}\n${initialText.slice(setup.insertionPosition)}`;
    const scrollValues = result.samples.map((sample) => sample.scrollTop);
    const scrollSpan = Math.max(result.beforeScrollTop, ...scrollValues)
      - Math.min(result.beforeScrollTop, ...scrollValues);
    const jumpedToEnd = result.samples.some((sample) => (
      sample.maximumScrollTop > 0
      && sample.scrollTop > sample.maximumScrollTop - 2
      && result.beforeScrollTop < sample.maximumScrollTop - 100
    ));
    const unexpectedSelection = result.samples.some((sample) => (
      sample.selectionHead !== setup.insertionPosition + 1
      || sample.selectionLine !== setup.targetLine + 1
    ));
    const expectedFenceShift = enterCase.edge === 'start' ? result.lineHeight : 0;
    const missingFenceFrames = result.samples.filter((sample) => sample.fenceTop === null).length;
    const fenceDrift = result.beforeFenceTop === null
      ? Number.POSITIVE_INFINITY
      : Math.max(...result.samples.map((sample) => (
        sample.fenceTop === null
          ? Number.POSITIVE_INFINITY
          : Math.abs(sample.fenceTop - result.beforeFenceTop - expectedFenceShift)
      )));

    if (
      result.samples.length < 12
      || result.text !== expectedText
      || result.selectionHead !== setup.insertionPosition + 1
      || result.selectionLine !== setup.targetLine + 1
      || !String(result.activeElement).includes('cm-content')
      || !result.caretVisible
      || scrollSpan > 1
      || jumpedToEnd
      || unexpectedSelection
      || missingFenceFrames > 0
      || (enterCase.edge === 'end' && fenceDrift > 1)
    ) {
      failures.push(`${fixture.name} ${enterCase.name} was unstable: ${JSON.stringify({
        expectedTextMatches: result.text === expectedText,
        expectedHead: setup.insertionPosition + 1,
        expectedLine: setup.targetLine + 1,
        selectionHead: result.selectionHead,
        selectionLine: result.selectionLine,
        activeElement: result.activeElement,
        caretVisible: result.caretVisible,
        scrollSpan,
        jumpedToEnd,
        unexpectedSelection,
        missingFenceFrames,
        fenceDrift,
        samples: result.samples
      })}`);
      continue;
    }
    console.log(`${fixture.name} ${enterCase.name}: content, caret, and viewport stayed stable`);
  }
  if (failures.length) throw new Error(failures.join('\n'));
} catch (error) {
  primaryError = error;
} finally {
  fs.rmSync(outdir, { recursive: true, force: true });
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
