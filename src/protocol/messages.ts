import { decodeEditorServiceRequest, decodeEditorServiceResponse, type EditorServiceRequest, type EditorServiceResponse } from './editorServices';
import { decodeSaveDocumentCopyRequest, decodeDocumentCopyResponse, type SaveDocumentCopyRequest, type DocumentCopyResponse } from './documentCopy';
import { decodeSaveImageFromClipboardRequest, decodeSavedImagePathResponse, type SaveImageFromClipboardRequest, type SavedImagePathResponse } from './clipboardImageSave';
import { decodeDiagnosticsChangedEvent, type DiagnosticsChangedEvent } from './diagnostics';
import { decodeDocumentSyncCommand, decodeDocumentSyncMessage, type DocumentSyncCommand, type DocumentSyncMessage } from './documentSync';
import { decodeDocumentRevisionRequest, decodeDocumentRevisionResponse, decodeSaveDocumentRevisionRequest, decodeSaveDocumentRevisionResponse, type DocumentRevisionRequest, type DocumentRevisionResponse, type SaveDocumentRevisionRequest, type SaveDocumentRevisionResponse } from './documentSession';
import { decodeFlushDocumentEditsRequest, decodeFlushDocumentEditsResponse, type FlushDocumentEditsRequest, type FlushDocumentEditsResponse } from './documentSaveFlush';
import { decodeEditorCommand, type EditorCommand } from './editorCommands';
import { decodeUpdateEditingPreferencesRequest, decodeUpdatedEditingPreferencesResponse, decodeEditingPreferencesChangedEvent, type UpdateEditingPreferencesRequest, type UpdatedEditingPreferencesResponse, type EditingPreferencesChangedEvent } from './editingPreferences';
import { decodeExportSnapshotRequest, decodeExportSnapshotResponse, type ExportSnapshotRequest, type ExportSnapshotResponse } from './exportSnapshot';
import { decodeGitBaselineChangedEvent, type GitBaselineChangedEvent } from './git';
import { decodeHostConfigurationEvent, type HostConfigurationEvent } from './hostConfigurationEvents';
import { decodeHostEditorEvent, type HostEditorEvent } from './hostEditorEvents';
import { decodeResolveImageSrcRequest, decodeResolvedImageSrcResponse, type ResolveImageSrcRequest, type ResolvedImageSrcResponse } from './imageResolution';
import { decodeResolveLocalLinksRequest, decodeResolvedLocalLinksResponse, type ResolveLocalLinksRequest, type ResolvedLocalLinksResponse } from './localLinkResolution';
import { decodePreviewRenderRequest, decodePreviewRenderResponse, type PreviewRenderRequest, type PreviewRenderResponse } from './previewRender';
import { decodeInitMessage, decodeReadyMessage, type InitMessage, type ReadyMessage } from './readyInit';
import { decodeResolveWikiLinksRequest, decodeResolvedWikiLinksResponse, type ResolveWikiLinksRequest, type ResolvedWikiLinksResponse } from './wikiLinkResolution';
import { decodeReadingPositionChangedMessage, type ReadingPositionChangedMessage } from './readingPosition';

export type WebviewToHostMessage =
  | EditorServiceRequest
  | ReadyMessage
  | DocumentSyncCommand
  | SaveDocumentRevisionRequest
  | DocumentRevisionRequest
  | FlushDocumentEditsResponse
  | EditorCommand
  | UpdateEditingPreferencesRequest
  | ReadingPositionChangedMessage
  | ResolveImageSrcRequest
  | ResolveWikiLinksRequest
  | ResolveLocalLinksRequest
  | SaveImageFromClipboardRequest
  | SaveDocumentCopyRequest
  | PreviewRenderRequest
  | ExportSnapshotResponse;

export type HostToWebviewMessage =
  | EditorServiceResponse
  | InitMessage
  | DocumentSyncMessage
  | SaveDocumentRevisionResponse
  | DocumentRevisionResponse
  | FlushDocumentEditsRequest
  | HostEditorEvent
  | HostConfigurationEvent
  | UpdatedEditingPreferencesResponse
  | EditingPreferencesChangedEvent
  | DiagnosticsChangedEvent
  | ResolvedImageSrcResponse
  | ResolvedWikiLinksResponse
  | ResolvedLocalLinksResponse
  | SavedImagePathResponse
  | DocumentCopyResponse
  | PreviewRenderResponse
  | ExportSnapshotRequest
  | GitBaselineChangedEvent;

export function decodeWebviewToHostMessage(value: unknown): WebviewToHostMessage | null {
  return decodeEditorServiceRequest(value)
    ?? decodeReadyMessage(value)
    ?? decodeDocumentSyncCommand(value)
    ?? decodeSaveDocumentRevisionRequest(value)
    ?? decodeDocumentRevisionRequest(value)
    ?? decodeFlushDocumentEditsResponse(value)
    ?? decodeEditorCommand(value)
    ?? decodeUpdateEditingPreferencesRequest(value)
    ?? decodeReadingPositionChangedMessage(value)
    ?? decodeResolveImageSrcRequest(value)
    ?? decodeResolveWikiLinksRequest(value)
    ?? decodeResolveLocalLinksRequest(value)
    ?? decodeSaveImageFromClipboardRequest(value)
    ?? decodeSaveDocumentCopyRequest(value)
    ?? decodePreviewRenderRequest(value)
    ?? decodeExportSnapshotResponse(value);
}

export function decodeHostToWebviewMessage(value: unknown): HostToWebviewMessage | null {
  return decodeEditorServiceResponse(value)
    ?? decodeInitMessage(value)
    ?? decodeDocumentSyncMessage(value)
    ?? decodeSaveDocumentRevisionResponse(value)
    ?? decodeDocumentRevisionResponse(value)
    ?? decodeFlushDocumentEditsRequest(value)
    ?? decodeHostEditorEvent(value)
    ?? decodeHostConfigurationEvent(value)
    ?? decodeUpdatedEditingPreferencesResponse(value)
    ?? decodeEditingPreferencesChangedEvent(value)
    ?? decodeDiagnosticsChangedEvent(value)
    ?? decodeResolvedImageSrcResponse(value)
    ?? decodeResolvedWikiLinksResponse(value)
    ?? decodeResolvedLocalLinksResponse(value)
    ?? decodeSavedImagePathResponse(value)
    ?? decodeDocumentCopyResponse(value)
    ?? decodePreviewRenderResponse(value)
    ?? decodeExportSnapshotRequest(value)
    ?? decodeGitBaselineChangedEvent(value);
}
