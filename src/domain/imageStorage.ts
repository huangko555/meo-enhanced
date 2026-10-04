import type { ImageStoragePreferences } from '../foundation/imageStorage';

export const imagePathVariables = ['fileDirname', 'fileBasename', 'fileBasenameNoExtension', 'fileExtname'] as const;
export type ImagePathContext = Readonly<Record<typeof imagePathVariables[number], string>>;

/** Basic folders are anchored to the Markdown directory; advanced rules resolve against the same directory. */
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
  if (rule.startsWith('~')) throw new Error('Home-directory paths (~) are not supported; use a path relative to the document or an absolute path.');
  if (rule.replace(/\$\{[^}]*\}/g, '').includes('${')) throw new Error('Invalid image path variable.');
  return rule.replace(/\$\{([^}]*)\}/g, (_match, variable: string) => {
    if (!imagePathVariables.includes(variable as typeof imagePathVariables[number])) throw new Error('Unknown image path variable: ' + variable);
    return context[variable as keyof ImagePathContext];
  });
}
