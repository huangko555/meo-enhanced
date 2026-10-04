import type { ImageStoragePreferences } from '../foundation/imageStorage';

export const imagePathVariables = ['fileDirname', 'fileBasename', 'fileBasenameNoExtension', 'fileExtname'] as const;
export type ImagePathContext = Readonly<Record<typeof imagePathVariables[number], string>>;

/** ~/ is a fixed basic-UI marker, never a home-directory expansion. */
export function expandImageStorage(preferences: ImageStoragePreferences, context: ImagePathContext): string {
  if (preferences.mode !== 'advanced') {
    const folder = preferences.folder.trim().replace(/\\/g, '/');
    if (!folder || folder.startsWith('/') || /^[a-z]:/i.test(folder)
      || folder.startsWith('~') || folder.includes('${') || folder.split('/').includes('..')) {
      throw new Error('Use a folder inside the document directory; use Advanced for other locations.');
    }
    return folder + (preferences.mode === 'perDocument' ? '/' + context.fileBasenameNoExtension : '');
  }
  const rule = preferences.rule.trim();
  if (!rule) throw new Error('Enter an image folder path.');
  if (rule.startsWith('~')) throw new Error('Use a relative path or an absolute path; ~/ is only a display marker.');
  if (rule.replace(/\$\{[^}]*\}/g, '').includes('${')) throw new Error('Invalid image path variable.');
  return rule.replace(/\$\{([^}]*)\}/g, (_match, variable: string) => {
    if (!imagePathVariables.includes(variable as typeof imagePathVariables[number])) throw new Error('Unknown image path variable: ' + variable);
    return context[variable as keyof ImagePathContext];
  });
}
