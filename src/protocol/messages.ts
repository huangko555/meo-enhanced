import { decodeSaveImageFromClipboardRequest, decodeSavedImagePathResponse, type SaveImageFromClipboardRequest, type SavedImagePathResponse } from './clipboardImageSave';
import { decodeDiagnosticsChangedEvent, type DiagnosticsChangedEvent } from './diagnostics';
import { decodeDocumentSyncCommand, decodeDocumentSyncMessage, type DocumentSyncCommand, type DocumentSyncMessage } from './documentSync';
import { decodeDocumentRevisionRequest, decodeDocumentRevisionResponse, decodeSaveDocumentRevisionRequest, decodeSaveDocumentRevisionResponse, type DocumentRevisionRequest, type DocumentRevisionResponse, type SaveDocumentRevisionRequest, type SaveDocumentRevisionResponse } from './documentSession';
import { decodeFlushDocumentEditsRequest, decodeFlushDocumentEditsResponse, type FlushDocumentEditsRequest, type FlushDocumentEditsResponse } from './documentSaveFlush';
import { decodeEditorCommand, type EditorCommand } from './editorCommands';
import { decodeExportSnapshotRequest, decodeExportSnapshotResponse, type ExportSnapshotRequest, type ExportSnapshotResponse } from './exportSnapshot';
import { decodeGitBaselineChangedEvent, type GitBaselineChangedEvent } from './git';
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
  | SaveDocumentRevisionRequest
  | DocumentRevisionRequest
  | FlushDocumentEditsResponse
  | EditorCommand
  | ResolveImageSrcRequest
  | ResolveWikiLinksRequest
  | ResolveLocalLinksRequest
  | SaveImageFromClipboardRequest
  | PreviewRenderRequest
  | ExportSnapshotResponse;

export type HostToWebviewMessage =
  | InitMessage
  | DocumentSyncMessage
  | SaveDocumentRevisionResponse
  | DocumentRevisionResponse
  | FlushDocumentEditsRequest
  | HostEditorEvent
  | HostConfigurationEvent
  | DiagnosticsChangedEvent
  | ResolvedImageSrcResponse
  | ResolvedWikiLinksResponse
  | ResolvedLocalLinksResponse
  | SavedImagePathResponse
  | PreviewRenderResponse
  | ExportSnapshotRequest
  | GitBaselineChangedEvent;

export function decodeWebviewToHostMessage(value: unknown): WebviewToHostMessage | null {
  return decodeReadyMessage(value)
    ?? decodeDocumentSyncCommand(value)
    ?? decodeSaveDocumentRevisionRequest(value)
    ?? decodeDocumentRevisionRequest(value)
    ?? decodeFlushDocumentEditsResponse(value)
    ?? decodeEditorCommand(value)
    ?? decodeResolveImageSrcRequest(value)
    ?? decodeResolveWikiLinksRequest(value)
    ?? decodeResolveLocalLinksRequest(value)
    ?? decodeSaveImageFromClipboardRequest(value)
    ?? decodePreviewRenderRequest(value)
    ?? decodeExportSnapshotResponse(value);
}

export function decodeHostToWebviewMessage(value: unknown): HostToWebviewMessage | null {
  return decodeInitMessage(value)
    ?? decodeDocumentSyncMessage(value)
    ?? decodeSaveDocumentRevisionResponse(value)
    ?? decodeDocumentRevisionResponse(value)
    ?? decodeFlushDocumentEditsRequest(value)
    ?? decodeHostEditorEvent(value)
    ?? decodeHostConfigurationEvent(value)
    ?? decodeDiagnosticsChangedEvent(value)
    ?? decodeResolvedImageSrcResponse(value)
    ?? decodeResolvedWikiLinksResponse(value)
    ?? decodeResolvedLocalLinksResponse(value)
    ?? decodeSavedImagePathResponse(value)
    ?? decodePreviewRenderResponse(value)
    ?? decodeExportSnapshotRequest(value)
    ?? decodeGitBaselineChangedEvent(value);
}
