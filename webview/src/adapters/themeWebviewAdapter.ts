import type { EditorAppearance } from '../../../src/protocol/editorCommands';
import type {
  CodeThemeDto,
  ThemeSettingsDto
} from '../../../src/protocol/hostConfigurationEvents';
import type { HostToWebviewMessage } from '../../../src/protocol/messages';

export type ThemeWebviewAdapterDependencies = {
  readonly setAppearanceControl: (appearance: EditorAppearance) => void;
  readonly applyTheme: (theme: ThemeSettingsDto, appearance: EditorAppearance) => void;
  readonly setShikiEnabled: (enabled: boolean) => void;
  readonly resolveCodeTheme: (
    theme: CodeThemeDto | null | undefined,
    appearance: EditorAppearance
  ) => CodeThemeDto | null | undefined;
  readonly setShikiTheme: (theme: CodeThemeDto | null | undefined) => void;
  readonly refreshMermaidTheme: () => void;
  readonly applyWithEditorViewportPreserved: (action: () => void) => void;
  readonly refreshEditorDecorations: () => void;
  readonly refreshPreview: () => void;
  readonly postEditorAppearance: (appearance: EditorAppearance) => void;
  readonly reportUnexpectedError: (context: string, error: unknown) => void;
};

export type ThemeWebviewAdapter = {
  start(input: {
    readonly theme: ThemeSettingsDto;
    readonly codeTheme: CodeThemeDto | null | undefined;
    readonly appearance: EditorAppearance;
    readonly shikiEnabled: boolean;
  }): void;
  setAppearance(appearance: EditorAppearance, options?: { readonly post?: boolean }): void;
  getAppearance(): EditorAppearance;
  accept(message: HostToWebviewMessage): boolean;
};

/** Owns Theme, code-theme and Editor appearance ordering for one Webview. */
export function createThemeWebviewAdapter(
  dependencies: ThemeWebviewAdapterDependencies
): ThemeWebviewAdapter {
  let theme: ThemeSettingsDto | null = null;
  let codeTheme: CodeThemeDto | null | undefined;
  let appearance: EditorAppearance = 'dark';

  const applyCodeTheme = (): void => {
    dependencies.setShikiTheme(dependencies.resolveCodeTheme(codeTheme, appearance));
  };

  return {
    start(input) {
      theme = input.theme;
      codeTheme = input.codeTheme;
      appearance = input.appearance;
      dependencies.setAppearanceControl(appearance);
      dependencies.applyTheme(theme, appearance);
      dependencies.setShikiEnabled(input.shikiEnabled);
      applyCodeTheme();
    },
    setAppearance(nextAppearance, { post = false } = {}) {
      const changed = appearance !== nextAppearance;
      appearance = nextAppearance;
      dependencies.setAppearanceControl(appearance);

      if (changed && theme) {
        const activeTheme = theme;
        dependencies.applyWithEditorViewportPreserved(() => {
          dependencies.applyTheme(activeTheme, appearance);
          applyCodeTheme();
          dependencies.refreshMermaidTheme();
          dependencies.refreshEditorDecorations();
        });
      }

      if (post) dependencies.postEditorAppearance(appearance);
    },
    getAppearance() {
      return appearance;
    },
    accept(message) {
      if (message.type === 'themeChanged') {
        try {
          theme = message.theme;
          codeTheme = message.codeTheme;
          dependencies.applyWithEditorViewportPreserved(() => {
            dependencies.applyTheme(message.theme, appearance);
            dependencies.refreshMermaidTheme();
            applyCodeTheme();
            dependencies.refreshEditorDecorations();
            dependencies.refreshPreview();
          });
        } catch (error) {
          dependencies.reportUnexpectedError('themeChanged handler', error);
        }
        return true;
      }

      if (message.type === 'shikiCodeBlocksChanged') {
        try {
          codeTheme = message.codeTheme;
          applyCodeTheme();
          dependencies.setShikiEnabled(message.enabled);
        } catch (error) {
          dependencies.reportUnexpectedError('shikiCodeBlocksChanged handler', error);
        }
        return true;
      }

      return false;
    }
  };
}
