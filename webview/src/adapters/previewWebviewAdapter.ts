import type { HostToWebviewMessage } from '../../../src/protocol/messages';
import type {
  PreviewRenderResponse
} from '../../../src/protocol/previewRender';
import type { EditorAppearance as PreviewAppearance } from '../../../src/protocol/editorCommands';

type ResolvedPreviewAppearance = Exclude<PreviewAppearance, 'auto'>;

export type PreviewSurface = {
  setAppearance(appearance: PreviewAppearance): void;
  setSourceColoring(enabled: boolean): void;
  setFontFamily(fontFamily: string): void;
  getAppearance(): ResolvedPreviewAppearance;
  setVisible(visible: boolean): void;
  preload(text: string): void | Promise<void>;
  requestRender(text: string, options?: {
    force?: boolean;
    preserveViewport?: boolean;
    preserveFrame?: boolean;
  }): void | Promise<void>;
  acceptRenderResponse(message: PreviewRenderResponse): boolean;
  getTopVisiblePosition(): { topLine: number; topLineOffset: number; editorLineOffset?: number } | null;
  dispose(): void;
};

export type PreviewWebviewAdapter = {
  start(input: { text: string; appearance: PreviewAppearance; fontFamily: string; sourceColoring: boolean; active: boolean }): void;
  setActive(input: {
    active: boolean;
    text: string;
  }): void;
  refreshVisible(text: string, options?: { preserveViewport?: boolean; preserveFrame?: boolean }): void;
  scheduleVisibleRefresh(text: string): void;
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
    readonly text: string;
    readonly options: { force?: boolean; preserveViewport?: boolean; preserveFrame?: boolean };
  } | null = null;
  let renderInFlight = false;
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
    const completion = surface.requestRender(request.text, request.options);
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
    text: string,
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

  return {
    start(input) {
      if (disposed) return;
      active = input.active;
      surface.setAppearance(input.appearance);
      surface.setSourceColoring(input.sourceColoring);
      surface.setFontFamily(input.fontFamily);
      if (!input.active) trackBackgroundRender(surface.preload(input.text));
    },
    setActive(input) {
      if (disposed) return;
      active = input.active;
      surface.setVisible(input.active);
      if (!input.active) {
        queuedRender = null;
        cancelScheduledRefresh();
        return;
      }
      requestImmediateRender(input.text);
    },
    refreshVisible(text, options = {}) {
      if (disposed || !active) return;
      requestImmediateRender(text, {
        force: true,
        preserveViewport: options.preserveViewport !== false,
        ...(options.preserveFrame === true ? { preserveFrame: true } : {})
      });
    },
    scheduleVisibleRefresh(text) {
      if (disposed || !active) return;
      queuedRender = {
        text,
        options: { force: true, preserveViewport: true }
      };
      cancelScheduledRefresh();
      if (renderInFlight) return;
      scheduledRefresh = scheduleTimeout(runQueuedRefresh, refreshDelayMs);
    },
    accept(message) {
      if (message.type === 'previewRenderResult') {
        if (!disposed) surface.acceptRenderResponse(message);
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
