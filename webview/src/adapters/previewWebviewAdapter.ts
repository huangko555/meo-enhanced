import type { HostToWebviewMessage } from '../../../src/protocol/messages';
import type {
  PreviewAppearance,
  PreviewRenderResponse
} from '../../../src/protocol/previewRender';

export type PreviewSurface = {
  setAppearance(appearance: PreviewAppearance): void;
  getAppearance(): PreviewAppearance;
  setVisible(visible: boolean): void;
  preload(text: string): void;
  requestRender(text: string, options?: { restoreLine?: number | null }): void;
  acceptRenderResponse(message: PreviewRenderResponse): boolean;
  getTopVisiblePosition(): { topLine: number; topLineOffset: number } | null;
  dispose(): void;
};

export type PreviewWebviewAdapter = {
  start(input: { text: string; appearance: PreviewAppearance; active: boolean }): void;
  setActive(input: {
    active: boolean;
    text: string;
    restoreLine?: number | null;
    initialAppearance: PreviewAppearance;
  }): void;
  restoreActive(active: boolean): void;
  refreshVisible(text: string, options?: { restoreLine?: number | null }): void;
  accept(message: HostToWebviewMessage): boolean;
  getAppearance(): PreviewAppearance;
  dispose(): void;
};

/** Coordinates Preview lifecycle while the concrete surface owns DOM rendering. */
export function createPreviewWebviewAdapter(surface: PreviewSurface): PreviewWebviewAdapter {
  let active = false;
  let appearanceInitializedForFirstActivation = false;
  let disposed = false;

  return {
    start(input) {
      if (disposed) return;
      active = input.active;
      surface.setAppearance(input.appearance);
      if (!input.active) surface.preload(input.text);
    },
    setActive(input) {
      if (disposed) return;
      active = input.active;
      surface.setVisible(input.active);
      if (!input.active) return;
      if (!appearanceInitializedForFirstActivation) {
        surface.setAppearance(input.initialAppearance);
        appearanceInitializedForFirstActivation = true;
      }
      surface.requestRender(input.text, { restoreLine: input.restoreLine ?? null });
    },
    restoreActive(nextActive) {
      if (disposed) return;
      active = nextActive;
      surface.setVisible(nextActive);
    },
    refreshVisible(text, options = {}) {
      if (disposed || !active) return;
      const restoreLine = options.restoreLine === undefined
        ? surface.getTopVisiblePosition()?.topLine ?? null
        : options.restoreLine;
      surface.requestRender(text, { restoreLine });
    },
    accept(message) {
      if (message.type === 'previewAppearanceChanged') {
        if (!disposed) surface.setAppearance(message.appearance);
        return true;
      }
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
      surface.dispose();
    }
  };
}
