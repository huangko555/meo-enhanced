import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { normalizePreviewFontFamily } from '../foundation/previewFontFamily';

export type PreviewFontFile = Readonly<{ path: string; weight: number; style: 'normal' | 'italic' | 'oblique'; stretch: number }>;
const execute = promisify(execFile);
// The family is data in the child environment, never PowerShell source.
const windowsFontFiles = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
Add-Type -AssemblyName PresentationCore
$name=$env:MEO_PREVIEW_FONT_FAMILY
$family=[System.Windows.Media.FontFamily]::new($name)
$faces=@($family.GetTypefaces() | ForEach-Object {
  $glyph=$null
  if (-not $_.IsBoldSimulated -and -not $_.IsObliqueSimulated -and $_.TryGetGlyphTypeface([ref]$glyph) -and $glyph.FontUri.IsFile -and
      @(@($glyph.FamilyNames.Values) + @($glyph.Win32FamilyNames.Values) | Where-Object { $_ -ieq $name }).Count) {
    [PSCustomObject]@{ path=$glyph.FontUri.LocalPath; weight=$glyph.Weight.ToOpenTypeWeight();
      style=$glyph.Style.ToString().ToLowerInvariant(); stretch=$glyph.Stretch.ToOpenTypeStretch() }
  }
})
ConvertTo-Json -InputObject $faces -Compress`;

export async function readSystemPreviewFontFiles(family: string): Promise<readonly PreviewFontFile[]> {
  if (process.platform !== 'win32' || !normalizePreviewFontFamily(family)) return [];
  const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsFontFiles], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, MEO_PREVIEW_FONT_FAMILY: family }
  });
  const entries: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '') || '[]');
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry): entry is PreviewFontFile => entry && typeof entry.path === 'string'
    && ['.ttf', '.otf', '.ttc', '.otc'].includes(extname(entry.path).toLowerCase())
    && Number.isInteger(entry.weight) && entry.weight >= 1 && entry.weight <= 1000
    && ['normal', 'italic', 'oblique'].includes(entry.style)
    && Number.isInteger(entry.stretch) && entry.stretch >= 1 && entry.stretch <= 9);
}

/** Browsers use only the first TTC face, even with a URL fragment. Extract the matching SFNT. */
function collectionFace(data: Buffer, family: string, face: PreviewFontFile): Buffer {
  const count = data.readUInt32BE(8);
  if (count > 1024 || 12 + count * 4 > data.length) throw new Error('Invalid font collection');
  for (let index = 0; index < count; index++) {
    const offset = data.readUInt32BE(12 + index * 4);
    const tableCount = data.readUInt16BE(offset + 4);
    if (tableCount > 256 || offset + 12 + tableCount * 16 > data.length) throw new Error('Invalid font tables');
    const tables = Array.from({ length: tableCount }, (_, table) => {
      const record = offset + 12 + table * 16;
      const start = data.readUInt32BE(record + 8), length = data.readUInt32BE(record + 12);
      if (start + length > data.length) throw new Error('Invalid font table range');
      return { tag: data.toString('ascii', record, record + 4), record, start, length };
    });
    const names = tables.find(table => table.tag === 'name');
    const os2 = tables.find(table => table.tag === 'OS/2');
    if (!names || !os2 || os2.length < 64) continue;
    const weight = data.readUInt16BE(os2.start + 4), stretch = data.readUInt16BE(os2.start + 6);
    const flags = data.readUInt16BE(os2.start + 62);
    const style = flags & 1 ? 'italic' : flags & 512 ? 'oblique' : 'normal';
    if (weight !== face.weight || stretch !== face.stretch || style !== face.style) continue;
    const nameCount = data.readUInt16BE(names.start + 2), strings = names.start + data.readUInt16BE(names.start + 4);
    let matches = false;
    for (let name = 0; name < nameCount; name++) {
      const record = names.start + 6 + name * 12;
      if (record + 12 > names.start + names.length) break;
      const platform = data.readUInt16BE(record), id = data.readUInt16BE(record + 6);
      if (![1, 16].includes(id) || ![0, 3].includes(platform)) continue;
      const start = strings + data.readUInt16BE(record + 10), length = data.readUInt16BE(record + 8);
      if (start + length > names.start + names.length || length % 2) continue;
      const value = Buffer.from(data.subarray(start, start + length)).swap16().toString('utf16le');
      if (value.toLowerCase() === family.toLowerCase()) matches = true;
    }
    if (!matches) continue;
    const headerLength = 12 + tableCount * 16;
    const result = Buffer.alloc(headerLength + tables.reduce((size, table) => size + ((table.length + 3) & ~3), 0));
    data.copy(result, 0, offset, offset + 12);
    let next = headerLength, head = 0;
    for (const [tableIndex, table] of tables.entries()) {
      const record = 12 + tableIndex * 16;
      data.copy(result, record, table.record, table.record + 16);
      result.writeUInt32BE(next, record + 8);
      data.copy(result, next, table.start, table.start + table.length);
      if (table.tag === 'head') { head = next; result.writeUInt32BE(0, head + 8); }
      next += (table.length + 3) & ~3;
    }
    if (!head) throw new Error('Missing font head');
    let checksum = 0;
    for (let byte = 0; byte < result.length; byte += 4) checksum = (checksum + result.readUInt32BE(byte)) >>> 0;
    result.writeUInt32BE((0xb1b0afba - checksum) >>> 0, head + 8);
    return result;
  }
  throw new Error('Font collection face unavailable');
}

/** Only explicit refresh enables file sources; normal startup keeps native font loading. */
export function createPreviewFontFiles(read: (family: string) => Promise<readonly PreviewFontFile[]> = readSystemPreviewFontFiles) {
  let enabled = false, disposed = false;
  let revision = 0;
  let directory: Promise<string> | undefined;
  let nextFile = 0;
  const pending = new Map<string, Promise<readonly PreviewFontFile[]>>();
  const work = new Set<Promise<readonly PreviewFontFile[]>>();
  const stretchValues = [50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200];
  const resolve = (family: string) => {
    let result = pending.get(family);
    if (!result) {
      result = read(family).then(async faces => {
        const unique = [...new Map(faces.map(face => [JSON.stringify(face), face])).values()];
        return Promise.all(unique.map(async face => {
          if (!['.ttc', '.otc'].includes(extname(face.path).toLowerCase())) return face;
          const data = collectionFace(await readFile(face.path), family, face);
          directory ??= mkdtemp(join(tmpdir(), 'meo-preview-fonts-'));
          const path = join(await directory, `${++nextFile}.ttf`);
          if (disposed) throw new Error('Preview fonts disposed');
          await writeFile(path, data);
          return { ...face, path };
        }));
      }).catch(() => { if (pending.get(family) === result) pending.delete(family); return []; });
      pending.set(family, result);
      work.add(result);
      void result.finally(() => work.delete(result!));
    }
    return result;
  };
  return {
    refresh() { enabled = true; revision++; pending.clear(); },
    async styles(families: readonly string[], resourceUrl: (path: string) => string): Promise<string> {
      if (!enabled || disposed) return '';
      const sourceRevision = revision;
      const values = [...new Set(families.map(normalizePreviewFontFamily).filter((family): family is string => Boolean(family)))];
      return (await Promise.all(values.map(async family => (await resolve(family)).map(face => {
        if (disposed) return '';
        const url = new URL(resourceUrl(face.path));
        if (url.protocol !== 'data:') url.searchParams.set('meo-font-refresh', String(sourceRevision));
        return `@font-face{font-family:${JSON.stringify(family)};src:url(${JSON.stringify(url.toString())});font-display:swap;font-weight:${face.weight};font-style:${face.style};font-stretch:${stretchValues[face.stretch - 1]}%;}`;
      }).join('\n')))).join('\n');
    },
    async dispose() {
      disposed = true;
      await Promise.allSettled(work);
      pending.clear();
      const path = await directory?.catch(() => undefined);
      if (path) await rm(path, { recursive: true, force: true });
    }
  };
}
