import { enterMermaidSource, findMermaidOpening, readMermaidHistoryTarget, setMermaidLayout } from './history-mermaid-chromium';
import { enterDisplayMathSource, findDisplayMathOpening, readDisplayMathHistoryTarget } from './history-display-math-chromium';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import {
  HistoryRenderedBlockInteractionError,
  runHistoryRenderedBlockInteraction,
  type HistoryRenderedBlockInteractionAdapter,
  type HistoryRenderedBlockTargetMode
} from './history-rendered-block-interaction';

type BlockMode = 'preview' | 'split' | 'source';
type NeedleOccurrence = 'first' | 'last';
type HistoryTarget =
  | { kind: 'outer'; lineNeedle: string }
  | { kind: 'table'; undoValue: string; redoValue: string }
  | { kind: 'mermaid'; marker: string; mode: Exclude<BlockMode, 'preview'>; needle: string; occurrence?: NeedleOccurrence }
  | { kind: 'math'; marker: string; needle: string; occurrence?: NeedleOccurrence };

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-history-matrix-'));

async function waitForFrames(page: any, count = 6) {
  await page.evaluate(async (count: number) => {
    for (let index = 0; index < count; index++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }, count);
}

async function pressHistoryShortcut(page: any, key: 'z' | 'y') {
  await page.keyboard.down('Control');
  await page.keyboard.press(key);
  await page.keyboard.up('Control');
}

async function runSettledHistoryCommand(page: any, direction: 'undo' | 'redo') {
  const applied = await page.evaluate(async (command) => (
    (window as any).__historyMatrixEditor[command]()
  ), direction);
  if (!applied) throw new Error(`History ${direction} was not applied`);
}

async function documentText(page: any): Promise<string> {
  return page.evaluate(() => (window as any).__historyMatrixEditor.getText());
}

async function waitForDocumentText(page: any, expected: string) {
  await page.waitForFunction((text) => (
    (window as any).__historyMatrixEditor.getText() === text
  ), {}, expected);
}

async function scrollToLineContaining(
  page: any,
  needle: string,
  occurrence: NeedleOccurrence = 'first',
  tableCellOverride: string | null = null,
  renderedKind: 'mermaid' | 'math' | null = null
) {
  const tableCell = tableCellOverride
    ?? (needle.trim().startsWith('|') ? needle.split('|')[1]?.trim() ?? null : null);
  const location = await page.evaluate(({ lineNeedle, targetOccurrence, targetRenderedKind }) => {
    const editor = (window as any).__historyMatrixEditor;
    const lines = editor.getText().split('\n');
    const index = targetOccurrence === 'first'
      ? lines.findIndex((line: string) => line.includes(lineNeedle))
      : lines.findLastIndex((line: string) => line.includes(lineNeedle));
    if (index < 0) throw new Error(`Missing line: ${lineNeedle}`);
    editor.scrollToLine(index + 1, 'center');
    let controlLineNumber = index + 1;
    if (targetRenderedKind) {
      for (let openingIndex = index; openingIndex >= 0; openingIndex -= 1) {
        const isOpening = targetRenderedKind === 'mermaid'
          ? lines[openingIndex].startsWith('```mermaid')
          : lines[openingIndex].trim() === '$$';
        if (!isOpening) continue;
        controlLineNumber = openingIndex + 1;
        break;
      }
    }
    return { lineNumber: index + 1, controlLineNumber };
  }, { lineNeedle: needle, targetOccurrence: occurrence, targetRenderedKind: renderedKind });
  await page.waitForFunction(({ lineNeedle, expectedTableCell, targetRenderedKind, targetLineNumber }) => {
    const editor = (window as any).__historyMatrixEditor;
    const scroller = document.querySelector<HTMLElement>('.cm-scroller');
    const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .find((candidate) => candidate.textContent?.includes(lineNeedle));
    const table = expectedTableCell
      ? Array.from(document.querySelectorAll<HTMLTextAreaElement>(
          '.meo-md-html-table:not(.meo-md-html-table-sticky-table) textarea'
        )).find((candidate) => candidate.value === expectedTableCell)?.closest<HTMLElement>('.meo-md-html-table') ?? null
      : null;
    const blockLabel = targetRenderedKind === 'mermaid'
      ? `Mermaid block controls at line ${targetLineNumber}`
      : `Formula block controls at line ${targetLineNumber}`;
    const block = targetRenderedKind
      ? document.querySelector<HTMLElement>(`[role="group"][aria-label="${blockLabel}"]`)
      : null;
    if (targetRenderedKind && !block) {
      editor.scrollToLine(targetLineNumber, 'center');
      return false;
    }
    const target = expectedTableCell ? table : block ?? line;
    if (!scroller || !target) return false;
    const targetViewport = scroller.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const visible = rect.bottom > targetViewport.top && rect.top < targetViewport.bottom;
    if (!visible && targetRenderedKind) {
      editor.scrollToLine(targetLineNumber, 'center');
    }
    return visible;
  }, {}, {
    lineNeedle: needle,
    expectedTableCell: tableCell,
    targetRenderedKind: renderedKind,
    targetLineNumber: location.controlLineNumber
  }).catch(async (error: unknown) => {
    const labels = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[role="group"][aria-label]')).map((element) => ({
      label: element.getAttribute('aria-label'),
      rect: element.getBoundingClientRect().toJSON()
    })));
    throw new Error(`Missing visible semantic target: ${JSON.stringify({ needle, renderedKind, location, labels })}`, { cause: error });
  });
  return location.controlLineNumber;
}

async function editOuterLine(page: any, needle: string, marker: string) {
  await scrollToLineContaining(page, needle);
  await page.evaluate((lineNeedle) => {
    const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .find((candidate) => candidate.textContent?.includes(lineNeedle));
    const content = line?.closest<HTMLElement>('.cm-content');
    if (!line || !content) throw new Error(`Missing visible line: ${lineNeedle}`);
    const range = document.createRange();
    range.selectNodeContents(line);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    content.focus();
  }, needle);
  await page.keyboard.type(marker);
  await page.waitForFunction((expected) => (
    (window as any).__historyMatrixEditor.getText().includes(expected)
  ), {}, marker);
}

async function editTableCell(page: any, tableLine: string, before: string, after: string) {
  await scrollToLineContaining(page, tableLine, 'first', before);
  const targetSourceLine = await page.evaluate((sourceLine) => {
    const editor = (window as any).__historyMatrixEditor;
    const documentLines = editor.view.state.doc.toString().split('\n');
    const sourceLineIndex = documentLines.findIndex((line: string) => line.includes(sourceLine));
    if (sourceLineIndex < 0) throw new Error(`Missing table source line: ${sourceLine}`);
    return sourceLineIndex + 1;
  }, tableLine);
  await page.waitForFunction(({ currentValue, currentSourceLine }) => (
    Array.from(document.querySelectorAll<HTMLTextAreaElement>(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) textarea'
    )).some((candidate) => (
      candidate.value === currentValue &&
      Number(candidate.closest('tr')?.getAttribute('data-source-line-number')) === currentSourceLine
    ))
  ), {}, { currentValue: before, currentSourceLine: targetSourceLine });
  const settlement = await page.evaluate(({ currentValue, nextValue, currentSourceLine }) => {
    const editor = (window as any).__historyMatrixEditor;
    const input = Array.from(document.querySelectorAll<HTMLTextAreaElement>(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) textarea'
    )).find((candidate) => (
      candidate.value === currentValue &&
      Number(candidate.closest('tr')?.getAttribute('data-source-line-number')) === currentSourceLine
    ));
    if (!input) throw new Error(`Missing table input: ${currentValue}`);
    input.focus();
    input.value = nextValue;
    input.setSelectionRange(nextValue.length, nextValue.length);
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: nextValue,
      inputType: 'insertText'
    }));
    return {
      committed: editor.commitTransientEdits(),
      text: editor.view.state.doc.toString()
    };
  }, { currentValue: before, nextValue: after, currentSourceLine: targetSourceLine });
  const expectedLine = tableLine.replace(before, after);
  if (!settlement.committed || !settlement.text.includes(expectedLine)) {
    throw new Error(`Table edit did not settle: ${JSON.stringify({ tableLine, before, after, settlement })}`);
  }
}

