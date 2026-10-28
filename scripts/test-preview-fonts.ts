import assert from 'node:assert/strict';
import { mergePreviewFonts, decodePreviewFonts } from '../src/foundation/previewFonts';
import { createAppearanceSettingsOwner } from '../src/host/appearanceSettings';
import { createPreviewFonts } from '../src/host/previewFonts';
import { readSystemPreviewFontFiles } from '../src/host/previewFontFiles';
import { decodeHostToWebviewMessage, decodeWebviewToHostMessage } from '../src/protocol/messages';
import { decodeEditorStyleEnvironment } from '../src/protocol/editorStyleEnvironment';
import { decodePreviewPresetPreferences, getPreviewPreset } from '../src/foundation/previewPresets';
import { createPreviewPresetPreferences } from '../src/host/previewPresetPreferences';
import { buildPresetPreviewStyles } from '../src/preview/presetStyles';
import { createPreviewFontsTransport } from '../webview/src/adapters/previewFontsTransport';

const fonts = [{ family: 'Example Sans', aliases: ['示例字体'] }, { family: 'example sans', aliases: ['Example'] }];
assert.deepEqual(mergePreviewFonts(fonts), [{ family: 'Example Sans', aliases: ['示例字体', 'Example'] }]);
const localizedFont = { family: 'Microsoft YaHei', aliases: ['微软雅黑'], localizedFamilies: { 'zh-CN': '微软雅黑' } };
assert.deepEqual(decodePreviewFonts([localizedFont]), [localizedFont], 'Localized display names survive the catalog decoder');
assert.deepEqual(mergePreviewFonts([{ family: localizedFont.family, aliases: [] }, localizedFont]), [localizedFont], 'Merging a duplicate family retains its localized name');
for (const localizedFamilies of [null, [], { 'zh-CN': 12 }, { 'zh-CN': 'Bad; name' }, { 'zh-CN': '' }, { ja: '日本語' }]) {
  assert.equal(decodePreviewFonts([{ ...localizedFont, localizedFamilies }]), null, 'Localized names are validated at the Protocol boundary');
}
assert.deepEqual(decodeHostToWebviewMessage({ type: 'previewFontsResult', requestId: 'localized', result: { ok: true, value: [localizedFont] } }),
  { type: 'previewFontsResult', requestId: 'localized', result: { ok: true, value: [localizedFont] } });
assert.equal(decodePreviewFonts([{ family: 'Bad; name', aliases: [] }]), null);
assert.equal(decodePreviewFonts([{ family: 'Good', aliases: [12] }]), null);
assert.equal(decodeWebviewToHostMessage({ type: 'getPreviewFonts', requestId: '', refresh: false }), null);
assert.equal(decodeWebviewToHostMessage({ type: 'getPreviewFonts', requestId: 'fonts', refresh: 'yes' }), null);
assert.equal(decodeHostToWebviewMessage({ type: 'previewFontsResult', requestId: 'fonts', result: { ok: true, value: [{ family: 'Bad; name', aliases: [] }] } }), null);
assert.equal(decodeEditorStyleEnvironment({ previewFontFamily: '', previewCodeFontFamily: 'Bad; name' }), null);
assert.equal(decodeWebviewToHostMessage({ type: 'setPreviewCodeFontFamily', fontFamily: 'Bad; name' }), null);
assert.deepEqual(decodeWebviewToHostMessage({ type: 'setPreviewCodeFontFamily', fontFamily: ' Consolas ' }), { type: 'setPreviewCodeFontFamily', fontFamily: 'Consolas' });
assert.equal(decodePreviewPresetPreferences({ whitey: { appearance: 'auto', contentWidth: 'responsive', codeFontFamily: 'Bad; name' } }), null);

let calls = 0;
let fail = false;
const catalog = createPreviewFonts(async () => { calls++; if (fail) throw new Error('Unavailable'); return fonts; });
const [first, second] = await Promise.all([catalog.read(), catalog.read(true)]);
assert.deepEqual(first, second); assert.equal(calls, 1, 'Concurrent panels share one query');
await catalog.read(); assert.equal(calls, 1, 'New documents reuse the session catalog');
fail = true; await assert.rejects(catalog.read(true));
assert.deepEqual(await catalog.read(), first, 'A failed refresh retains the previous catalog');
fail = false; await catalog.read(true); assert.equal(calls, 3, 'Explicit refresh retries');

