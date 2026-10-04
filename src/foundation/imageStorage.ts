export type ImageStoragePreferences = {
  readonly mode: 'default' | 'perDocument' | 'advanced';
  readonly folder: string;
  readonly rule: string;
};

export const defaultImageStorage: ImageStoragePreferences = {
  mode: 'default', folder: 'assets', rule: '${fileDirname}/assets'
};

export type ImageLocationState = {
  readonly preferences: ImageStoragePreferences;
  readonly documentPath: string | null;
  readonly documentName: string;
  readonly targetDirectory: string | null;
  readonly error: string | null;
  readonly legacy: boolean;
};

export function decodeImageStorage(value: unknown): ImageStoragePreferences | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.mode !== 'string' || !['default', 'perDocument', 'advanced'].includes(candidate.mode)
    || typeof candidate.folder !== 'string' || typeof candidate.rule !== 'string'
    || candidate.folder.length > 4096 || candidate.rule.length > 4096) return null;
  return { mode: candidate.mode as ImageStoragePreferences['mode'], folder: candidate.folder, rule: candidate.rule };
}

export function decodeImageLocationState(value: unknown): ImageLocationState | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const preferences = decodeImageStorage(candidate.preferences);
  if (!preferences || (candidate.documentPath !== null && typeof candidate.documentPath !== 'string')
    || typeof candidate.documentName !== 'string'
    || (candidate.targetDirectory !== null && typeof candidate.targetDirectory !== 'string')
    || (candidate.error !== null && typeof candidate.error !== 'string')
    || typeof candidate.legacy !== 'boolean') return null;
  return { preferences, documentPath: candidate.documentPath, documentName: candidate.documentName,
    targetDirectory: candidate.targetDirectory, error: candidate.error, legacy: candidate.legacy };
}
