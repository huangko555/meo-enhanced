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
    const evaluateHandle = page.evaluateHandle.bind(page);
    let retainedObserverHandle: any;
    page.evaluateHandle = async (...args: any[]) => {
      const handle = await evaluateHandle(...args);
      retainedObserverHandle ??= handle;
      return handle;
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
    let retainedHandleClosed = false;
    try {
      await retainedObserverHandle.evaluate((observer: any) => observer.snapshot());
    } catch {
      retainedHandleClosed = true;
    }
    check(retainedHandleClosed, 'Module-owned handoff retained its observer JSHandle');
  } finally {
    await browser.close();
  }
}

async function runMaterializationFailureEvidenceCase() {
  const browser = await launchTestBrowser();
  try {
    const page: any = await browser.newPage();
    await page.setContent(`
      <div class="cm-editor"><div class="cm-scroller" style="height:80px;overflow:auto">
        <div class="cm-content" contenteditable="true" role="textbox">
          <div class="cm-line">before target</div>
          <div class="cm-line"><span>\`\`\`mermaid</span><div class="mermaid-source-block">graph TD</div></div>
          <div class="cm-line">after target</div>
        </div>
        <div role="group" aria-label="Mermaid block controls at line 130" style="position:absolute;left:10px;top:20px;width:30px;height:20px">
          <button aria-label="Edit Mermaid in split view">Old split</button>
        </div>
      </div></div>
    `);
    await page.evaluate(() => {
      (window as any).__historyMatrixEditor = {
        scrollToLine() {
          queueMicrotask(() => { throw new Error('synthetic materialization page error'); });
        }
      };
      (document.querySelector('[contenteditable="true"]') as HTMLElement).focus();
    });
    const waitForFunction = page.waitForFunction.bind(page);
    page.waitForFunction = (...args: any[]) => {
      if (args[2] === 'Mermaid block controls at line 131') {
        return Promise.reject(new Error('synthetic controls materialization timeout'));
      }
      return waitForFunction(...args);
    };

    let failure: unknown;
    try {
      await runHistoryRenderedBlockChromiumInteraction(
        page,
        { kind: 'mermaid', lineNumber: 131, targetMode: 'split' },
        '__historyMatrixEditor'
      );
    } catch (error) {
      failure = error;
    }

    check(failure instanceof HistoryRenderedBlockInteractionError, 'materialization failure did not preserve InteractionError');
    check(failure.hasPrimary, 'materialization failure lost its primary');
    check(failure.cause === failure.primary && failure.errors[0] === failure.primary, 'materialization primary/cause order changed');
    check(failure.errors.length === 1, 'materialization evidence added an unexpected cleanup failure');
    check(failure.primary instanceof Error && failure.primary.cause instanceof Error, 'materialization wait cause chain is incomplete');
    check(String(failure.primary.cause).includes('synthetic controls materialization timeout'), 'materialization wait error was not retained');
    const evidence = failure.evidence as any;
    check(evidence?.requested?.targetLine === 131, 'materialization evidence omitted requested target line');
    check(evidence?.requested?.controlsLabel === 'Mermaid block controls at line 131', 'materialization evidence omitted requested controls');
    check(evidence.groups.some((group: any) => group.ariaLabel === 'Mermaid block controls at line 130' && group.connected), 'materialization evidence omitted current line130 group');
    check(evidence.sources.some((source: any) => source.text.includes('```mermaid') && source.connected && source.rect?.height > 0), 'materialization evidence omitted target source DOM');
    check(evidence.groupMutations.every((mutation: any) => !mutation.added?.includes('Mermaid block controls at line 131')), 'materialization evidence invented a target group add');
    check(typeof evidence.scroller?.scrollTop === 'number' && evidence.scroller?.rect?.height > 0, 'materialization evidence omitted scroll geometry');
    check(evidence.activeElement?.role === 'textbox' && evidence.activeElement?.connected, 'materialization evidence omitted active element');
    check(evidence.pageErrors.some((entry: string) => entry.includes('synthetic materialization page error')), 'materialization evidence omitted page error');
    check(evidence.registrations === 0 && evidence.cleaned && evidence.sentinelRejected, 'materialization evidence leaked observer lifecycle');
    check(String(failure.primary).includes('"targetLine":131'), 'materialization primary did not atomically publish evidence');
  } finally {
    await browser.close();
  }
}

