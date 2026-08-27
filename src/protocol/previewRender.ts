import { decodeRequestResult, type RequestResult } from './requestResult';
import { decodeEditorStyleEnvironment, type EditorStyleEnvironment } from './editorStyleEnvironment';
import { isUiLanguage, type UiLanguage } from '../foundation/uiLanguage';

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
};

export type PreviewRenderValue = {
  readonly html: string;
  readonly hasMermaid: boolean;
  readonly styles: PreviewStyles;
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
    || !isUiLanguage(value.uiLanguage)) return null;
  const environment = decodeEditorStyleEnvironment(value.environment);
  if (environment === null) return null;
  return {
    type: 'requestPreviewRender',
    requestId: value.requestId,
    text: value.text,
    uiLanguage: value.uiLanguage,
    environment
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
          || typeof candidate.styles.light !== 'string') return null;
        return {
          html: candidate.html,
          hasMermaid: candidate.hasMermaid,
          styles: { dark: candidate.styles.dark, light: candidate.styles.light }
        };
      })
    : null;
  if (!isRecord(value)
    || value.type !== 'previewRenderResult'
    || !isNonEmptyString(value.requestId)
    || result === null) return null;
  return { type: 'previewRenderResult', requestId: value.requestId, result };
}