async function editRenderedBlock(
  page: any,
  kind: 'mermaid' | 'math',
  lineNeedle: string,
  marker: string,
  finalMode: BlockMode,
  occurrence: NeedleOccurrence = 'first',
  stopAfterModeSettlement = false,
  stopBeforeFinalPreviewPointer = false,
  stopAfterFinalPreviewClick = false,
  expectFinalPreviewReplacementFailure = false,
  stopAfterFinalPreviewStableMovement = false,
  injectPreDownReplacement = false,
  injectDetachedOldEvents = false
) {
  if (kind === 'math') {
    const opening = await findDisplayMathOpening(page, '__historyMatrixEditor', lineNeedle, occurrence);
    await enterDisplayMathSource(page, '__historyMatrixEditor', opening, 'end');
    await page.keyboard.type(marker);
    await waitForFrames(page);
    if (finalMode === 'preview') await page.evaluate(() => (window as any).__historyMatrixEditor.revealSelection(0, 0, { align: 'none' }));
    return;
  }
  let targetLineNumber = 0;
  let modeClickSequence = 0;
  const settleTargetModeControl = async () => {
    targetLineNumber = await scrollToLineContaining(page, lineNeedle, occurrence, null, kind);
    const scrollSettlementKey = '__historyMatrixRenderedBlockScroll';
    const scrollSettlement = await page.evaluate(({ lineNumber, controlsLabel, registryKey }) => {
      const scroller = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller');
      const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${controlsLabel}"]`);
      if (!scroller || !group) throw new Error(`Missing rendered block controls: ${controlsLabel}`);
      const viewport = scroller.getBoundingClientRect();
      const controls = group.getBoundingClientRect();
      if (![viewport.top, viewport.bottom, controls.top, controls.bottom].every(Number.isFinite)
        || viewport.bottom <= viewport.top || controls.bottom <= controls.top) {
        throw new Error('Invalid rendered block geometry');
      }
      const center = (viewport.top + viewport.bottom) / 2;
      if (controls.top <= center && controls.bottom >= center) return { status: 'settled' as const };
      const fullyVisible = controls.top >= viewport.top && controls.bottom <= viewport.bottom;
      if (!('onscrollend' in scroller)) return { status: 'unsupported' as const };
      const registry = window as any;
      const transaction = {
        settled: false,
        dispose() { scroller.removeEventListener('scrollend', onScrollEnd); }
      };
      const onScrollEnd = () => { transaction.settled = true; transaction.dispose(); };
      registry[registryKey] = transaction;
      scroller.addEventListener('scrollend', onScrollEnd);
      const beforeScrollTop = scroller.scrollTop;
      try { (window as any).__historyMatrixEditor.scrollToLine(lineNumber, 'center'); }
      catch (error) { transaction.dispose(); delete registry[registryKey]; throw error; }
      if (
        !transaction.settled
        && fullyVisible
        && Math.abs(scroller.scrollTop - beforeScrollTop) <= 0.5
      ) {
        transaction.settled = true;
        transaction.dispose();
      }
      return { status: transaction.settled ? 'settled' as const : 'pending' as const };
    }, {
      lineNumber: targetLineNumber,
      controlsLabel: kind === 'mermaid'
        ? `Mermaid block controls at line ${targetLineNumber}`
        : `Formula block controls at line ${targetLineNumber}`,
      registryKey: scrollSettlementKey
    });
    if (scrollSettlement.status === 'unsupported') {
      throw new Error('Browser does not expose scrollend for a required rendered-block center transaction');
    }
    try {
      if (scrollSettlement.status === 'pending') {
        await page.waitForFunction((registryKey) => (
          (window as any)[registryKey]?.settled === true
        ), {}, scrollSettlementKey).catch(async (error: unknown) => {
          const evidence = await page.evaluate(({ blockKind, lineNumber }) => {
            const scroller = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller');
            const label = blockKind === 'mermaid'
              ? `Mermaid block controls at line ${lineNumber}`
              : `Formula block controls at line ${lineNumber}`;
            const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${label}"]`);
            const viewport = scroller?.getBoundingClientRect();
            const controls = group?.getBoundingClientRect();
            return {
              scrollTop: scroller?.scrollTop ?? null,
              viewport: viewport?.toJSON() ?? null,
              controls: controls?.toJSON() ?? null,
              fullyVisible: Boolean(viewport && controls && controls.top >= viewport.top && controls.bottom <= viewport.bottom)
            };
          }, { blockKind: kind, lineNumber: targetLineNumber });
          throw new Error(`Rendered block scroll did not settle for ${lineNeedle}: ${JSON.stringify(evidence)}`, { cause: error });
        });
      }
    } finally {
      await page.evaluate((key) => {
        const transaction = (window as any)[key];
        transaction?.dispose();
        delete (window as any)[key];
      }, scrollSettlementKey);
    }
    await page.waitForFunction(({ blockKind, lineNumber }) => {
      const viewport = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller')?.getBoundingClientRect();
      const controlsLabel = blockKind === 'mermaid'
        ? `Mermaid block controls at line ${lineNumber}`
        : `Formula block controls at line ${lineNumber}`;
      const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${controlsLabel}"]`)
        ?.getBoundingClientRect();
      return Boolean(viewport && group && group.top >= viewport.top && group.bottom <= viewport.bottom);
    }, {}, { blockKind: kind, lineNumber: targetLineNumber }).catch((error: unknown) => {
      throw new Error(`Rendered block controls did not become visible for ${lineNeedle} at line ${targetLineNumber}`, { cause: error });
    });
  };
  const clickTargetModeButton = async () => {
    // Visible geometry may precede the last accepted input presentation.
    // Acquire the native target only after the public readiness boundary.
    await page.evaluate(async () => (window as any).__historyMatrixEditor.whenVisiblePresentationReady(1_200));
    modeClickSequence += 1;
    await settleTargetModeControl();
    const transition = await page.evaluate(({ blockKind, needle, lineNumber }) => {
      const labels = blockKind === 'mermaid'
        ? {
            controls: `Mermaid block controls at line ${lineNumber}`,
            preview: 'Edit',
            split: 'Finish editing',
            source: 'Finish editing'
          }
        : {
            controls: `Formula block controls at line ${lineNumber}`,
            preview: 'Edit',
            split: 'Finish editing',
            source: 'Finish editing'
          };
      const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${labels.controls}"]`);
      const button = Array.from(group?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])
        .find((candidate) => (
          candidate.getAttribute('aria-label') === labels.preview
          || candidate.getAttribute('aria-label') === labels.split
          || candidate.getAttribute('aria-label') === labels.source
        )) ?? null;
      if (!button) throw new Error(`Missing ${blockKind} mode button for ${needle}`);
      const currentLabel = button.getAttribute('aria-label');
      const expectedLabel = currentLabel === labels.preview ? labels.split : labels.preview;
      const rect = button.getBoundingClientRect();
      return {
        controlsLabel: labels.controls,
        currentLabel,
        expectedLabel,
        hitPoint: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      };
    }, { blockKind: kind, needle: lineNeedle, lineNumber: targetLineNumber });
    await page.mouse.move(transition.hitPoint.x, transition.hitPoint.y);
    const exerciseFinalPreviewPointerSeam = (
      (
        stopAfterFinalPreviewClick
        || expectFinalPreviewReplacementFailure
        || stopAfterFinalPreviewStableMovement
      )
      && modeClickSequence === 2
    );
    if (exerciseFinalPreviewPointerSeam) {
      await page.evaluate((lineNumber) => {
        (window as any).__historyMatrixEditor.scrollToLine(lineNumber, 'top');
      }, targetLineNumber);
      await page.waitForFunction(({ controlsLabel, currentLabel, hitPoint }) => {
        const viewport = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller')?.getBoundingClientRect();
        const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${controlsLabel}"]`);
        const button = Array.from(group?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])
          .find((candidate) => candidate.getAttribute('aria-label') === currentLabel);
        const hit = document.elementFromPoint(hitPoint.x, hitPoint.y);
        const rect = button?.getBoundingClientRect();
        return Boolean(
          viewport && button?.isConnected && rect
          && rect.top >= viewport.top && rect.bottom <= viewport.bottom
          && hit?.closest('button[aria-label]') !== button
        );
      }, {}, transition);
    }
    let pointerDownRect: { top: number; bottom: number } | null = null;
    let acquiredModeButtonHandle: any;
    let pointerObserverHandle: any;
    let pointerObserverEvidence: any = null;
    const safeReleaseLabel = 'History pointer safe release target';
    try {
      const targetMode: HistoryRenderedBlockTargetMode = transition.expectedLabel === (
        kind === 'mermaid' ? 'Finish editing' : 'Finish editing'
      ) ? 'split' : transition.expectedLabel === (
        kind === 'mermaid' ? 'Finish editing' : 'Finish editing'
      ) ? 'source' : 'preview';
      await runHistoryRenderedBlockInteraction({ kind, lineNumber: targetLineNumber, targetMode }, {
      isCurrent: async () => true,
      settleScroll: async () => {
        await settleTargetModeControl();
        return 'settled';
      },
      isTargetSettled: async () => false,
      async acquireCurrentHandle() {
        acquiredModeButtonHandle = await page.evaluateHandle(({ controlsLabel, currentLabel }) => {
        const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${controlsLabel}"]`);
        return Array.from(group?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])
          .find((candidate) => candidate.getAttribute('aria-label') === currentLabel) ?? null;
        }, transition);
        return acquiredModeButtonHandle;
      },
      validateCurrentHandle: async (modeButtonHandle: any, phase: 'pointerdown' | 'pointerup') => {
        const stableModeButton = modeButtonHandle.asElement();
        if (!stableModeButton) {
          throw new Error(`Missing stable mode button before ${phase}: ${transition.controlsLabel}`);
        }
        const point = await stableModeButton.evaluate(
          (button: HTMLButtonElement, contract: typeof transition & { phase: string }) => {
            const scroller = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller');
            const expectedGroup = document.querySelector<HTMLElement>(
              `[role="group"][aria-label="${contract.controlsLabel}"]`
            );
            const actualGroup = button.closest<HTMLElement>('[role="group"][aria-label]');
            const currentButton = Array.from(
              expectedGroup?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? []
            ).find((candidate) => candidate.getAttribute('aria-label') === contract.currentLabel);
            if (
              !button.isConnected
              || actualGroup !== expectedGroup
              || currentButton !== button
              || actualGroup?.getAttribute('aria-label') !== contract.controlsLabel
              || button.getAttribute('aria-label') !== contract.currentLabel
            ) {
              throw new Error(`Mode button identity changed before ${contract.phase}: ${contract.controlsLabel}`);
            }
            if (!scroller || !actualGroup || !scroller.contains(actualGroup) || !actualGroup.contains(button)) {
              throw new Error(`Mode button left its editor scroller before ${contract.phase}: ${contract.controlsLabel}`);
            }
            const viewport = scroller.getBoundingClientRect();
            const groupRect = actualGroup.getBoundingClientRect();
            const buttonRect = button.getBoundingClientRect();
            const fullyVisible = [groupRect, buttonRect].every((rect) => (
              rect.top >= viewport.top && rect.bottom <= viewport.bottom
              && rect.left >= viewport.left && rect.right <= viewport.right
            ));
            if (!fullyVisible) {
              throw new Error(`Mode button is not fully visible before ${contract.phase}: ${contract.controlsLabel}`);
            }
            return {
              x: buttonRect.left + buttonRect.width / 2,
              y: buttonRect.top + buttonRect.height / 2,
              rect: buttonRect.toJSON()
            };
          },
          { ...transition, phase }
        );
        if (phase === 'pointerdown') pointerDownRect = point.rect;
        return point;
      },
      async preparePointerDown(point: { x: number; y: number }) {
        if (injectPreDownReplacement && modeClickSequence === 1) {
          const stableModeButton = acquiredModeButtonHandle?.asElement();
          if (!stableModeButton) throw new Error(`Missing stable mode button before injected replacement: ${transition.controlsLabel}`);
          const evidenceHandle = await stableModeButton.evaluateHandle((button: HTMLButtonElement) => {
            const evidence = document.createElement('output');
            evidence.setAttribute('aria-label', 'History pointer pre-down replacement evidence');
            document.body.append(evidence);
            const snapshot = (candidate: HTMLButtonElement) => ({
              connected: candidate.isConnected,
              label: candidate.getAttribute('aria-label'),
              group: candidate.closest('[role="group"]')?.getAttribute('aria-label') ?? null,
              line: candidate.closest('.cm-line')?.textContent ?? null,
              rect: candidate.getBoundingClientRect().toJSON()
            });
            const oldBefore = snapshot(button);
            const replacement = button.cloneNode(true) as HTMLButtonElement;
            button.replaceWith(replacement);
            evidence.textContent = JSON.stringify({
              oldBefore,
              oldAfter: snapshot(button),
              replacement: snapshot(replacement),
              sameNode: button === replacement
            });
            return evidence;
          });
          try {
            pointerObserverHandle = await stableModeButton.evaluateHandle((oldButton: HTMLButtonElement, contract) => {
              const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${contract.controlsLabel}"]`);
              const replacementButton = Array.from(group?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])
                .find((candidate) => candidate.getAttribute('aria-label') === contract.currentLabel) ?? null;
              if (!replacementButton) throw new Error('Missing pre-down replacement observer target');
              const registrations: Array<{ role: 'old' | 'replacement' | 'document'; target: EventTarget; type: string; listener: EventListener }> = [];
              const events: string[] = [];
              const registrationIdentity: string[] = [];
              const direct = { old: { pointerdown: 0, pointerup: 0, click: 0 }, replacement: { pointerdown: 0, pointerup: 0, click: 0 } };
              const documentEvents: string[] = [];
              let cleaned = false;
              let sentinelRejected = false;
              const snapshot = () => ({
                events: [...events], direct: { old: { ...direct.old }, replacement: { ...direct.replacement } },
                documentEvents: [...documentEvents], registrationIdentity: [...registrationIdentity],
                registrations: registrations.length, cleaned, sentinelRejected, sentinelVerified: sentinelRejected
              });
              const publish = () => {
                const output = document.querySelector<HTMLOutputElement>('output[aria-label="History pointer pre-down replacement evidence"]');
                if (output) output.dataset.historyPointerObserver = JSON.stringify(snapshot());
              };
              const observe = (target: EventTarget, role: 'old' | 'replacement' | 'document') => {
                for (const type of ['pointerdown', 'pointerup', 'click']) {
                  const listener = (event: Event) => {
                    const category = role === 'document'
                      ? (event.target instanceof Element && event.target.closest('button') === replacementButton) ? 'current'
                        : (event.target instanceof Element && event.target.closest('button') === oldButton) ? 'old' : 'other'
                      : role;
                    events.push(`${role}:${type}:${category}`);
                    if (role === 'document') documentEvents.push(`${type}:${category === 'current' ? 'replacement' : category}`);
                    else direct[role][type] += 1;
                    publish();
                  };
                  target.addEventListener(type, listener, true);
                  registrations.push({ role, target, type, listener });
                  registrationIdentity.push(`${role}:${type}`);
                }
              };
              observe(oldButton, 'old');
              observe(replacementButton, 'replacement');
              observe(document, 'document');
              return {
                cleanup() {
                  const pending = registrations.splice(0);
                  const errors: unknown[] = [];
                  for (const registration of pending) {
                    try { registration.target.removeEventListener(registration.type, registration.listener, true); }
                    catch (error) { errors.push(error); }
                  }
                  if (errors.length) throw new AggregateError(errors, 'History pointer observer cleanup failed');
                  cleaned = true;
                  publish();
                },
                verifySentinel() {
                  const before = events.length;
                  for (const target of [oldButton, replacementButton, document]) target.dispatchEvent(new Event('click'));
                  sentinelRejected = events.length === before;
                  publish();
                  return sentinelRejected;
                },
                snapshot
              };
            }, transition);
          } finally {
            await evidenceHandle.dispose();
          }
          if (injectDetachedOldEvents) {
            await stableModeButton.evaluate((button: HTMLButtonElement) => {
              for (const eventName of ['pointerdown', 'pointerup', 'click'] as const) {
                button.addEventListener(eventName, (event) => event.stopImmediatePropagation(), {
                  capture: true,
                  once: true
                });
                button.dispatchEvent(new Event(eventName, { bubbles: true }));
              }
            });
          }
        }
        await page.mouse.move(point.x, point.y);
      },
      disposeSupersededHandle: (modeButtonHandle: any) => modeButtonHandle.dispose(),
      async deliverPointerDown(point: { x: number; y: number }) {
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
      },
      async afterPointerDown(modeButtonHandle: any) {
        const stableModeButton = modeButtonHandle.asElement();
        if (!stableModeButton) throw new Error(`Missing stable mode button after pointerdown: ${transition.controlsLabel}`);
        if (expectFinalPreviewReplacementFailure && modeClickSequence === 2) {
          await stableModeButton.evaluate((button: HTMLButtonElement) => {
            const evidence = document.createElement('output');
            evidence.setAttribute('aria-label', 'History pointer replacement release evidence');
            document.body.append(evidence);
            const replacement = button.cloneNode(true) as HTMLButtonElement;
            document.addEventListener('pointerup', (event) => {
              const eventTarget = event.target instanceof Element ? event.target : null;
              const category = eventTarget?.closest('[aria-label="History pointer safe release target"]')
                ? 'safe'
                : eventTarget === replacement ? 'replacement' : 'other';
              evidence.append(`document:${category}\n`);
            }, { capture: true, once: true });
            replacement.addEventListener('pointerup', () => {
              evidence.append('replacement:pointerup\n');
            }, { once: true });
            button.replaceWith(replacement);
          });
        } else if (stopAfterFinalPreviewStableMovement && modeClickSequence === 2) {
          if (!pointerDownRect) throw new Error('Missing pointerdown geometry before stable movement');
          await stableModeButton.evaluate((button: HTMLButtonElement) => {
            const movement = button.animate(
              [{ transform: 'translateY(0)' }, { transform: 'translateY(50%)' }],
              { duration: 1, fill: 'both' }
            );
            movement.pause();
            movement.currentTime = 1;
          });
          await page.waitForFunction((button: HTMLElement, previousRect: DOMRect) => {
            if (!button.isConnected) return false;
            const rect = button.getBoundingClientRect();
            return rect.top !== previousRect.top || rect.bottom !== previousRect.bottom;
          }, {}, stableModeButton, pointerDownRect).catch((error: unknown) => {
            throw new Error('Stable mode button did not move between pointerdown and pointerup', { cause: error });
          });
        }
      },
      preparePointerUp: (point: { x: number; y: number }) => page.mouse.move(point.x, point.y),
      async deliverPointerUp(point: { x: number; y: number }) {
        await page.mouse.move(point.x, point.y);
        await page.mouse.up();
      },
      settleTarget: async () => {
        if (injectPreDownReplacement) return;
        try {
          await page.waitForFunction(({ controlsLabel, expectedLabel }) => Array.from(
            document.querySelector<HTMLElement>(`[role="group"][aria-label="${controlsLabel}"]`)
              ?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? []
          ).some((candidate) => candidate.getAttribute('aria-label') === expectedLabel), {}, transition);
        } catch (error) {
          const evidence = await page.evaluate((contract) => ({
            transition: contract,
            active: document.activeElement instanceof HTMLElement ? {
              tag: document.activeElement.tagName,
              label: document.activeElement.getAttribute('aria-label'),
              className: document.activeElement.className
            } : null,
            hit: document.elementFromPoint(contract.hitPoint.x, contract.hitPoint.y)?.closest<HTMLElement>('[aria-label]')?.getAttribute('aria-label') ?? null,
            groups: Array.from(document.querySelectorAll<HTMLElement>(
              '.meo-mermaid-toolbar, .meo-latex-math-toolbar'
            )).map((group) => ({
              label: group.getAttribute('aria-label'),
              mode: group.dataset.meoMermaidMode ?? group.dataset.meoLatexMathMode,
              from: group.dataset.meoBlockFrom,
              line: group.closest('.cm-line')?.textContent ?? null,
              shell: Boolean(group.closest('.meo-rendered-block-preview')),
              buttons: Array.from(group.querySelectorAll<HTMLButtonElement>('button[aria-label]')).map((button) => button.getAttribute('aria-label'))
            }))
          }), transition);
          throw new Error(`Mode button label did not settle: ${JSON.stringify(evidence)}`, { cause: error });
        }
      },
      async moveToSafeReleaseTarget() {
        const safePoint = await page.evaluate((ariaLabel) => {
          const existing = document.querySelector(`[aria-label="${ariaLabel}"]`);
          existing?.remove();
          const target = document.createElement('div');
          target.setAttribute('aria-label', ariaLabel);
          Object.assign(target.style, {
            position: 'fixed',
            inset: '0',
            zIndex: '2147483647',
            pointerEvents: 'auto'
          });
          document.body.append(target);
          const rect = target.getBoundingClientRect();
          const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          const hit = document.elementFromPoint(point.x, point.y);
          const interactive = target.closest(
            'button, a, input, textarea, select, [role="button"], [role="group"], [contenteditable="true"]'
          );
          if (hit !== target || interactive) {
            target.remove();
            throw new Error('Could not establish a public non-control pointer release target');
          }
          return point;
        }, safeReleaseLabel);
        await page.mouse.move(safePoint.x, safePoint.y);
        return { ...safePoint, category: 'safe' as const };
      },
      cancelPointer: () => page.mouse.up(),
      disposeSafeReleaseTarget: () => page.evaluate((ariaLabel) => {
        document.querySelector(`[aria-label="${ariaLabel}"]`)?.remove();
      }, safeReleaseLabel),
      async cancelAnimation(modeButtonHandle: any) {
        if (!stopAfterFinalPreviewStableMovement || modeClickSequence !== 2) return;
        const stableModeButton = modeButtonHandle.asElement();
        if (stableModeButton) {
          await stableModeButton.evaluate((button: HTMLButtonElement) => {
            button.getAnimations().forEach((animation) => animation.cancel());
          });
        }
      },
      disposeHandle: (modeButtonHandle: any) => modeButtonHandle.dispose(),
      openObserver: async () => ({
        cleanup: async () => {
          if (!pointerObserverHandle) return;
          try {
            pointerObserverEvidence = await pointerObserverHandle.evaluate((registry: { cleanup(): void; snapshot(): { registrations: number } }) => {
              registry.cleanup();
              return registry.snapshot();
            });
            if (pointerObserverEvidence.registrations !== 0) throw new Error('History pointer observer registry leaked after cleanup');
          } catch (error) { throw error; }
        },
        snapshot: async () => pointerObserverEvidence ?? { events: [], registrations: 0, cleaned: true, sentinelRejected: true },
        verifySentinel: async () => {
          if (!pointerObserverHandle) return true;
          try {
            const verified = await pointerObserverHandle.evaluate((registry: { verifySentinel(): boolean; snapshot(): unknown }) => ({
              verified: registry.verifySentinel(), evidence: registry.snapshot()
            }));
            pointerObserverEvidence = verified.evidence;
            return verified.verified;
          } finally {
            await pointerObserverHandle.dispose();
            pointerObserverHandle = null;
          }
        }
      })
      });
    } catch (error) {
      const primaryError = error instanceof HistoryRenderedBlockInteractionError ? error.primary : error;
      if (injectPreDownReplacement && primaryError instanceof Error) {
        const evidence = await page.evaluate(() => (
          document.querySelector<HTMLOutputElement>(
            'output[aria-label="History pointer pre-down replacement evidence"]'
          )?.textContent ?? null
        ));
        const primary = new Error(`Pre-down replacement evidence: ${JSON.stringify({
          evidence: evidence ? JSON.parse(evidence) : null,
          primary: String(primaryError)
        })}`, { cause: error });
        throw primary;
      }
      throw error;
    }
  };
  targetLineNumber = await scrollToLineContaining(page, lineNeedle, occurrence, null, kind);
  await clickTargetModeButton();
  await setMermaidLayout(page, '__historyMatrixEditor', targetLineNumber, finalMode === 'source' ? 'stacked' : 'side-by-side');
  if (stopAfterModeSettlement) return;
  await enterMermaidSource(page, '__historyMatrixEditor', targetLineNumber, 'end');
  await page.keyboard.type(marker);
  await page.waitForFunction(expected => (window as any).__historyMatrixEditor.getText().includes(expected), {}, marker);
  if (finalMode === 'preview') {
    if (stopBeforeFinalPreviewPointer) {
      await settleTargetModeControl();
      await page.evaluate(({ blockKind, lineNumber }) => {
        const controlsLabel = blockKind === 'mermaid'
          ? `Mermaid block controls at line ${lineNumber}`
          : `Formula block controls at line ${lineNumber}`;
        const expectedLabel = blockKind === 'mermaid' ? 'Finish editing' : 'Finish editing';
        const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${controlsLabel}"]`);
        const settledBeforePointer = Array.from(group?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])
          .some((button) => button.getAttribute('aria-label') === expectedLabel);
        if (!settledBeforePointer) throw new Error(`Final preview settlement crossed its pointer boundary: ${controlsLabel}`);
      }, { blockKind: kind, lineNumber: targetLineNumber });
      return;
    }
    await clickTargetModeButton();
    if (
      stopAfterFinalPreviewClick
      || expectFinalPreviewReplacementFailure
      || stopAfterFinalPreviewStableMovement
    ) return;
  }

}