async function runMaterializationHandoffEvidenceCase() {
  const browser = await launchTestBrowser();
  try {
    const page: any = await browser.newPage();
    await page.setContent(`
      <div class="cm-editor"><div class="cm-scroller" style="height:80px;overflow:auto;position:relative">
        <div class="cm-line"><span>\`\`\`mermaid</span><div class="mermaid-source-block">graph TD</div></div>
        <div role="group" aria-label="Mermaid block controls at line 130">
          <button aria-label="Edit Mermaid in split view">Old split</button>
        </div>
      </div></div>
    `);
    await page.evaluate(() => {
      (window as any).__historyMatrixEditor = {
        scrollToLine() {
          const scroller = document.querySelector('.cm-scroller')!;
          const group = document.createElement('div');
          group.setAttribute('role', 'group');
          group.setAttribute('aria-label', 'Mermaid block controls at line 131');
          group.innerHTML = '<button aria-label="Edit Mermaid in split view">Target split</button>';
          group.querySelector('button')!.addEventListener('click', (event) => {
            (event.currentTarget as HTMLButtonElement).setAttribute('aria-label', 'Show Mermaid code only');
          });
          scroller.append(group);
          document.querySelector('[aria-label="Mermaid block controls at line 130"]')!.remove();
        }
      };
    });
    const waitForFunction = page.waitForFunction.bind(page);
    page.waitForFunction = (...args: any[]) => {
      const known = args[2];
      if (known && typeof known === 'object' && known.expectedLabel === 'Show Mermaid code only') {
        return Promise.reject(new Error('synthetic handoff settlement timeout'));
      }
      return waitForFunction(...args);
    };

    let failure: unknown;
    try {
      await runHistoryRenderedBlockChromiumInteraction(
        page,
        { kind: 'mermaid', lineNumber: 131, targetMode: 'split' },
        '__historyMatrixEditor'
      );
    } catch (error) {
      failure = error;
    }

    check(failure instanceof HistoryRenderedBlockInteractionError, 'materialization handoff did not reach gesture evidence');
    const evidence = failure.evidence as any;
    const events = evidence.events.map((entry: string) => JSON.parse(entry));
    check(evidence.groupMutations.some((mutation: any) => mutation.added?.includes('Mermaid block controls at line 131')), 'single observer missed target group add');
    check(evidence.groupMutations.some((mutation: any) => mutation.removed?.includes('Mermaid block controls at line 130')), 'single observer missed prior group removal');
    check(events.filter((event: any) => event.type === 'pointerdown').length === 1, 'materialization handoff repeated pointerdown');
    check(events.filter((event: any) => event.type === 'pointerup').length === 1, 'materialization handoff repeated pointerup');
    check(events.filter((event: any) => event.type === 'click' && event.semanticTarget).length === 1, 'materialization handoff did not use current target once');
    check(evidence.registrations === 0 && evidence.cleaned && evidence.sentinelRejected, 'materialization handoff leaked observer lifecycle');
  } finally {
    await browser.close();
  }
}

async function runMaterializationDisconnectCase() {
  const browser = await launchTestBrowser();
  try {
    const page: any = await browser.newPage();
    await page.setContent('<div class="cm-editor"><div class="cm-scroller"></div></div>');
    await page.evaluate(() => { (window as any).__historyMatrixEditor = { scrollToLine() {} }; });
    page.waitForFunction = async (...args: any[]) => {
      if (args[2] === 'Mermaid block controls at line 131') {
        await page.close();
        throw new Error('synthetic materialization page disconnect');
      }
      throw new Error('unexpected waitForFunction');
    };

    let failure: unknown;
    try {
      await runHistoryRenderedBlockChromiumInteraction(
        page,
        { kind: 'mermaid', lineNumber: 131, targetMode: 'split' },
        '__historyMatrixEditor'
      );
    } catch (error) {
      failure = error;
    }

    check(failure instanceof HistoryRenderedBlockInteractionError, 'page disconnect did not preserve InteractionError');
    check(failure.hasPrimary && failure.cause === failure.primary && failure.errors[0] === failure.primary, 'page disconnect changed primary-first order');
    check(failure.primary instanceof Error && failure.primary.cause instanceof Error, 'page disconnect lost original cause');
    check(String(failure.primary.cause).includes('synthetic materialization page disconnect'), 'page disconnect primary lost selector failure');
    check(failure.errors.length > 1, 'page disconnect did not append observer cleanup failures');
    check(failure.errors.slice(1).every((error: unknown) => String(error).includes('cleanup failed')), 'page disconnect cleanup failures preceded primary');
  } finally {
    await browser.close();
  }
}

