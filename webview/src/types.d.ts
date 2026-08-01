declare function acquireVsCodeApi(): VsCodeWebviewApi;

type PreviewRenderRequestMessage = import('../../src/shared/preview').PreviewRenderRequestMessage;
type PreviewRenderedMessage = import('../../src/shared/preview').PreviewRenderedMessage;
type PreviewRenderErrorMessage = import('../../src/shared/preview').PreviewRenderErrorMessage;

interface VsCodeWebviewApi {
  getState?(): unknown;
  setState?(state: unknown): void;
  postMessage(message: WebviewMessage): void;
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'applyChanges'; content?: string; baseVersion: number; changes?: { from: number; to: number; insert: string }[] }
  | { type: 'draftChanged'; text: string | null }
  | { type: 'setMode'; mode: 'live' | 'source' | 'preview' }
  | { type: 'setLineNumbers'; visible: boolean }
  | { type: 'setGitChangesGutter'; visible: boolean }
  | { type: 'setFixedBaseline'; enabled: boolean }
  | { type: 'releaseFixedBaseline' }
  | { type: 'setGitBlame'; enabled: boolean }
  | { type: 'setDiffBaselineMode'; mode: 'current-edit' | 'recent-save' | 'git-head' }
  | { type: 'setSpellCheck'; enabled: boolean }
  | { type: 'setContentMaxWidth'; enabled: boolean }
  | { type: 'setLongCodeBlockFolding'; enabled: boolean }
  | { type: 'setOutlineVisible'; visible: boolean }
  | { type: 'setOutlinePosition'; position: 'left' | 'right' }
  | { type: 'setOutlineWidth'; width: number }
  | { type: 'setFindOptions'; findOptions: { wholeWord: boolean; caseSensitive: boolean } }
  | { type: 'viewPositionChanged'; topLine: number; topLineOffset?: number }
  | { type: 'openLink'; href: string; source?: 'preview' }
  | { type: 'openImageExternally'; url: string }
  | { type: 'resolveImageSrc'; requestId: string; url: string }
  | { type: 'resolveWikiLinks'; requestId: string; targets: string[] }
  | { type: 'resolveLocalLinks'; requestId: string; targets: string[] }
  | { type: 'requestDiagnosticSuggestions'; requestId: string; from: number; to: number; message: string; source?: string; code?: string }
  | { type: 'saveDocument' }
  | { type: 'discardChanges'; topLine: number; topLineOffset?: number }
  | { type: 'exportDocument'; format: 'html' | 'pdf'; appearance: 'dark' | 'light' }
  | { type: 'setPreviewAppearance'; appearance: 'dark' | 'light' }
  | { type: 'setEditorAppearance'; appearance: 'dark' | 'light' }
  | { type: 'exportSnapshot'; requestId: string; text: string; environment?: Record<string, unknown> }
  | { type: 'exportSnapshotError'; requestId: string; error: string; message?: string }
  | PreviewRenderRequestMessage
  | { type: 'saveImageFromClipboard'; requestId: string; imageData: string; fileName: string };

type VimKeybinding = {
  before: string;
  after: string;
  mode: 'normal' | 'insert' | 'visual';
  recursive: boolean;
};

