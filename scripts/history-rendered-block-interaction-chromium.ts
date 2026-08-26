import {
  HistoryRenderedBlockInteractionError,
  runHistoryRenderedBlockInteraction,
  type HistoryRenderedBlockInteractionAdapter,
  type HistoryRenderedBlockInteractionResult,
  type HistoryRenderedBlockKind,
  type HistoryRenderedBlockObserver,
  type HistoryRenderedBlockObserverEvidence,
  type HistoryRenderedBlockTargetMode
} from './history-rendered-block-interaction';

type ModeLabels = Record<HistoryRenderedBlockTargetMode, string> & { readonly controls: string };

type ChromiumHistoryObserver = HistoryRenderedBlockObserver & {
  configureTarget(currentLabel: string, expectedLabel: string): Promise<void>;
  settleAndValidatePointer(
    point: { readonly x: number; readonly y: number },
    phase: 'pointerdown' | 'pointerup',
    currentLabel: string
  ): Promise<void>;
  snapshotCurrent(): Promise<HistoryRenderedBlockObserverEvidence>;
};

function labelsFor(kind: HistoryRenderedBlockKind, lineNumber: number): ModeLabels {
  return kind === 'mermaid'
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
}

function nextMode(mode: HistoryRenderedBlockTargetMode): HistoryRenderedBlockTargetMode {
  return mode === 'preview' ? 'split' : mode === 'split' ? 'source' : 'preview';
}

async function currentMode(page: any, labels: ModeLabels): Promise<HistoryRenderedBlockTargetMode | null> {
  return page.evaluate((known) => {
    const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${known.controls}"]`);
    const label = Array.from(group?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])
      .map((button) => button.getAttribute('aria-label'))
      .find((candidate) => candidate === known.preview || candidate === known.split || candidate === known.source);
    return label === known.preview ? 'preview' : label === known.split ? 'split' : label === known.source ? 'source' : null;
  }, labels);
}

