import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import { syntaxParsingBuildPlugin } from './test-editor-syntax-parsing-build';

type ParseCall = {
  kind: 'ensure' | 'force';
  phase: string;
  docLength: number;
  viewportFrom?: number;
  viewportTo?: number;
  upto: number;
  timeout: number;
  result: 'tree' | 'complete' | 'partial';
  duration: number;
};

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-editor-syntax-parsing-matrix-'));

function assertFullDocumentEnsures(calls: ParseCall[], docLength: number, label: string): void {
  const ensures = calls.filter((call) => call.kind === 'ensure');
  assert.ok(ensures.length > 0, `${label} must request the syntax needed by existing Live decorations`);
  assert.ok(
    ensures.every((call) => call.upto === docLength && call.timeout === 50 && call.result === 'partial'),
    `${label} must keep the existing 50ms Live ensureSyntaxTree contract and accept timeout fallback`
  );
}

function assertOneLiveForce(calls: ParseCall[], docLength: number, label: string): void {
  const forceCalls = calls.filter((call) => call.kind === 'force');
  assert.deepEqual(
    forceCalls.map(({ upto, timeout, result }) => ({ upto, timeout, result })),
    [{ upto: docLength, timeout: 500, result: 'partial' }],
    `${label} must have one bounded full-document Live parse request and tolerate a partial result`
  );
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-editor-syntax-parsing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js',
    plugins: [syntaxParsingBuildPlugin()]
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 720, deviceScaleFactor: 1 });
    await page.setContent([
      '<!doctype html><style>html,body{height:100%;margin:0}.host{height:48%;overflow:auto}</style>',
      '<div id="source" class="host"></div><div id="live" class="host"></div>'
    ].join(''));
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#fff;--meo-foreground:#111;--meo-code-background:#f4f4f4;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--meo-line-height-live:1.6;--meo-line-height-source:1.5}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(() => {
      (window as any).__meoSyntaxParseControls = { ensure: 'null', force: 'false' };
      (window as any).__meoSyntaxParseCalls = [];
      (window as any).__meoSyntaxParsePhase = 'setup';
    });

    const visiblePrefix = [
      '# Visible heading',
      '',
      'Visible ==highlight== and **strong** text.',
      '',
      '| A | B |',
      '| --- | --- |',
      '| one | two |',
      ''
    ];
    const largeText = [
      ...visiblePrefix,
      ...Array.from({ length: 1400 }, (_, index) => `plain source line ${index}`),
      '## OFFSCREEN SYNTAX',
      '',
      '| Far A | Far B |',
      '| --- | --- |',
      '| far one | far two |'
    ].join('\n');

    const initialSource = await page.evaluate((text) => {
      const harness = (window as any).EditorSyntaxParsingHarness;
      (window as any).__meoSyntaxParsePhase = 'initial-source';
      const editor = harness.createEditor({
        parent: document.getElementById('source'),
        text,
        initialMode: 'source',
        onApplyChanges() {}
      });
      (window as any).__syntaxSourceEditor = editor;
      const selectionFrom = text.indexOf('Visible');
      editor.view.dispatch({ selection: { anchor: selectionFrom, head: selectionFrom + 7 } });
      editor.focus();
      return {
        mode: editor.view.dom.classList.contains('meo-mode-source') ? 'source' : 'live',
        text: editor.getText(),
        selection: {
          anchor: editor.view.state.selection.main.anchor,
          head: editor.view.state.selection.main.head
        },
        history: editor.getHistoryDepth(),
        focused: editor.hasFocus(),
        viewport: editor.getTopVisiblePosition(),
        visibleHighlight: Boolean(document.querySelector('#source .meo-md-highlight')),
        offscreenPosition: text.indexOf('OFFSCREEN SYNTAX'),
        calls: structuredClone((window as any).__meoSyntaxParseCalls)
      };
    }, largeText);
    assert.equal(initialSource.mode, 'source');
    assert.equal(initialSource.text, largeText);
    assert.equal(initialSource.visibleHighlight, true, 'Source must keep visible basic Markdown presentation');
    assert.ok(initialSource.offscreenPosition > 3_000);
    assert.deepEqual(initialSource.history, { undo: 0, redo: 0 });
    assert.equal(initialSource.focused, true);
    assert.deepEqual(
      initialSource.calls.filter((call: ParseCall) => call.phase === 'initial-source'),
      [],
      'initial Source must not synchronously request whole-document parsing'
    );

    const sourceEditedText = largeText.replace('plain source line 0', 'plain Source line 0');
    const sourceDocumentChange = await page.evaluate((text) => {
      const editor = (window as any).__syntaxSourceEditor;
      (window as any).__meoSyntaxParseCalls = [];
      (window as any).__meoSyntaxParsePhase = 'source-document-change';
      editor.setText(text);
      return {
        text: editor.getText(),
        history: editor.getHistoryDepth(),
        calls: structuredClone((window as any).__meoSyntaxParseCalls)
      };
    }, sourceEditedText);
    assert.equal(sourceDocumentChange.text, sourceEditedText);
    assert.deepEqual(sourceDocumentChange.history, initialSource.history);
    assert.deepEqual(
      sourceDocumentChange.calls,
      [],
      'Source document presentation must consume the published partial tree without whole-document parsing'
    );

    const sourceToLive = await page.evaluate(() => {
      const editor = (window as any).__syntaxSourceEditor;
      (window as any).__meoSyntaxParseCalls = [];
      (window as any).__meoSyntaxParsePhase = 'source-to-live-partial';
      editor.setMode('live');
      return {
        mode: editor.view.dom.classList.contains('meo-mode-live') ? 'live' : 'source',
        text: editor.getText(),
        selection: {
          anchor: editor.view.state.selection.main.anchor,
          head: editor.view.state.selection.main.head
        },
        history: editor.getHistoryDepth(),
        focused: editor.hasFocus(),
        viewport: editor.getTopVisiblePosition(),
        visibleRichContent: Boolean(document.querySelector('#source .meo-md-table-shell, #source .meo-md-highlight')),
        calls: structuredClone((window as any).__meoSyntaxParseCalls)
      };
    });
    assert.equal(sourceToLive.mode, 'live');
    assert.equal(sourceToLive.text, sourceEditedText);
    assert.deepEqual(sourceToLive.selection, initialSource.selection);
    assert.deepEqual(sourceToLive.history, initialSource.history);
    assert.equal(sourceToLive.focused, true);
    assert.deepEqual(sourceToLive.viewport, initialSource.viewport);
    assert.equal(sourceToLive.visibleRichContent, true, 'partial Live parse must preserve visible rendering');
    assertFullDocumentEnsures(sourceToLive.calls, largeText.length, 'Source-to-Live');
    assertOneLiveForce(sourceToLive.calls, largeText.length, 'Source-to-Live');
    assert.ok(
      sourceToLive.calls.some((call) => call.kind === 'force' && call.upto > initialSource.offscreenPosition),
      'the retained Live force request must explicitly include offscreen syntax'
    );

    const liveToSource = await page.evaluate(() => {
      const editor = (window as any).__syntaxSourceEditor;
      (window as any).__meoSyntaxParseCalls = [];
      (window as any).__meoSyntaxParsePhase = 'live-to-source';
      editor.setMode('source');
      return {
        mode: editor.view.dom.classList.contains('meo-mode-source') ? 'source' : 'live',
        text: editor.getText(),
        selection: {
          anchor: editor.view.state.selection.main.anchor,
          head: editor.view.state.selection.main.head
        },
        history: editor.getHistoryDepth(),
        focused: editor.hasFocus(),
        viewport: editor.getTopVisiblePosition(),
        calls: structuredClone((window as any).__meoSyntaxParseCalls)
      };
    });
    assert.equal(liveToSource.mode, 'source');
    assert.equal(liveToSource.text, sourceEditedText);
    assert.deepEqual(liveToSource.selection, initialSource.selection);
    assert.deepEqual(liveToSource.history, initialSource.history);
    assert.equal(liveToSource.focused, true);
    assert.deepEqual(liveToSource.viewport, initialSource.viewport);
    assert.deepEqual(liveToSource.calls, [], 'Live-to-Source must not parse resources that were just removed');

    const rollback = await page.evaluate(() => {
      const editor = (window as any).__syntaxSourceEditor;
      editor.setMode('live');
      const before = {
        text: editor.getText(),
        selection: {
          anchor: editor.view.state.selection.main.anchor,
          head: editor.view.state.selection.main.head
        },
        history: editor.getHistoryDepth(),
        focused: editor.hasFocus(),
        viewport: editor.getTopVisiblePosition()
      };
      const originalDispatch = editor.view.dispatch.bind(editor.view);
      (window as any).__meoSyntaxParseCalls = [];
      (window as any).__meoSyntaxParsePhase = 'failed-live-to-source';
      editor.view.dispatch = () => { throw new Error('forced reconfigure failure'); };
      let message = '';
      try {
        editor.setMode('source');
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      } finally {
        editor.view.dispatch = originalDispatch;
      }
      return {
        message,
        mode: editor.view.dom.classList.contains('meo-mode-live') ? 'live' : 'source',
        before,
        after: {
          text: editor.getText(),
          selection: {
            anchor: editor.view.state.selection.main.anchor,
            head: editor.view.state.selection.main.head
          },
          history: editor.getHistoryDepth(),
          focused: editor.hasFocus(),
          viewport: editor.getTopVisiblePosition()
        },
        calls: structuredClone((window as any).__meoSyntaxParseCalls)
      };
    });
    assert.equal(rollback.message, 'forced reconfigure failure');
    assert.equal(rollback.mode, 'live');
    assert.deepEqual(rollback.after, rollback.before);
    assert.deepEqual(rollback.calls, [], 'failed reconfigure must not trigger parsing');

    const roundTrips = await page.evaluate(() => {
      const editor = (window as any).__syntaxSourceEditor;
      editor.setMode('source');
      (window as any).__meoSyntaxParseCalls = [];
      for (let cycle = 0; cycle < 2; cycle += 1) {
        (window as any).__meoSyntaxParsePhase = `round-${cycle}-source-to-live`;
        editor.setMode('live');
        (window as any).__meoSyntaxParsePhase = `round-${cycle}-live-to-source`;
        editor.setMode('source');
      }
      return {
        mode: editor.view.dom.classList.contains('meo-mode-source') ? 'source' : 'live',
        text: editor.getText(),
        history: editor.getHistoryDepth(),
        calls: structuredClone((window as any).__meoSyntaxParseCalls)
      };
    });
    assert.equal(roundTrips.mode, 'source');
    assert.equal(roundTrips.text, sourceEditedText);
    assert.deepEqual(roundTrips.history, initialSource.history);
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const toLive = roundTrips.calls.filter((call: ParseCall) => call.phase === `round-${cycle}-source-to-live`);
      const toSource = roundTrips.calls.filter((call: ParseCall) => call.phase === `round-${cycle}-live-to-source`);
      assertFullDocumentEnsures(toLive, largeText.length, `round ${cycle} Source-to-Live`);
      assertOneLiveForce(toLive, largeText.length, `round ${cycle} Source-to-Live`);
      assert.deepEqual(toSource, []);
    }

    const smallText = visiblePrefix.join('\n');
    const initialLiveCalls = await page.evaluate((text) => {
      const harness = (window as any).EditorSyntaxParsingHarness;
      (window as any).__meoSyntaxParseCalls = [];
      (window as any).__meoSyntaxParsePhase = 'initial-live-small';
      const editor = harness.createEditor({
        parent: document.getElementById('live'),
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
      (window as any).__syntaxLiveEditor = editor;
      return structuredClone((window as any).__meoSyntaxParseCalls);
    }, smallText);
    assertFullDocumentEnsures(initialLiveCalls, smallText.length, 'initial Live');
    assert.equal(initialLiveCalls.some((call: ParseCall) => call.kind === 'force'), false);

    const publicationPrefix = Array.from(
      { length: 6_200 },
      (_, index) => `remote paragraph ${index.toString().padStart(4, '0')} with stable Markdown content and parser lookahead padding`
    );
    const publicationSuffix = [
      '| Real A | Real B |',
      '| --- | --- |',
      '| one | two |',
      'paragraph with #valid-tag',
      '```text',
      '| Fake A | Fake B |',
      '| :--- | ---: |',
      '#not-a-tag',
      'const insideFence = true',
      '```'
    ];
    const publicationText = [...publicationPrefix, ...publicationSuffix].join('\n');
    assert.ok(publicationText.length > 347_000, 'publication matrix must cross the production-scale parser lookahead');

    const publicationInitial = await page.evaluate((text) => {
      const host = document.createElement('div');
      host.id = 'publication';
      host.className = 'host';
      document.body.append(host);
      const harness = (window as any).EditorSyntaxParsingHarness;
      (window as any).__meoSyntaxParseCalls = [];
      (window as any).__meoSyntaxParsePhase = 'publication-initial-source';
      const editor = harness.createEditor({
        parent: host,
        text,
        initialMode: 'source',
        onApplyChanges() {}
      });
      (window as any).__syntaxPublicationEditor = editor;
      return {
        text: editor.getText(),
        history: editor.getHistoryDepth(),
        calls: structuredClone((window as any).__meoSyntaxParseCalls)
      };
    }, publicationText);
    assert.equal(publicationInitial.text, publicationText);
    assert.deepEqual(publicationInitial.history, { undo: 0, redo: 0 });
    assert.deepEqual(publicationInitial.calls, []);

    const fakeHeaderPosition = publicationText.indexOf('| Fake A | Fake B |');
    const targetLine = publicationPrefix.length + 5;
    await page.evaluate(({ line, position }) => {
      const editor = (window as any).__syntaxPublicationEditor;
      editor.scrollToLine(line, 'top');
      editor.revealSelection(position, position, { align: 'nearest', focusEditor: true });
    }, { line: targetLine, position: fakeHeaderPosition });
    await page.waitForFunction((position) => {
      const harness = (window as any).EditorSyntaxParsingHarness;
      const editor = (window as any).__syntaxPublicationEditor;
      const names = harness.publishedNodeNamesAt(editor, position);
      return names.includes('CodeText') && names.includes('FencedCode');
    }, {}, fakeHeaderPosition);
    await page.evaluate(async () => {
      for (let frame = 0; frame < 4; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });

    const publicationDecorations = await page.evaluate(() => {
      const lines = Array.from(document.querySelectorAll<HTMLElement>('#publication .cm-line'));
      const findLine = (text: string) => lines.find((line) => line.textContent === text) ?? null;
      const summarize = (text: string) => {
        const line = findLine(text);
        return {
          visible: Boolean(line),
          tableLine: line?.classList.contains('meo-md-source-table-header-line') ?? false,
          tableCells: line?.querySelectorAll('.meo-md-source-table-header-cell').length ?? 0,
          codeLine: line?.classList.contains('meo-src-code-block') ?? false,
          tags: line?.querySelectorAll('.meo-md-tag').length ?? 0
        };
      };
      const editor = (window as any).__syntaxPublicationEditor;
      return {
        realHeader: summarize('| Real A | Real B |'),
        validTag: summarize('paragraph with #valid-tag'),
        fenceStart: summarize('```text'),
        fakeHeader: summarize('| Fake A | Fake B |'),
        fakeDelimiter: summarize('| :--- | ---: |'),
        fakeTag: summarize('#not-a-tag'),
        codeText: summarize('const insideFence = true'),
        fenceEnd: summarize('```'),
        text: editor.getText(),
        history: editor.getHistoryDepth(),
        calls: structuredClone((window as any).__meoSyntaxParseCalls)
      };
    });
    assert.equal(publicationDecorations.text, publicationText);
    assert.deepEqual(publicationDecorations.history, publicationInitial.history);
    assert.deepEqual(publicationDecorations.calls, [], 'parser publication must not add explicit ensure/force calls');
    assert.equal(publicationDecorations.realHeader.tableLine, true, 'published legal table header must stay decorated');
    assert.ok(publicationDecorations.realHeader.tableCells > 0);
    assert.equal(publicationDecorations.validTag.tags, 1, 'published legal Source tag must stay decorated');
    for (const [label, line] of Object.entries({
      fenceStart: publicationDecorations.fenceStart,
      fakeHeader: publicationDecorations.fakeHeader,
      fakeDelimiter: publicationDecorations.fakeDelimiter,
      fakeTag: publicationDecorations.fakeTag,
      codeText: publicationDecorations.codeText,
      fenceEnd: publicationDecorations.fenceEnd
    })) {
      assert.equal(line.visible, true, `${label} must be visible after scrolling past parser lookahead`);
      assert.equal(line.codeLine, true, `${label} must receive the Source code-block line decoration after publication`);
    }
    assert.equal(publicationDecorations.fakeHeader.tableLine, false, 'table-like fenced code must lose temporary header line decoration');
    assert.equal(publicationDecorations.fakeHeader.tableCells, 0, 'table-like fenced code must lose temporary header cell decorations');
    assert.equal(publicationDecorations.fakeTag.tags, 0, 'fenced code must lose temporary Source tag decoration');

    await page.evaluate(() => {
      (window as any).__syntaxSourceEditor.destroy();
      (window as any).__syntaxLiveEditor.destroy();
      (window as any).__syntaxPublicationEditor.destroy();
    });
  } finally {
    await browser.close();
  }

  console.log('Editor syntax parsing direction/budget/partial matrix passed');
}

main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
