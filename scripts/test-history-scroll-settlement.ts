import { launchTestBrowser } from './browser-test-helpers';
import {
  beginHistoryScrollSettlement,
  disposeHistoryScrollSettlement,
  type HistoryScrollSettlementResult
} from './history-scroll-settlement';

type Scenario = {
  name: string;
  controls: { top: Coordinate; bottom: Coordinate };
  viewport?: { top: Coordinate; bottom: Coordinate };
  supportsScrollEnd: boolean;
  outcome: 'event' | 'none' | 'throw';
  expectedStatus: HistoryScrollSettlementResult['status'] | 'throws';
  expectedTriggerCount: number;
  expectedError?: string;
};

type Coordinate = number | 'nan' | 'positive-infinity' | 'negative-infinity';

const scenarios: Scenario[] = [
  {
    name: 'scrollend', controls: { top: 350, bottom: 370 }, supportsScrollEnd: true, outcome: 'event',
    expectedStatus: 'settled', expectedTriggerCount: 1
  },
  {
    name: 'center-crossing-no-op', controls: { top: 194, bottom: 214 }, supportsScrollEnd: true, outcome: 'none',
    expectedStatus: 'settled', expectedTriggerCount: 0
  },
  {
    name: 'center-on-top-boundary', controls: { top: 200, bottom: 220 }, supportsScrollEnd: true, outcome: 'none',
    expectedStatus: 'settled', expectedTriggerCount: 0
  },
  {
    name: 'center-on-bottom-boundary', controls: { top: 180, bottom: 200 }, supportsScrollEnd: true, outcome: 'none',
    expectedStatus: 'settled', expectedTriggerCount: 0
  },
  {
    name: 'controls-above-center', controls: { top: 150, bottom: 170 }, supportsScrollEnd: true, outcome: 'event',
    expectedStatus: 'settled', expectedTriggerCount: 1
  },
  {
    name: 'controls-below-center', controls: { top: 230, bottom: 250 }, supportsScrollEnd: true, outcome: 'event',
    expectedStatus: 'settled', expectedTriggerCount: 1
  },
  {
    name: 'zero-height', controls: { top: 200, bottom: 200 }, supportsScrollEnd: true, outcome: 'none',
    expectedStatus: 'throws', expectedTriggerCount: 0, expectedError: 'Invalid rendered block geometry'
  },
  {
    name: 'inverted-geometry', controls: { top: 210, bottom: 190 }, supportsScrollEnd: true, outcome: 'none',
    expectedStatus: 'throws', expectedTriggerCount: 0, expectedError: 'Invalid rendered block geometry'
  },
  {
    name: 'controls-nan', controls: { top: 'nan', bottom: 210 }, supportsScrollEnd: true, outcome: 'none',
    expectedStatus: 'throws', expectedTriggerCount: 0, expectedError: 'Invalid rendered block geometry'
  },
  {
    name: 'controls-positive-infinity', controls: { top: 190, bottom: 'positive-infinity' },
    supportsScrollEnd: true, outcome: 'none', expectedStatus: 'throws', expectedTriggerCount: 0,
    expectedError: 'Invalid rendered block geometry'
  },
  {
    name: 'controls-negative-infinity', controls: { top: 'negative-infinity', bottom: 210 },
    supportsScrollEnd: true, outcome: 'none', expectedStatus: 'throws', expectedTriggerCount: 0,
    expectedError: 'Invalid rendered block geometry'
  },
  {
    name: 'viewport-nan', controls: { top: 190, bottom: 210 }, viewport: { top: 'nan', bottom: 400 },
    supportsScrollEnd: true, outcome: 'none', expectedStatus: 'throws', expectedTriggerCount: 0,
    expectedError: 'Invalid rendered block geometry'
  },
  {
    name: 'viewport-positive-infinity', controls: { top: 190, bottom: 210 },
    viewport: { top: 0, bottom: 'positive-infinity' }, supportsScrollEnd: true, outcome: 'none',
    expectedStatus: 'throws', expectedTriggerCount: 0, expectedError: 'Invalid rendered block geometry'
  },
  {
    name: 'viewport-negative-infinity', controls: { top: 190, bottom: 210 },
    viewport: { top: 'negative-infinity', bottom: 400 }, supportsScrollEnd: true, outcome: 'none',
    expectedStatus: 'throws', expectedTriggerCount: 0, expectedError: 'Invalid rendered block geometry'
  },
  {
    name: 'unsupported', controls: { top: 350, bottom: 370 }, supportsScrollEnd: false, outcome: 'none',
    expectedStatus: 'unsupported', expectedTriggerCount: 0
  },
  {
    name: 'missing-event', controls: { top: 350, bottom: 370 }, supportsScrollEnd: true, outcome: 'none',
    expectedStatus: 'pending', expectedTriggerCount: 1
  },
  {
    name: 'trigger-error', controls: { top: 350, bottom: 370 }, supportsScrollEnd: true, outcome: 'throw',
    expectedStatus: 'throws', expectedTriggerCount: 1, expectedError: 'synthetic scroll failure'
  }
];

