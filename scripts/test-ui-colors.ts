import assert from 'node:assert/strict';
import { decodeUiColors, normalizeUiColor, uiColorKeys } from '../src/foundation/uiColors';
import { defaultUiColors } from '../webview/src/themes/defaultUiColors';
import { createAppearanceSettingsOwner, UI_COLORS_SETTING_KEY, type AppearanceSettingsStore } from '../src/host/appearanceSettings';
import { decodeHostToWebviewMessage, decodeWebviewToHostMessage } from '../src/protocol/messages';
import { createUiColorsTransport } from '../webview/src/adapters/uiColorsTransport';
import { UI_COLORS_TIMEOUT_MS, type UpdateUiColorsRequest } from '../src/protocol/uiColors';

assert.equal(normalizeUiColor(' #aBc '), '#AABBCC');
assert.equal(normalizeUiColor('#12ab34'), '#12AB34');
for (const profile of Object.values(defaultUiColors)) {
  assert.deepEqual(Object.keys(profile).sort(), [...uiColorKeys].sort(), 'bundled defaults contain exactly the configurable base inputs');
  for (const color of Object.values(profile)) assert.equal(normalizeUiColor(color), color, 'bundled defaults are normalized HEX colors');
}
assert.deepEqual(decodeUiColors(defaultUiColors), defaultUiColors);
for (const invalid of ['red', '#1234', '#12345678', 'var(--color)', '#12345G']) assert.equal(normalizeUiColor(invalid), null);
assert.deepEqual(decodeUiColors({ dark: { text: '#Abc' } }), { light: {}, dark: { text: '#AABBCC' } });
for (const invalid of [null, [], { surface: '#123' }, { dark: [] }, { light: { unknown: '#123' } }, { dark: { text: 'red' } }]) {
  assert.equal(decodeUiColors(invalid), null);
  assert.equal(decodeWebviewToHostMessage({ type: 'updateUiColors', requestId: 'test', colors: invalid }), null);
  assert.equal(decodeHostToWebviewMessage({ type: 'uiColorsChanged', colors: invalid }), null);
}
const colors = { light: { accent: '#226644', documentBackground: '#FFFAEE', link: '#0055AA' }, dark: { textEmphasis: '#99CCAA', link: '#66CCFF', documentBackground: '#182C38' } };
assert.deepEqual(decodeUiColors({ dark: { textEmphasis: '#99CCAA' } }), { light: {}, dark: { textEmphasis: '#99CCAA' } }, 'existing heading overrides survive without forcing a link override');
assert.deepEqual(decodeWebviewToHostMessage({ type: 'updateUiColors', requestId: 'save', colors }), { type: 'updateUiColors', requestId: 'save', colors });
assert.equal(decodeWebviewToHostMessage({ type: 'updateUiColors', requestId: '', colors }), null);
assert.equal(decodeHostToWebviewMessage({ type: 'uiColorsResult', requestId: 'save', result: { ok: true, value: { dark: { text: 'red' } } } }), null);

const configuration = new Map<string, unknown>();
let fail = false;
const store: AppearanceSettingsStore = {
  readConfiguration: key => ({ value: configuration.get(key), explicit: configuration.has(key), globalValue: configuration.get(key) }),
  updateConfiguration: async (key, value) => { if (fail) throw new Error('fixture write failure'); configuration.set(key, value); },
  readLegacy: () => undefined, updateLegacy: async () => {}
};
let owner = await createAppearanceSettingsOwner(store);
assert.deepEqual(owner.getUiColors(), { light: {}, dark: {} });
assert.deepEqual(await owner.setUiColors(colors), colors);
owner = await createAppearanceSettingsOwner(store);
assert.deepEqual(owner.getUiColors(), colors, 'a fresh owner reads the persisted profiles');
fail = true;
await assert.rejects(owner.setUiColors({ light: {}, dark: {} }), /fixture write failure/);
assert.deepEqual(owner.getUiColors(), colors, 'failure retains the authoritative configuration');
fail = false;
configuration.set(UI_COLORS_SETTING_KEY, { dark: { text: 'invalid' } });
assert.deepEqual(owner.getUiColors(), { light: {}, dark: {} });
await assert.rejects(owner.setUiColors({ light: {}, dark: { text: 'red' } }), /Invalid UI colors/);

const sent: UpdateUiColorsRequest[] = [];
const transport = createUiColorsTransport(request => sent.push(request));
const first = transport.update(colors); const second = transport.update({ light: {}, dark: {} });
assert.notEqual(sent[0].requestId, sent[1].requestId);
transport.accept({ type: 'uiColorsResult', requestId: 'unknown', result: { ok: true, value: colors } });
transport.accept({ type: 'uiColorsResult', requestId: sent[1].requestId, result: { ok: true, value: { light: {}, dark: {} } } });
assert.deepEqual(await second, { ok: true, value: { light: {}, dark: {} } });
transport.accept({ type: 'uiColorsResult', requestId: sent[1].requestId, result: { ok: false, error: { code: 'operation-failed', message: 'duplicate' } } });
transport.dispose(); assert.equal((await first).ok, false);
transport.accept({ type: 'uiColorsResult', requestId: sent[0].requestId, result: { ok: true, value: colors } });
assert.equal((await transport.update(colors)).ok, false);
const schedule = globalThis.setTimeout;
let expire: (() => void) | undefined;
try {
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    assert.equal(delay, UI_COLORS_TIMEOUT_MS); expire = callback; return 123;
  }) as typeof setTimeout;
  const timeoutTransport = createUiColorsTransport(request => sent.push(request));
  const timedOut = timeoutTransport.update(colors); expire!();
  assert.deepEqual(await timedOut, { ok: false, error: { code: 'timeout', message: 'Appearance settings request timed out.' } });
  timeoutTransport.accept({ type: 'uiColorsResult', requestId: sent.at(-1)!.requestId, result: { ok: true, value: colors } });
  timeoutTransport.dispose();
} finally { globalThis.setTimeout = schedule; }
console.log('UI color validation, owner persistence/failure and correlated save disposal passed');