async function assertFirstMermaidModeClickAfterAdjacentEdit(page: any, lineNeedle: string) {
  await editOuterLine(page, 'CODE_TARGET', ' // CODE_EDIT');
  const targetLineNumber = await scrollToLineContaining(page, lineNeedle, 'first', null, 'mermaid');
  if (targetLineNumber !== 130) {
    throw new Error(`Expected first Mermaid control at line 130, received line ${targetLineNumber}`);
  }
  const controlsLabel = `Mermaid block controls at line ${targetLineNumber}`;
  await page.evaluate((lineNumber) => {
    (window as any).__historyMatrixEditor.scrollToLine(lineNumber, 'center');
  }, targetLineNumber);
  await page.waitForFunction((label) => {
    const scroller = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller')?.getBoundingClientRect();
    const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${label}"]`)
      ?.getBoundingClientRect();
    return Boolean(scroller && group && group.top >= scroller.top && group.bottom <= scroller.bottom);
  }, {}, controlsLabel);
  await setMermaidLayout(page, '__historyMatrixEditor', targetLineNumber, 'preview');
  const hitPoint = await page.evaluate((label) => {
    const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${label}"]`);
    const button = Array.from(group?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])
      .find((candidate) => candidate.getAttribute('aria-label') === 'Edit');
    if (!button) throw new Error(`Missing preview mode control: ${label}`);
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, controlsLabel);
  await page.mouse.click(hitPoint.x, hitPoint.y);
  await page.waitForFunction((controlsLabel) => Array.from(
    document.querySelector<HTMLElement>(`[role="group"][aria-label="${controlsLabel}"]`)
      ?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? []
  ).some((candidate) => candidate.getAttribute('aria-label') === 'Finish editing'), {}, controlsLabel);

  await page.waitForFunction(lineNumber => {
    const view = (window as any).__historyMatrixEditor.view, position = view.state.doc.line(lineNumber + 1).from;
    const coords = view.coordsAtPos(position), viewport = view.scrollDOM.getBoundingClientRect();
    return view.hasFocus && !!coords && coords.bottom > viewport.top && coords.top < viewport.bottom;
  }, {}, targetLineNumber);

  const repeatedLineNumber = await scrollToLineContaining(page, lineNeedle, 'last', null, 'mermaid');
  if (repeatedLineNumber === targetLineNumber) {
    throw new Error('Expected a distinct repeated Mermaid block');
  }
  await page.waitForFunction((lineNumber) => Array.from(
    document.querySelector<HTMLElement>(
      `[role="group"][aria-label="Mermaid block controls at line ${lineNumber}"]`
    )?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? []
  ).some((candidate) => candidate.getAttribute('aria-label') === 'Finish editing'), {}, repeatedLineNumber);
}