async function main() {
  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    for (const scenario of scenarios) {
      await page.setContent(`
        <div class="cm-editor"><div class="cm-scroller"></div></div>
        <div role="group" aria-label="Mermaid block controls at line 130"></div>
      `);
      const registryKey = `__historyScrollSettlement_${scenario.name}`;
      await page.evaluate(({ controls, viewport, outcome, key }) => {
        const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
        const group = document.querySelector<HTMLElement>('[role="group"]')!;
        const coordinate = (value: Coordinate): number => {
          if (typeof value === 'number') return value;
          if (value === 'nan') return Number.NaN;
          return value === 'positive-infinity' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
        };
        const originalAddEventListener = scroller.addEventListener.bind(scroller);
        const originalRemoveEventListener = scroller.removeEventListener.bind(scroller);
        (window as any)[`${key}_activeListeners`] = 0;
        scroller.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
          if (type === 'scrollend') (window as any)[`${key}_activeListeners`] += 1;
          originalAddEventListener(type, listener, options);
        }) as typeof scroller.addEventListener;
        scroller.removeEventListener = ((type: string, listener: EventListener, options?: EventListenerOptions) => {
          if (type === 'scrollend') (window as any)[`${key}_activeListeners`] -= 1;
          originalRemoveEventListener(type, listener, options);
        }) as typeof scroller.removeEventListener;
        scroller.getBoundingClientRect = () => ({
          top: coordinate(viewport.top),
          bottom: coordinate(viewport.bottom)
        } as DOMRect);
        group.getBoundingClientRect = () => ({
          top: coordinate(controls.top),
          bottom: coordinate(controls.bottom)
        } as DOMRect);
        (window as any).__historyMatrixEditor = {
          scrollToLine() {
            (window as any)[`${key}_triggerCount`] = ((window as any)[`${key}_triggerCount`] ?? 0) + 1;
            (window as any)[`${key}_listenerBeforeTrigger`] = (window as any)[key]?.listenerCount ?? 0;
            if (outcome === 'throw') throw new Error('synthetic scroll failure');
            if (outcome === 'event') scroller.dispatchEvent(new Event('scrollend'));
          }
        };
      }, {
        controls: scenario.controls,
        viewport: scenario.viewport ?? { top: 0, bottom: 400 },
        outcome: scenario.outcome,
        key: registryKey
      });

      let result: HistoryScrollSettlementResult | null = null;
      let thrown = false;
      try {
        result = await page.evaluate(beginHistoryScrollSettlement, {
          lineNumber: 130,
          controlsLabel: 'Mermaid block controls at line 130',
          registryKey,
          supportsScrollEndOverride: scenario.supportsScrollEnd
        });
      } catch (error) {
        thrown = true;
        if (scenario.expectedStatus !== 'throws' || !String(error).includes(scenario.expectedError ?? '')) throw error;
      }
      if (scenario.expectedStatus === 'throws' ? !thrown : result?.status !== scenario.expectedStatus) {
        throw new Error(`${scenario.name}: expected ${scenario.expectedStatus}, received ${result?.status ?? 'throws'}`);
      }
      if (result?.status !== 'pending' && (result?.listenerCount ?? 0) !== 0) {
        throw new Error(`${scenario.name}: expected listener registry 0, received ${result?.listenerCount}`);
      }
      const beforeCleanup = await page.evaluate((key) => ({
        listenerBeforeTrigger: (window as any)[`${key}_listenerBeforeTrigger`] ?? 0,
        triggerCount: (window as any)[`${key}_triggerCount`] ?? 0
      }), registryKey);
      if (beforeCleanup.triggerCount !== scenario.expectedTriggerCount) {
        throw new Error(`${scenario.name}: expected ${scenario.expectedTriggerCount} triggers, received ${beforeCleanup.triggerCount}`);
      }
      if (scenario.expectedTriggerCount > 0 && beforeCleanup.listenerBeforeTrigger !== 1) {
        throw new Error(`${scenario.name}: listener was not installed before the center trigger`);
      }
      const cleanupCount = await page.evaluate(disposeHistoryScrollSettlement, registryKey);
      if (cleanupCount !== 0) throw new Error(`${scenario.name}: cleanup left ${cleanupCount} listeners`);
      const activeListeners = await page.evaluate((key) => (
        (window as any)[`${key}_activeListeners`] ?? 0
      ), registryKey);
      if (activeListeners !== 0) throw new Error(`${scenario.name}: listener registry retained ${activeListeners}`);
    }
    console.log('history scroll settlement matrix checks passed');
  } finally {
    await browser.close();
  }
}

await main();
