import { launchTestBrowser } from './browser-test-helpers';
import {
  HistoryRenderedBlockInteractionError,
  runHistoryRenderedBlockInteraction,
  type HistoryRenderedBlockInteractionAdapter
} from './history-rendered-block-interaction';
import { runHistoryRenderedBlockChromiumInteraction } from './history-rendered-block-interaction-chromium';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function runCase(replacement: 0 | 1 | 2, moveSameNode: boolean, disposeAfterDown = false, offscreen = false) {
  const browser = await launchTestBrowser();
  try {
    const page: any = await browser.newPage();
    await page.setContent(`
      <div class="cm-editor"><div class="cm-scroller" style="height:40px;overflow:hidden">
        <button aria-label="Edit Mermaid in split view" style="${offscreen ? 'margin-top:80px' : ''}">Split</button>
      </div></div>
    `);
    let acquires = 0;
    let first: any;
    let current = true;
    let safeReleases = 0;
    if (offscreen) {
      const oldDirectClick = await page.evaluate(() => {
        let clicks = 0;
        const button = document.querySelector('button')!;
        button.addEventListener('click', () => { clicks += 1; });
        button.click();
        return clicks;
      });
      if (oldDirectClick !== 1) throw new Error('old direct click red control did not deliver offscreen activation');
    }
    const adapter: HistoryRenderedBlockInteractionAdapter<any> = {
      isCurrent: async () => current,
      settleScroll: async () => 'settled',
      isTargetSettled: async () => false,
      acquireCurrentHandle: async () => {
        acquires += 1;
        const handle = await page.evaluateHandle(() => document.querySelector('button'));
        if (acquires === 1) first = handle;
        return handle;
      },
      validateCurrentHandle: async (handle, phase) => {
        const element = handle.asElement();
        if (!element) throw new Error(`missing handle before ${phase}`);
        return element.evaluate((button: HTMLButtonElement, expectedPhase) => {
          if (!button.isConnected || document.querySelector('button') !== button) throw new Error(`replacement before ${expectedPhase}`);
          const rect = button.getBoundingClientRect();
          const viewport = button.closest<HTMLElement>('.cm-scroller')?.getBoundingClientRect();
          if (!viewport || rect.top < viewport.top || rect.bottom > viewport.bottom) {
            throw new Error(`offscreen control before ${expectedPhase}`);
          }
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }, phase);
      },
      preparePointerDown: async () => {
        if (replacement > 0) await first.evaluate((button: HTMLButtonElement) => button.replaceWith(button.cloneNode(true)));
      },
      disposeSupersededHandle: async (handle) => handle.dispose(),
      deliverPointerDown: async (point) => {
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        if (disposeAfterDown) current = false;
      },
      afterPointerDown: async (handle) => {
        if (replacement === 2) await handle.evaluate((button: HTMLButtonElement) => button.replaceWith(button.cloneNode(true)));
        if (moveSameNode) await handle.evaluate((button: HTMLButtonElement) => { button.style.transform = 'translateY(8px)'; });
      },
      preparePointerUp: async (point) => page.mouse.move(point.x, point.y),
      deliverPointerUp: async (point) => { await page.mouse.move(point.x, point.y); await page.mouse.up(); },
      settleTarget: async () => {},
      moveToSafeReleaseTarget: async () => { await page.mouse.move(1, 1); },
      cancelPointer: async () => { safeReleases += 1; await page.mouse.up(); },
      disposeSafeReleaseTarget: async () => {},
      disposeHandle: async (handle) => handle.dispose(),
      openObserver: async () => ({
        cleanup: async () => {},
        snapshot: async () => ({ events: ['current:pointerdown'], registrations: 0, cleaned: true, sentinelRejected: true }),
        verifySentinel: async () => true
      })
    };
    const result = await Promise.allSettled([runHistoryRenderedBlockInteraction({ kind: 'mermaid', lineNumber: 1, targetMode: 'split' }, adapter)]);
    const succeeded = result[0].status === 'fulfilled';
    if (succeeded !== (replacement !== 2 && !disposeAfterDown && !offscreen) || acquires !== (offscreen ? 1 : 2)) {
      throw new Error(`replacement ${replacement} result differs`);
    }
    if (disposeAfterDown && safeReleases !== 1) throw new Error('disposed Chromium interaction did not safely release its pointer');
  } finally { await browser.close(); }
}