async function runRunnerOwnedUnsupportedCleanupCase() {
  const browser = await launchTestBrowser();
  try {
    const page: any = await browser.newPage();
    await page.setContent(`
      <div class="cm-editor"><div class="cm-scroller" style="height:40px;overflow:hidden">
        <div role="group" aria-label="Mermaid block controls at line 1" style="margin-top:80px">
          <button aria-label="Edit Mermaid in split view">Split</button>
        </div>
      </div></div>
    `);
    await page.evaluate(() => {
      for (const prototype of [HTMLElement.prototype, Element.prototype, Document.prototype, Window.prototype]) {
        Reflect.deleteProperty(prototype, 'onscrollend');
      }
      const scroller = document.querySelector('.cm-scroller')!;
      if ('onscrollend' in scroller) throw new Error('fixture could not establish unsupported scroll settlement');
      (window as any).__historyMatrixEditor = { scrollToLine() {} };
    });
    const evaluateHandle = page.evaluateHandle.bind(page);
    let retainedObserverHandle: any;
    page.evaluateHandle = async (...args: any[]) => {
      const handle = await evaluateHandle(...args);
      retainedObserverHandle ??= handle;
      return handle;
    };

    const result = await runHistoryRenderedBlockChromiumInteraction(
      page,
      { kind: 'mermaid', lineNumber: 1, targetMode: 'split' },
      '__historyMatrixEditor'
    );
    check(result?.status === 'unsupported', 'runner did not preserve unsupported result');
    check(result.evidence?.registrations === 0 && result.evidence.cleaned && result.evidence.sentinelRejected, 'unsupported runner result leaked observer registry');
    await page.evaluate(() => {
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      document.querySelector('[role="group"]')?.setAttribute('aria-label', 'late public group mutation');
      queueMicrotask(() => { throw new Error('late public page error'); });
    });
    let retainedHandleClosed = false;
    try {
      await retainedObserverHandle.evaluate((observer: any) => observer.snapshot());
    } catch {
      retainedHandleClosed = true;
    }
    check(retainedHandleClosed, 'unsupported runner result retained its observer JSHandle after late public events');
  } finally {
    await browser.close();
  }
}

async function runRunnerOwnedNoopCleanupCase() {
  const browser = await launchTestBrowser();
  try {
    const page: any = await browser.newPage();
    await page.setContent(`
      <div class="cm-editor"><div class="cm-scroller" style="height:40px;overflow:hidden">
        <div role="group" aria-label="Mermaid block controls at line 1">
          <button aria-label="Edit Mermaid in split view">Split</button>
        </div>
      </div></div>
    `);
    await page.evaluate(() => {
      (window as any).__historyMatrixEditor = {
        scrollToLine() {
          const group = document.querySelector<HTMLElement>('[role="group"]')!;
          if (group.style.marginTop === '80px') {
            group.style.marginTop = '0';
            group.querySelector('button')!.setAttribute('aria-label', 'Show Mermaid code only');
            return;
          }
          queueMicrotask(() => { group.style.marginTop = '80px'; });
        }
      };
    });

    const result = await runHistoryRenderedBlockChromiumInteraction(
      page,
      { kind: 'mermaid', lineNumber: 1, targetMode: 'split' },
      '__historyMatrixEditor'
    );
    check(result.status === 'noop', 'runner did not preserve Module noop result');
    check(result.evidence?.registrations === 0 && result.evidence.cleaned && result.evidence.sentinelRejected, 'noop runner result leaked observer registry');
    const before = JSON.stringify(result.evidence);
    await page.evaluate(() => {
      document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      document.querySelector('[role="group"]')?.setAttribute('aria-label', 'late noop group mutation');
    });
    check(JSON.stringify(result.evidence) === before, 'noop evidence changed after public late events');
  } finally {
    await browser.close();
  }
}

