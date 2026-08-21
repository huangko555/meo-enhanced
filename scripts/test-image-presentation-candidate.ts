import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-image-presentation-candidate-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-image-presentation-candidate-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><style>.meo-md-image{display:block;height:40px}.meo-md-image img{width:80px;height:40px}</style>
      <input id="focus" value="keep focus"><span id="selection">keep selection</span>
      <div id="one" class="meo-md-image"></div>
      <div id="two" class="meo-md-image"></div>
      <div id="replace" class="meo-md-image"></div>
      <div id="failure" class="meo-md-image"></div>
      <div id="other-context" class="meo-md-image"></div>
      <div style="height:2000px"></div>`);
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    const result = await page.evaluate(async () => {
      const harness = (window as any).ImagePresentationCandidate;
      const svg = (label: string, color: string) => (
        `data:image/svg+xml,${encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="${color}"/><text x="4" y="24">${label}</text></svg>`
        )}`
      );
      const pending = new Map<string, Array<(value: string | null) => void>>();
      const environment = harness.createEnvironment(async (contextKey: string, rawSrc: string) => {
        if (rawSrc.includes('missing')) return null;
        if (rawSrc.includes('broken-load')) return 'invalid-image://broken';
        if (rawSrc.includes('slow')) {
          return new Promise<string | null>((resolve) => {
            const waiters = pending.get(rawSrc) ?? [];
            waiters.push(resolve);
            pending.set(rawSrc, waiters);
          });
        }
        return svg(`${contextKey}:${rawSrc}`, '#6a8');
      });

      const first = environment.create(document.getElementById('one'), 'document-a', 'first');
      const second = environment.create(document.getElementById('two'), 'document-a', 'second');
      first.present('![shared](shared.png)', 'shared.png');
      second.present('![shared](shared.png)', 'shared.png');
      await Promise.all([
        first.whenCurrentPresentationSettles(),
        second.whenCurrentPresentationSettles()
      ]);
      const shared = {
        first: document.querySelector('#one img')?.getAttribute('src') ?? '',
        second: document.querySelector('#two img')?.getAttribute('src') ?? '',
        counts: environment.counts()
      };

      const replacement = environment.create(document.getElementById('replace'), 'document-a', 'replacement');
      replacement.present('![old](slow-old.png)', 'slow-old.png');
      const oldId = replacement.state().current?.presentationId;
      replacement.present('![new](new.png)', 'new.png');
      const newId = replacement.state().current?.presentationId;
      await replacement.whenCurrentPresentationSettles();
      const beforeOldCompletion = {
        phase: replacement.state().projected.phase,
        src: document.querySelector('#replace img')?.getAttribute('src') ?? ''
      };
      pending.get('slow-old.png')?.forEach((resolve: (value: string) => void) => resolve(svg('old', '#a66')));
      await Promise.resolve();
      await Promise.resolve();
      const afterOldCompletion = {
        phase: replacement.state().projected.phase,
        id: replacement.state().current?.presentationId,
        src: document.querySelector('#replace img')?.getAttribute('src') ?? ''
      };

      const failure = environment.create(document.getElementById('failure'), 'document-a', 'failure');
      failure.present('![missing](missing.png)', 'missing.png');
      await failure.whenCurrentPresentationSettles();
      failure.present('![broken](broken-load.png)', 'broken-load.png');
      await failure.whenCurrentPresentationSettles();

      const otherContext = environment.create(
        document.getElementById('other-context'),
        'document-b',
        'other context'
      );
      otherContext.present('![shared](shared.png)', 'shared.png');
      await otherContext.whenCurrentPresentationSettles();

      const focus = document.getElementById('focus') as HTMLInputElement;
      focus.focus();
      window.scrollTo(0, 180);
      const activeBefore = document.activeElement?.id;
      const scrollBefore = document.scrollingElement?.scrollTop ?? 0;
      replacement.present('![viewport](viewport.png)', 'viewport.png');
      await replacement.whenCurrentPresentationSettles();
      const activeAfter = document.activeElement?.id;
      const scrollAfter = document.scrollingElement?.scrollTop ?? 0;
      const selectionNode = document.getElementById('selection')?.firstChild;
      if (!selectionNode) throw new Error('selection fixture missing');
      const range = document.createRange();
      range.selectNodeContents(selectionNode);
      const documentSelection = document.getSelection();
      documentSelection?.removeAllRanges();
      documentSelection?.addRange(range);
      const selectionBefore = documentSelection?.toString() ?? '';
      const sameSourceCountsBefore = environment.counts();
      const sameSourceIdBefore = replacement.state().current?.presentationId;
      replacement.present('![viewport](viewport.png)', 'viewport.png');
      const sameSourceIdAfter = replacement.state().current?.presentationId;
      await replacement.whenCurrentPresentationSettles();
      const sameSourceCountsAfter = environment.counts();
      const selectionAfter = document.getSelection()?.toString() ?? '';

      const external = environment.create(document.createElement('div'), 'document-a', 'external');
      external.present('![external](slow-external.png)', 'slow-external.png');
      const externalId = external.state().current?.presentationId;
      external.externalDocumentPresented();
      const externalReplayId = external.state().current?.presentationId;
      pending.get('slow-external.png')?.forEach((resolve: (value: string) => void) => resolve(svg('external', '#66a')));
      await external.whenCurrentPresentationSettles();

      const sharedSlowRootA = document.createElement('div');
      const sharedSlowRootB = document.createElement('div');
      document.body.append(sharedSlowRootA, sharedSlowRootB);
      const sharedSlowA = environment.create(sharedSlowRootA, 'document-a', 'slow-a');
      const sharedSlowB = environment.create(sharedSlowRootB, 'document-a', 'slow-b');
      sharedSlowA.present('![slow](slow-shared.png)', 'slow-shared.png');
      sharedSlowB.present('![slow](slow-shared.png)', 'slow-shared.png');
      sharedSlowA.dispose();
      pending.get('slow-shared.png')?.forEach((resolve: (value: string) => void) => resolve(svg('shared', '#886')));
      await sharedSlowB.whenCurrentPresentationSettles();
      const survivingShared = sharedSlowRootB.querySelector('img')?.getAttribute('src') ?? '';

      const rebuiltRoot = document.createElement('div');
      rebuiltRoot.hidden = true;
      document.body.appendChild(rebuiltRoot);
      const rebuilt = environment.create(rebuiltRoot, 'document-a', 'rebuilt');
      rebuilt.present('![shared](shared.png)', 'shared.png');
      await rebuilt.whenCurrentPresentationSettles();
      rebuiltRoot.hidden = false;
      const rebuiltShared = rebuiltRoot.querySelector('img')?.getAttribute('src') ?? '';

      const counts = environment.counts();
      const externalState = external.state();
      const output = {
        shared,
        oldId,
        newId,
        beforeOldCompletion,
        afterOldCompletion,
        failure: {
          phase: failure.state().projected.phase,
          text: document.getElementById('failure')?.textContent ?? ''
        },
        otherContext: document.querySelector('#other-context img')?.getAttribute('src') ?? '',
        activeBefore,
        activeAfter,
        scrollBefore,
        scrollAfter,
        selectionBefore,
        selectionAfter,
        sameSource: {
          idBefore: sameSourceIdBefore,
          idAfter: sameSourceIdAfter,
          resolveDelta: sameSourceCountsAfter.resolveCalls - sameSourceCountsBefore.resolveCalls,
          loadDelta: sameSourceCountsAfter.loadCalls - sameSourceCountsBefore.loadCalls
        },
        external: {
          id: externalId,
          replayId: externalReplayId,
          currentId: externalState.current?.presentationId,
          currentPhase: externalState.current?.phase,
          projectedId: externalState.projected.phase === 'none'
            ? null
            : externalState.projected.presentationId,
          projectedPhase: externalState.projected.phase,
          sourceKey: externalState.current?.sourceKey
        },
        survivingShared,
        rebuiltShared,
        counts,
        legacyDom: document.querySelectorAll('.meo-mermaid-block, .meo-latex-math-block').length
      };
      environment.dispose();
      return output;
    });

    assert.equal(result.shared.first, result.shared.second);
    assert.equal(result.shared.counts.resolveCalls, 1, 'same source/context did not share resolution');
    assert.equal(result.shared.counts.loadCalls, 1, 'same source/context did not share browser load');
    assert.notEqual(result.oldId, result.newId);
    assert.equal(result.beforeOldCompletion.phase, 'ready');
    assert.equal(result.afterOldCompletion.phase, 'ready');
    assert.equal(result.afterOldCompletion.id, result.newId);
    assert.equal(result.afterOldCompletion.src, result.beforeOldCompletion.src);
    assert.deepEqual(result.failure, { phase: 'error', text: '![broken](broken-load.png)' });
    assert.notEqual(result.otherContext, '');
    assert.equal(result.activeBefore, 'focus');
    assert.equal(result.activeAfter, 'focus');
    assert.equal(result.scrollAfter, result.scrollBefore);
    assert.equal(result.selectionBefore, 'keep selection');
    assert.equal(result.selectionAfter, result.selectionBefore);
    assert.notEqual(result.sameSource.idBefore, result.sameSource.idAfter);
    assert.deepEqual(
      { resolveDelta: result.sameSource.resolveDelta, loadDelta: result.sameSource.loadDelta },
      { resolveDelta: 0, loadDelta: 0 },
      'same-source restart should advance presentation without repeating shared resource work'
    );
    assert.notEqual(result.external.replayId, result.external.id);
    assert.deepEqual(result.external, {
      id: result.external.id,
      replayId: result.external.replayId,
      currentId: result.external.replayId,
      currentPhase: 'ready',
      projectedId: result.external.replayId,
      projectedPhase: 'ready',
      sourceKey: '![external](slow-external.png)'
    });
    assert.notEqual(result.survivingShared, '', 'disposing one subscriber cancelled the shared resource');
    assert.notEqual(result.rebuiltShared, '', 'hidden Widget rebuild did not restore the cached image');
    assert.deepEqual(
      {
        applications: result.counts.applications,
        runtimes: result.counts.runtimes,
        adapters: result.counts.adapters,
        resourcePools: result.counts.resourcePools,
        legacyWidgets: result.counts.legacyWidgets
      },
      { applications: 9, runtimes: 9, adapters: 9, resourcePools: 1, legacyWidgets: 0 }
    );
    assert.ok(result.counts.preservedReplacements >= 6);
    assert.equal(result.legacyDom, 0);
    console.log('image presentation Adapter/Runtime Chromium candidate passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
