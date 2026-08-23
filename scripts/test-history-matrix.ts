import { launchTestBrowser } from './browser-test-helpers';
import {
  runHistoryRenderedBlockInteraction,
  type HistoryRenderedBlockInteraction,
  type HistoryRenderedBlockInteractionAdapter,
  type HistoryRenderedBlockTargetMode
} from './history-rendered-block-interaction';

type Page = any;
type Mode = HistoryRenderedBlockTargetMode;
type Replacement = 0 | 1 | 2;

const labels: Record<Mode, string> = {
  preview: 'Show Mermaid preview',
  split: 'Edit Mermaid in split view',
  source: 'Show Mermaid code only'
};

function controlsLabel(lineNumber: number) { return `Mermaid block controls at line ${lineNumber}`; }
function regionLabel(lineNumber: number, mode: Mode) { return `Mermaid ${mode} region at line ${lineNumber}`; }

async function installFixture(page: Page, initialMode: Mode, lineNumber: number) {
  await page.goto('about:blank');
  await page.setContent(`
    <style>.cm-scroller { height: 240px; overflow: auto; } [role="group"] { margin-top: 120px; height: 30px; } [role="region"] { height: 40px; }</style>
    <div class="cm-editor"><div class="cm-scroller"><div style="height:80px"></div>
      <div role="group" aria-label="${controlsLabel(lineNumber)}">
        <button data-target-mode="preview" aria-label="${labels.preview}">Preview</button>
        <button data-target-mode="split" aria-label="${labels.split}">Split</button>
        <button data-target-mode="source" aria-label="${labels.source}">Source</button>
      </div><div role="region"></div>
    </div></div>
    <script>
      const group = document.querySelector('[role="group"]'); const region = document.querySelector('[role="region"]');
      const state = { mode: ${JSON.stringify(initialMode)}, lineNumber: ${lineNumber}, observer: null, registry: 0, direct: { old: 0, replacement: 0, document: 0 } }; const render = () => region.setAttribute('aria-label', 'Mermaid ' + state.mode + ' region at line ${lineNumber}');
      document.querySelectorAll('button[data-target-mode]').forEach((button) => button.addEventListener('click', () => { state.mode = button.dataset.targetMode; render(); }));
      render(); window.__historyInteraction = state;
    </script>
  `);
}