async function runRunnerOwnedPreOpeningFailureCase() {
  const browser = await launchTestBrowser();
  try {
    const page: any = await browser.newPage();
    await page.setContent(`
      <div class="cm-editor"><div class="cm-scroller" style="height:0;overflow:hidden">
        <div role="group" aria-label="Mermaid block controls at line 1">
          <button aria-label="Edit Mermaid in split view">Split</button>
        </div>
      </div></div>
    `);
    await page.evaluate(() => { (window as any).__historyMatrixEditor = { scrollToLine() {} }; });
    const evaluateHandle = page.evaluateHandle.bind(page);
    let retainedObserverHandle: any;
    page.evaluateHandle = async (...args: any[]) => {
      const handle = await evaluateHandle(...args);
      retainedObserverHandle ??= handle;
      return handle;
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
    check(failure instanceof HistoryRenderedBlockInteractionError, 'pre-opening failure did not preserve InteractionError');
    check(failure.hasPrimary && failure.cause === failure.primary && failure.errors[0] === failure.primary, 'pre-opening cleanup changed primary-first order');
    check(String(failure.primary).includes('Invalid rendered block geometry'), 'pre-opening failure lost its public geometry primary');
    check(failure.evidence?.registrations === 0 && failure.evidence.cleaned && failure.evidence.sentinelRejected, 'pre-opening failure leaked observer registry');
    let retainedHandleClosed = false;
    try {
      await retainedObserverHandle.evaluate((observer: any) => observer.snapshot());
    } catch {
      retainedHandleClosed = true;
    }
    check(retainedHandleClosed, 'pre-opening failure retained its observer JSHandle');
  } finally {
    await browser.close();
  }
}

async function runRunnerOwnedDisconnectCleanupFailureCase() {
  const browser = await launchTestBrowser();
  try {
    const page: any = await browser.newPage();
    await page.setContent(`
      <div class="cm-editor"><div class="cm-scroller" style="height:40px;overflow:hidden">
        <div role="group" aria-label="Mermaid block controls at line 1">
          <button aria-label="Edit Mermaid in split view">Split</button>
        </div>
      </div></div>
    `);
    await page.evaluate(() => {
      (window as any).__historyMatrixEditor = {
        scrollToLine() {
          const group = document.querySelector<HTMLElement>('[role="group"]')!;
          if (group.style.marginTop === '80px') {
            console.log('close-before-observer-opening');
            return;
          }
          queueMicrotask(() => { group.style.marginTop = '80px'; });
        }
      };
    });
    page.on('console', (message: any) => {
      if (message.text() === 'close-before-observer-opening') void page.close();
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
    check(failure instanceof HistoryRenderedBlockInteractionError, 'runner-owned disconnect did not preserve InteractionError');
    check(failure.hasPrimary && failure.cause === failure.primary && failure.errors[0] === failure.primary, 'runner-owned disconnect changed primary-first order');
    check(failure.errors.length > 1, 'runner-owned disconnect omitted cleanup failures');
    check(failure.errors.slice(1).every((error: unknown) => String(error).includes('cleanup failed')), 'runner-owned cleanup failure preceded primary');
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
await runMaterializationFailureEvidenceCase();
await runMaterializationHandoffEvidenceCase();
await runMaterializationDisconnectCase();
await runRunnerOwnedUnsupportedCleanupCase();
await runRunnerOwnedNoopCleanupCase();
await runRunnerOwnedPreOpeningFailureCase();
await runRunnerOwnedDisconnectCleanupFailureCase();
await runMissingSemanticClickCase();
await runSameLabelDifferentGroupCase();
await runMoveSettlementMismatchCase();
console.log('history rendered-block synthetic Chromium matrix passed');
