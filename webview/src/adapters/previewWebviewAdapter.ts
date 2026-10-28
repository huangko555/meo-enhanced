import type { HostToWebviewMessage } from '../../../src/protocol/messages';
import type {
  PreviewRenderResponse
} from '../../../src/protocol/previewRender';
import type { EditorAppearance as PreviewAppearance } from '../../../src/protocol/editorCommands';
import { assessLargeDocument } from '../../../src/foundation/largeDocument';
import type { PreviewPresetDefinition, PreviewPresetDiagnostic, PreviewPresetId } from '../../../src/foundation/previewPresets';
import { readDocumentText, type DocumentText } from '../../../src/foundation/documentSnapshot';
import type { PreviewDocumentResponse } from '../../../src/protocol/previewDocument';

type ResolvedPreviewAppearance = Exclude<PreviewAppearance, 'auto'>;

export type PreviewSurface = {
  setAppearance(appearance: PreviewAppearance): void;
  setSourceColoring(enabled: boolean): void;
  setShowComments(enabled: boolean): void;
  setFontFamily(fontFamily: string): void;
  setCodeFontFamily?(fontFamily: string): void;
  restorePresetState?(state: unknown): void;
  updateCustomPresets?(presets: readonly PreviewPresetDefinition[], selected?: PreviewPresetId, initial?: boolean, diagnostics?: readonly PreviewPresetDiagnostic[], options?: { render?: boolean; disabled?: readonly PreviewPresetId[] }): void;
  invalidateRender?(): void;
  getAppearance(): ResolvedPreviewAppearance;
  setVisible(visible: boolean): void;
  preload(text: string): void | Promise<void>;
  requestRender(text: string, options?: {
    force?: boolean;
    preserveViewport?: boolean;
    preserveFrame?: boolean;
  }): void | Promise<void>;
  acceptRenderResponse(message: PreviewRenderResponse): boolean;
  acceptDocumentResponse?(message: PreviewDocumentResponse): boolean;
  getTopVisiblePosition(): { topLine: number; topLineOffset: number; editorLineOffset?: number } | null;
  dispose(): void;
};

export type PreviewWebviewAdapter = {
  start(input: { text: string; appearance: PreviewAppearance; fontFamily: string; codeFontFamily?: string; sourceColoring: boolean; showComments: boolean; active: boolean; presetState?: unknown; customPreviewPresets?: readonly PreviewPresetDefinition[]; previewPresetDiagnostics?: readonly PreviewPresetDiagnostic[]; disabledPreviewPresets?: readonly PreviewPresetId[] }): void;
  setActive(input: {
    active: boolean;
    text: string;
  }): void;
  /** Invalidate retained settings/results even while hidden; render only when active. */
  refreshVisible(text: string, options?: { preserveViewport?: boolean; preserveFrame?: boolean }): void;
  scheduleVisibleRefresh(text: DocumentText): void;
  invalidateResources(text?: string): void;
  accept(message: HostToWebviewMessage): boolean;
  getAppearance(): ResolvedPreviewAppearance;
  dispose(): void;
};