async function assertHistoryTarget(
  page: any,
  target: HistoryTarget,
  direction: 'undo' | 'redo',
  step: number
) {
  if (target.kind === 'outer') {
    await page.waitForFunction((needle) => {
      const content = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller .cm-content');
      const selection = window.getSelection();
      const focusNode = selection?.focusNode ?? null;
      const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement ?? null;
      const line = focusElement?.closest<HTMLElement>('.cm-line');
      if (!content || !line || !content.contains(document.activeElement)) return false;
      const viewport = content.closest<HTMLElement>('.cm-scroller')!.getBoundingClientRect();
      const rect = line.getBoundingClientRect();
      return line.textContent?.includes(needle)
        && rect.bottom > viewport.top
        && rect.top < viewport.bottom;
    }, {}, target.lineNeedle).catch((error: unknown) => {
      throw new Error(`${direction} step ${step} missed outer target: ${JSON.stringify(target)}`, { cause: error });
    });
    return;
  }

  if (target.kind === 'table') {
    const expectedValue = direction === 'undo' ? target.undoValue : target.redoValue;
    await page.waitForFunction((expected) => {
      const input = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null;
      const rect = input?.getBoundingClientRect();
      const viewport = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller')?.getBoundingClientRect();
      return input?.value === expected
        && Boolean(rect && viewport && rect.bottom > viewport.top && rect.top < viewport.bottom);
    }, {}, expectedValue).catch((error: unknown) => {
      throw new Error(`${direction} step ${step} missed table target: ${JSON.stringify(target)}`, { cause: error });
    });
    return;
  }

  if (target.kind === 'math') {
    const opening = await findDisplayMathOpening(page, '__historyMatrixEditor', target.needle, target.occurrence ?? 'first');
    const state = await readDisplayMathHistoryTarget(page, '__historyMatrixEditor', opening, { waitForVisibility: true });
    if (!state.focused || !state.caretAtEnd || !state.visible || !state.resultPresent || state.source.includes(target.marker) !== (direction === 'redo'))
      throw new Error(`${direction} step ${step} missed native formula: ${JSON.stringify({ target, state })}`);
    return;
  }
  const opening = await findMermaidOpening(page, '__historyMatrixEditor', target.needle, target.occurrence ?? 'first');
  const state = await readMermaidHistoryTarget(page, '__historyMatrixEditor', opening);
  if (!state.focused || !state.visible || !state.caretAtEnd || !state.resultPresent
    || state.side !== (target.mode === 'split') || state.source.includes(target.marker) !== (direction === 'redo'))
    throw new Error(`${direction} step ${step} missed native Mermaid target: ${JSON.stringify({ target, state })}`);

}

