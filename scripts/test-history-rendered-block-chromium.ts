import { launchTestBrowser } from './browser-test-helpers';
import {
  runHistoryRenderedBlockInteraction,
  type HistoryRenderedBlockInteractionAdapter
} from './history-rendered-block-interaction';

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

for (const scenario of [[0, false], [1, false], [0, true], [2, false], [0, false, true], [0, false, false, true]] as const) {
  await runCase(...scenario);
}
console.log('history rendered-block synthetic Chromium matrix passed');
