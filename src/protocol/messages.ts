import { decodeSaveImageFromClipboardRequest, decodeSavedImagePathResponse, type SaveImageFromClipboardRequest, type SavedImagePathResponse } from './clipboardImageSave';
import { decodeDiagnosticSuggestionsRequest, decodeDiagnosticSuggestionsResult, type DiagnosticSuggestionsResult, type RequestDiagnosticSuggestions } from './diagnosticSuggestions';
import { decodeDiagnosticsChangedEvent, type DiagnosticsChangedEvent } from './diagnostics';
import { decodeDocumentSyncCommand, decodeDocumentSyncMessage, type DocumentSyncCommand, type DocumentSyncMessage } from './documentSync';
import { decodeEditorCommand, type EditorCommand } from './editorCommands';
import { decodeExportSnapshotRequest, decodeExportSnapshotResponse, type ExportSnapshotRequest, type ExportSnapshotResponse } from './exportSnapshot';
import { decodeGitBaselineChangedEvent, decodeGitBlameRequest, decodeGitBlameResponse, decodeGitNavigationCommand, type GitBaselineChangedEvent, type GitBlameRequest, type GitBlameResponse, type GitNavigationCommand } from './git';
import { decodeHostConfigurationEvent, type HostConfigurationEvent } from './hostConfigurationEvents';
import { decodeHostEditorEvent, type HostEditorEvent } from './hostEditorEvents';
import { decodeResolveImageSrcRequest, decodeResolvedImageSrcResponse, type ResolveImageSrcRequest, type ResolvedImageSrcResponse } from './imageResolution';
import { decodeResolveLocalLinksRequest, decodeResolvedLocalLinksResponse, type ResolveLocalLinksRequest, type ResolvedLocalLinksResponse } from './localLinkResolution';
import { decodePreviewRenderRequest, decodePreviewRenderResponse, type PreviewRenderRequest, type PreviewRenderResponse } from './previewRender';
import { decodeInitMessage, decodeReadyMessage, type InitMessage, type ReadyMessage } from './readyInit';
import { decodeResolveWikiLinksRequest, decodeResolvedWikiLinksResponse, type ResolveWikiLinksRequest, type ResolvedWikiLinksResponse } from './wikiLinkResolution';

export type WebviewToHostMessage =
  | ReadyMessage
  | DocumentSyncCommand
  | EditorCommand
  | ResolveImageSrcRequest
  | ResolveWikiLinksRequest
  | ResolveLocalLinksRequest
  | RequestDiagnosticSuggestions
  | SaveImageFromClipboardRequest
  | PreviewRenderRequest
  | ExportSnapshotResponse
  | GitBlameRequest
  | GitNavigationCommand;

export type HostToWebviewMessage =
  | InitMessage
  | DocumentSyncMessage
  | HostEditorEvent
  | HostConfigurationEvent
  | DiagnosticsChangedEvent
  | ResolvedImageSrcResponse
  | ResolvedWikiLinksResponse
  | ResolvedLocalLinksResponse
  | DiagnosticSuggestionsResult
  | SavedImagePathResponse
  | PreviewRenderResponse
  | ExportSnapshotRequest
  | GitBlameResponse
  | GitBaselineChangedEvent;

export function decodeWebviewToHostMessage(value: unknown): WebviewToHostMessage | null {
  return decodeReadyMessage(value)
    ?? decodeDocumentSyncCommand(value)
    ?? decodeEditorCommand(value)
    ?? decodeResolveImageSrcRequest(value)
    ?? decodeResolveWikiLinksRequest(value)
    ?? decodeResolveLocalLinksRequest(value)
    ?? decodeDiagnosticSuggestionsRequest(value)
    ?? decodeSaveImageFromClipboardRequest(value)
    ?? decodePreviewRenderRequest(value)
    ?? decodeExportSnapshotResponse(value)
    ?? decodeGitBlameRequest(value)
    ?? decodeGitNavigationCommand(value);
}

export function decodeHostToWebviewMessage(value: unknown): HostToWebviewMessage | null {
  return decodeInitMessage(value)
    ?? decodeDocumentSyncMessage(value)
    ?? decodeHostEditorEvent(value)
    ?? decodeHostConfigurationEvent(value)
    ?? decodeDiagnosticsChangedEvent(value)
    ?? decodeResolvedImageSrcResponse(value)
    ?? decodeResolvedWikiLinksResponse(value)
    ?? decodeResolvedLocalLinksResponse(value)
    ?? decodeDiagnosticSuggestionsResult(value)
    ?? decodeSavedImagePathResponse(value)
    ?? decodePreviewRenderResponse(value)
    ?? decodeExportSnapshotRequest(value)
    ?? decodeGitBlameResponse(value)
    ?? decodeGitBaselineChangedEvent(value);
}