async function runPublicFailureEvidenceCase() {
  const browser = await launchTestBrowser();
  try {
    const page: any = await browser.newPage();
    await page.setContent(`
      <div class="cm-editor"><div class="cm-scroller" style="height:80px;overflow:hidden">
        <div role="group" aria-label="Mermaid block controls at line 1">
          <button aria-label="Edit Mermaid in split view">Split</button>
        </div>
      </div>
    `);
    await page.evaluate(() => {
      (window as any).__historyMatrixEditor = { scrollToLine() {} };
      const button = document.querySelector<HTMLButtonElement>('button')!;
      button.addEventListener('pointerdown', () => {
        throw new Error('synthetic public page error');
      });
      button.addEventListener('click', () => {
        button.setAttribute('aria-label', 'Show Mermaid code only');
      });
    });

    const waitForFunction = page.waitForFunction.bind(page);
    page.waitForFunction = (...args: any[]) => {
      const known = args[2];
      if (known && typeof known === 'object' && known.expectedLabel === 'Show Mermaid code only') {
        return Promise.reject(new Error('synthetic target settlement timeout'));
      }
      return waitForFunction(...args);
    };

    let failure: unknown;
    try {
      await runHistoryRenderedBlockChromiumInteraction(
        page,
        { kind: 'mermaid', lineNumber: 1, targetMode: 'split' },
        '__historyMatrixEditor'
      );
    } catch (error) {
      failure = error;
    }

    check(failure instanceof HistoryRenderedBlockInteractionError, 'target settlement did not preserve InteractionError');
    check(failure.hasPrimary, 'target settlement evidence lost the primary failure');
    check(failure.cause === failure.primary && failure.errors[0] === failure.primary, 'InteractionError primary/cause order changed');
    check(failure.errors.length === 1, 'public evidence case added a cleanup failure');
    check(failure.primary instanceof Error && failure.primary.cause instanceof Error, 'target settlement cause chain is incomplete');
    check(String(failure.primary.cause).includes('synthetic target settlement timeout'), 'Puppeteer settlement failure was not retained as cause');

    const evidence = failure.evidence as any;
    check(evidence && Array.isArray(evidence.events), 'InteractionError omitted observer evidence');
    const events = evidence.events.map((entry: string) => JSON.parse(entry));
    check(events.some((entry: any) => entry.type === 'pointerdown'), 'public evidence omitted pointerdown');
    check(events.some((entry: any) => entry.type === 'pointerup'), 'public evidence omitted pointerup');
    check(events.some((entry: any) => (
      entry.type === 'click'
      && entry.semanticTarget
      && entry.actualGroup?.ariaLabel === 'Mermaid block controls at line 1'
      && entry.actualGroup?.isTarget
    )), 'public evidence omitted semantic target group identity');
    check(events.filter((entry: any) => entry.type === 'pointerdown').length === 1, 'public evidence repeated pointerdown');
    check(events.filter((entry: any) => entry.type === 'pointerup').length === 1, 'public evidence repeated pointerup');
    check(events.filter((entry: any) => entry.type === 'click').length === 1, 'public evidence repeated click');
    check(events.every((entry: any) => Array.isArray(entry.currentModeLabels)), 'event evidence omitted current mode labels');
    check(events.every((entry: any) => entry.targetRect && typeof entry.targetHit === 'boolean'), 'event evidence omitted target rect/hit');
    check(Array.isArray(evidence.labelChanges) && evidence.labelChanges.some((entry: any) => (
      entry.currentModeLabels.includes('Show Mermaid code only')
    )), 'single MutationObserver omitted the label transition');
    check(Array.isArray(evidence.pageErrors) && evidence.pageErrors.some((entry: string) => (
      entry.includes('synthetic public page error')
    )), 'public evidence omitted page error');
    check(String(failure.primary).includes('"currentModeLabels"'), 'primary failure did not atomically publish its public snapshot');
    check(evidence.registrations === 0 && evidence.cleaned && evidence.sentinelRejected, 'failure evidence did not close observer lifecycle');
  } finally {
    await browser.close();
  }
}

