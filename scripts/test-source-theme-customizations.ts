import assert from 'node:assert/strict';
import { resolveSourceThemeCustomizations } from '../src/foundation/sourceThemeCustomizations';
import { decodeCodeTheme } from '../src/protocol/hostConfigurationEvents';
import { createCodePaletteWebviewAdapter } from '../webview/src/adapters/codePaletteWebviewAdapter';

const theme = { name: 'Example Dark', type: 'dark' as const, colors: { 'editor.foreground': '#cccccc', 'editor.background': '#222222' }, tokenColors: [{ scope: 'comment', settings: { foreground: '#888888' } }] };
const custom = resolveSourceThemeCustomizations(theme,
  { 'editor.foreground': '#ffffff', '[*Dark]': { 'editor.foreground': '#eeeeee', 'editor.background': 'default' }, '[Other]': { 'editor.foreground': '#000000' } },
  { comments: '#999999', textMateRules: [{ scope: 'markup.heading', settings: { foreground: '#44aaff', fontStyle: 'bold' } }], '[Example*][Other]': { textMateRules: [{ scope: 'markup.heading punctuation.definition.heading', settings: { foreground: '#ffaa44', fontStyle: '' } }] }, '[Other]': { strings: '#000000' } });
assert.equal(custom.sourceColors['editor.foreground'], '#eeeeee');
assert.equal(custom.sourceColors['editor.background'], undefined);
assert.equal(custom.sourceTokenColors.length, 4);
assert.deepEqual(custom.sourceTokenColors[1], { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#999999' } });
assert.equal(theme.colors['editor.foreground'], '#cccccc', 'Live/Preview raw theme must remain unchanged');
assert.equal(theme.tokenColors.length, 1);
assert.ok(decodeCodeTheme({ ...theme, ...custom }));
assert.equal(decodeCodeTheme({ ...theme, sourceColors: { a: 1 } }), false);
assert.equal(decodeCodeTheme({ ...theme, sourceTokenColors: [() => {}] }), false);
const writes = new Map<string, string>();
let live: unknown, source: unknown;
const adapter = createCodePaletteWebviewAdapter({ setShikiTheme: value => { live = value; }, setSourceDocumentTheme: value => { source = value; }, sourceStyle: { setProperty: (name, value) => { writes.set(name, value!); } } });
const customized = { ...theme, ...custom };
adapter.apply(adapter.resolve(customized, 'dark'));
assert.deepEqual(live, customized, 'Existing code surfaces retain the original tokenColors field');
assert.equal((source as typeof theme).colors['editor.foreground'], '#eeeeee');
assert.equal((source as typeof theme).tokenColors.length, 4);
assert.equal(writes.get('--meo-source-foreground'), '#eeeeee');
assert.equal(writes.get('--meo-content-heading-input'), '#44aaff', 'heading accent uses the Source override without borrowing heading punctuation');
assert.equal(writes.get('--meo-content-link-input'), '', 'absent link rules clear the previous input for UI fallback');
adapter.apply(adapter.resolve({ ...customized, sourceTokenColors: [...custom.sourceTokenColors,
  { scope: 'markup.underline.link.markdown', settings: { foreground: '#66ccff' } }
] }, 'dark'));
assert.equal(writes.get('--meo-content-link-input'), '#66ccff', 'link accent follows Source customizations independently');
assert.equal(writes.get('--meo-content-heading-input'), '#44aaff');
adapter.apply(adapter.resolve(customized, 'light'));
assert.equal((source as typeof theme).type, 'light');
assert.notEqual((source as typeof theme).colors['editor.foreground'], '#eeeeee', 'Inverse appearance cannot borrow dark user customizations');
assert.notEqual(writes.get('--meo-content-heading-input'), '#44aaff');
assert.notEqual(writes.get('--meo-content-link-input'), '#66ccff');
const missing = { ...theme, tokenColors: [], sourceTokenColors: [{ scope: 'comment', settings: { foreground: '#123456' } }], sourceColors: { 'editor.foreground': '#abcdef' } };
adapter.apply(adapter.resolve(missing, 'dark'));
assert.equal((source as typeof theme).colors['editor.foreground'], '#abcdef');
assert.ok((source as typeof theme).tokenColors.length > 1, 'Unknown themes retain a readable syntax fallback plus user rules');
adapter.apply(adapter.resolve({ ...theme, tokenColors: [{ settings: { foreground: '#ff0000' } }, ...theme.tokenColors] }, 'dark'));
assert.equal((source as typeof theme).tokenColors.length, 1, 'Native Source ignores contributed scopeless defaults');
console.log('Source theme customizations: scope precedence, DTO validation, inverse appearance and content isolation passed.');
