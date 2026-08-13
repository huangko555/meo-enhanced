declare function acquireVsCodeApi(): VsCodeWebviewApi;

type InitMessage = import('../../src/protocol/readyInit').InitMessage;

interface VsCodeWebviewApi {
  getState?(): unknown;
  setState?(state: unknown): void;
  postMessage(message: WebviewMessage): void;
}

type WebviewMessage = import('../../src/protocol/messages').WebviewToHostMessage;

type ExtensionMessage = import('../../src/protocol/messages').HostToWebviewMessage;

type ThemeSettings = import('../../src/protocol/hostConfigurationEvents').ThemeSettingsDto;
type EditorDiagnostic = import('../../src/protocol/diagnostics').SerializedDiagnostic;

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

