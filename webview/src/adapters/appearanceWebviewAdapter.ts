import type { EditorAppearance } from '../../../src/protocol/editorCommands';
import type { CodeThemeDto } from '../../../src/protocol/hostConfigurationEvents';
import type { HostToWebviewMessage } from '../../../src/protocol/messages';
import type { FinalCodePalette } from '../application/finalCodePalette';

export type AppearanceWebviewAdapterDependencies = {
  readonly setAppearanceControl: (appearance: EditorAppearance) => void;
  readonly applyAppearance: (appearance: 'light' | 'dark') => void;
  readonly resolveCodePalette: (
    currentVscodeTheme: CodeThemeDto | null | undefined,
    appearance: 'light' | 'dark'
  ) => FinalCodePalette;
  readonly applyCodePalette: (palette: FinalCodePalette) => void;
  readonly refreshMermaidTheme: () => void;
  readonly applyWithEditorViewportPreserved: (action: () => void) => void;
  readonly refreshEditorDecorations: () => void;
  readonly syncPreviewAutoAppearance: () => void;
  readonly postEditorAppearance: (appearance: EditorAppearance) => void;
  readonly reportUnexpectedError: (context: string, error: unknown) => void;
};

export type AppearanceWebviewAdapter = {
  start(input: {
    readonly vscodeTheme: CodeThemeDto | null | undefined;
    readonly appearance: EditorAppearance;
  }): void;
  setAppearance(appearance: EditorAppearance, options?: { readonly post?: boolean }): void;
  getAppearance(): 'light' | 'dark';
  getCodePalette(appearance?: 'light' | 'dark'): FinalCodePalette;
  accept(message: HostToWebviewMessage): boolean;
};

/** Owns resolved Editor appearance and final Live/Preview code palette ordering for one Webview. */
export function createAppearanceWebviewAdapter(
  dependencies: AppearanceWebviewAdapterDependencies
): AppearanceWebviewAdapter {
  let vscodeTheme: CodeThemeDto | null | undefined;
  let vscodeAppearance: 'light' | 'dark' = 'dark';
  let appearancePreference: EditorAppearance = 'auto';
  let appearance: 'light' | 'dark' = 'dark';

  const resolveAppearance = (): 'light' | 'dark' => (
    appearancePreference === 'auto' ? vscodeAppearance : appearancePreference
  );

  const applyCodePalette = (): void => {
    dependencies.applyCodePalette(dependencies.resolveCodePalette(vscodeTheme, appearance));
  };

  return {
    start(input) {
      vscodeTheme = input.vscodeTheme;
      vscodeAppearance = input.vscodeTheme?.type ?? 'dark';
      appearancePreference = input.appearance;
      appearance = resolveAppearance();
      dependencies.setAppearanceControl(appearancePreference);
      dependencies.applyAppearance(appearance);
      applyCodePalette();
    },
    setAppearance(nextAppearance, { post = false } = {}) {
      const previousAppearance = appearance;
      appearancePreference = nextAppearance;
      appearance = resolveAppearance();
      const changed = appearance !== previousAppearance;
      dependencies.setAppearanceControl(appearancePreference);

      if (changed) {
        dependencies.applyWithEditorViewportPreserved(() => {
          dependencies.applyAppearance(appearance);
          applyCodePalette();
          dependencies.refreshMermaidTheme();
          dependencies.refreshEditorDecorations();
          dependencies.syncPreviewAutoAppearance();
        });
      }

      if (post) dependencies.postEditorAppearance(appearancePreference);
    },
    getAppearance() {
      return appearance;
    },
    getCodePalette(requestedAppearance = appearance) {
      return dependencies.resolveCodePalette(vscodeTheme, requestedAppearance);
    },
    accept(message) {
      if (message.type !== 'vscodeCodeThemeChanged') return false;
      try {
        vscodeTheme = message.vscodeTheme;
        vscodeAppearance = message.appearance;
        const nextAppearance = resolveAppearance();
        appearance = nextAppearance;
        dependencies.applyWithEditorViewportPreserved(() => {
          // VS Code rewrites its CSS variables before this event. Reapply the fixed
          // baseline even when a manual appearance itself did not change.
          dependencies.applyAppearance(appearance);
          dependencies.refreshMermaidTheme();
          applyCodePalette();
          dependencies.refreshEditorDecorations();
          dependencies.syncPreviewAutoAppearance();
        });
      } catch (error) {
        dependencies.reportUnexpectedError('vscodeCodeThemeChanged handler', error);
      }
      return true;
    }
  };
}
