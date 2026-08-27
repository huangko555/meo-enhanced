import assert from 'node:assert/strict';
import {
  getUiStrings,
  normalizeUiLanguagePreference,
  resolveUiLanguage
} from '../src/foundation/uiLanguage';

assert.equal(normalizeUiLanguagePreference('en'), 'en');
assert.equal(normalizeUiLanguagePreference('zh-CN'), 'zh-CN');
assert.equal(normalizeUiLanguagePreference('zh-cn'), 'auto');
assert.equal(normalizeUiLanguagePreference(null), 'auto');

assert.equal(resolveUiLanguage('en', 'zh-cn'), 'en');
assert.equal(resolveUiLanguage('zh-CN', 'en'), 'zh-CN');
assert.equal(resolveUiLanguage('auto', 'zh-CN'), 'zh-CN');
assert.equal(resolveUiLanguage('auto', 'ZH-cn'), 'zh-CN');
assert.equal(resolveUiLanguage('auto', 'zh-TW'), 'en');
assert.equal(resolveUiLanguage('invalid', 'en'), 'en');

const english = getUiStrings('en');
const chinese = getUiStrings('zh-CN');
assert.equal(english.exportHtml, 'Export HTML');
assert.equal(chinese.exportHtml, '导出 HTML');
assert.equal(Object.isFrozen(english), true);
assert.equal(Object.isFrozen(chinese), true);

console.log('UI language checks passed');
