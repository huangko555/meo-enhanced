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
  preload(text: string): void;
  requestRender(text: string, options?: {
    force?: boolean;
    preserveViewport?: boolean;
    preserveFrame?: boolean;
  }): void;
  acceptRenderResponse(message: PreviewRenderResponse): boolean;
  getTopVisiblePosition(): { topLine: number; topLineOffset: number } | null;
  dispose(): void;
};

export type PreviewWebviewAdapter = {
  start(input: { text: string; appearance: PreviewAppearance; fontFamily: string; sourceColoring: boolean; active: boolean }): void;
  setActive(input: {
    active: boolean;
    text: string;
  }): void;
  refreshVisible(text: string, options?: { preserveViewport?: boolean; preserveFrame?: boolean }): void;
  accept(message: HostToWebviewMessage): boolean;
  getAppearance(): ResolvedPreviewAppearance;
  dispose(): void;
};

/** Coordinates Preview lifecycle while the concrete surface owns DOM rendering. */
export function createPreviewWebviewAdapter(surface: PreviewSurface): PreviewWebviewAdapter {
  let active = false;
  let disposed = false;

  return {
    start(input) {
      if (disposed) return;
      active = input.active;
      surface.setAppearance(input.appearance);
      surface.setSourceColoring(input.sourceColoring);
      surface.setFontFamily(input.fontFamily);
      if (!input.active) surface.preload(input.text);
    },
    setActive(input) {
      if (disposed) return;
      active = input.active;
      surface.setVisible(input.active);
      if (!input.active) return;
      surface.requestRender(input.text);
    },
    refreshVisible(text, options = {}) {
      if (disposed || !active) return;
      surface.requestRender(text, {
        force: true,
        preserveViewport: options.preserveViewport !== false,
        ...(options.preserveFrame === true ? { preserveFrame: true } : {})
      });
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
      surface.dispose();
    }
  };
}
