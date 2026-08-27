import { assessLargeDocument } from '../foundation/largeDocument';
export {
  assessLargeDocument,
  type LargeDocumentAssessment,
  type LargeDocumentDimensions
} from '../foundation/largeDocument';

export type InitialEditorMode = 'live' | 'source' | 'preview';

type InitialEditorModeInput = {
  readonly text: string;
  readonly persistedMode: InitialEditorMode | null;
  readonly documentMode: InitialEditorMode | null;
  readonly optimizationEnabled: boolean;
};

/** Selects the initial mode only; later user intent remains owned by EditorModeApplication. */
export function selectInitialEditorMode(input: InitialEditorModeInput): InitialEditorMode {
  if (!input.optimizationEnabled) return input.persistedMode ?? 'live';
  if (assessLargeDocument(input.text).preferSource) return input.documentMode ?? 'source';
  return input.persistedMode ?? 'live';
}
