import { defaultThemeSettings } from '../src/shared/themeDefaults';
import { parseThemeJsonc, serializeThemeFile } from '../src/shared/themeJsonc';

const parsed = parseThemeJsonc(`\uFEFF{
  // URLs and comment-like string content must remain intact.
  "url": "https://example.com/a/*literal*/",
  "nested": {
    "value": 1,
  },
}`) as any;

if (parsed.url !== 'https://example.com/a/*literal*/' || parsed.nested?.value !== 1) {
  throw new Error('JSONC comments or trailing commas were parsed incorrectly');
}

const json = serializeThemeFile(defaultThemeSettings, 'json');
const jsonPayload = JSON.parse(json);
if (json.includes('//') || jsonPayload.id !== defaultThemeSettings.id) {
  throw new Error('Strict JSON theme export is invalid or contains comments');
}

const jsonc = serializeThemeFile(defaultThemeSettings, 'jsonc');
if (!jsonc.includes('// 主题基本信息。')) {
  throw new Error('JSONC theme export lost its annotations');
}
if ((parseThemeJsonc(jsonc) as any).id !== defaultThemeSettings.id) {
  throw new Error('Annotated JSONC theme export cannot be imported');
}

console.log('theme JSON and JSONC parsing/serialization checks passed');
