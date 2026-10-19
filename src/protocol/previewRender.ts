import { decodeRequestResult, type RequestResult } from './requestResult';
import { decodeEditorStyleEnvironment, type EditorStyleEnvironment } from './editorStyleEnvironment';
import { isUiLanguage, type UiLanguage } from '../foundation/uiLanguage';
import { isPreviewPresetId, type PreviewPresetId, type PreviewContentWidth } from '../foundation/previewPresets';
import type { PreviewDocumentManifest } from '../foundation/previewDocument';
import { decodePreviewDocumentManifest } from './previewDocument';

export const PREVIEW_RENDER_TIMEOUT_MS = 15_000;

export type PreviewAppearance = 'dark' | 'light';

export type PreviewStyles = Record<PreviewAppearance, string>;

export type PreviewStyleEnvironment = EditorStyleEnvironment;

export type PreviewRenderRequest = {
  readonly type: 'requestPreviewRender';
  readonly requestId: string;
  readonly text: string;
  readonly uiLanguage: UiLanguage;
  readonly environment: PreviewStyleEnvironment;
  readonly preset?: PreviewPresetId;
  readonly presetRevision?: string;
  readonly contentWidth?: PreviewContentWidth;
  readonly window?: { readonly anchorLine: number };
};

export type PreviewRenderValue = {
  readonly html: string;
  readonly hasMermaid: boolean;
  readonly styles: PreviewStyles;
  readonly preset?: PreviewPresetId;
  readonly presetRevision?: string;
  readonly document?: PreviewDocumentManifest;
};

export type PreviewRenderResolution = RequestResult<PreviewRenderValue>;

export type PreviewRenderResponse = {
  readonly type: 'previewRenderResult';
  readonly requestId: string;
  readonly result: PreviewRenderResolution;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function decodePreviewRenderRequest(value: unknown): PreviewRenderRequest | null {
  if (!isRecord(value)
    || value.type !== 'requestPreviewRender'
    || !isNonEmptyString(value.requestId)
    || typeof value.text !== 'string'
    || !isUiLanguage(value.uiLanguage)
    || (value.preset !== undefined && !isPreviewPresetId(value.preset))
    || (value.presetRevision !== undefined && (typeof value.presetRevision !== 'string' || !/^[a-f0-9]{64}$/.test(value.presetRevision)))
    || (value.contentWidth !== undefined && value.contentWidth !== 'responsive' && value.contentWidth !== 'reference')
    || (value.window !== undefined && (!isRecord(value.window) || !Number.isSafeInteger(value.window.anchorLine)
      || Number(value.window.anchorLine) < 1))) return null;
  const environment = decodeEditorStyleEnvironment(value.environment);
  if (environment === null) return null;
  return {
    type: 'requestPreviewRender',
    requestId: value.requestId,
    text: value.text,
    uiLanguage: value.uiLanguage,
    environment,
    ...(value.window === undefined ? {} : { window: value.window as { anchorLine: number } }),
    ...(value.presetRevision === undefined ? {} : { presetRevision: value.presetRevision as string }),
    ...(value.preset === undefined ? {} : { preset: value.preset as PreviewPresetId }),
    ...(value.contentWidth === undefined ? {} : { contentWidth: value.contentWidth as PreviewContentWidth })
  };
}

export function decodePreviewRenderResponse(value: unknown): PreviewRenderResponse | null {
  const result = isRecord(value)
    ? decodeRequestResult(value.result, (candidate): PreviewRenderValue | null => {
        if (!isRecord(candidate)
          || typeof candidate.html !== 'string'
          || typeof candidate.hasMermaid !== 'boolean'
          || !isRecord(candidate.styles)
          || typeof candidate.styles.dark !== 'string'
          || typeof candidate.styles.light !== 'string'
          || (candidate.preset !== undefined && !isPreviewPresetId(candidate.preset))
          || (candidate.presetRevision !== undefined && (typeof candidate.presetRevision !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.presetRevision)))
          || (candidate.document !== undefined && decodePreviewDocumentManifest(candidate.document) === null)) return null;
        return {
          html: candidate.html,
          hasMermaid: candidate.hasMermaid,
          styles: { dark: candidate.styles.dark, light: candidate.styles.light },
          ...(candidate.document === undefined ? {} : { document: candidate.document as PreviewDocumentManifest }),
          ...(candidate.presetRevision === undefined ? {} : { presetRevision: candidate.presetRevision as string }),
          ...(candidate.preset === undefined ? {} : { preset: candidate.preset as PreviewPresetId })
        };
      })
    : null;
  if (!isRecord(value)
    || value.type !== 'previewRenderResult'
    || !isNonEmptyString(value.requestId)
    || result === null) return null;
  return { type: 'previewRenderResult', requestId: value.requestId, result };
}