async function openHistoryObserver(
  page: any,
  requested: { readonly kind: HistoryRenderedBlockKind; readonly lineNumber: number },
  labels: ModeLabels
): Promise<ChromiumHistoryObserver> {
  let handle: any = null;
  const pageErrors: string[] = [];
  const pageErrorListener = (error: unknown) => { pageErrors.push(String(error)); };
  page.on('pageerror', pageErrorListener);
  try {
    handle = await page.evaluateHandle((known) => {
      const events: string[] = [];
      const groupMutations: Array<Record<string, unknown>> = [];
      let registrations = 0;
      let cleaned = false;
      let targetGroup: HTMLElement | null = null;
      let currentLabel: string | null = null;
      let expectedLabel: string | null = null;
      const scroller = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller');
      if (!scroller) throw new Error('Missing editor scroller while opening History evidence observer');
      const pointerSettlements: Array<{
        readonly known: { readonly controls: string; readonly currentLabel: string; readonly point: { readonly x: number; readonly y: number }; readonly phase: string };
        readonly resolve: () => void;
        readonly reject: (error: unknown) => void;
      }> = [];
      const rectOf = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left
        };
      };
      const describeElement = (element: Element) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        ariaLabel: element.getAttribute('aria-label'),
        className: (element as HTMLElement).className?.toString() ?? '',
        text: (element.textContent ?? '').trim().slice(0, 240),
        connected: element.isConnected,
        rect: rectOf(element)
      });
      const describeHitStack = (point: { readonly x: number; readonly y: number }) => (
        document.elementsFromPoint(point.x, point.y).slice(0, 10).map((element) => ({
          ...describeElement(element),
          position: getComputedStyle(element).position,
          zIndex: getComputedStyle(element).zIndex,
          pointerEvents: getComputedStyle(element).pointerEvents,
          opacity: getComputedStyle(element).opacity,
          transform: getComputedStyle(element).transform,
          actualGroup: element.closest<HTMLElement>('[role="group"]')?.getAttribute('aria-label') ?? null
        }))
      );
      const groupsIn = (node: Node) => {
        if (!(node instanceof Element)) return [];
        return [
          ...(node.matches('[role="group"]') ? [node] : []),
          ...node.querySelectorAll('[role="group"]')
        ].map((group) => group.getAttribute('aria-label'))
          .filter((label): label is string => Boolean(label));
      };
      const readMaterialization = () => {
        const viewport = scroller.getBoundingClientRect();
        const groups = Array.from(document.querySelectorAll<HTMLElement>('[role="group"]')).map((group) => {
          const description = describeElement(group);
          const rect = group.getBoundingClientRect();
          return {
            ...description,
            visible: rect.bottom >= viewport.top && rect.top <= viewport.bottom
              && rect.right >= viewport.left && rect.left <= viewport.right
          };
        });
        const sources = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .map((line, domIndex) => ({ line, domIndex, text: line.textContent ?? '' }))
          .filter(({ text }) => known.kind === 'mermaid'
            ? text.trimStart().startsWith('```mermaid')
            : text.trim() === '$$')
          .map(({ line, domIndex, text }) => ({
            domIndex,
            text,
            connected: line.isConnected,
            rect: rectOf(line),
            blocks: Array.from(line.querySelectorAll<HTMLElement>('[role="group"], [role="region"], .meo-rendered-block-mode-shell'))
              .map(describeElement)
          }));
        const activeElement = document.activeElement instanceof Element
          ? describeElement(document.activeElement)
          : null;
        return {
          requested: { targetLine: known.lineNumber, controlsLabel: known.controls },
          groups,
          sources,
          scroller: { connected: scroller.isConnected, scrollTop: scroller.scrollTop, rect: rectOf(scroller) },
          activeElement,
          groupMutations: [...groupMutations]
        };
      };
      const readTarget = () => {
        const buttons = Array.from(targetGroup?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? []);
        const currentModeLabels = buttons
          .map((button) => button.getAttribute('aria-label'))
          .filter((label): label is string => (
            label === known.preview || label === known.split || label === known.source
          ));
        const target = buttons.find((button) => button.getAttribute('aria-label') === currentLabel)
          ?? buttons.find((button) => button.getAttribute('aria-label') === expectedLabel)
          ?? null;
        const rect = target?.getBoundingClientRect() ?? null;
        const hit = rect
          ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          : null;
        const point = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
        const targetHit = Boolean(target && hit && (hit === target || target.contains(hit)));
        return {
          currentModeLabels,
          targetConnected: Boolean(target?.isConnected),
          targetRect: rect ? rectOf(target) : null,
          targetHit,
          elementsFromPoint: !targetHit && point ? describeHitStack(point) : [],
          hitTarget: hit ? {
            tag: hit.tagName.toLowerCase(),
            ariaLabel: hit.getAttribute('aria-label'),
            className: (hit as HTMLElement).className?.toString() ?? '',
            actualGroup: hit.closest<HTMLElement>('[role="group"]')?.getAttribute('aria-label') ?? null
          } : null
        };
      };
      const labelChanges: Array<ReturnType<typeof readTarget>> = [];
      let lastLabels = JSON.stringify(readTarget().currentModeLabels);
      const validateCurrentPointer = (pointer: (typeof pointerSettlements)[number]['known']) => {
        const registeredGroup = document.querySelector<HTMLElement>(`[role="group"][aria-label="${pointer.controls}"]`);
        const current = Array.from(targetGroup?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])
          .find((button) => button.getAttribute('aria-label') === pointer.currentLabel) ?? null;
        const rect = current?.getBoundingClientRect() ?? null;
        const hit = document.elementFromPoint(pointer.point.x, pointer.point.y);
        const identityCurrent = Boolean(targetGroup?.isConnected)
          && registeredGroup === targetGroup
          && Boolean(targetGroup && scroller.contains(targetGroup))
          && Boolean(current?.isConnected)
          && current?.closest('[role="group"]') === targetGroup;
        const geometryCurrent = Boolean(rect
          && [rect.x, rect.y, rect.width, rect.height, rect.top, rect.right, rect.bottom, rect.left].every(Number.isFinite)
          && rect.width > 0
          && rect.height > 0);
        const targetHit = Boolean(current && hit && (hit === current || current.contains(hit)));
        const evidence = {
          controls: pointer.controls,
          currentLabel: pointer.currentLabel,
          point: pointer.point,
          identityCurrent,
          geometryCurrent,
          targetHit,
          elementsFromPoint: targetHit ? [] : describeHitStack(pointer.point),
          hitTarget: hit instanceof Element ? {
            tag: hit.tagName.toLowerCase(),
            ariaLabel: hit.getAttribute('aria-label'),
            className: (hit as HTMLElement).className?.toString() ?? '',
            actualGroup: hit.closest<HTMLElement>('[role="group"]')?.getAttribute('aria-label') ?? null
          } : null
        };
        if (!identityCurrent) throw new Error(`Rendered-block current target identity changed before ${pointer.phase}: ${JSON.stringify(evidence)}`);
        if (!geometryCurrent) throw new Error(`Rendered-block current target geometry was invalid before ${pointer.phase}: ${JSON.stringify(evidence)}`);
        if (!targetHit) throw new Error(`Rendered-block pointer did not activate semantic target before ${pointer.phase}: ${JSON.stringify(evidence)}`);
      };
      const listener = (event: Event) => {
        const eventButton = event.composedPath()
          .find((candidate): candidate is HTMLButtonElement => candidate instanceof HTMLButtonElement);
        const actualGroup = eventButton?.closest<HTMLElement>('[role="group"]') ?? null;
        const eventButtonLabel = eventButton?.getAttribute('aria-label') ?? null;
        const semanticTarget = actualGroup === targetGroup
          && (eventButtonLabel === currentLabel || eventButtonLabel === expectedLabel);
        events.push(JSON.stringify({
          type: event.type,
          semanticTarget,
          actualGroup: actualGroup ? {
            ariaLabel: actualGroup.getAttribute('aria-label'),
            isTarget: actualGroup === targetGroup
          } : null,
          eventTarget: event.target instanceof Element ? {
            tag: event.target.tagName.toLowerCase(),
            ariaLabel: event.target.getAttribute('aria-label'),
            className: (event.target as HTMLElement).className?.toString() ?? ''
          } : null,
          ...readTarget()
        }));
      };
      for (const type of ['pointerdown', 'pointerup', 'click']) {
        document.addEventListener(type, listener, true);
        registrations += 1;
      }
      const mutationObserver = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes' && record.target instanceof Element && record.target.matches('[role="group"]')) {
            groupMutations.push({
              type: 'aria-label',
              oldValue: record.oldValue,
              ariaLabel: record.target.getAttribute('aria-label'),
              connected: record.target.isConnected,
              rect: rectOf(record.target)
            });
            continue;
          }
          if (record.type === 'childList') {
            const added = Array.from(record.addedNodes).flatMap(groupsIn);
            const removed = Array.from(record.removedNodes).flatMap(groupsIn);
            if (added.length || removed.length) groupMutations.push({ type: 'childList', added, removed });
          }
        }
        const current = readTarget();
        const serializedLabels = JSON.stringify(current.currentModeLabels);
        if (serializedLabels !== lastLabels) {
          lastLabels = serializedLabels;
          labelChanges.push(current);
        }
        for (const settlement of pointerSettlements.splice(0)) {
          try {
            validateCurrentPointer(settlement.known);
            settlement.resolve();
          } catch (error) {
            settlement.reject(error);
          }
        }
      });
      mutationObserver.observe(scroller, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ['aria-label']
      });
      registrations += 1;
      return {
        configureTarget(configured: { readonly controls: string; readonly currentLabel: string; readonly expectedLabel: string }) {
          const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${configured.controls}"]`);
          if (!group) throw new Error(`Missing rendered-block controls while configuring observer: ${configured.controls}`);
          targetGroup = group;
          currentLabel = configured.currentLabel;
          expectedLabel = configured.expectedLabel;
          lastLabels = JSON.stringify(readTarget().currentModeLabels);
        },
        cleanup() {
          if (cleaned) return;
          for (const type of ['pointerdown', 'pointerup', 'click']) document.removeEventListener(type, listener, true);
          mutationObserver.disconnect();
          registrations = 0;
          cleaned = true;
        },
        settleAndValidatePointer(pointer: (typeof pointerSettlements)[number]['known']) {
          return new Promise<void>((resolve, reject) => {
            if (!targetGroup?.isConnected || !scroller.contains(targetGroup)) {
              try { validateCurrentPointer(pointer); }
              catch (error) { reject(error); }
              return;
            }
            pointerSettlements.push({ known: pointer, resolve, reject });
            const sentinel = document.createComment('History pointer DOM settlement');
            targetGroup.append(sentinel);
            sentinel.remove();
          });
        },
        snapshot() {
          return {
            events: [...events],
            labelChanges: [...labelChanges],
            current: readTarget(),
            ...readMaterialization(),
            registrations,
            cleaned,
            sentinelRejected: false
          };
        },
        verifySentinel() {
          const before = JSON.stringify({ events, labelChanges, groupMutations });
          document.dispatchEvent(new Event('click'));
          const sentinel = document.createComment('History observer cleanup sentinel');
          scroller.append(sentinel);
          sentinel.remove();
          return JSON.stringify({ events, labelChanges, groupMutations }) === before;
        }
      };
    }, {
      controls: labels.controls,
      preview: labels.preview,
      split: labels.split,
      source: labels.source,
      kind: requested.kind,
      lineNumber: requested.lineNumber
    });
  } catch (error) {
    page.off('pageerror', pageErrorListener);
    throw error;
  }

  const snapshotCurrent = async () => {
    const evidence = await handle.evaluate((observer: any) => observer.snapshot());
    return { ...evidence, pageErrors: [...pageErrors] };
  };
  return {
    configureTarget: (currentLabel, expectedLabel) => handle.evaluate(
      (observer: any, configured) => observer.configureTarget(configured),
      { controls: labels.controls, currentLabel, expectedLabel }
    ),
    settleAndValidatePointer: (point, phase, currentLabel) => handle.evaluate(
      (observer: any, known) => observer.settleAndValidatePointer(known),
      { controls: labels.controls, currentLabel, point, phase }
    ),
    cleanup: async () => {
      try {
        await handle.evaluate((observer: any) => observer.cleanup());
      } finally {
        page.off('pageerror', pageErrorListener);
      }
    },
    snapshotCurrent,
    snapshot: async () => {
      try {
        const evidence = await snapshotCurrent();
        return { ...evidence, sentinelRejected: true };
      } finally {
        await handle.dispose();
        handle = null;
      }
    },
    verifySentinel: () => handle.evaluate((observer: any) => observer.verifySentinel())
  };
}