async function assertReplacementSafeReleaseAndRecovery(page: any) {
  const evidence = await page.evaluate(() => {
    const output = document.querySelector<HTMLOutputElement>(
      'output[aria-label="History pointer replacement release evidence"]'
    );
    const safeTarget = document.querySelector('[aria-label="History pointer safe release target"]');
    return {
      events: output?.textContent?.split('\n').filter(Boolean) ?? [],
      safeTargetConnected: Boolean(safeTarget?.isConnected)
    };
  });
  if (JSON.stringify(evidence.events) !== JSON.stringify(['document:safe'])) {
    throw new Error(`Replacement release was not isolated to the safe target: ${JSON.stringify(evidence)}`);
  }
  if (evidence.safeTargetConnected) throw new Error('Safe pointer release target was not disposed');

  const recovery = await page.evaluate(() => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'History pointer recovery probe');
    Object.assign(button.style, {
      position: 'fixed',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: '2147483647'
    });
    button.addEventListener('click', () => {
      button.setAttribute('aria-label', 'History pointer recovery complete');
    }, { once: true });
    document.body.append(button);
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  try {
    await page.mouse.move(recovery.x, recovery.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction(() => Boolean(document.querySelector(
      'button[aria-label="History pointer recovery complete"]'
    )));
  } finally {
    await page.evaluate(() => {
      document.querySelector('button[aria-label^="History pointer recovery"]')?.remove();
      document.querySelector('output[aria-label="History pointer replacement release evidence"]')?.remove();
    });
  }
}

async function main() {
  const realFixturePath = process.env.MEO_HISTORY_REAL_FIXTURE?.trim() || null;
  const firstMermaidClickOnly = process.env.MEO_HISTORY_FIRST_MERMAID_CLICK_ONLY === '1';
  const firstDefaultMermaidClickOnly = process.env.MEO_HISTORY_FIRST_DEFAULT_MERMAID_CLICK_ONLY === '1';
  const firstDefaultMermaidFinalPreviewSettlementOnly = (
    process.env.MEO_HISTORY_FIRST_DEFAULT_MERMAID_FINAL_PREVIEW_SETTLEMENT_ONLY === '1'
  );
  const firstDefaultMermaidFinalPreviewClickOnly = (
    process.env.MEO_HISTORY_FIRST_DEFAULT_MERMAID_FINAL_PREVIEW_CLICK_ONLY === '1'
  );
  const firstDefaultMermaidFinalPreviewReplacementOnly = (
    process.env.MEO_HISTORY_FIRST_DEFAULT_MERMAID_FINAL_PREVIEW_REPLACEMENT_ONLY === '1'
  );
  const firstDefaultMermaidFinalPreviewStableMovementOnly = (
    process.env.MEO_HISTORY_FIRST_DEFAULT_MERMAID_FINAL_PREVIEW_STABLE_MOVEMENT_ONLY === '1'
  );
  const firstDefaultMermaidPreDownReplacementOnly = (
    process.env.MEO_HISTORY_FIRST_DEFAULT_MERMAID_PRE_DOWN_REPLACEMENT_ONLY === '1'
  );
  const firstDefaultMermaidPreDownDetachedOldEventsOnly = (
    process.env.MEO_HISTORY_FIRST_DEFAULT_MERMAID_PRE_DOWN_DETACHED_OLD_EVENTS_ONLY === '1'
  );
  const realFixtureText = realFixturePath ? fs.readFileSync(realFixturePath, 'utf8') : null;
  if (firstMermaidClickOnly && realFixtureText) {
    throw new Error('The focused first-Mermaid click path requires the synthetic History fixture');
  }
  const fixture = realFixtureText
    ? {
        outerTop: '普通段落原始值：Alpha Bravo Charlie',
        table1Line: '| 1 | Alpha | Ready |',
        table1FirstBefore: '1',
        table1FirstAfter: '1_REAL',
        table1LineAfterFirst: '| 1_REAL | Alpha | Ready |',
        table1SecondBefore: 'Alpha',
        table1SecondAfter: 'Alpha_REAL',
        code: "const baselineUser: User = { id: 1, name: 'Alice' }",
        mermaidPreview: 'A[Baseline A] --> B{Choose}',
        mermaidSplit: 'participant U as User',
        mermaidSource: 'B -->|Undo| C[Restore]',
        mathPreview: '\\int_{-\\infty}^{\\infty}',
        mathPreviewOccurrence: 'first' as NeedleOccurrence,
        mathSplit: '\\operatorname{score}',
        mathSource: '\\alpha \\cdot \\operatorname{readability}',
        table2Line: '| Long Chinese | 这是一段很长很长的中文说明文字，用来测试表格列宽、自动换行、输入后高度变化以及撤销重做时的布局稳定性。 | 原始值 LONG-CN | Pending |',
        table2FirstBefore: 'Long Chinese',
        table2FirstAfter: 'Long Chinese_REAL',
        table2LineAfterFirst: '| Long Chinese_REAL',
        table2SecondBefore: '这是一段很长很长的中文说明文字，用来测试表格列宽、自动换行、输入后高度变化以及撤销重做时的布局稳定性。',
        table2SecondAfter: '长表内容_REAL',
        table2ThirdBefore: 'Pending',
        table2ThirdAfter: 'Pending_REAL',
        extraOuter1: '标题 B 的正文',
        extraOuter2: '压力行 A：STRESS-A-BASELINE',
        extraMermaid1: 'participant U as User',
        extraMermaid2: 'A[Baseline A] --> B{Choose}',
        extraMath1: '\\operatorname{score}',
        extraMath2: '\\int_{-\\infty}^{\\infty}',
        outerBottom: '最后一行：END-BASELINE-C',
        typingNeedle: '普通段落原始值：Alpha Bravo Charlie'
      }
    : {
        outerTop: 'PLAIN_TOP',
        table1Line: '| T1A | T1B |',
        table1FirstBefore: 'T1A',
        table1FirstAfter: 'T1A_EDIT',
        table1LineAfterFirst: '| T1A_EDIT | T1B |',
        table1SecondBefore: 'T1B',
        table1SecondAfter: 'T1B_EDIT',
        code: 'CODE_TARGET',
        mermaidPreview: 'MP_A --> MP_B',
        mermaidSplit: 'MS_A --> MS_B',
        mermaidSource: 'MC_A --> MC_B',
        mathPreview: 'mathPreview = 1',
        mathPreviewOccurrence: 'first' as NeedleOccurrence,
        mathSplit: 'mathSplit = 1',
        mathSource: 'mathSource = 1',
        table2Line: '| T2A | T2B |',
        table2FirstBefore: 'T2A',
        table2FirstAfter: 'T2A_EDIT',
        table2LineAfterFirst: 'T2A_EDIT',
        table2SecondBefore: 'T2B',
        table2SecondAfter: 'T2B_EDIT',
        table2ThirdBefore: 'left text',
        table2ThirdAfter: 'left text_EDIT',
        extraOuter1: 'EXTRA_OUTER_ONE',
        extraOuter2: 'EXTRA_OUTER_TWO',
        extraMermaid1: 'MP_A --> MP_B',
        extraMermaid2: 'ME_EXTRA_C --> ME_EXTRA_D',
        extraMath1: 'mathExtra = 1',
        extraMath2: 'mathExtraTwo = 1',
        outerBottom: 'PLAIN_BOTTOM',
        typingNeedle: 'gap-'
      };
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-mermaid-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 920, height: 460, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate((fixtureText) => {
      (window as any).mermaid = {
        initialize() {},
        async render(_id: string, text: string) {
          return { svg: `<svg width="360" height="140"><text>${text.length}</text></svg>` };
        }
      };
      const gap = (name: string, count = 10) => Array.from({ length: count }, (_, index) => `${name} ${index + 1}`);
      const text = fixtureText ?? [
        'PLAIN_TOP',
        'EXTRA_OUTER_ONE',
        'EXTRA_OUTER_TWO',
        ...gap('gap-a'),
        '| T1H1 | T1H2 |',
        '| --- | --- |',
        '| T1A | T1B |',
        ...gap('gap-b', 100),
        '```ts',
        'const CODE_TARGET = true;',
        '```',
        ...gap('gap-c'),
        '```mermaid',
        'graph TD',
        'MP_A --> MP_B',
        '```',
        ...gap('gap-d'),
        '```mermaid',
        'graph TD',
        'MS_A --> MS_B',
        '```',
        ...gap('gap-e'),
        '```mermaid',
        'graph TD',
        'MC_A --> MC_B',
        '```',
        '```mermaid',
        'graph TD',
        'MP_A --> MP_B',
        '```',
        '```mermaid',
        'graph TD',
        'ME_EXTRA_C --> ME_EXTRA_D',
        '```',
        ...gap('gap-f'),
        '$$',
        'mathPreview = 1',
        '$$',
        ...gap('gap-g'),
        '$$',
        'mathSplit = 1',
        '$$',
        ...gap('gap-h'),
        '$$',
        'mathSource = 1',
        '$$',
        '$$',
        'mathExtra = 1',
        '$$',
        '$$',
        'mathExtraTwo = 1',
        '$$',
        ...gap('gap-i', 100),
        '| T2H1 | T2H2 | T2H3 |',
        '| --- | --- | --- |',
        '| T2A | T2B | left text |',
        ...gap('gap-j'),
        'PLAIN_BOTTOM'
      ].join('\n');
      (window as any).__historyMatrixEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, realFixtureText);
    await page.waitForFunction(() => Boolean(
      (window as any).__historyMatrixEditor?.getText()
      && document.querySelector('.cm-editor > .cm-scroller')
    ));

    if (firstMermaidClickOnly) {
      await assertFirstMermaidModeClickAfterAdjacentEdit(page, fixture.mermaidPreview);
      console.log('focused first Mermaid mode click checks passed');
      return;
    }
    const externalSyncDepth = await page.evaluate(() => {
      const editor = (window as any).__historyMatrixEditor;
      const text = editor.getText();
      const before = editor.getHistoryDepth();
      editor.setText(`${text}\nEXTERNAL_SYNC_PROBE`);
      editor.setText(text);
      const after = editor.getHistoryDepth();
      if (before.undo !== after.undo || before.redo !== after.redo) {
        throw new Error(`External sync changed history depth: ${JSON.stringify({ before, after })}`);
      }
      return after;
    });
    if (externalSyncDepth.undo !== 0 || externalSyncDepth.redo !== 0) {
      throw new Error(`Expected a clean history after external sync probe: ${JSON.stringify(externalSyncDepth)}`);
    }

    const pendingTableBaseline = await page.evaluate(() => (window as any).__historyMatrixEditor.getText());
    await scrollToLineContaining(page, fixture.table1Line);
    const pendingTableBaselineRowCount = await page.evaluate((before) => {
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
      const input = table?.querySelector<HTMLTextAreaElement>('tbody textarea');
      if (!input) throw new Error('Missing first-table pending edit target');
      if (input.value !== before) throw new Error(`Unexpected first-table value: ${input.value}`);
      input.focus();
      input.value = `${before}_PENDING`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return table.querySelectorAll('tbody tr').length;
    }, fixture.table1FirstBefore);
    const commandConsumed = await page.evaluate(() => {
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
      const command = table?.closest<HTMLElement>('.meo-md-html-table-shell')
        ?.querySelector<HTMLButtonElement>('button[data-tooltip="Insert row below"]');
      if (!command) throw new Error('Missing Insert row below control');
      const consumed = !command.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0,
        bubbles: true,
        cancelable: true
      }));
      command.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }));
      command.click();
      return consumed;
    });
    if (!commandConsumed) throw new Error('Insert row below command was not consumed');
    await page.waitForFunction((expectedRows) => document.querySelectorAll<HTMLElement>(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table)'
    )[0]?.querySelectorAll('tbody tr').length === expectedRows, {}, pendingTableBaselineRowCount + 1);
    const afterPendingInsert = await page.evaluate(({ pending }) => {
      const editor = (window as any).__historyMatrixEditor;
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
      return {
        rowCount: table?.querySelectorAll('tbody tr').length ?? 0,
        text: editor.getText(),
        pending
      };
    }, { pending: `${fixture.table1FirstBefore}_PENDING` });
    if (
      afterPendingInsert.rowCount !== pendingTableBaselineRowCount + 1
      || !afterPendingInsert.text.includes(afterPendingInsert.pending)
      || !afterPendingInsert.text.includes(fixture.table2FirstBefore)
    ) {
      throw new Error(`Pending table edit leaked during structural command: ${JSON.stringify(afterPendingInsert)}`);
    }
    const waitForPendingStructureState = async (expected: {
      readonly text: string;
      readonly rowCount: number;
      readonly focused: boolean;
    }) => page.waitForFunction(({ text, rowCount, focused }) => {
      const editor = (window as any).__historyMatrixEditor;
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
      const active = document.activeElement;
      return editor.getText() === text
        && table?.querySelectorAll('tbody tr').length === rowCount
        && (!focused || (active instanceof HTMLTextAreaElement && table.contains(active)));
    }, {}, expected);
    await page.evaluate(async () => {
      const applied = await (window as any).__historyMatrixEditor.undo();
      if (!applied) throw new Error('Pending table structure undo was not applied');
    });
    await waitForPendingStructureState({ text: pendingTableBaseline, rowCount: pendingTableBaselineRowCount, focused: true });
    await page.evaluate(async () => {
      const applied = await (window as any).__historyMatrixEditor.redo();
      if (!applied) throw new Error('Pending table structure redo was not applied');
    });
    await waitForPendingStructureState({ text: afterPendingInsert.text, rowCount: pendingTableBaselineRowCount + 1, focused: true });
    await page.evaluate((text) => (window as any).__historyMatrixEditor.setText(text), pendingTableBaseline);
    await waitForPendingStructureState({ text: pendingTableBaseline, rowCount: pendingTableBaselineRowCount, focused: false });

    const versions = [await documentText(page)];
    const targets: HistoryTarget[] = [];
    const record = async (target: HistoryTarget) => {
      const text = await documentText(page);
      if (text === versions[versions.length - 1]) {
        throw new Error(`Edit did not change the document: ${JSON.stringify(target)}`);
      }
      targets.push(target);
      versions.push(text);
    };

    await editOuterLine(page, fixture.outerTop, ' PLAIN_TOP_EDIT');
    await record({ kind: 'outer', lineNeedle: fixture.outerTop });
    await editTableCell(page, fixture.table1Line, fixture.table1FirstBefore, fixture.table1FirstAfter);
    await record({ kind: 'table', undoValue: fixture.table1FirstBefore, redoValue: fixture.table1FirstAfter });
    await editTableCell(page, fixture.table1LineAfterFirst, fixture.table1SecondBefore, fixture.table1SecondAfter);
    await record({ kind: 'table', undoValue: fixture.table1SecondBefore, redoValue: fixture.table1SecondAfter });
    await editOuterLine(page, fixture.code, ' // CODE_EDIT');
    await record({ kind: 'outer', lineNeedle: fixture.code });

    let rejectedReplacement = false;
    try {
      await editRenderedBlock(
        page,
        'mermaid',
        fixture.mermaidPreview,
        ' M_PREVIEW_EDIT',
        'preview',
        'first',
        firstDefaultMermaidClickOnly
          || firstDefaultMermaidPreDownReplacementOnly
          || firstDefaultMermaidPreDownDetachedOldEventsOnly,
        firstDefaultMermaidFinalPreviewSettlementOnly,
        firstDefaultMermaidFinalPreviewClickOnly,
        firstDefaultMermaidFinalPreviewReplacementOnly,
        firstDefaultMermaidFinalPreviewStableMovementOnly,
        firstDefaultMermaidPreDownReplacementOnly || firstDefaultMermaidPreDownDetachedOldEventsOnly,
        firstDefaultMermaidPreDownDetachedOldEventsOnly
      );
    } catch (error) {
      const expectedReplacementError = (
        'Mode button identity changed before pointerup: Mermaid block controls at line 130'
      );
      if (!firstDefaultMermaidFinalPreviewReplacementOnly || !String(error).includes(expectedReplacementError)) {
        throw error;
      }
      rejectedReplacement = true;
    }
    if (firstDefaultMermaidClickOnly) {
      console.log('suite-prefix first default Mermaid click checks passed');
      return;
    }
    if (firstDefaultMermaidFinalPreviewSettlementOnly) {
      console.log('suite-prefix first default Mermaid final preview settlement checks passed');
      return;
    }
    if (firstDefaultMermaidFinalPreviewClickOnly) {
      console.log('suite-prefix first default Mermaid final preview click checks passed');
      return;
    }
    if (firstDefaultMermaidFinalPreviewReplacementOnly) {
      if (!rejectedReplacement) throw new Error('Final preview mode button replacement was not rejected');
      await assertReplacementSafeReleaseAndRecovery(page);
      console.log('suite-prefix first default Mermaid final preview replacement checks passed');
      return;
    }
    if (firstDefaultMermaidFinalPreviewStableMovementOnly) {
      console.log('suite-prefix first default Mermaid final preview stable movement checks passed');
      return;
    }
    if (firstDefaultMermaidPreDownReplacementOnly || firstDefaultMermaidPreDownDetachedOldEventsOnly) {
      const evidence = await page.evaluate(() => {
        const output = document.querySelector<HTMLOutputElement>(
          'output[aria-label="History pointer pre-down replacement evidence"]'
        );
        return {
          details: output?.textContent ?? null,
          observer: output?.dataset.historyPointerObserver ?? null
        };
      });
      const details = evidence.details ? JSON.parse(evidence.details) : null;
      const observer = evidence.observer ? JSON.parse(evidence.observer) : null;
      const sameAccessibleControl = (
        details?.oldBefore?.label === details?.replacement?.label
        && details?.oldBefore?.group === details?.replacement?.group
        && details?.oldBefore?.line === details?.replacement?.line
        && JSON.stringify(details?.oldBefore?.rect) === JSON.stringify(details?.replacement?.rect)
      );
      if (
        !details
        || details.sameNode !== false
        || details.oldAfter?.connected !== false
        || details.replacement?.connected !== true
        || !sameAccessibleControl
        || JSON.stringify(observer?.direct) !== JSON.stringify({
          old: firstDefaultMermaidPreDownDetachedOldEventsOnly
            ? { pointerdown: 1, pointerup: 1, click: 1 }
            : { pointerdown: 0, pointerup: 0, click: 0 },
          replacement: { pointerdown: 1, pointerup: 1, click: 1 }
        })
        || observer?.cleaned !== true
        || observer?.registrations !== 0
        || observer?.sentinelVerified !== true
        || observer?.sentinelRejected !== true
        || observer?.registrationIdentity?.length !== 9
        || !observer?.events?.some((event: string) => event === 'document:pointerdown:current')
        || JSON.stringify(observer?.documentEvents) !== JSON.stringify([
          'pointerdown:replacement', 'pointerup:replacement', 'click:replacement'
        ])
      ) {
        throw new Error(`Pre-down replacement did not reacquire the current public control: ${JSON.stringify({
          details, observer
        })}`);
      }
      console.log('suite-prefix first default Mermaid pre-down replacement checks passed');
      return;
    }
    await record({ kind: 'mermaid', marker: 'M_PREVIEW_EDIT', mode: 'split', needle: fixture.mermaidPreview });
    await editRenderedBlock(page, 'mermaid', fixture.mermaidSplit, ' M_SPLIT_EDIT', 'split');
    await record({ kind: 'mermaid', marker: 'M_SPLIT_EDIT', mode: 'split', needle: fixture.mermaidSplit });
    await editRenderedBlock(page, 'mermaid', fixture.mermaidSource, ' M_SOURCE_EDIT', 'source');
    await record({ kind: 'mermaid', marker: 'M_SOURCE_EDIT', mode: 'source', needle: fixture.mermaidSource });

    const mathPreviewMarker = realFixtureText ? '555' : ' + MATH_PREVIEW_EDIT';
    await editRenderedBlock(
      page,
      'math',
      fixture.mathPreview,
      mathPreviewMarker,
      'preview',
      fixture.mathPreviewOccurrence
    );
    await record({ kind: 'math', marker: realFixtureText ? '555' : 'MATH_PREVIEW_EDIT', needle: fixture.mathPreview, occurrence: fixture.mathPreviewOccurrence });
    await editRenderedBlock(page, 'math', fixture.mathSplit, ' + MATH_SPLIT_EDIT', 'split');
    await record({ kind: 'math', marker: 'MATH_SPLIT_EDIT', needle: fixture.mathSplit });
    await editRenderedBlock(page, 'math', fixture.mathSource, ' + MATH_SOURCE_EDIT', 'source');
    await record({ kind: 'math', marker: 'MATH_SOURCE_EDIT', needle: fixture.mathSource });

    await editTableCell(page, fixture.table2Line, fixture.table2FirstBefore, fixture.table2FirstAfter);
    await record({ kind: 'table', undoValue: fixture.table2FirstBefore, redoValue: fixture.table2FirstAfter });
    await editTableCell(page, fixture.table2LineAfterFirst, fixture.table2SecondBefore, fixture.table2SecondAfter);
    await record({ kind: 'table', undoValue: fixture.table2SecondBefore, redoValue: fixture.table2SecondAfter });
    await editTableCell(page, fixture.table2LineAfterFirst, fixture.table2ThirdBefore, fixture.table2ThirdAfter);
    await record({ kind: 'table', undoValue: fixture.table2ThirdBefore, redoValue: fixture.table2ThirdAfter });
    await editOuterLine(page, fixture.outerBottom, ' PLAIN_BOTTOM_EDIT');
    await record({ kind: 'outer', lineNeedle: fixture.outerBottom });
    await editOuterLine(page, fixture.extraOuter1, ' EXTRA_ONE_EDIT');
    await record({ kind: 'outer', lineNeedle: fixture.extraOuter1 });
    await editOuterLine(page, fixture.extraOuter2, ' EXTRA_TWO_EDIT');
    await record({ kind: 'outer', lineNeedle: fixture.extraOuter2 });
    await editRenderedBlock(page, 'mermaid', fixture.extraMermaid1, ' M_EXTRA_ONE', 'source', 'last');
    await record({ kind: 'mermaid', marker: 'M_EXTRA_ONE', mode: 'source', needle: fixture.extraMermaid1, occurrence: 'last' });
    await editRenderedBlock(page, 'mermaid', fixture.extraMermaid2, ' M_EXTRA_TWO', 'split');
    await record({ kind: 'mermaid', marker: 'M_EXTRA_TWO', mode: 'split', needle: fixture.extraMermaid2 });
    await editRenderedBlock(page, 'math', fixture.extraMath1, ' MATH_EXTRA_ONE', 'source');
    await record({ kind: 'math', marker: 'MATH_EXTRA_ONE', needle: fixture.extraMath1 });
    await editRenderedBlock(page, 'math', fixture.extraMath2, ' MATH_EXTRA_TWO', 'split');
    await record({ kind: 'math', marker: 'MATH_EXTRA_TWO', needle: fixture.extraMath2 });

    for (let index = targets.length - 1; index >= 0; index -= 1) {
      await runSettledHistoryCommand(page, 'undo');
      await waitForDocumentText(page, versions[index]);
      await assertHistoryTarget(page, targets[index], 'undo', targets.length - index);
    }

    for (let index = 0; index < targets.length; index += 1) {
      await runSettledHistoryCommand(page, 'redo');
      await waitForDocumentText(page, versions[index + 1]);
      await assertHistoryTarget(page, targets[index], 'redo', index + 1);
    }

    const heldUndoCountToFirstTable = targets.length - 2;
    await page.keyboard.down('Control');
    try {
      for (let count = 1; count <= heldUndoCountToFirstTable; count += 1) {
        await page.keyboard.down('z');
        const expected = versions[targets.length - count];
        await waitForDocumentText(page, expected);
      }
      await page.keyboard.up('z');
    } finally {
      await page.keyboard.up('Control');
    }
    await assertHistoryTarget(page, targets[2], 'undo', heldUndoCountToFirstTable);

    await page.keyboard.down('Control');
    try {
      for (let count = 1; count <= heldUndoCountToFirstTable; count += 1) {
        await page.keyboard.down('y');
        const expected = versions[2 + count];
        await waitForDocumentText(page, expected);
      }
      await page.keyboard.up('y');
    } finally {
      await page.keyboard.up('Control');
    }
    await waitForDocumentText(page, versions[targets.length]);

    await page.keyboard.down('Control');
    try {
      for (let count = 1; count <= targets.length; count += 1) {
        await page.keyboard.press('z');
      }
    } finally {
      await page.keyboard.up('Control');
    }
    await waitForDocumentText(page, versions[0]);
    await scrollToLineContaining(page, fixture.typingNeedle);
    const typingStart = await page.evaluate((typingNeedle) => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes(typingNeedle));
      const content = line?.closest<HTMLElement>('.cm-content');
      const scroller = content?.closest<HTMLElement>('.cm-scroller');
      if (!line || !content || !scroller) throw new Error('Missing visible post-history typing line');
      const range = document.createRange();
      range.selectNodeContents(line);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      content.focus();
      return { scrollTop: scroller.scrollTop, lineTop: line.getBoundingClientRect().top };
    }, fixture.typingNeedle);
    await page.keyboard.type(' TYPE_AFTER_HELD_HISTORY');
    await page.waitForFunction(() => (
      (window as any).__historyMatrixEditor.getText().includes('TYPE_AFTER_HELD_HISTORY')
    ));
    const typingEnd = await page.evaluate((typingNeedle) => {
      const editor = (window as any).__historyMatrixEditor;
      const content = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller .cm-content');
      const scroller = content?.closest<HTMLElement>('.cm-scroller');
      const selection = window.getSelection();
      const focusNode = selection?.focusNode ?? null;
      const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement ?? null;
      const line = focusElement?.closest<HTMLElement>('.cm-line');
      return {
        scrollTop: scroller?.scrollTop ?? null,
        focused: Boolean(content?.contains(document.activeElement)),
        lineTop: line?.getBoundingClientRect().top ?? null,
        line: line?.textContent ?? null,
        textContainsMarker: editor.getText().includes('TYPE_AFTER_HELD_HISTORY'),
        lineContainsNeedle: line?.textContent?.includes(typingNeedle) ?? false,
        activeTag: document.activeElement?.tagName ?? null
      };
    }, fixture.typingNeedle);
    if (
      !typingEnd.focused ||
      !typingEnd.textContainsMarker ||
      !typingEnd.lineContainsNeedle ||
      !typingEnd.line?.includes('TYPE_AFTER_HELD_HISTORY') ||
      typingEnd.scrollTop === null ||
      typingEnd.lineTop === null ||
      Math.abs(typingEnd.scrollTop - typingStart.scrollTop) > 2 ||
      Math.abs(typingEnd.lineTop - typingStart.lineTop) > 2
    ) {
      throw new Error(`Typing after held-Control history lost focus or scrolled: ${JSON.stringify({ typingStart, typingEnd })}`);
    }

    const semanticLines = await page.evaluate(() => {
      const editor = (window as any).__historyMatrixEditor;
      const lines = editor.getText().split('\n');
      const mermaidLine = lines.findIndex((line: string) => line.startsWith('```mermaid')) + 1;
      const formulaLine = lines.findIndex((line: string) => line.trim() === '$$') + 1;
      editor.revealSelection(0, 1, { focusEditor: true, align: 'upper' });
      return { mermaidLine, formulaLine };
    });
    await page.keyboard.press('Enter');
    const shiftedSemanticLines = await page.evaluate(() => {
      const editor = (window as any).__historyMatrixEditor;
      const lines = editor.getText().split('\n');
      return {
        mermaidLine: lines.findIndex((line: string) => line.startsWith('```mermaid')) + 1,
        formulaLine: lines.findIndex((line: string) => line.trim() === '$$') + 1
      };
    });
    if (shiftedSemanticLines.mermaidLine !== semanticLines.mermaidLine + 1
      || shiftedSemanticLines.formulaLine !== semanticLines.formulaLine + 1) {
      throw new Error(`Equal-length leading-line edit did not shift rendered blocks: ${JSON.stringify({
        before: semanticLines,
        after: shiftedSemanticLines
      })}`);
    }
    // Drive the current public controls after their document line identity changes.
    await setMermaidLayout(page, '__historyMatrixEditor', shiftedSemanticLines.mermaidLine, 'side-by-side');
    await enterDisplayMathSource(page, '__historyMatrixEditor', shiftedSemanticLines.formulaLine);
    await page.evaluate(async () => {
      const applied = await (window as any).__historyMatrixEditor.undo();
      if (!applied) throw new Error('Equal-length line shift undo was not applied');
    });
    await setMermaidLayout(page, '__historyMatrixEditor', semanticLines.mermaidLine, 'side-by-side');
    await enterDisplayMathSource(page, '__historyMatrixEditor', semanticLines.formulaLine);
    const relocatedMath = await readDisplayMathHistoryTarget(page, '__historyMatrixEditor', semanticLines.formulaLine);
    if (!relocatedMath.focused || !relocatedMath.visible) throw new Error('Relocated formula lost its main document target');

    console.log(`history matrix checks passed (${targets.length} undo + ${targets.length} redo steps + held-Control mixed stress)`);
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
