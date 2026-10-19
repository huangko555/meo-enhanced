import { decodePreviewFontsRequest, decodePreviewFontsResponse, type PreviewFontsRequest, type PreviewFontsResponse } from './previewFonts';
import { decodeEditorServiceRequest, decodeEditorServiceResponse, type EditorServiceRequest, type EditorServiceResponse } from './editorServices';
import { decodeSaveDocumentCopyRequest, decodeDocumentCopyResponse, type SaveDocumentCopyRequest, type DocumentCopyResponse } from './documentCopy';
import { decodeSaveDocumentAsRequest, decodeDocumentSaveAsResponse, type SaveDocumentAsRequest, type DocumentSaveAsResponse } from './documentSaveAs';
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
import { decodePreviewDocumentRequest, decodePreviewDocumentResponse, type PreviewDocumentRequest, type PreviewDocumentResponse } from './previewDocument';
import { decodeInitMessage, decodeReadyMessage, type InitMessage, type ReadyMessage } from './readyInit';
import { decodeResolveWikiLinksRequest, decodeResolvedWikiLinksResponse, type ResolveWikiLinksRequest, type ResolvedWikiLinksResponse } from './wikiLinkResolution';
import { decodeReadingPositionChangedMessage, type ReadingPositionChangedMessage } from './readingPosition';
import { decodeWebviewVisibilityRequest, decodeWebviewVisibilityResponse, type WebviewVisibilityRequest, type WebviewVisibilityResponse } from './webviewVisibility';
import { decodePreviewPresetsChanged, decodePreviewPresetRequest, decodePreviewPresetResponse, type PreviewPresetRequest, type PreviewPresetResponse, type OpenPreviewPresetSettings, type PreviewPresetsChanged } from './previewPresets';

import { decodeImageLocationRequest, decodeImageLocationResponse, decodeImageStorageChangedEvent, type ImageLocationRequest, type ImageLocationResponse, type ImageStorageChangedEvent } from './imageStorage';
import { decodeUpdateUiColorsRequest, decodeUiColorsResult, type UpdateUiColorsRequest, type UiColorsResult } from './uiColors';

export type WebviewToHostMessage =
  | PreviewFontsRequest
  | WebviewVisibilityRequest
  | UpdateUiColorsRequest
  | PreviewPresetRequest
  | ImageLocationRequest
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
  | SaveDocumentAsRequest
  | PreviewRenderRequest
  | PreviewDocumentRequest
  | ExportSnapshotResponse;

export type HostToWebviewMessage =
  | PreviewFontsResponse
  | WebviewVisibilityResponse
  | UiColorsResult
  | PreviewPresetResponse
  | OpenPreviewPresetSettings
  | PreviewPresetsChanged
  | ImageLocationResponse
  | ImageStorageChangedEvent
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
  | DocumentSaveAsResponse
  | PreviewRenderResponse
  | PreviewDocumentResponse
  | ExportSnapshotRequest
  | GitBaselineChangedEvent;

export function decodeWebviewToHostMessage(value: unknown): WebviewToHostMessage | null {
  return decodePreviewFontsRequest(value)
    ?? decodeWebviewVisibilityRequest(value)
    ?? decodePreviewPresetRequest(value)
    ?? decodeImageLocationRequest(value)
    ?? decodeUpdateUiColorsRequest(value)
    ?? decodeEditorServiceRequest(value)
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
    ?? decodeSaveDocumentAsRequest(value)
    ?? decodePreviewRenderRequest(value)
    ?? decodePreviewDocumentRequest(value)
    ?? decodeExportSnapshotResponse(value);
}

export function decodeHostToWebviewMessage(value: unknown): HostToWebviewMessage | null {
  if (value && typeof value === 'object' && 'type' in value && value.type === 'openPreviewPresetSettings') return { type: 'openPreviewPresetSettings' };
  return decodePreviewFontsResponse(value)
    ?? decodeWebviewVisibilityResponse(value)
    ?? decodePreviewPresetsChanged(value)
    ?? decodeUiColorsResult(value)
    ?? decodePreviewPresetResponse(value)
    ?? decodeImageLocationResponse(value)
    ?? decodeImageStorageChangedEvent(value)
    ?? decodeEditorServiceResponse(value)
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
    ?? decodeDocumentSaveAsResponse(value)
    ?? decodePreviewRenderResponse(value)
    ?? decodePreviewDocumentResponse(value)
    ?? decodeExportSnapshotRequest(value)
    ?? decodeGitBaselineChangedEvent(value);
}