async function closeHistoryObserver(observer: ChromiumHistoryObserver) {
  const cleanup: unknown[] = [];
  let evidence: HistoryRenderedBlockObserverEvidence | null = null;
  try { await observer.cleanup(); }
  catch (error) { cleanup.push(new Error('History rendered-block interaction cleanup failed during observerCleanup', { cause: error })); }
  try {
    if (!await observer.verifySentinel()) throw new Error('History rendered-block observer accepted a late event');
  } catch (error) {
    cleanup.push(new Error('History rendered-block interaction cleanup failed during observerSentinel', { cause: error }));
  }
  try {
    evidence = await observer.snapshot();
    if (evidence.registrations !== 0 || !evidence.cleaned || !evidence.sentinelRejected) {
      cleanup.push(new Error('History rendered-block observer evidence did not close its registry'));
    }
  } catch (error) {
    cleanup.push(new Error('History rendered-block interaction cleanup failed during observerSnapshot', { cause: error }));
  }
  return { cleanup, evidence };
}

/**
 * The real-browser Adapter for a rendered-block mode intent. It deliberately
 * owns neither editor state nor private controllers: all facts are exposed by
 * the accessible group, its current button and the scroller geometry.
 */
export async function runHistoryRenderedBlockChromiumInteraction(
  page: any,
  interaction: { readonly kind: HistoryRenderedBlockKind; readonly lineNumber: number; readonly targetMode: HistoryRenderedBlockTargetMode },
  editorGlobal: '__historyMatrixEditor' | '__renderedHistoryStressEditor'
): Promise<HistoryRenderedBlockInteractionResult> {
  const labels = labelsFor(interaction.kind, interaction.lineNumber);
  let observer: ChromiumHistoryObserver;
  let observerOwnership: 'runner-owned' | 'claimed' | 'closed' = 'runner-owned';
  try {
    observer = await openHistoryObserver(page, interaction, labels);
  } catch (error) {
    throw new HistoryRenderedBlockInteractionError(true, error, [], null);
  }
  const closeRunnerOwnedObserver = async () => {
    if (observerOwnership !== 'runner-owned') return null;
    // Claim terminal ownership before the first cleanup await. Re-entry and
    // late failures can then neither close nor dispose the same resource twice.
    observerOwnership = 'closed';
    return closeHistoryObserver(observer);
  };
  const mergeRunnerFailure = (
    error: unknown,
    closed: Awaited<ReturnType<typeof closeHistoryObserver>>
  ): HistoryRenderedBlockInteractionError => {
    if (error instanceof HistoryRenderedBlockInteractionError) {
      const previousCleanup = error.errors.slice(error.hasPrimary ? 1 : 0);
      return new HistoryRenderedBlockInteractionError(
        error.hasPrimary,
        error.primary,
        [...previousCleanup, ...closed.cleanup],
        closed.evidence ?? error.evidence
      );
    }
    return new HistoryRenderedBlockInteractionError(true, error, closed.cleanup, closed.evidence);
  };
  // The Module owns settled scrolling. This one-time semantic lookup only
  // makes the virtualized accessible group materialize so the first explicit
  // source mode can be read; it never sends a pointer or accepts geometry.
  try {
    await page.evaluate(({ editorName, lineNumber }) => {
      const editor = (window as any)[editorName];
      if (!editor) throw new Error(`Missing History editor: ${editorName}`);
      editor.scrollToLine(lineNumber, 'center');
    }, { editorName: editorGlobal, lineNumber: interaction.lineNumber });
    await page.waitForFunction((controlsLabel) => Boolean(
      document.querySelector(`[role="group"][aria-label="${controlsLabel}"]`)
    ), {}, labels.controls);
  } catch (error) {
    const closed = await closeRunnerOwnedObserver();
    if (!closed) throw error;
    const primary = new Error(
      `Rendered-block controls did not materialize: ${JSON.stringify(closed.evidence)}`,
      { cause: error }
    );
    throw new HistoryRenderedBlockInteractionError(true, primary, closed.cleanup, closed.evidence);
  }
  for (let transition = 0; transition < 3; transition += 1) {
    let sourceMode: HistoryRenderedBlockTargetMode | null;
    try {
      sourceMode = await currentMode(page, labels);
    } catch (error) {
      const closed = await closeRunnerOwnedObserver();
      if (!closed) throw error;
      const primary = new Error(`Rendered-block controls selector failed: ${JSON.stringify(closed.evidence)}`, { cause: error });
      throw new HistoryRenderedBlockInteractionError(true, primary, closed.cleanup, closed.evidence);
    }
    if (!sourceMode) {
      const closed = await closeRunnerOwnedObserver();
      if (!closed) throw new Error('History observer ownership was transferred before current-mode inspection');
      const primary = new Error(`Missing current rendered-block mode: ${labels.controls}`);
      throw new HistoryRenderedBlockInteractionError(true, primary, closed.cleanup, closed.evidence);
    }
    if (sourceMode === interaction.targetMode) {
      const closed = await closeRunnerOwnedObserver();
      if (!closed) throw new Error('History observer ownership was transferred before target-mode inspection');
      if (closed.cleanup.length > 0) {
        throw new HistoryRenderedBlockInteractionError(false, undefined, closed.cleanup, closed.evidence);
      }
      return { status: 'noop', evidence: closed.evidence };
    }
    const targetMode = nextMode(sourceMode);
    try {
      await observer.configureTarget(labels[sourceMode], labels[targetMode]);
    } catch (error) {
      const closed = await closeRunnerOwnedObserver();
      if (!closed) throw error;
      const primary = new Error(`Rendered-block controls selector failed: ${JSON.stringify(closed.evidence)}`, { cause: error });
      throw new HistoryRenderedBlockInteractionError(true, primary, closed.cleanup, closed.evidence);
    }
    const transitionObserver = observer;
    const safeReleaseLabel = 'History pointer safe release target';
    const snapshotObserverEvidence = () => transitionObserver.snapshotCurrent();
    const settleAndValidatePointer = async (point: { readonly x: number; readonly y: number }, phase: 'pointerdown' | 'pointerup') => {
      await transitionObserver.settleAndValidatePointer(point, phase, labels[sourceMode]);
    };
    const adapter: HistoryRenderedBlockInteractionAdapter<any> = {
      isCurrent: () => page.evaluate(({ editorName, controlsLabel }) => {
        const editor = (window as any)[editorName];
        const scroller = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller');
        return Boolean(editor && scroller?.isConnected && document.querySelector(`[role="group"][aria-label="${controlsLabel}"]`));
      }, { editorName: editorGlobal, controlsLabel: labels.controls }),
      settleScroll: async () => {
        const result = await page.evaluate(({ editorName, lineNumber, controlsLabel }) => {
          const editor = (window as any)[editorName];
          const scroller = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller');
          const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${controlsLabel}"]`);
          if (!editor || !scroller || !group) throw new Error(`Missing rendered-block controls: ${controlsLabel}`);
          const viewport = scroller.getBoundingClientRect();
          const controls = group.getBoundingClientRect();
          if (![viewport.top, viewport.bottom, controls.top, controls.bottom].every(Number.isFinite)
            || viewport.bottom <= viewport.top || controls.bottom <= controls.top) {
            throw new Error('Invalid rendered block geometry');
          }
          const fullyVisible = controls.top >= viewport.top && controls.bottom <= viewport.bottom
            && controls.left >= viewport.left && controls.right <= viewport.right;
          if (fullyVisible) return 'settled';
          if (!('onscrollend' in scroller)) return 'unsupported';
          let settled = false;
          const onScrollEnd = () => { settled = true; scroller.removeEventListener('scrollend', onScrollEnd); };
          scroller.addEventListener('scrollend', onScrollEnd, { once: true });
          try { editor.scrollToLine(lineNumber, 'center'); }
          catch (error) { scroller.removeEventListener('scrollend', onScrollEnd); throw error; }
          // CodeMirror may synchronously apply the requested scroll without
          // dispatching scrollend. Complete public control visibility is then
          // sufficient evidence of settlement, including top/bottom document
          // blocks that cannot geometrically occupy the viewport center.
          const after = group.getBoundingClientRect();
          if (after.top >= viewport.top && after.bottom <= viewport.bottom
            && after.left >= viewport.left && after.right <= viewport.right) {
            scroller.removeEventListener('scrollend', onScrollEnd);
            return 'settled';
          }
          (window as any).__historyRenderedBlockScrollSettlement = {
            get settled() { return settled; },
            dispose: () => scroller.removeEventListener('scrollend', onScrollEnd)
          };
          return settled ? 'settled' : 'pending';
        }, { editorName: editorGlobal, lineNumber: interaction.lineNumber, controlsLabel: labels.controls });
        if (result === 'unsupported') return 'unsupported';
        if (result === 'pending') {
          try {
            await page.waitForFunction((controlsLabel) => {
              if ((window as any).__historyRenderedBlockScrollSettlement?.settled === true) return true;
              const scroller = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller');
              const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${controlsLabel}"]`);
              if (!scroller || !group) return false;
              const viewport = scroller.getBoundingClientRect();
              const controls = group.getBoundingClientRect();
              return controls.top >= viewport.top && controls.bottom <= viewport.bottom
                && controls.left >= viewport.left && controls.right <= viewport.right;
            }, {}, labels.controls).catch(async (error: unknown) => {
              const geometry = await page.evaluate((controlsLabel) => {
                const scroller = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller')?.getBoundingClientRect().toJSON() ?? null;
                const controls = document.querySelector<HTMLElement>(`[role="group"][aria-label="${controlsLabel}"]`)
                  ?.getBoundingClientRect().toJSON() ?? null;
                return { scroller, controls };
              }, labels.controls);
              throw new Error(`Rendered-block scroll did not settle: ${JSON.stringify({ controlsLabel: labels.controls, geometry })}`, { cause: error });
            });
          } finally {
            await page.evaluate(() => {
              const settlement = (window as any).__historyRenderedBlockScrollSettlement;
              settlement?.dispose();
              delete (window as any).__historyRenderedBlockScrollSettlement;
            });
          }
        }
        await page.waitForFunction((controlsLabel) => {
          const scroller = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller');
          const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${controlsLabel}"]`);
          if (!scroller || !group) return false;
          const viewport = scroller.getBoundingClientRect();
          const rect = group.getBoundingClientRect();
          return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
        }, {}, labels.controls);
        return 'settled';
      },
      isTargetSettled: async (intent) => (await currentMode(page, labels)) === intent.targetMode,
      acquireCurrentHandle: () => page.evaluateHandle((known) => {
        const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${known.controls}"]`);
        return Array.from(group?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])
          .find((button) => button.getAttribute('aria-label') === known.currentLabel) ?? null;
      }, { controls: labels.controls, currentLabel: labels[sourceMode] }),
      validateCurrentHandle: async (handle, phase) => {
        const element = handle.asElement();
        if (!element) throw new Error(`Missing stable mode button before ${phase}: ${labels.controls}`);
        return element.evaluate((button: HTMLButtonElement, known) => {
          const scroller = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller');
          const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${known.controls}"]`);
          const current = Array.from(group?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])
            .find((candidate) => candidate.getAttribute('aria-label') === known.currentLabel);
          if (!button.isConnected || button !== current || button.closest('[role="group"]') !== group) {
            throw new Error(`Mode button identity changed before ${known.phase}: ${known.controls}`);
          }
          if (!scroller || !group || !scroller.contains(group)) throw new Error(`Mode button left its editor scroller before ${known.phase}`);
          const viewport = scroller.getBoundingClientRect();
          const groupRect = group.getBoundingClientRect();
          const rect = button.getBoundingClientRect();
          if (![groupRect, rect].every((candidate) => candidate.top >= viewport.top && candidate.bottom <= viewport.bottom
            && candidate.left >= viewport.left && candidate.right <= viewport.right)) {
            throw new Error(`Mode button is not fully visible before ${known.phase}: ${known.controls}`);
          }
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }, { controls: labels.controls, currentLabel: labels[sourceMode], phase });
      },
      preparePointerDown: (point) => page.mouse.move(point.x, point.y),
      deliverPointerDown: async (point) => {
        await page.mouse.move(point.x, point.y);
        await settleAndValidatePointer(point, 'pointerdown');
        await page.mouse.down();
      },
      preparePointerUp: (point) => page.mouse.move(point.x, point.y),
      deliverPointerUp: async (point) => {
        await page.mouse.move(point.x, point.y);
        await settleAndValidatePointer(point, 'pointerup');
        await page.mouse.up();
      },
      settleTarget: async () => {
        const deliveredEvidence = await snapshotObserverEvidence();
        const semanticClickDelivered = deliveredEvidence?.events.some((entry: string) => {
          try {
            const event = JSON.parse(entry);
            return event.type === 'click' && event.semanticTarget === true;
          } catch {
            return false;
          }
        }) ?? false;
        if (!semanticClickDelivered) {
          throw new Error(`Rendered-block pointer did not activate semantic target: ${JSON.stringify(deliveredEvidence)}`);
        }
        try {
          await page.waitForFunction((known) => {
            const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${known.controls}"]`);
            return Array.from(group?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])
              .some((button) => button.getAttribute('aria-label') === known.expectedLabel);
          }, {}, { controls: labels.controls, expectedLabel: labels[targetMode] });
        } catch (error) {
          let publicEvidence: unknown;
          try {
            publicEvidence = await snapshotObserverEvidence();
          } catch (snapshotError) {
            publicEvidence = { captureError: String(snapshotError) };
          }
          throw new Error(`Rendered-block target did not settle: ${JSON.stringify(publicEvidence)}`, { cause: error });
        }
      },
      disposeSupersededHandle: (handle) => handle.dispose(),
      disposeHandle: (handle) => handle.dispose(),
      moveToSafeReleaseTarget: async () => {
        const point = await page.evaluate((ariaLabel) => {
          document.querySelector(`[aria-label="${ariaLabel}"]`)?.remove();
          const target = document.createElement('div');
          target.setAttribute('aria-label', ariaLabel);
          Object.assign(target.style, { position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'auto' });
          document.body.append(target);
          const rect = target.getBoundingClientRect();
          const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          if (document.elementFromPoint(point.x, point.y) !== target) throw new Error('Could not establish a safe pointer release target');
          return point;
        }, safeReleaseLabel);
        await page.mouse.move(point.x, point.y);
      },
      cancelPointer: () => page.mouse.up(),
      disposeSafeReleaseTarget: () => page.evaluate((ariaLabel) => document.querySelector(`[aria-label="${ariaLabel}"]`)?.remove(), safeReleaseLabel),
      openObserver: async () => {
        if (observerOwnership !== 'runner-owned') {
          throw new Error(`History observer cannot transfer from ${observerOwnership}`);
        }
        observerOwnership = 'claimed';
        return transitionObserver;
      }
    };
    let result: HistoryRenderedBlockInteractionResult;
    try {
      result = await runHistoryRenderedBlockInteraction({ ...interaction, targetMode }, adapter);
    } catch (error) {
      const closed = await closeRunnerOwnedObserver();
      if (!closed) throw error;
      throw mergeRunnerFailure(error, closed);
    }
    const runnerClosed = await closeRunnerOwnedObserver();
    if (runnerClosed) {
      if (runnerClosed.cleanup.length > 0) {
        throw new HistoryRenderedBlockInteractionError(false, undefined, runnerClosed.cleanup, runnerClosed.evidence);
      }
      result = { ...result, evidence: runnerClosed.evidence };
    }
    if (result.status === 'unsupported') return result;
    if (targetMode === interaction.targetMode) return result;
    try {
      observer = await openHistoryObserver(page, interaction, labels);
      observerOwnership = 'runner-owned';
    } catch (error) {
      throw new HistoryRenderedBlockInteractionError(true, error, [], null);
    }
  }
  throw new Error(`Rendered-block mode did not reach ${interaction.targetMode}: ${labels.controls}`);
}
