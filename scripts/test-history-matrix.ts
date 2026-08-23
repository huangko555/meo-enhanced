import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import {
  beginHistoryScrollSettlement,
  disposeHistoryScrollSettlement
} from './history-scroll-settlement';

type BlockMode = 'preview' | 'split' | 'source';
type NeedleOccurrence = 'first' | 'last';
type HistoryTarget =
  | { kind: 'outer'; lineNeedle: string }
  | { kind: 'table'; undoValue: string; redoValue: string }
  | { kind: 'mermaid' | 'math'; marker: string; mode: Exclude<BlockMode, 'preview'> };

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-history-matrix-'));

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
  const tableFrom = await page.evaluate((sourceLine) => {
    const editor = (window as any).__historyMatrixEditor;
    const documentLines = editor.view.state.doc.toString().split('\n');
    const sourceLineIndex = documentLines.findIndex((line: string) => line.includes(sourceLine));
    if (sourceLineIndex < 0) throw new Error(`Missing table source line: ${sourceLine}`);
    let tableStartLineIndex = sourceLineIndex;
    while (tableStartLineIndex > 0 && documentLines[tableStartLineIndex - 1].trim().startsWith('|')) {
      tableStartLineIndex -= 1;
    }
    return editor.view.state.doc.line(tableStartLineIndex + 1).from;
  }, tableLine);
  await page.waitForFunction(({ currentValue, currentTableFrom }) => (
    Array.from(document.querySelectorAll<HTMLTextAreaElement>(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) textarea'
    )).some((candidate) => (
      candidate.value === currentValue
        && Number(candidate.closest<HTMLTableElement>('table')?.dataset.tableFrom) === currentTableFrom
    ))
  ), {}, { currentValue: before, currentTableFrom: tableFrom });
  const settlement = await page.evaluate(({ currentValue, nextValue, currentTableFrom }) => {
    const editor = (window as any).__historyMatrixEditor;
    const input = Array.from(document.querySelectorAll<HTMLTextAreaElement>(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) textarea'
    )).find((candidate) => (
      candidate.value === currentValue
        && Number(candidate.closest<HTMLTableElement>('table')?.dataset.tableFrom) === currentTableFrom
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
  }, { currentValue: before, nextValue: after, currentTableFrom: tableFrom });
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
  stopAfterFinalPreviewStableMovement = false
) {
  const modeButton = kind === 'mermaid' ? '.meo-mermaid-mode-btn' : '.meo-latex-math-mode-btn';
  const blockSelector = kind === 'mermaid' ? '.meo-mermaid-editing-block' : '.meo-latex-math-editing-block';
  let targetLineNumber = 0;
  const editorRegionLabel = () => kind === 'mermaid'
    ? `Mermaid editor at line ${targetLineNumber}`
    : `Formula editor at line ${targetLineNumber}`;
  let modeClickSequence = 0;
  const settleTargetModeControl = async () => {
    targetLineNumber = await scrollToLineContaining(page, lineNeedle, occurrence, null, kind);
    const scrollSettlementKey = '__historyMatrixRenderedBlockScroll';
    const scrollSettlement = await page.evaluate(beginHistoryScrollSettlement, {
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
        ), {}, scrollSettlementKey);
      }
    } finally {
      await page.evaluate(disposeHistoryScrollSettlement, scrollSettlementKey);
    }
    await page.waitForFunction(({ blockKind, lineNumber }) => {
      const viewport = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller')?.getBoundingClientRect();
      const controlsLabel = blockKind === 'mermaid'
        ? `Mermaid block controls at line ${lineNumber}`
        : `Formula block controls at line ${lineNumber}`;
      const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${controlsLabel}"]`)
        ?.getBoundingClientRect();
      return Boolean(viewport && group && group.top >= viewport.top && group.bottom <= viewport.bottom);
    }, {}, { blockKind: kind, lineNumber: targetLineNumber });
  };
  const clickTargetModeButton = async () => {
    modeClickSequence += 1;
    await settleTargetModeControl();
    const transition = await page.evaluate(({ blockKind, needle, lineNumber }) => {
      const labels = blockKind === 'mermaid'
        ? {
            controls: `Mermaid block controls at line ${lineNumber}`,
            preview: 'Edit Mermaid in split view',
            split: 'Show Mermaid code only',
            source: 'Show Mermaid preview'
          }
        : {
            controls: `Formula block controls at line ${lineNumber}`,
            preview: 'Edit formula in split view',
            split: 'Show formula source only',
            source: 'Show formula preview'
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
      const expectedLabel = currentLabel === labels.preview
        ? labels.split
        : currentLabel === labels.split ? labels.source : labels.preview;
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
      && modeClickSequence === 3
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
    const modeButtonHandle = await page.evaluateHandle(({ controlsLabel, currentLabel }) => {
      const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${controlsLabel}"]`);
      return Array.from(group?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])
        .find((candidate) => candidate.getAttribute('aria-label') === currentLabel) ?? null;
    }, transition);
    const stableModeButton = modeButtonHandle.asElement();
    if (!stableModeButton) {
      await modeButtonHandle.dispose();
      throw new Error(`Missing stable mode button before pointer delivery: ${transition.controlsLabel}`);
    }
    const stableModeButtonHitPoint = (phase: 'pointerdown' | 'pointerup') => stableModeButton.evaluate(
      (button, contract) => {
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
          throw new Error(
            `Mode button identity changed before ${contract.phase}: ${contract.controlsLabel}`
          );
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
    let pointerDown = false;
    try {
      const downPoint = await stableModeButtonHitPoint('pointerdown');
      await page.mouse.move(downPoint.x, downPoint.y);
      await page.mouse.down();
      pointerDown = true;
      if (expectFinalPreviewReplacementFailure && modeClickSequence === 3) {
        await stableModeButton.evaluate((button, expectedLabel) => {
          const replacement = button.cloneNode(true) as HTMLButtonElement;
          replacement.addEventListener('pointerup', () => {
            replacement.setAttribute('aria-label', expectedLabel);
          }, { once: true });
          button.replaceWith(replacement);
        }, transition.expectedLabel);
      } else if (stopAfterFinalPreviewStableMovement && modeClickSequence === 3) {
        await stableModeButton.evaluate((button) => {
          const movement = button.animate(
            [{ transform: 'translateY(0)' }, { transform: 'translateY(50%)' }],
            { duration: 1, fill: 'both' }
          );
          movement.pause();
          movement.currentTime = 1;
        });
        await page.waitForFunction((button, previousRect) => {
          if (!(button instanceof HTMLElement) || !button.isConnected) return false;
          const rect = button.getBoundingClientRect();
          return rect.top !== previousRect.top || rect.bottom !== previousRect.bottom;
        }, {}, stableModeButton, downPoint.rect).catch((error: unknown) => {
          throw new Error('Stable mode button did not move between pointerdown and pointerup', { cause: error });
        });
      }
      const upPoint = await stableModeButtonHitPoint('pointerup');
      await page.mouse.move(upPoint.x, upPoint.y);
      await page.mouse.up();
      pointerDown = false;
    } finally {
      try {
        if (pointerDown) await page.mouse.up();
      } finally {
        try {
          if (stopAfterFinalPreviewStableMovement && modeClickSequence === 3) {
            await stableModeButton.evaluate((button) => {
              button.getAnimations().forEach((animation) => animation.cancel());
            });
          }
        } finally {
          await modeButtonHandle.dispose();
        }
      }
    }
    if (stopAfterFinalPreviewStableMovement && modeClickSequence === 3) return;
    await page.waitForFunction(({ controlsLabel, expectedLabel }) => Array.from(
      document.querySelector<HTMLElement>(`[role="group"][aria-label="${controlsLabel}"]`)
        ?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? []
    ).some((candidate) => candidate.getAttribute('aria-label') === expectedLabel), {}, transition).catch((error: unknown) => {
      throw new Error(`Mode button label did not settle: ${transition.controlsLabel}`, { cause: error });
    });
  };
  targetLineNumber = await scrollToLineContaining(page, lineNeedle, occurrence, null, kind);
  await clickTargetModeButton();
  if (finalMode === 'source') {
    await clickTargetModeButton();
  }
  if (stopAfterModeSettlement) return;
  await page.waitForFunction(({ selector, regionLabel }) => {
    const viewport = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller')?.getBoundingClientRect();
    const block = document.querySelector<HTMLElement>(`${selector}[role="region"][aria-label="${regionLabel}"]`);
    const rect = block?.getBoundingClientRect();
    return Boolean(viewport && rect && rect.bottom > viewport.top && rect.top < viewport.bottom);
  }, {}, { selector: blockSelector, regionLabel: editorRegionLabel() }).catch(async (error: unknown) => {
    const state = await page.evaluate(({ buttonSelector, blockSelector }) => ({
      viewport: document.querySelector<HTMLElement>('.cm-editor > .cm-scroller')?.getBoundingClientRect().toJSON(),
      buttons: Array.from(document.querySelectorAll<HTMLButtonElement>(buttonSelector)).map((button) => ({
        label: button.getAttribute('aria-label'),
        groupLabel: button.closest('[role="group"]')?.getAttribute('aria-label'),
        rect: button.getBoundingClientRect().toJSON(),
        lineText: button.closest('.cm-line')?.textContent
      })),
      blocks: Array.from(document.querySelectorAll<HTMLElement>(blockSelector)).map((block) => ({
        label: block.getAttribute('aria-label'),
        rect: block.getBoundingClientRect().toJSON(),
        text: block.textContent
      }))
    }), { buttonSelector: modeButton, blockSelector });
    throw new Error(`Rendered block did not enter editing mode: ${JSON.stringify({ kind, lineNeedle, state })}`, { cause: error });
  });
  await page.evaluate(({ blockKind, needle, selector, regionLabel }) => {
    const block = document.querySelector<HTMLElement>(`${selector}[role="region"][aria-label="${regionLabel}"]`);
    if (!block) throw new Error(`Missing ${blockKind} editing block for ${needle}`);
    const content = block.querySelector<HTMLElement>('.cm-content');
    if (!content) throw new Error(`Missing ${blockKind} source editor for ${needle}`);
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    content.focus();
  }, {
    blockKind: kind,
    needle: lineNeedle,
    selector: blockSelector,
    regionLabel: editorRegionLabel()
  });
  await page.keyboard.type(marker);
  await page.waitForFunction(({ selector, expected }) => {
    const active = document.activeElement;
    const block = active instanceof HTMLElement ? active.closest<HTMLElement>(selector) : null;
    return Boolean(block && (window as any).__historyMatrixEditor.getText().includes(expected));
  }, {}, { selector: blockSelector, expected: marker });
  if (finalMode === 'preview') {
    await clickTargetModeButton();
    if (stopBeforeFinalPreviewPointer) {
      await settleTargetModeControl();
      await page.evaluate(({ blockKind, lineNumber }) => {
        const controlsLabel = blockKind === 'mermaid'
          ? `Mermaid block controls at line ${lineNumber}`
          : `Formula block controls at line ${lineNumber}`;
        const expectedLabel = blockKind === 'mermaid' ? 'Show Mermaid preview' : 'Show formula preview';
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
  const desiredMode = finalMode === 'preview' ? 'split' : finalMode;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actualMode = await page.evaluate(({ blockKind, lineNumber }) => {
      const labels = blockKind === 'mermaid'
        ? {
            controls: `Mermaid block controls at line ${lineNumber}`,
            preview: 'Edit Mermaid in split view',
            split: 'Show Mermaid code only',
            source: 'Show Mermaid preview'
          }
        : {
            controls: `Formula block controls at line ${lineNumber}`,
            preview: 'Edit formula in split view',
            split: 'Show formula source only',
            source: 'Show formula preview'
          };
      const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${labels.controls}"]`);
      const currentLabel = Array.from(group?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])
        .map((candidate) => candidate.getAttribute('aria-label'))
        .find((label) => label === labels.preview || label === labels.split || label === labels.source);
      if (currentLabel === labels.preview) return 'preview';
      if (currentLabel === labels.split) return 'split';
      if (currentLabel === labels.source) return 'source';
      return null;
    }, { blockKind: kind, lineNumber: targetLineNumber });
    if (actualMode === desiredMode) break;
    await clickTargetModeButton();
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
  const hitPoint = await page.evaluate((label) => {
    const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${label}"]`);
    const button = Array.from(group?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])
      .find((candidate) => candidate.getAttribute('aria-label') === 'Edit Mermaid in split view');
    if (!button) throw new Error(`Missing preview mode control: ${label}`);
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, controlsLabel);
  await page.mouse.click(hitPoint.x, hitPoint.y);
  await page.waitForFunction((controlsLabel) => Array.from(
    document.querySelector<HTMLElement>(`[role="group"][aria-label="${controlsLabel}"]`)
      ?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? []
  ).some((candidate) => candidate.getAttribute('aria-label') === 'Show Mermaid code only'), {}, controlsLabel);

  const regionLabel = `Mermaid editor at line ${targetLineNumber}`;
  await page.waitForFunction((label) => {
    const scroller = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller')?.getBoundingClientRect();
    const region = document.querySelector<HTMLElement>(`[role="region"][aria-label="${label}"]`)
      ?.getBoundingClientRect();
    return Boolean(scroller && region && region.bottom > scroller.top && region.top < scroller.bottom);
  }, { timeout: 5000 }, regionLabel).catch(async (error: unknown) => {
    const state = await page.evaluate(({ controlsLabel, editorLabel }) => {
      const scrollerElement = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller');
      const scroller = scrollerElement?.getBoundingClientRect();
      const toolbar = document.querySelector<HTMLElement>(`[role="group"][aria-label="${controlsLabel}"]`);
      const region = document.querySelector<HTMLElement>(`[role="region"][aria-label="${editorLabel}"]`);
      const active = document.activeElement as HTMLElement | null;
      const visibleLines = Array.from(document.querySelectorAll<HTMLElement>('.cm-line')).filter((line) => {
        const rect = line.getBoundingClientRect();
        return Boolean(scroller && rect.bottom > scroller.top && rect.top < scroller.bottom);
      });
      return {
        scroller: scroller?.toJSON() ?? null,
        toolbar: toolbar?.getBoundingClientRect().toJSON() ?? null,
        region: region?.getBoundingClientRect().toJSON() ?? null,
        active: active ? {
          tag: active.tagName,
          role: active.getAttribute('role'),
          label: active.getAttribute('aria-label'),
          className: active.className
        } : null,
        regionFocused: Boolean(region?.contains(active)),
        viewportAnchor: visibleLines[0]?.textContent ?? null
      };
    }, { controlsLabel, editorLabel: regionLabel });
    throw new Error(`First Mermaid editing region is not visible: ${JSON.stringify(state)}`, { cause: error });
  });

  const repeatedLineNumber = await scrollToLineContaining(page, lineNeedle, 'last', null, 'mermaid');
  if (repeatedLineNumber === targetLineNumber) {
    throw new Error('Expected a distinct repeated Mermaid block');
  }
  await page.waitForFunction((lineNumber) => Array.from(
    document.querySelector<HTMLElement>(
      `[role="group"][aria-label="Mermaid block controls at line ${lineNumber}"]`
    )?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? []
  ).some((candidate) => candidate.getAttribute('aria-label') === 'Edit Mermaid in split view'), {}, repeatedLineNumber);
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

  const markerExpected = direction === 'redo';
  await page.waitForFunction(({ kind, marker, mode, expected }) => {
    const kindLabel = kind === 'mermaid' ? 'Mermaid' : 'Formula';
    const active = document.activeElement;
    const block = active instanceof HTMLElement
      ? active.closest<HTMLElement>(`[role="region"][aria-label^="${kindLabel} editor at line "]`)
      : null;
    if (!block) return false;
    const lineNumber = block.getAttribute('aria-label')?.match(/ at line (\d+)$/)?.[1] ?? null;
    const labels = kind === 'mermaid'
      ? {
          preview: 'Edit Mermaid in split view',
          split: 'Show Mermaid code only',
          source: 'Show Mermaid preview'
        }
      : {
          preview: 'Edit formula in split view',
          split: 'Show formula source only',
          source: 'Show formula preview'
        };
    const buttonLabel = lineNumber
      ? Array.from(document.querySelector<HTMLElement>(
          `[role="group"][aria-label="${kindLabel} block controls at line ${lineNumber}"]`
        )?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])
          .map((button) => button.getAttribute('aria-label'))
          .find((label) => label === labels.preview || label === labels.split || label === labels.source) ?? null
      : null;
    const rect = block.getBoundingClientRect();
    const actualMode = buttonLabel === labels.source
      ? 'source'
      : buttonLabel === labels.split ? 'split' : buttonLabel === labels.preview ? 'preview' : null;
    return actualMode === mode
      && (window as any).__historyMatrixEditor.getText().includes(marker) === expected
      && rect.bottom > 0
      && rect.top < window.innerHeight;
  }, {}, {
    kind: target.kind,
    marker: target.marker,
    mode: target.mode,
    expected: markerExpected
  }).catch(async (error: unknown) => {
    const state = await page.evaluate(({ kind, marker }) => {
      const kindLabel = kind === 'mermaid' ? 'Mermaid' : 'Formula';
      return Array.from(document.querySelectorAll<HTMLElement>(
        `[role="region"][aria-label^="${kindLabel} editor at line "]`
      )).map((block) => ({
        active: block.contains(document.activeElement),
        label: block.getAttribute('aria-label'),
        documentContainsMarker: (window as any).__historyMatrixEditor.getText().includes(marker),
        rect: block.getBoundingClientRect().toJSON()
      }));
    }, { kind: target.kind, marker: target.marker });
    throw new Error(`${direction} step ${step} missed rendered-block target: ${JSON.stringify({ target, state })}`, { cause: error });
  });
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
  const realFixtureText = realFixturePath ? fs.readFileSync(realFixturePath, 'utf8') : null;
  if (firstMermaidClickOnly && realFixtureText) {
    throw new Error('The focused first-Mermaid click path requires the synthetic History fixture');
  }
  const fixture = realFixtureText
    ? {
        outerTop: 'represents the pro',
        table1Line: '| 三种写法 | 12312 |',
        table1FirstBefore: '三种写法',
        table1FirstAfter: '三种写法_REAL',
        table1LineAfterFirst: '| 三种写法_REAL | 12312 |',
        table1SecondBefore: '12312',
        table1SecondAfter: '12312_REAL',
        code: "CODE_BLOCK_SEARCH_NEEDLE = 'visible diff search target'",
        mermaidPreview: 'Start --> Check --> Done',
        mermaidSplit: 'MERMAID_SPLIT_SEARCH_TARGET',
        mermaidSource: 'A[Open Markdown File] --> B{Choose Editor}',
        mathPreview: '\\int \\!\\!\\! \\int \\!\\!\\! \\int_V',
        mathPreviewOccurrence: 'last' as NeedleOccurrence,
        mathSplit: '\\sum_{i=1}^{n}',
        mathSource: 'E = mc^2',
        table2Line: '| Bold        |    OK    | left text |',
        table2FirstBefore: 'Bold',
        table2FirstAfter: 'Bold_REAL',
        table2LineAfterFirst: '| Bold_REAL',
        table2SecondBefore: 'OK',
        table2SecondAfter: 'OK_REAL',
        table2ThirdBefore: 'left text',
        table2ThirdAfter: 'left text_REAL',
        extraOuter1: 'represents the probability',
        extraOuter2: '# Markdown Render Test123123',
        extraMermaid1: 'Start --> Check --> Done',
        extraMermaid2: 'A[Start]',
        extraMath1: '\\int \\!\\!\\! \\int_V',
        extraMath2: '\\int_{-\\infty}^{\\infty}',
        outerBottom: '123123123123123123123123123123123123123123',
        typingNeedle: 'represents the pro'
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
      && document.querySelector('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')
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
    await page.evaluate((before) => {
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
      const input = table?.querySelector<HTMLTextAreaElement>('tbody textarea');
      if (!input) throw new Error('Missing first-table pending edit target');
      if (input.value !== before) throw new Error(`Unexpected first-table value: ${input.value}`);
      input.focus();
      input.value = `${before}_PENDING`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, fixture.table1FirstBefore);
    const commandConsumed = await page.evaluate(() => {
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
      const command = table?.closest<HTMLElement>('.meo-md-html-table-shell')
        ?.querySelector<HTMLButtonElement>('button[title="Insert row below"]');
      if (!command) throw new Error('Missing Insert row below control');
      return !command.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0,
        bubbles: true,
        cancelable: true
      }));
    });
    if (!commandConsumed) throw new Error('Insert row below command was not consumed');
    await page.waitForFunction(() => document.querySelectorAll<HTMLElement>(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table)'
    )[0]?.querySelectorAll('tbody tr').length === 2);
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
      afterPendingInsert.rowCount !== 2
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
    await waitForPendingStructureState({ text: pendingTableBaseline, rowCount: 1, focused: true });
    await page.evaluate(async () => {
      const applied = await (window as any).__historyMatrixEditor.redo();
      if (!applied) throw new Error('Pending table structure redo was not applied');
    });
    await waitForPendingStructureState({ text: afterPendingInsert.text, rowCount: 2, focused: true });
    await page.evaluate((text) => (window as any).__historyMatrixEditor.setText(text), pendingTableBaseline);
    await waitForPendingStructureState({ text: pendingTableBaseline, rowCount: 1, focused: false });

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
        firstDefaultMermaidClickOnly,
        firstDefaultMermaidFinalPreviewSettlementOnly,
        firstDefaultMermaidFinalPreviewClickOnly,
        firstDefaultMermaidFinalPreviewReplacementOnly,
        firstDefaultMermaidFinalPreviewStableMovementOnly
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
      console.log('suite-prefix first default Mermaid final preview replacement checks passed');
      return;
    }
    if (firstDefaultMermaidFinalPreviewStableMovementOnly) {
      console.log('suite-prefix first default Mermaid final preview stable movement checks passed');
      return;
    }
    await record({ kind: 'mermaid', marker: 'M_PREVIEW_EDIT', mode: 'split' });
    await editRenderedBlock(page, 'mermaid', fixture.mermaidSplit, ' M_SPLIT_EDIT', 'split');
    await record({ kind: 'mermaid', marker: 'M_SPLIT_EDIT', mode: 'split' });
    await editRenderedBlock(page, 'mermaid', fixture.mermaidSource, ' M_SOURCE_EDIT', 'source');
    await record({ kind: 'mermaid', marker: 'M_SOURCE_EDIT', mode: 'source' });

    const mathPreviewMarker = realFixtureText ? '555' : ' + MATH_PREVIEW_EDIT';
    await editRenderedBlock(
      page,
      'math',
      fixture.mathPreview,
      mathPreviewMarker,
      'preview',
      fixture.mathPreviewOccurrence
    );
    await record({ kind: 'math', marker: realFixtureText ? '555' : 'MATH_PREVIEW_EDIT', mode: 'split' });
    await editRenderedBlock(page, 'math', fixture.mathSplit, ' + MATH_SPLIT_EDIT', 'split');
    await record({ kind: 'math', marker: 'MATH_SPLIT_EDIT', mode: 'split' });
    await editRenderedBlock(page, 'math', fixture.mathSource, ' + MATH_SOURCE_EDIT', 'source');
    await record({ kind: 'math', marker: 'MATH_SOURCE_EDIT', mode: 'source' });

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
    await record({ kind: 'mermaid', marker: 'M_EXTRA_ONE', mode: 'source' });
    await editRenderedBlock(page, 'mermaid', fixture.extraMermaid2, ' M_EXTRA_TWO', 'split');
    await record({ kind: 'mermaid', marker: 'M_EXTRA_TWO', mode: 'split' });
    await editRenderedBlock(page, 'math', fixture.extraMath1, ' MATH_EXTRA_ONE', 'source');
    await record({ kind: 'math', marker: 'MATH_EXTRA_ONE', mode: 'source' });
    await editRenderedBlock(page, 'math', fixture.extraMath2, ' MATH_EXTRA_TWO', 'split');
    await record({ kind: 'math', marker: 'MATH_EXTRA_TWO', mode: 'split' });

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
    const revealAndOpenSemanticBlock = async (kind: 'Mermaid' | 'Formula', lineNumber: number) => {
      await page.evaluate((line) => (window as any).__historyMatrixEditor.scrollToLine(line, 'center'), lineNumber);
      const groupLabel = `${kind} block controls at line ${lineNumber}`;
      const regionLabel = `${kind} editor at line ${lineNumber}`;
      await page.waitForFunction((label) => Boolean(
        document.querySelector(`[role="group"][aria-label="${label}"]`)
      ), {}, groupLabel);
      await page.evaluate(({ groupLabel, regionLabel }) => {
        if (document.querySelector(`[role="region"][aria-label="${regionLabel}"]`)) return;
        const button = document.querySelector<HTMLElement>(`[role="group"][aria-label="${groupLabel}"]`)
          ?.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn, .meo-latex-math-mode-btn');
        if (!button) throw new Error(`Missing semantic mode control: ${groupLabel}`);
        button.click();
      }, { groupLabel, regionLabel });
      await page.waitForFunction((label) => Boolean(
        document.querySelector(`[role="region"][aria-label="${label}"]`)
      ), {}, regionLabel);
    };
    await revealAndOpenSemanticBlock('Mermaid', semanticLines.mermaidLine + 1);
    await revealAndOpenSemanticBlock('Formula', semanticLines.formulaLine + 1);
    await page.evaluate(async () => {
      const applied = await (window as any).__historyMatrixEditor.undo();
      if (!applied) throw new Error('Equal-length line shift undo was not applied');
    });
    for (const [kind, lineNumber] of [
      ['Mermaid', semanticLines.mermaidLine],
      ['Formula', semanticLines.formulaLine]
    ] as const) {
      await page.evaluate((line) => (window as any).__historyMatrixEditor.scrollToLine(line, 'center'), lineNumber);
      await page.waitForFunction(({ groupLabel, regionLabel }) => Boolean(
        document.querySelector(`[role="group"][aria-label="${groupLabel}"]`)
        && document.querySelector(`[role="region"][aria-label="${regionLabel}"]`)
      ), {}, {
        groupLabel: `${kind} block controls at line ${lineNumber}`,
        regionLabel: `${kind} editor at line ${lineNumber}`
      });
    }

    console.log(`history matrix checks passed (${targets.length} undo + ${targets.length} redo steps + held-Control mixed stress)`);
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