/** Coordinates Preview lifecycle while the concrete surface owns DOM rendering. */
export function createPreviewWebviewAdapter(
  surface: PreviewSurface,
  options: {
    readonly refreshDelayMs?: number;
    readonly scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
    readonly cancelTimeout?: (timeout: unknown) => void;
  } = {}
): PreviewWebviewAdapter {
  let active = false;
  let disposed = false;
  let scheduledRefresh: unknown = null;
  let queuedRender: {
    readonly text: DocumentText;
    readonly options: { force?: boolean; preserveViewport?: boolean; preserveFrame?: boolean };
  } | null = null;
  let renderInFlight = false;
  let currentText: DocumentText | null = null;
  let renderInvalidated = false;
  const refreshDelayMs = options.refreshDelayMs ?? 300;
  const scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const cancelTimeout = options.cancelTimeout ?? ((timeout) => globalThis.clearTimeout(timeout as ReturnType<typeof setTimeout>));

  const cancelScheduledRefresh = (): void => {
    if (scheduledRefresh === null) return;
    cancelTimeout(scheduledRefresh);
    scheduledRefresh = null;
  };

  const runQueuedRefresh = (): void => {
    scheduledRefresh = null;
    if (disposed || !active || renderInFlight || queuedRender === null) return;
    const request = queuedRender;
    queuedRender = null;
    renderInFlight = true;
    const forceRefresh = renderInvalidated;
    renderInvalidated = false;
    const completion = surface.requestRender(readDocumentText(request.text), {
      ...request.options,
      ...(forceRefresh ? { force: true } : {})
    });
    if (!completion || typeof (completion as Promise<void>).then !== 'function') {
      renderInFlight = false;
      if (!disposed && active && queuedRender !== null) runQueuedRefresh();
      return;
    }
    void completion.finally(() => {
      renderInFlight = false;
      if (!disposed && active && queuedRender !== null) runQueuedRefresh();
    });
  };

  const requestImmediateRender = (
    text: DocumentText,
    renderOptions: { force?: boolean; preserveViewport?: boolean; preserveFrame?: boolean } = {}
  ): void => {
    if (disposed || !active) return;
    cancelScheduledRefresh();
    queuedRender = { text, options: renderOptions };
    runQueuedRefresh();
  };

  const trackBackgroundRender = (completion: void | Promise<void>): void => {
    if (!completion || typeof (completion as Promise<void>).then !== 'function') return;
    renderInFlight = true;
    void completion.finally(() => {
      renderInFlight = false;
      if (!disposed && active && queuedRender !== null) runQueuedRefresh();
    });
  };

  const invalidateRender = (): void => {
    // Reject obsolete payloads when their requests settle; the next active
    // render must bypass the same-text cache, including an in-flight preload.
    surface.invalidateRender?.();
    renderInvalidated = true;
  };

  const invalidateResources = (text?: string): void => {
    if (disposed) return;
    if (text !== undefined) currentText = text;
    invalidateRender();
    if (active && currentText !== null) requestImmediateRender(currentText, { force: true, preserveViewport: true });
  };

  return {
    start(input) {
      if (disposed) return;
      active = input.active;
      currentText = input.text;
      surface.updateCustomPresets?.(input.customPreviewPresets ?? [], undefined, true, input.previewPresetDiagnostics ?? [], { render: false, disabled: input.disabledPreviewPresets });
      surface.setAppearance(input.appearance);
      surface.setSourceColoring(input.sourceColoring);
      surface.setShowComments(input.showComments);
      surface.setFontFamily(input.fontFamily);
      surface.setCodeFontFamily?.(input.codeFontFamily ?? '');
      if (input.presetState !== undefined) surface.restorePresetState?.(input.presetState);
      // Full document preparation stays off expensive Source/Live startups.
      // Short complex documents preload their bounded reading window, keeping
      // the first Preview switch warm without constructing their complete DOM.
      if (!input.active && !assessLargeDocument(input.text).preferSource) {
        trackBackgroundRender(surface.preload(input.text));
      }
    },
    setActive(input) {
      if (disposed) return;
      active = input.active;
      currentText = input.text;
      surface.setVisible(input.active);
      if (!input.active) {
        queuedRender = null;
        cancelScheduledRefresh();
        return;
      }
      requestImmediateRender(input.text);
    },
    refreshVisible(text, options = {}) {
      if (disposed) return;
      currentText = text;
      // Settings can change while this retained surface is hidden. Invalidate
      // its cache and in-flight result now; defer rendering until activation.
      invalidateRender();
      if (!active) return;
      requestImmediateRender(text, {
        force: true,
        preserveViewport: options.preserveViewport !== false,
        ...(options.preserveFrame === true ? { preserveFrame: true } : {})
      });
    },
    scheduleVisibleRefresh(text) {
      if (!disposed) currentText = text;
      if (disposed || !active) return;
      queuedRender = {
        text,
        options: { force: true, preserveViewport: true }
      };
      cancelScheduledRefresh();
      if (renderInFlight) return;
      scheduledRefresh = scheduleTimeout(runQueuedRefresh, refreshDelayMs);
    },
    invalidateResources,
    accept(message) {
      if (message.type === 'previewPresetsChanged') {
        if (!disposed) {
          surface.updateCustomPresets?.(message.presets, message.selected, false, message.diagnostics, { render: false, disabled: message.disabled });
          invalidateResources();
        }
        return true;
      }
      if (message.type === 'previewRenderResult') {
        if (!disposed) surface.acceptRenderResponse(message);
        return true;
      }
      if (message.type === 'previewDocumentResult') {
        if (!disposed) surface.acceptDocumentResponse?.(message);
        return true;
      }
      return false;
    },
    getAppearance() {
      return surface.getAppearance();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      queuedRender = null;
      cancelScheduledRefresh();
      surface.dispose();
    }
  };
}