async function runMissingSemanticClickCase() {
  const browser = await launchTestBrowser();
  try {
    const page: any = await browser.newPage();
    await page.setContent(`
      <div class="cm-editor"><div class="cm-scroller" style="height:80px;overflow:hidden">
        <div role="group" aria-label="Mermaid block controls at line 1">
          <button aria-label="Edit Mermaid in split view" style="pointer-events:none">Split</button>
        </div>
      </div>
    `);
    await page.evaluate(() => { (window as any).__historyMatrixEditor = { scrollToLine() {} }; });
    const waitForFunction = page.waitForFunction.bind(page);
    page.waitForFunction = (...args: any[]) => {
      const known = args[2];
      if (known && typeof known === 'object' && known.expectedLabel === 'Show Mermaid code only') {
        return Promise.reject(new Error('semantic click failure incorrectly entered target wait'));
      }
      return waitForFunction(...args);
    };

    let failure: unknown;
    try {
      await runHistoryRenderedBlockChromiumInteraction(
        page,
        { kind: 'mermaid', lineNumber: 1, targetMode: 'split' },
        '__historyMatrixEditor'
      );
    } catch (error) {
      failure = error;
    }
    check(failure instanceof HistoryRenderedBlockInteractionError, 'missing semantic click did not preserve InteractionError');
    check(String(failure.primary).includes('pointer did not activate semantic target'), 'missing semantic click was not failed fast');
    check(!String(failure.primary).includes('incorrectly entered target wait'), 'missing semantic click waited for a label transition');
    const evidence = failure.evidence as any;
    const events = evidence.events.map((entry: string) => JSON.parse(entry));
    check(events.every((entry: any) => entry.type !== 'pointerdown' && entry.type !== 'click'), 'missing semantic target consumed a pointer gesture');
    check(!evidence.current?.targetHit, 'missing semantic target evidence omitted the hit mismatch');
    check(evidence.registrations === 0 && evidence.cleaned && evidence.sentinelRejected, 'missing-click evidence leaked observer lifecycle');
  } finally {
    await browser.close();
  }
}

async function runSameLabelDifferentGroupCase() {
  const browser = await launchTestBrowser();
  try {
    const page: any = await browser.newPage();
    await page.setContent(`
      <div class="cm-editor"><div class="cm-scroller" style="height:80px;overflow:hidden;position:relative">
        <div role="group" aria-label="Mermaid block controls at line 1" style="position:absolute;left:0;top:0">
          <button aria-label="Edit Mermaid in split view">Target split</button>
        </div>
        <div role="group" aria-label="Mermaid block controls at line 2" style="position:absolute;left:0;top:0;z-index:1">
          <button aria-label="Edit Mermaid in split view">Other split</button>
        </div>
      </div></div>
    `);
    await page.evaluate(() => { (window as any).__historyMatrixEditor = { scrollToLine() {} }; });
    const waitForFunction = page.waitForFunction.bind(page);
    page.waitForFunction = (...args: any[]) => {
      const known = args[2];
      if (known && typeof known === 'object' && known.expectedLabel === 'Show Mermaid code only') {
        return Promise.reject(new Error('different group click incorrectly entered target wait'));
      }
      return waitForFunction(...args);
    };

    let failure: unknown;
    try {
      await runHistoryRenderedBlockChromiumInteraction(
        page,
        { kind: 'mermaid', lineNumber: 1, targetMode: 'split' },
        '__historyMatrixEditor'
      );
    } catch (error) {
      failure = error;
    }
    check(failure instanceof HistoryRenderedBlockInteractionError, 'different-group click did not preserve InteractionError');
    check(String(failure.primary).includes('pointer did not activate semantic target'), 'different-group click was mistaken for the semantic target');
    check(!String(failure.primary).includes('incorrectly entered target wait'), 'different-group click entered target settlement');
    const evidence = failure.evidence as any;
    const events = evidence.events.map((entry: string) => JSON.parse(entry));
    check(events.every((entry: any) => entry.type !== 'pointerdown' && entry.type !== 'click'), 'different-group target consumed a pointer gesture');
    check(evidence.current?.hitTarget?.actualGroup === 'Mermaid block controls at line 2', 'different-group evidence omitted the actual group');
    check(evidence.registrations === 0 && evidence.cleaned && evidence.sentinelRejected, 'different-group evidence leaked observer lifecycle');
  } finally {
    await browser.close();
  }
}

