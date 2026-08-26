import {
  runHistoryRenderedBlockInteraction,
  type HistoryRenderedBlockInteractionAdapter,
  type HistoryRenderedBlockKind,
  type HistoryRenderedBlockTargetMode
} from './history-rendered-block-interaction';

type ModeLabels = Record<HistoryRenderedBlockTargetMode, string> & { readonly controls: string };

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

/**
 * The real-browser Adapter for a rendered-block mode intent. It deliberately
 * owns neither editor state nor private controllers: all facts are exposed by
 * the accessible group, its current button and the scroller geometry.
 */
export async function runHistoryRenderedBlockChromiumInteraction(
  page: any,
  interaction: { readonly kind: HistoryRenderedBlockKind; readonly lineNumber: number; readonly targetMode: HistoryRenderedBlockTargetMode },
  editorGlobal: '__historyMatrixEditor' | '__renderedHistoryStressEditor'
) {
  const labels = labelsFor(interaction.kind, interaction.lineNumber);
  // The Module owns settled scrolling. This one-time semantic lookup only
  // makes the virtualized accessible group materialize so the first explicit
  // source mode can be read; it never sends a pointer or accepts geometry.
  await page.evaluate(({ editorName, lineNumber }) => {
    const editor = (window as any)[editorName];
    if (!editor) throw new Error(`Missing History editor: ${editorName}`);
    editor.scrollToLine(lineNumber, 'center');
  }, { editorName: editorGlobal, lineNumber: interaction.lineNumber });
  await page.waitForFunction((controlsLabel) => Boolean(
    document.querySelector(`[role="group"][aria-label="${controlsLabel}"]`)
  ), {}, labels.controls);
  for (let transition = 0; transition < 3; transition += 1) {
    const sourceMode = await currentMode(page, labels);
    if (!sourceMode) throw new Error(`Missing current rendered-block mode: ${labels.controls}`);
    if (sourceMode === interaction.targetMode) return;
    const targetMode = nextMode(sourceMode);
    let observerHandle: any = null;
    let pageErrorListener: ((error: unknown) => void) | null = null;
    const pageErrors: string[] = [];
    const safeReleaseLabel = 'History pointer safe release target';
    const snapshotObserverEvidence = async () => {
      if (!observerHandle) return null;
      const evidence = await observerHandle.evaluate((observer: any) => observer.snapshot());
      return { ...evidence, pageErrors: [...pageErrors] };
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
      deliverPointerDown: async (point) => { await page.mouse.move(point.x, point.y); await page.mouse.down(); },
      preparePointerUp: (point) => page.mouse.move(point.x, point.y),
      deliverPointerUp: async (point) => { await page.mouse.move(point.x, point.y); await page.mouse.up(); },
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
            publicEvidence = { captureError: String(snapshotError), pageErrors: [...pageErrors] };
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
        observerHandle = await page.evaluateHandle((known) => {
          const events: string[] = [];
          let registrations = 0;
          let cleaned = false;
          const readTarget = () => {
            const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${known.controls}"]`);
            const buttons = Array.from(group?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? []);
            const currentModeLabels = buttons
              .map((button) => button.getAttribute('aria-label'))
              .filter((label): label is string => (
                label === known.preview || label === known.split || label === known.source
              ));
            const target = buttons.find((button) => button.getAttribute('aria-label') === known.currentLabel)
              ?? buttons.find((button) => button.getAttribute('aria-label') === known.expectedLabel)
              ?? null;
            const rect = target?.getBoundingClientRect() ?? null;
            const hit = rect
              ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
              : null;
            return {
              currentModeLabels,
              targetConnected: Boolean(target?.isConnected),
              targetRect: rect ? {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                left: rect.left
              } : null,
              targetHit: Boolean(target && hit && (hit === target || target.contains(hit))),
              hitTarget: hit ? {
                tag: hit.tagName.toLowerCase(),
                ariaLabel: hit.getAttribute('aria-label'),
                className: (hit as HTMLElement).className?.toString() ?? ''
              } : null
            };
          };
          const labelChanges: Array<ReturnType<typeof readTarget>> = [];
          const listener = (event: Event) => {
            const semanticTarget = event.composedPath().some((candidate) => {
              if (!(candidate instanceof HTMLButtonElement)) return false;
              const label = candidate.getAttribute('aria-label');
              return label === known.currentLabel || label === known.expectedLabel;
            });
            events.push(JSON.stringify({
              type: event.type,
              semanticTarget,
              eventTarget: event.target instanceof Element ? {
                tag: event.target.tagName.toLowerCase(),
                ariaLabel: event.target.getAttribute('aria-label'),
                className: (event.target as HTMLElement).className?.toString() ?? ''
              } : null,
              ...readTarget()
            }));
          };
          for (const type of ['pointerdown', 'pointerup', 'click']) { document.addEventListener(type, listener, true); registrations += 1; }
          let lastLabels = JSON.stringify(readTarget().currentModeLabels);
          const mutationObserver = new MutationObserver(() => {
            const current = readTarget();
            const serializedLabels = JSON.stringify(current.currentModeLabels);
            if (serializedLabels === lastLabels) return;
            lastLabels = serializedLabels;
            labelChanges.push(current);
          });
          const scroller = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller');
          if (!scroller) throw new Error('Missing editor scroller while opening History evidence observer');
          mutationObserver.observe(scroller, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['aria-label']
          });
          registrations += 1;
          return {
            cleanup() {
              for (const type of ['pointerdown', 'pointerup', 'click']) document.removeEventListener(type, listener, true);
              mutationObserver.disconnect();
              registrations = 0;
              cleaned = true;
            },
            snapshot() {
              return {
                events: [...events],
                labelChanges: [...labelChanges],
                current: readTarget(),
                registrations,
                cleaned,
                sentinelRejected: false
              };
            },
            verifySentinel() {
              const before = JSON.stringify({ events, labelChanges });
              document.dispatchEvent(new Event('click'));
              return JSON.stringify({ events, labelChanges }) === before;
            }
          };
        }, {
          controls: labels.controls,
          preview: labels.preview,
          split: labels.split,
          source: labels.source,
          currentLabel: labels[sourceMode],
          expectedLabel: labels[targetMode]
        });
        pageErrorListener = (error: unknown) => { pageErrors.push(String(error)); };
        page.on('pageerror', pageErrorListener);
        return {
          cleanup: async () => {
            try {
              await observerHandle.evaluate((observer: any) => observer.cleanup());
            } finally {
              if (pageErrorListener) {
                page.off('pageerror', pageErrorListener);
                pageErrorListener = null;
              }
            }
          },
          snapshot: async () => {
            try {
              const evidence = await snapshotObserverEvidence();
              return { ...evidence, sentinelRejected: true };
            } finally {
              await observerHandle.dispose();
              observerHandle = null;
            }
          },
          verifySentinel: () => observerHandle.evaluate((observer: any) => observer.verifySentinel())
        };
      }
    };
    await runHistoryRenderedBlockInteraction({ ...interaction, targetMode }, adapter);
  }
  throw new Error(`Rendered-block mode did not reach ${interaction.targetMode}: ${labels.controls}`);
}