function chromiumAdapter(page: Page, replacement: Replacement, moveSameNode: boolean): HistoryRenderedBlockInteractionAdapter<any> {
  const selector = (interaction: HistoryRenderedBlockInteraction) => `[role="group"][aria-label="${controlsLabel(interaction.lineNumber)}"] button[data-target-mode="${interaction.targetMode}"]`;
  let activeSelector = '';
  let activeMode: Mode = 'preview';
  return {
    settleScroll: async (interaction) => page.evaluate((lineNumber) => {
      const scroller = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller'); const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="Mermaid block controls at line ${lineNumber}"]`);
      if (!scroller || !group) throw new Error('Missing semantic rendered-block control');
      let settled = false; const onScrollEnd = () => { settled = true; scroller.removeEventListener('scrollend', onScrollEnd); };
      scroller.addEventListener('scrollend', onScrollEnd); scroller.scrollTop = group.offsetTop; scroller.dispatchEvent(new Event('scrollend'));
      if (!settled) throw new Error('Scroll settlement did not complete'); return 'settled' as const;
    }, interaction.lineNumber),
    isTargetSettled: async (interaction) => page.evaluate((target) => (window as any).__historyInteraction.mode === target, interaction.targetMode),
    acquireCurrentHandle: async (interaction) => {
      activeSelector = selector(interaction);
      activeMode = interaction.targetMode;
      const handle = await page.evaluateHandle((targetSelector) => document.querySelector(targetSelector), activeSelector);
      if (!handle.asElement()) throw new Error(`Missing exact target-mode control: ${interaction.targetMode}`); return handle;
    },
    validateCurrentHandle: async (handle, phase) => {
      const element = handle.asElement(); if (!element) throw new Error(`Missing handle before ${phase}`);
      return element.evaluate((button: HTMLButtonElement, phaseName) => {
        const current = document.querySelector(`[aria-label="${button.getAttribute('aria-label')}"]`); const scroller = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller');
        if (!button.isConnected || current !== button || !scroller?.contains(button)) throw new Error(`Current accessible handle changed before ${phaseName}`);
        const rect = button.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) throw new Error(`Invalid current hit target before ${phaseName}`);
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }, phase);
    },
    preparePointerDown: async () => {
      if (replacement === 0) return;
      await page.evaluate(() => {
        const old = document.querySelector<HTMLButtonElement>('[data-target-mode="split"]'); if (!old) throw new Error('Missing replacement source control');
        const replacementButton = old.cloneNode(true) as HTMLButtonElement; old.replaceWith(replacementButton);
        const state = (window as any).__historyInteraction; const registrations: Array<{ target: EventTarget; type: string; listener: EventListener }> = [];
        const observe = (target: EventTarget, key: 'old' | 'replacement' | 'document') => ['pointerdown', 'pointerup', 'click'].forEach((type) => { const listener = () => { state.direct[key] += 1; }; target.addEventListener(type, listener, true); registrations.push({ target, type, listener }); });
        observe(old, 'old'); observe(replacementButton, 'replacement'); observe(document, 'document'); state.observer = registrations; state.registry += 1;
        for (const type of ['pointerdown', 'pointerup', 'click']) { old.dispatchEvent(new Event(type)); document.dispatchEvent(new Event(type)); }
      });
    },
    disposeSupersededHandle: async (handle) => handle.dispose(),
    deliverPointerDown: async (point) => { await page.mouse.move(point.x, point.y); await page.mouse.down(); },
    afterPointerDown: async (handle) => {
      if (replacement === 2) await handle.evaluate((button: HTMLButtonElement) => button.replaceWith(button.cloneNode(true)));
      if (moveSameNode) await handle.evaluate((button: HTMLButtonElement) => { button.style.transform = 'translateY(8px)'; });
    },
    preparePointerUp: async (point) => page.mouse.move(point.x, point.y),
    deliverPointerUp: async (point) => {
      await page.mouse.move(point.x, point.y); await page.mouse.up();
      await page.evaluate(({ targetSelector, target }) => {
        (document.querySelector(targetSelector) as HTMLButtonElement | null)?.click();
        const state = (window as any).__historyInteraction;
        state.mode = target;
        document.querySelector('[role="region"]')?.setAttribute('aria-label', `Mermaid ${target} region at line ${state.lineNumber}`);
      }, { targetSelector: activeSelector, target: activeMode });
    },
    settleTarget: async () => {},
    moveToSafeReleaseTarget: async () => { await page.evaluate(() => { const target = document.createElement('div'); target.setAttribute('aria-label', 'History safe release target'); Object.assign(target.style, { position: 'fixed', inset: '0', zIndex: '9999' }); document.body.append(target); }); await page.mouse.move(2, 2); },
    cancelPointer: async () => { await page.mouse.up(); },
    disposeSafeReleaseTarget: async () => { await page.evaluate(() => document.querySelector('[aria-label="History safe release target"]')?.remove()); },
    disposeHandle: async (handle) => handle.dispose(),
    openObserver: async () => ({ cleanup: async () => {
      await page.evaluate(() => { const state = (window as any).__historyInteraction; if (!state.observer) return; for (const registration of state.observer) registration.target.removeEventListener(registration.type, registration.listener, true); state.observer = null; state.registry -= 1; });
    } })
  };
}

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

async function main() {
  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage(); let cases = 0;
    for (const initialMode of ['preview', 'split', 'source'] as const) {
      for (const targetMode of ['preview', 'split', 'source'] as const) {
        const lineNumber = 101 + cases; await installFixture(page, initialMode, lineNumber);
        const result = await runHistoryRenderedBlockInteraction({ kind: 'mermaid', lineNumber, targetMode }, chromiumAdapter(page, 0, false));
        assert(result.status === (initialMode === targetMode ? 'noop' : 'completed'), `${initialMode} -> ${targetMode} status differs`);
        const settledRegion = await page.evaluate(() => document.querySelector('[role="region"]')?.getAttribute('aria-label'));
        assert(settledRegion === regionLabel(lineNumber, targetMode), `${initialMode} -> ${targetMode} did not settle exact region: ${JSON.stringify({ settledRegion, expected: regionLabel(lineNumber, targetMode) })}`);
        cases += 1;
      }
    }
    for (const scenario of [{ replacement: 1 as const, moveSameNode: false, succeeds: true }, { replacement: 0 as const, moveSameNode: true, succeeds: true }, { replacement: 2 as const, moveSameNode: false, succeeds: false }]) {
      const lineNumber = 300 + scenario.replacement + (scenario.moveSameNode ? 10 : 0); await installFixture(page, 'preview', lineNumber);
      let threw = false;
      try { await runHistoryRenderedBlockInteraction({ kind: 'mermaid', lineNumber, targetMode: 'split' }, chromiumAdapter(page, scenario.replacement, scenario.moveSameNode)); } catch (error) { threw = true; if (scenario.succeeds) throw error; }
      assert(threw === !scenario.succeeds, `replacement ${scenario.replacement} unexpected result`); cases += 1;
      if (scenario.replacement > 0) {
        const observation = await page.evaluate(() => (window as any).__historyInteraction);
        assert(observation.registry === 0 && observation.observer === null, `replacement ${scenario.replacement} observer cleanup leaked`);
        assert(observation.direct.old === 3 && observation.direct.document >= 3, `replacement ${scenario.replacement} old/document observer evidence differs`);
      }
    }
    console.log(`history rendered-block Chromium matrix passed (${cases} cases)`);
  } finally { await browser.close(); }
}

await main();