type ExtensionMessage =
  | { type: 'init'; text: string; version: number; diagnostics: EditorDiagnostic[]; theme: ThemeSettings; mode: 'live' | 'source' | 'preview'; previewAppearance: 'dark' | 'light'; editorAppearance?: 'dark' | 'light'; outlinePosition: 'left' | 'right'; outlineVisible: boolean; outlineWidth: number; lineNumbers: boolean; gitChangesGutter: boolean; gitBlameEnabled: boolean; gitDiffLineHighlights: boolean; diffBaselineMode: 'current-edit' | 'recent-save' | 'git-head'; fixedBaselinePinned: boolean; fixedBaselineActive: boolean; spellCheckEnabled: boolean; contentMaxWidthEnabled: boolean; longCodeBlockFoldingEnabled: boolean; vimMode: boolean; vimKeybindings: VimKeybinding[]; vimLeader: string; findOptions: { wholeWord: boolean; caseSensitive: boolean }; restoreTopLine?: number; restoreTopLineOffset?: number }
  | { type: 'previewAppearanceChanged'; appearance: 'dark' | 'light' }
  | { type: 'docChanged'; text: string; version: number }
  | { type: 'discardedChanges'; text: string; version: number; topLine: number; topLineOffset?: number }
  | { type: 'applied'; version: number }
  | { type: 'focusEditor' }
  | { type: 'revealSelection'; anchor: number; head: number; focus?: boolean; preserveViewport?: boolean }
  | { type: 'revealDocumentFragment'; href: string }
  | { type: 'diagnosticsChanged'; diagnostics: EditorDiagnostic[] }
  | { type: 'themeChanged'; theme: ThemeSettings }
  | { type: 'outlinePositionChanged'; position: 'left' | 'right' }
  | { type: 'outlineVisibilityChanged'; visible: boolean }
  | { type: 'lineNumbersChanged'; enabled: boolean }
  | { type: 'gitChangesGutterChanged'; enabled: boolean }
  | { type: 'gitBlameChanged'; enabled: boolean }
  | { type: 'gitDiffLineHighlightsChanged'; enabled: boolean }
  | { type: 'diffBaselineModeChanged'; mode: 'current-edit' | 'recent-save' | 'git-head' }
  | { type: 'fixedBaselineChanged'; pinned: boolean; active: boolean }
  | { type: 'spellCheckChanged'; enabled: boolean }
  | { type: 'contentMaxWidthChanged'; enabled: boolean }
  | { type: 'longCodeBlockFoldingChanged'; enabled: boolean }
  | { type: 'vimModeChanged'; enabled: boolean }
  | { type: 'vimKeybindingsChanged'; keybindings: VimKeybinding[]; leaderKey: string }
  | { type: 'findOptionsChanged'; findOptions: { wholeWord: boolean; caseSensitive: boolean } }
  | { type: 'resolvedImageSrc'; requestId: string; resolvedUrl: string }
  | { type: 'resolvedWikiLinks'; requestId: string; results: Array<{ target: string; exists: boolean }> }
  | { type: 'resolvedLocalLinks'; requestId: string; results: Array<{ target: string; exists: boolean }> }
  | { type: 'diagnosticSuggestionsResult'; requestId: string; from: number; to: number; suggestions: string[] }
  | { type: 'savedImagePath'; requestId: string; success: boolean; path?: string; error?: string }
  | PreviewRenderedMessage
  | PreviewRenderErrorMessage;

interface ThemeSettings {
  id: string;
  name: string;
  backgroundColor?: string;
  colors: Record<string, string>;
  syntaxTokens: Record<string, string>;
  fonts: {
    liveFont?: string;
    sourceFont?: string;
    liveFontWeight?: string;
    sourceFontWeight?: string;
    liveFontSize?: number | null;
    sourceFontSize?: number | null;
    h1FontSize?: number | null;
    h2FontSize?: number | null;
    h3FontSize?: number | null;
    h4FontSize?: number | null;
    h5FontSize?: number | null;
    h6FontSize?: number | null;
    h1FontWeight?: string;
    h2FontWeight?: string;
    h3FontWeight?: string;
    h4FontWeight?: string;
    h5FontWeight?: string;
    h6FontWeight?: string;
    liveLineHeight?: number;
    sourceLineHeight?: number;
  };
}

interface EditorDiagnostic {
  from: number;
  to: number;
  severity: 0 | 1 | 2 | 3;
  message: string;
  source?: string;
  code?: string;
}

interface WikiLinkStatus {
  exists: boolean;
  path?: string;
}

interface HeadingInfo {
  text: string;
  level: number;
  from: number;
  to: number;
  lineFrom: number;
  lineTo: number;
  id: string;
}

interface GitDiffLine {
  type: 'added' | 'removed' | 'modified' | 'unchanged';
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
}

interface GitBlameInfo {
  hash: string;
  author: string;
  date: string;
  message: string;
}