let fileReads = 0, enumerationFails = false;
const fileCatalog = createPreviewFonts(async () => { if (enumerationFails) throw new Error('Unavailable'); return fonts; }, async family => {
  fileReads++;
  return [{ path: `/fonts/${family}.ttf`, weight: 700, style: 'italic', stretch: 5 }];
});
const fileUrl = () => 'https://example.invalid/font.ttf';
assert.equal(await fileCatalog.styles(['Example Sans'], fileUrl), '', 'Normal startup keeps native fonts without reading files');
await fileCatalog.read();
assert.equal(await fileCatalog.styles(['Example Sans'], fileUrl), '');
assert.equal(fileReads, 0);
await fileCatalog.read(true);
const [firstStyles, concurrentStyles] = await Promise.all([
  fileCatalog.styles(['Example Sans', 'Example Sans', 'Bad; family', ''], fileUrl), fileCatalog.styles(['Example Sans'], fileUrl)
]);
assert.equal(fileReads, 1, 'Panels and body/code choices share one file resolution per family');
assert.equal(firstStyles, concurrentStyles);
assert.match(firstStyles, /font-weight:700;font-style:italic;font-stretch:100%/);
assert.match(firstStyles, /font-display:swap/);
assert.match(firstStyles, /meo-font-refresh=1/);
enumerationFails = true; await assert.rejects(fileCatalog.read(true));
assert.equal(await fileCatalog.styles(['Example Sans'], fileUrl), firstStyles, 'A failed refresh retains working font sources');
enumerationFails = false; await fileCatalog.read(true);
assert.match(await fileCatalog.styles(['Example Sans'], fileUrl), /meo-font-refresh=2/, 'Refresh invalidates file metadata and browser resource caches');
assert.equal(fileReads, 2);
await fileCatalog.dispose();
assert.equal(await fileCatalog.styles(['Example Sans'], fileUrl), '', 'Disposed catalogs cannot publish font resources');
if (process.platform === 'win32') {
  assert.ok((await readSystemPreviewFontFiles('Arial')).length > 0, 'Windows file discovery resolves a real installed family');
  assert.deepEqual(await readSystemPreviewFontFiles('MEO Missing Font 923689'), [], 'A missing family must not expose fallback font files');
}
const requests: any[] = [];
const transport = createPreviewFontsTransport(request => requests.push(request));
const pending = transport.request(false);
transport.accept({ type: 'previewFontsResult', requestId: 'stale', result: { ok: true, value: [] } });
transport.accept({ type: 'previewFontsResult', requestId: requests[0].requestId, result: { ok: true, value: first } });
assert.deepEqual(await pending, first);
const disposed = transport.request(true); transport.dispose(); assert.equal(await disposed, null);
assert.equal(await transport.request(false), null);

const configuration = new Map<string, unknown>();
const legacyState = new Map<string, unknown>();
const settingsStore = {
  readConfiguration: (key: string) => ({ value: configuration.get(key), explicit: configuration.has(key), globalValue: configuration.get(key) }),
  updateConfiguration: async (key: string, value: unknown) => { configuration.set(key, value); },
  readLegacy: (key: string) => legacyState.get(key),
  updateLegacy: async (key: string, value: unknown) => { legacyState.set(key, value); }
};
const appearance = await createAppearanceSettingsOwner(settingsStore);
assert.equal(appearance.getPreviewCodeFontFamily(), '');
await appearance.setPreviewCodeFontFamily('Consolas');
assert.equal((await createAppearanceSettingsOwner(settingsStore)).getPreviewCodeFontFamily(), 'Consolas', 'Default code font survives owner restart');
await appearance.setPreviewCodeFontFamily('Bad; name');
assert.equal(appearance.getPreviewCodeFontFamily(), 'Consolas');

let preferences: any;
const owner = () => createPreviewPresetPreferences({ readStored: () => preferences, writeStored: async value => { preferences = value; }, getPreset: getPreviewPreset });
const initial = { appearance: 'auto' as const, contentWidth: 'responsive' as const, fontFamily: 'Arial', codeFontFamily: '' };
const currentOwner = owner();
await Promise.all([currentOwner.update('whitey', { codeFontFamily: 'Consolas' }, initial), currentOwner.update('whitey', { fontFamily: 'Georgia' }, initial)]);
assert.equal((await owner().read())?.whitey?.fontFamily, 'Georgia');
assert.equal((await owner().read())?.whitey?.codeFontFamily, 'Consolas');
await owner().update('github-readme', { fontFamily: 'Arial', codeFontFamily: 'Consolas' }, initial);
assert.equal((await owner().read())?.['github-readme'], undefined, 'GitHub restoration rejects both font overrides');

for (const preset of ['default', 'newsprint', 'whitey', 'obsidian-minimal'] as const) {
  const css = buildPresetPreviewStyles(preset, { previewFontFamily: 'Georgia', previewCodeFontFamily: 'Consolas' }, 'light');
  assert.ok(css.includes('"Georgia"') && css.includes('"Consolas"'), `${preset} receives separate body and code families`);
  assert.ok(css.includes('code:not(pre code)'), `${preset} retains separate inline code typography`);
}
const github = buildPresetPreviewStyles('github-readme', { previewFontFamily: 'MEO Body Override', previewCodeFontFamily: 'MEO Code Override' }, 'light');
assert.ok(!github.includes('MEO Body Override') && !github.includes('MEO Code Override'));
console.log('Preview font catalog, protocol, caching, persistence and typography contracts passed.');
