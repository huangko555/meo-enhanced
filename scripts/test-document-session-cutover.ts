import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import { darkBuiltInVisuals } from '../src/shared/builtInVisualBaseline';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-document-session-cutover-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-document-session-cutover-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'candidate.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><style>html,body,#editor{height:100%;margin:0}</style><body><div id="editor"></div></body>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'candidate.js') });
    await page.evaluate((theme) => {
      (window as any).__documentSessionCandidate.initialize({
        type: 'init',
        documentId: 'file:///candidate.md',
        text: 'alpha',
        version: 1,
        savedRevision: { version: 1, text: 'alpha' },
        diagnostics: [],
        mode: 'source',
        previewAppearance: 'dark',
        previewFontFamily: '',
        previewSourceColoring: true,
        editorAppearance: 'dark',
        gitChangesGutter: false,
        gitDiffLineHighlights: false,
        diffBaselineMode: 'current-edit',
        fixedBaselinePinned: false,
        fixedBaselineActive: false,
        contentMaxWidthEnabled: false,
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right',
        outlineVisible: false,
        outlineWidth: 260,
        vscodeTheme: null
      });
    }, darkBuiltInVisuals);
    await page.waitForSelector('.cm-editor');

    const initial = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(initial.syncOwner, 'document-session');
    assert.equal(initial.coordinatorStarts, 1);
    assert.equal(initial.legacyCoordinatorStarts, 0);
    assert.equal(initial.editorText, 'alpha');

    await page.click('.cm-content');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('local-one');
    await page.evaluate(() => (window as any).__documentSessionCandidate.whenIdle());

    let snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.hostRevision.text, 'alpha\nlocal-one');
    assert.equal(snapshot.persistedDraft, null);

    await page.evaluate(() => (window as any).__documentSessionCandidate.holdApplyChanges(true));
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('local-two');
    await page.evaluate(() => (window as any).__documentSessionCandidate.whenIdle());
    await page.evaluate(() => (window as any).__documentSessionCandidate.externalChange('remote\nalpha\nlocal-one'));
    await page.evaluate(() => (window as any).__documentSessionCandidate.releaseApplyChanges());

    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.editorText, 'remote\nalpha\nlocal-one\nlocal-two');
    assert.equal(snapshot.hostRevision.text, snapshot.editorText);
    assert.equal(snapshot.persistedDraft, null);

    await page.evaluate(() => (window as any).__documentSessionCandidate.save());
    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.savedText, snapshot.editorText);
    assert.equal(snapshot.messages.some((message: any) => message.type === 'saveDocument'), false);
    assert.equal(snapshot.messages.some((message: any) => message.type === 'saveDocumentRevision'), true);

    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('after-save');
    await page.evaluate(() => (window as any).__documentSessionCandidate.whenIdle());
    const savedBeforeFailure = snapshot.savedText;
    await page.evaluate(() => {
      (window as any).__documentSessionCandidate.failNextSave();
      return (window as any).__documentSessionCandidate.save();
    });
    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.savedText, savedBeforeFailure);
    assert.equal(snapshot.editorText.endsWith('after-save'), true);

    await page.evaluate(() => (window as any).__documentSessionCandidate.holdApplyChanges(true));
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('protected-draft');
    await page.evaluate(() => (window as any).__documentSessionCandidate.whenIdle());
    await page.evaluate(() => {
      const candidate = (window as any).__documentSessionCandidate;
      const current = candidate.snapshot();
      candidate.failRevisionRequests(2);
      return candidate.replay(current.hostRevision.version, 'contradictory replay');
    });
    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.editorText.endsWith('protected-draft'), true);
    assert.equal(snapshot.persistedDraft.endsWith('protected-draft'), true);
    assert.deepEqual(snapshot.notices, ['Could not resynchronize the document. Local edits were kept.']);
    await page.evaluate(() => (window as any).__documentSessionCandidate.releaseApplyChanges());

    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    const beforeStaleReplay = snapshot.editorText;
    await page.evaluate(() => {
      const candidate = (window as any).__documentSessionCandidate;
      const current = candidate.snapshot();
      return candidate.replay(current.hostRevision.version - 1, 'stale text');
    });
    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.editorText, beforeStaleReplay);

    await page.evaluate(() => (window as any).__documentSessionCandidate.discard());
    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.editorText, savedBeforeFailure);
    assert.equal(snapshot.hostRevision.text, savedBeforeFailure);
    assert.equal(snapshot.persistedDraft, null);
    assert.equal(snapshot.coordinatorStarts, 1);
    assert.equal(snapshot.legacyCoordinatorStarts, 0);

    await page.evaluate(() => {
      type PendingRender = {
        resolve(value: { svg: string }): void;
        reject(error: Error): void;
      };
      const pending = new Map<string, PendingRender[]>();
      const waiting = new Map<string, Array<(render: PendingRender) => void>>();
      const takeNext = (source: string): Promise<PendingRender> => {
        const queued = pending.get(source)?.shift();
        if (queued) return Promise.resolve(queued);
        return new Promise((resolve) => {
          const sourceWaiters = waiting.get(source) ?? [];
          sourceWaiters.push(resolve);
          waiting.set(source, sourceWaiters);
        });
      };
      (window as any).mermaid = {
        initialize() {},
        render(_renderId: string, source: string) {
          return new Promise<{ svg: string }>((resolve, reject) => {
            const sourceWaiters = waiting.get(source);
            const waiter = sourceWaiters?.shift();
            if (waiter) {
              if (sourceWaiters?.length === 0) waiting.delete(source);
              waiter({ resolve, reject });
              return;
            }
            const queued = pending.get(source) ?? [];
            queued.push({ resolve, reject });
            pending.set(source, queued);
          });
        }
      };
      (window as any).__completeDocumentSessionMermaid = async (source: string, marker: string) => {
        const render = await takeNext(source);
        render.resolve({ svg: `<svg data-marker="${marker}" width="160" height="80"></svg>` });
      };
      (window as any).__failDocumentSessionMermaid = async (source: string, message: string) => {
        const render = await takeNext(source);
        render.reject(new Error(message));
      };
    });

    const readyMermaidBaseText = [
      '```mermaid',
      'READY_VISIBLE',
      '```',
      '',
      ...Array.from({ length: 20 }, (_, index) => `ready-line-${index + 1}`)
    ].join('\n');
    await page.evaluate(
      (text) => (window as any).__documentSessionCandidate.externalChange(text),
      readyMermaidBaseText
    );
    await page.click('.cm-content');
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await page.keyboard.type(' ready-edit');
    await page.evaluate(() => (window as any).__documentSessionCandidate.whenIdle());
    const equalReadyMermaidText = `${readyMermaidBaseText} ready-edit`;
    await page.evaluate(() => (window as any).__documentSessionCandidate.setMode('live'));
    await page.waitForSelector('.meo-mermaid-loading');
    await page.evaluate(() => {
      (window as any).__completeDocumentSessionMermaid('READY_VISIBLE', 'ready-visible');
    });
    await page.waitForSelector('svg[data-marker="ready-visible"]');
    await page.evaluate(async (text) => {
      const candidate = (window as any).__documentSessionCandidate;
      await candidate.externalChange(text);
      await candidate.externalChange(text);
    }, equalReadyMermaidText);
    assert.equal(
      await page.$('svg[data-marker="ready-visible"]') !== null,
      true,
      'equal-text external presentation must preserve an already visible Mermaid diagram'
    );

    const errorMermaidBaseText = [
      '```mermaid',
      'ERROR_VISIBLE',
      '```',
      '',
      ...Array.from({ length: 20 }, (_, index) => `error-line-${index + 1}`)
    ].join('\n');
    await page.evaluate(() => (window as any).__documentSessionCandidate.setMode('source'));
    await page.evaluate(
      (text) => (window as any).__documentSessionCandidate.externalChange(text),
      errorMermaidBaseText
    );
    await page.click('.cm-content');
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await page.keyboard.type(' error-edit');
    await page.evaluate(() => (window as any).__documentSessionCandidate.whenIdle());
    const equalErrorMermaidText = `${errorMermaidBaseText} error-edit`;
    await page.evaluate(() => (window as any).__documentSessionCandidate.setMode('live'));
    await page.waitForSelector('.meo-mermaid-loading');
    await page.evaluate(() => {
      (window as any).__failDocumentSessionMermaid('ERROR_VISIBLE', 'visible parse error');
    });
    await page.waitForSelector('.meo-mermaid-error-badge');
    await page.evaluate(async (text) => {
      const candidate = (window as any).__documentSessionCandidate;
      await candidate.externalChange(text);
      await candidate.externalChange(text);
    }, equalErrorMermaidText);
    assert.equal(
      await page.$('.meo-mermaid-fallback') !== null,
      true,
      'equal-text external presentation must preserve the visible Mermaid source fallback'
    );
    assert.equal(
      await page.$eval('.meo-mermaid-error-badge', (node) => node.textContent),
      'Mermaid error: visible parse error'
    );

    const mermaidBaseText = [
      '```mermaid',
      'SLOW_OLD',
      '```',
      '',
      ...Array.from({ length: 80 }, (_, index) => `history-line-${index + 1}`)
    ].join('\n');
    await page.evaluate(() => (window as any).__documentSessionCandidate.setMode('source'));
    await page.evaluate(
      (text) => (window as any).__documentSessionCandidate.externalChange(text),
      mermaidBaseText
    );
    await page.click('.cm-content');
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await page.keyboard.type(' history-edit');
    await page.evaluate(() => (window as any).__documentSessionCandidate.whenIdle());
    const equalExternalText = `${mermaidBaseText} history-edit`;
    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.editorText, equalExternalText);

    await page.evaluate(() => (window as any).__documentSessionCandidate.setMode('live'));
    await page.waitForSelector('.meo-mermaid-loading');
    await page.keyboard.down('Shift');
    for (let index = 0; index < 4; index += 1) await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Shift');
    const beforeEqualExternal = await page.evaluate(() => {
      (window as any).__equalTextEditorDom = document.querySelector('.cm-editor');
      return {
        snapshot: (window as any).__documentSessionCandidate.snapshot(),
        liveMode: document.querySelector('.cm-editor')?.classList.contains('meo-mode-live') ?? false,
        focusInEditor: document.activeElement?.closest('.cm-editor') === document.querySelector('.cm-editor'),
        selection: document.getSelection()?.toString() ?? '',
        scrollTop: document.querySelector<HTMLElement>('.cm-scroller')?.scrollTop ?? -1
      };
    });
    assert.equal(beforeEqualExternal.liveMode, true);
    assert.equal(beforeEqualExternal.focusInEditor, true);
    assert.equal(beforeEqualExternal.selection, 'edit');
    assert.ok(beforeEqualExternal.scrollTop > 0);

    await page.evaluate(async (text) => {
      const candidate = (window as any).__documentSessionCandidate;
      await candidate.externalChange(text);
      await candidate.externalChange(text);
      const mermaidBlock = document.querySelector('.meo-mermaid-block');
      if (!mermaidBlock) throw new Error('Missing public Mermaid block');
      if (mermaidBlock.querySelector('.meo-mermaid-error-badge')) {
        throw new Error('External Mermaid replacement was not started');
      }
      const scroller = document.querySelector<HTMLElement>('.cm-scroller');
      if (!scroller) throw new Error('Missing public CodeMirror scroller');
      const viewportSettled = new Promise<void>((resolve) => {
        scroller.addEventListener('scrollend', () => resolve(), { once: true });
      });
      let errorObserver!: MutationObserver;
      const unexpectedError = new Promise<never>((_resolve, reject) => {
        errorObserver = new MutationObserver(() => {
          if (mermaidBlock.querySelector('.meo-mermaid-error-badge')) {
            reject(new Error('External Mermaid replacement was not started'));
          }
        });
        errorObserver.observe(mermaidBlock, { childList: true, subtree: true });
      });
      await (window as any).__completeDocumentSessionMermaid('SLOW_OLD', 'stale-old');
      try {
        await Promise.race([
          (window as any).__completeDocumentSessionMermaid('SLOW_OLD', 'current-external'),
          unexpectedError
        ]);
      } finally {
        errorObserver.disconnect();
      }
      await viewportSettled;
    }, equalExternalText);
    await page.waitForSelector('svg[data-marker="current-external"]');
    await page.evaluate(() => (window as any).__documentSessionCandidate.whenIdle());
    const afterEqualExternal = await page.evaluate(() => {
      return {
        snapshot: (window as any).__documentSessionCandidate.snapshot(),
        sameEditorDom: (window as any).__equalTextEditorDom === document.querySelector('.cm-editor'),
        liveMode: document.querySelector('.cm-editor')?.classList.contains('meo-mode-live') ?? false,
        focusInEditor: document.activeElement?.closest('.cm-editor') === document.querySelector('.cm-editor'),
        selection: document.getSelection()?.toString() ?? '',
        scrollTop: document.querySelector<HTMLElement>('.cm-scroller')?.scrollTop ?? -1,
        staleDiagramVisible: Boolean(document.querySelector('svg[data-marker="stale-old"]')),
        currentDiagramVisible: Boolean(document.querySelector('svg[data-marker="current-external"]'))
      };
    });
    assert.equal(afterEqualExternal.sameEditorDom, true);
    assert.equal(afterEqualExternal.snapshot.editorText, equalExternalText);
    assert.equal(afterEqualExternal.liveMode, true);
    assert.equal(afterEqualExternal.focusInEditor, beforeEqualExternal.focusInEditor);
    assert.equal(afterEqualExternal.selection, beforeEqualExternal.selection);
    assert.equal(
      afterEqualExternal.staleDiagramVisible,
      false,
      'equal-text external presentation must reject the prior Mermaid completion'
    );
    assert.equal(
      afterEqualExternal.currentDiagramVisible,
      true,
      'equal-text external presentation must complete its replacement Mermaid generation'
    );
    assert.equal(afterEqualExternal.snapshot.viewport.line, beforeEqualExternal.snapshot.viewport.line);
    assert.ok(
      Math.abs(
        afterEqualExternal.snapshot.viewport.lineOffset
          - beforeEqualExternal.snapshot.viewport.lineOffset
      ) < 1
    );

    await page.evaluate(() => (window as any).__documentSessionCandidate.undo());
    await page.evaluate(() => (window as any).__documentSessionCandidate.whenIdle());
    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.editorText, mermaidBaseText);
    await page.evaluate(() => (window as any).__documentSessionCandidate.redo());
    await page.evaluate(() => (window as any).__documentSessionCandidate.whenIdle());
    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.editorText, equalExternalText);

    const currentMermaidText = equalExternalText.replace('SLOW_OLD', 'CURRENT_NEW');
    await page.evaluate(
      (text) => (window as any).__documentSessionCandidate.externalChange(text),
      currentMermaidText
    );
    await page.waitForSelector('.meo-mermaid-loading');
    await page.evaluate(() => {
      (window as any).__completeDocumentSessionMermaid('CURRENT_NEW', 'current');
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const currentDiagramMarker = await page.$eval(
      '.meo-mermaid-svg-wrapper > svg',
      (node) => node.getAttribute('data-marker')
    );
    assert.equal(currentDiagramMarker, 'current');

    console.log('Document Session candidate cutover browser trace passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
