import type { EditorAppearance } from '../../../src/protocol/editorCommands';
import type { CodeThemeDto } from '../../../src/protocol/hostConfigurationEvents';
import type { HostToWebviewMessage } from '../../../src/protocol/messages';

export type AppearanceWebviewAdapterDependencies = {
  readonly setAppearanceControl: (appearance: EditorAppearance) => void;
  readonly applyAppearance: (appearance: 'light' | 'dark') => void;
  readonly resolveCodeTheme: (
    currentVscodeTheme: CodeThemeDto | null | undefined,
    appearance: 'light' | 'dark'
  ) => CodeThemeDto | null | undefined;
  readonly setCodeTheme: (theme: CodeThemeDto | null | undefined) => void;
  readonly refreshMermaidTheme: () => void;
  readonly applyWithEditorViewportPreserved: (action: () => void) => void;
  readonly refreshEditorDecorations: () => void;
  readonly refreshPreview: () => void;
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
  accept(message: HostToWebviewMessage): boolean;
};

/** Owns resolved Editor appearance and final Live/Preview code palette ordering for one Webview. */
export function createAppearanceWebviewAdapter(
  dependencies: AppearanceWebviewAdapterDependencies
): AppearanceWebviewAdapter {
  let vscodeTheme: CodeThemeDto | null | undefined;
  let appearancePreference: EditorAppearance = 'auto';
  let appearance: 'light' | 'dark' = 'dark';

  const resolveAppearance = (): 'light' | 'dark' => (
    appearancePreference === 'auto' ? vscodeTheme?.type ?? 'dark' : appearancePreference
  );

  const applyCodeTheme = (): void => {
    dependencies.setCodeTheme(dependencies.resolveCodeTheme(vscodeTheme, appearance));
  };

  return {
    start(input) {
      vscodeTheme = input.vscodeTheme;
      appearancePreference = input.appearance;
      appearance = resolveAppearance();
      dependencies.setAppearanceControl(appearancePreference);
      dependencies.applyAppearance(appearance);
      applyCodeTheme();
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
          applyCodeTheme();
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
    accept(message) {
      if (message.type !== 'vscodeCodeThemeChanged') return false;
      try {
        vscodeTheme = message.vscodeTheme;
        const nextAppearance = resolveAppearance();
        appearance = nextAppearance;
        dependencies.applyWithEditorViewportPreserved(() => {
          // VS Code rewrites its CSS variables before this event. Reapply the fixed
          // baseline even when a manual appearance itself did not change.
          dependencies.applyAppearance(appearance);
          dependencies.refreshMermaidTheme();
          applyCodeTheme();
          dependencies.refreshEditorDecorations();
          dependencies.syncPreviewAutoAppearance();
        });
        dependencies.refreshPreview();
      } catch (error) {
        dependencies.reportUnexpectedError('vscodeCodeThemeChanged handler', error);
      }
      return true;
    }
  };
}
