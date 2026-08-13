import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  darkBuiltInVisuals,
  getBuiltInVisuals,
  lightBuiltInVisuals
} from '../src/shared/builtInVisualBaseline';

const source = readFileSync(resolve(import.meta.dir, '../src/shared/builtInVisualBaseline.ts'), 'utf8');
for (const removedShape of [
  /\bThemeFonts\b/,
  /\bBuiltInVisualBaseline\b/,
  /\bh[1-6]Font(?:Size|Weight)\b/,
  /Partial<(?:Visual|Theme|Semantic|Syntax|BuiltIn)/
]) {
  assert.doesNotMatch(source, removedShape, `fixed visuals must not expose the removed editable shape: ${removedShape}`);
}

assert.equal(getBuiltInVisuals('dark'), darkBuiltInVisuals);
assert.equal(getBuiltInVisuals('light'), lightBuiltInVisuals);
for (const visuals of [darkBuiltInVisuals, lightBuiltInVisuals]) {
  assert.equal('id' in visuals, false);
  assert.equal('name' in visuals, false);
  assert.equal(Object.isFrozen(visuals), true);
  assert.equal(Object.isFrozen(visuals.colors), true);
  assert.equal(Object.isFrozen(visuals.semanticColors), true);
  assert.equal(Object.isFrozen(visuals.syntaxTokens), true);
  assert.equal(Object.isFrozen(visuals.typography), true);
  assert.equal(visuals.typography.headingFontSizes.length, 6);
  assert.equal(visuals.typography.headingFontWeights.length, 6);
}

console.log('Built-in fixed visual source-shape checks passed');
