import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-editor-history-runtime-'));

async function waitForFrames(page: any, count = 8): Promise<void> {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main(): Promise<void> {
  const entry = path.join(repoRoot, 'scripts', 'test-editor-history-runtime-entry.ts');
  const entrySource = fs.readFileSync(entry, 'utf8');
  assert.equal(/from ['"]\.\.\/webview\/src\/editor(?:['"]|\/)/.test(entrySource), false, 'candidate must not load production Editor');
  assert.equal(entrySource.includes('HistoryCoordinator'), false, 'candidate must not instantiate Legacy history');

  const build = await Bun.build({
    entrypoints: [entry],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'candidate.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 500 });
    await page.setContent(`<!doctype html><style>
      html,body,#app{height:100%;margin:0}.cm-editor{height:100%}.cm-scroller{overflow:auto}
      #rendered,#table-fixture{position:fixed;right:8px;width:180px}
      #rendered{top:8px}#table-fixture{top:52px}
    </style><div id="app"></div><textarea id="rendered"></textarea><textarea id="table-fixture"></textarea>`);
    await page.addScriptTag({ path: path.join(tempDir, 'candidate.js') });
    await page.evaluate(() => (window as any).__editorHistoryCandidate.initialize());
    await waitForFrames(page);

    let snapshot = await page.evaluate(() => (window as any).__editorHistoryCandidate.snapshot());
    assert.equal(snapshot.runtimeStarts, 1);
    assert.equal(snapshot.legacyCoordinatorStarts, 0);
    assert.equal(snapshot.state.lifecycle, 'active');

    await page.evaluate(() => (window as any).__editorHistoryCandidate.edit(' SOURCE_EDIT', 'source'));
    await page.evaluate(() => (window as any).__editorHistoryCandidate.setMode('live'));
    await page.evaluate(() => (window as any).__editorHistoryCandidate.edit(' LIVE_EDIT', 'live'));
    snapshot = await page.evaluate(() => (window as any).__editorHistoryCandidate.snapshot());
    assert.match(snapshot.text, /SOURCE_EDIT LIVE_EDIT$/);

    await page.evaluate(() => (window as any).__editorHistoryCandidate.replay('undo'));
    snapshot = await page.evaluate(() => (window as any).__editorHistoryCandidate.snapshot());
    assert.match(snapshot.text, /SOURCE_EDIT$/);
    assert.equal(snapshot.focusOwner, 'editor');
    assert.equal(snapshot.selectionHead, snapshot.text.length);
    assert.equal(snapshot.focusedHead, snapshot.text.length);
    assert.equal(snapshot.selectionVisible, true);

    await page.evaluate(() => (window as any).__editorHistoryCandidate.setMode('source'));
    await page.evaluate(() => (window as any).__editorHistoryCandidate.replay('undo'));
    snapshot = await page.evaluate(() => (window as any).__editorHistoryCandidate.snapshot());
    assert.equal(snapshot.text.includes('SOURCE_EDIT'), false, 'mode switch must preserve native history continuity');
    assert.equal(snapshot.selectionHead, snapshot.text.length);

    await page.evaluate(() => Promise.all([
      (window as any).__editorHistoryCandidate.replay('redo'),
      (window as any).__editorHistoryCandidate.replay('redo')
    ]));
    snapshot = await page.evaluate(() => (window as any).__editorHistoryCandidate.snapshot());
    assert.match(snapshot.text, /SOURCE_EDIT LIVE_EDIT$/);
    assert.deepEqual(snapshot.nativeReplayTail, ['redo', 'redo'], 'rapid replays must retain serialized order');

    await page.evaluate(() => (window as any).__editorHistoryCandidate.prepareTableTransient(' TABLE_EDIT'));
    await page.evaluate(() => (window as any).__editorHistoryCandidate.replay('undo'));
    snapshot = await page.evaluate(() => (window as any).__editorHistoryCandidate.snapshot());
    assert.equal(snapshot.text.includes('TABLE_EDIT'), false, 'pending table fixture must commit before native undo');
    assert.equal(snapshot.focusOwner, 'table-boundary');

    await page.evaluate(() => (window as any).__editorHistoryCandidate.editRendered(' RENDERED_EDIT', 'split'));
    await page.evaluate(() => (window as any).__editorHistoryCandidate.replay('undo'));
    snapshot = await page.evaluate(() => (window as any).__editorHistoryCandidate.snapshot());
    assert.equal(snapshot.text.includes('RENDERED_EDIT'), false);
    assert.equal(snapshot.renderedMode, 'split');
    assert.equal(snapshot.focusOwner, 'rendered-block');
    assert.equal(snapshot.focusedHead, snapshot.text.length);

    await page.evaluate(() => (window as any).__editorHistoryCandidate.editRendered(' RETRY_EDIT', 'preview'));
    await page.evaluate(() => (window as any).__editorHistoryCandidate.setRenderedMounted(false));
    await page.evaluate(() => (window as any).__editorHistoryCandidate.replay('undo'));
    snapshot = await page.evaluate(() => (window as any).__editorHistoryCandidate.snapshot());
    assert.equal(snapshot.state.pendingReplay?.phase, 'restoring');
    await page.evaluate(() => (window as any).__editorHistoryCandidate.setRenderedMounted(true));
    await waitForFrames(page, 6);
    await page.evaluate(() => (window as any).__editorHistoryCandidate.whenIdle());
    snapshot = await page.evaluate(() => (window as any).__editorHistoryCandidate.snapshot());
    assert.equal(snapshot.state.pendingReplay, null);
    assert.equal(snapshot.focusOwner, 'rendered-block');

    await page.evaluate(() => (window as any).__editorHistoryCandidate.editRendered(' STALE_EDIT', 'split'));
    await page.evaluate(() => (window as any).__editorHistoryCandidate.setRenderedMounted(false));
    await page.evaluate(() => (window as any).__editorHistoryCandidate.replay('undo'));
    const restoresBeforeInvalidation = await page.evaluate(() => (
      (window as any).__editorHistoryCandidate.snapshot().boundaryRestores
    ));
    await page.evaluate(() => (window as any).__editorHistoryCandidate.externalPresent());
    await page.evaluate(() => (window as any).__editorHistoryCandidate.setRenderedMounted(true));
    await waitForFrames(page, 6);
    snapshot = await page.evaluate(() => (window as any).__editorHistoryCandidate.snapshot());
    assert.equal(snapshot.state.pendingReplay, null);
    assert.equal(snapshot.boundaryRestores, restoresBeforeInvalidation, 'external presentation must cancel stale focus retry');

    await page.evaluate(() => (window as any).__editorHistoryCandidate.editKnownSourceLimit(' SOURCE_LIMIT'));
    await page.evaluate(() => (window as any).__editorHistoryCandidate.replay('undo'));
    snapshot = await page.evaluate(() => (window as any).__editorHistoryCandidate.snapshot());
    assert.equal(snapshot.knownSourcePreserved, false, 'candidate must retain the frozen source block-mode limitation');
    assert.equal(snapshot.renderedMode, 'preview');
    assert.equal(snapshot.focusOwner, 'rendered-block');
    assert.equal(snapshot.focusedHead, snapshot.text.length);

    const boundary = await page.evaluate(() => (window as any).__editorHistoryCandidate.exhaustHistory());
    assert.equal(boundary.applied, false);
    assert.equal(boundary.state.pendingReplay, null);

    await page.evaluate(() => (window as any).__editorHistoryCandidate.dispose());
    await page.evaluate(() => (window as any).__editorHistoryCandidate.replay('redo'));
    snapshot = await page.evaluate(() => (window as any).__editorHistoryCandidate.snapshot());
    assert.equal(snapshot.state.lifecycle, 'disposed');
    assert.equal(snapshot.disposes, 1);
    assert.deepEqual(snapshot.errors, []);
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('Editor history Chromium + CodeMirror candidate trace passed');
}

await main();
