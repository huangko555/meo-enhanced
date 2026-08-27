import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
assert.equal(english.findMatches(2), '2 matches');
assert.equal(chinese.findMatches(2), '2 个匹配项');
assert.equal(chinese.replacedRemaining(3), '已替换 • 剩余 3 个');
assert.equal(chinese.outlineNoHeadings, '暂无标题');
assert.equal(chinese.headingLevel(3), '3 级标题');
assert.equal(Object.isFrozen(english), true);
assert.equal(Object.isFrozen(chinese), true);

const repoRoot = path.resolve(import.meta.dir, '..');
const packageText = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
const englishNls = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.nls.json'), 'utf8')) as Record<string, string>;
const chineseNls = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.nls.zh-cn.json'), 'utf8')) as Record<string, string>;
const referencedNlsKeys = [...packageText.matchAll(/%([^%]+)%/g)].map((match) => match[1]);
assert.deepEqual(Object.keys(chineseNls).sort(), Object.keys(englishNls).sort());
for (const key of referencedNlsKeys) {
  assert.equal(typeof englishNls[key], 'string', `Missing English package NLS key: ${key}`);
  assert.equal(typeof chineseNls[key], 'string', `Missing Chinese package NLS key: ${key}`);
  assert.notEqual(englishNls[key], '');
  assert.notEqual(chineseNls[key], '');
}

console.log('UI language checks passed');