async function runMoveSettlementMismatchCase() {
  const browser = await launchTestBrowser();
  try {
    const page: any = await browser.newPage();
    await page.setContent(`
      <div class="cm-editor"><div class="cm-scroller" style="height:80px;overflow:hidden;position:relative">
        <div role="group" aria-label="Mermaid block controls at line 1" style="position:absolute;left:0;top:0">
          <button aria-label="Edit Mermaid in split view">Target split</button>
        </div>
      </div></div>
    `);
    await page.evaluate(() => {
      (window as any).__historyMatrixEditor = { scrollToLine() {} };
      const group = document.querySelector<HTMLElement>('[role="group"]')!;
      document.addEventListener('pointermove', () => {
        if (!group.dataset.moveSettlement) {
          const current = group.querySelector<HTMLButtonElement>('button')!;
          const replacement = current.cloneNode(true) as HTMLButtonElement;
          replacement.dataset.currentTarget = 'true';
          current.replaceWith(replacement);
          group.style.transform = 'translateX(120px)';
          group.dataset.moveSettlement = 'replaced';
          return;
        }
        if (group.dataset.moveSettlement !== 'replaced') return;
        const rect = group.querySelector<HTMLButtonElement>('button')!.getBoundingClientRect();
        const blocker = document.createElement('div');
        blocker.className = 'move-settlement-blocker';
        Object.assign(blocker.style, {
          position: 'fixed',
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          zIndex: '1'
        });
        document.body.append(blocker);
        group.dataset.moveSettlement = 'blocked';
      }, true);
    });

    let failure: unknown;
    try {
      await runHistoryRenderedBlockChromiumInteraction(
        page,
        { kind: 'mermaid', lineNumber: 1, targetMode: 'split' },
        '__historyMatrixEditor'
      );
    } catch (error) {
      failure = error;
    }
    check(failure instanceof HistoryRenderedBlockInteractionError, 'move settlement mismatch did not preserve InteractionError');
    check(String(failure.primary).includes('pointer did not activate semantic target before pointerdown'), 'move settlement mismatch was not rejected before pointerdown');
    const evidence = failure.evidence as any;
    const events = evidence.events.map((entry: string) => JSON.parse(entry));
    check(events.every((entry: any) => entry.type !== 'pointerdown' && entry.type !== 'click'), 'move settlement mismatch consumed a pointer gesture');
    check(evidence.current?.targetConnected, 'move settlement evidence lost the replacement target');
    check(!evidence.current?.targetHit, 'move settlement evidence did not expose the hit mismatch');
    check(evidence.current?.hitTarget?.className === 'move-settlement-blocker', 'move settlement evidence omitted the actual hit target');
    check(evidence.registrations === 0 && evidence.cleaned && evidence.sentinelRejected, 'move settlement evidence leaked observer lifecycle');
  } finally {
    await browser.close();
  }
}

for (const scenario of [[0, false], [1, false], [0, true], [2, false], [0, false, true], [0, false, false, true]] as const) {
  await runCase(...scenario);
}
await runPublicFailureEvidenceCase();
await runMissingSemanticClickCase();
await runSameLabelDifferentGroupCase();
await runMoveSettlementMismatchCase();
console.log('history rendered-block synthetic Chromium matrix passed');
