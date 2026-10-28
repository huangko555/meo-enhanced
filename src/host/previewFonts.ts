import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodePreviewFonts, mergePreviewFonts, type PreviewFont } from '../foundation/previewFonts';
import { createPreviewFontFiles, type PreviewFontFile } from './previewFontFiles';

const execute = promisify(execFile);
// Static commands only: font names never enter shell source or command arguments.
const windowsFonts = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); Add-Type -AssemblyName System.Drawing; $collection=[System.Drawing.Text.InstalledFontCollection]::new(); try { @($collection.Families | ForEach-Object { $family=$_; [PSCustomObject]@{ family=$family.GetName(1033); aliases=@(@($family.Name,$family.GetName(2052)) | Select-Object -Unique); localizedFamilies=@{'zh-CN'=$family.GetName(2052)} } }) | ConvertTo-Json -Compress -Depth 4 } finally { $collection.Dispose() }`;

export async function readSystemPreviewFonts(platform = process.platform): Promise<readonly PreviewFont[]> {
  const options = { encoding: 'utf8' as const, timeout: 10000, maxBuffer: 2 * 1024 * 1024, windowsHide: true };
  let fonts: readonly PreviewFont[] | null;
  if (platform === 'win32') {
    const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsFonts], options);
    const entries: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    fonts = Array.isArray(entries) ? entries.flatMap(entry => decodePreviewFonts([entry]) ?? []) : null;
  } else if (platform === 'linux') {
    const { stdout } = await execute('fc-list', ['--format', '%{family}\n'], options);
    fonts = stdout.split(/\r?\n/).filter(Boolean).map(line => {
      const [family, ...aliases] = line.split(',').map(value => value.trim());
      return { family, aliases };
    });
  } else if (platform === 'darwin') {
    const { stdout } = await execute('osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit'); JSON.stringify(ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies))"], options);
    const names: unknown = JSON.parse(stdout);
    fonts = Array.isArray(names) ? decodePreviewFonts(names.map(family => ({ family, aliases: [] }))) : null;
  } else throw new Error('System font enumeration unavailable');
  const merged = fonts && mergePreviewFonts(fonts);
  if (!merged?.length) throw new Error('System font enumeration unavailable');
  return merged;
}

/** One catalog per local extension session. Failure retains the last successful catalog. */
export function createPreviewFonts(read: () => Promise<readonly PreviewFont[]>, readFiles?: (family: string) => Promise<readonly PreviewFontFile[]>) {
  const files = createPreviewFontFiles(readFiles);
  let cached: readonly PreviewFont[] | undefined;
  let pending: Promise<readonly PreviewFont[]> | undefined;
  let refreshRequested = false;
  return {
    read(refresh = false): Promise<readonly PreviewFont[]> {
      refreshRequested ||= refresh;
      if (pending) return pending;
      if (cached && !refresh) return Promise.resolve(cached);
      pending = read().then(fonts => {
        cached = mergePreviewFonts(fonts);
        if (refreshRequested) files.refresh();
        return cached;
      }).finally(() => { pending = undefined; refreshRequested = false; });
      return pending;
    },
    styles: files.styles,
    dispose: files.dispose
  };
}
