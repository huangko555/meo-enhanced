import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const fixtureRoot = mkdtempSync(join(repoRoot, '.tmp-architecture-shared-module-'));

const write = (path: string, contents: string): void => {
  const absolute = join(fixtureRoot, path);
  mkdirSync(resolve(absolute, '..'), { recursive: true });
  writeFileSync(absolute, contents);
};

const runCheck = (): { ok: boolean; output: string } => {
  try {
    return {
      ok: true,
      output: execFileSync('bun', ['scripts/check-architecture.ts'], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
    };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
};

try {
  mkdirSync(join(fixtureRoot, 'scripts'), { recursive: true });
  cpSync(join(repoRoot, 'scripts', 'check-architecture.ts'), join(fixtureRoot, 'scripts', 'check-architecture.ts'));
  write('scripts/architecture-baseline.json', JSON.stringify({
    targetRoots: [],
    sharedModuleContracts: [{
      module: 'src/shared/latexMathScanner.ts',
      exactImporters: ['webview/src/helpers/math.ts', 'src/export/math.ts'],
      delegates: [
        { file: 'webview/src/helpers/math.ts', function: 'collect', requiredCall: 'scanLatexMath' },
        { file: 'webview/src/helpers/math.ts', function: 'find', requiredCall: 'scanLatexMathAt', allowNullReturn: true },
        { file: 'src/export/math.ts', function: 'collect', requiredCall: 'scanLatexMath' }
      ]
    }],
    knownLegacyTestFailures: []
  }, null, 2));
  write('src/shared/latexMathScanner.ts', [
    'export const scanLatexMath = (_text: string) => [];',
    'export const scanLatexMathAt = (_text: string, _index: number) => null;',
    ''
  ].join('\n'));
  write('webview/src/helpers/math.ts', [
    "import { scanLatexMath, scanLatexMathAt } from '../../../src/shared/latexMathScanner';",
    'export function collect(text: string) { return (scanLatexMath(text)); }',
    'export function find(text: string, index: number) { const range = scanLatexMathAt(text, index); if (!range) return null; return range; }',
    'export function renderRows(rows: string[]) { for (const row of rows) void row; }',
    ''
  ].join('\n'));
  write('src/export/math.ts', [
    "import { scanLatexMath } from '../shared/latexMathScanner';",
    'export function collect(text: string) { return scanLatexMath(text) as unknown[]; }',
    ''
  ].join('\n'));

  const valid = runCheck();
  assert.equal(valid.ok, true, `valid thin callers should pass: ${valid.output}`);

  write('src/export/math.ts', 'export function collect(_text: string) { return []; }\n');
  const missingImporter = runCheck();
  assert.equal(missingImporter.ok, false, 'missing required importer must be rejected');
  assert.match(missingImporter.output, /ARCH010/);
  write('src/export/math.ts', [
    "import { scanLatexMath } from '../shared/latexMathScanner';",
    'export function collect(text: string) { return scanLatexMath(text); }',
    ''
  ].join('\n'));

  write('src/unexpected.ts', [
    "import { scanLatexMath } from './shared/latexMathScanner';",
    "void scanLatexMath('$x$');",
    ''
  ].join('\n'));
  const unexpectedImporter = runCheck();
  assert.equal(unexpectedImporter.ok, false, 'unexpected importer must be rejected');
  assert.match(unexpectedImporter.output, /ARCH010/);
  rmSync(join(fixtureRoot, 'src', 'unexpected.ts'));

  write('webview/src/helpers/math.ts', [
    "import { scanLatexMath, scanLatexMathAt } from '../../../src/shared/latexMathScanner';",
    'export function collect(text: string) { scanLatexMath(text); return []; }',
    'export function find(text: string, index: number) { const range = scanLatexMathAt(text, index); if (!range) return null; return range; }',
    ''
  ].join('\n'));
  const discardedCollection = runCheck();
  assert.equal(discardedCollection.ok, false, 'discarded shared collection result must be rejected');
  assert.match(discardedCollection.output, /ARCH011/);

  write('webview/src/helpers/math.ts', [
    "import { scanLatexMath, scanLatexMathAt } from '../../../src/shared/latexMathScanner';",
    'export function collect(text: string) { return scanLatexMath(text); }',
    'export function find(text: string, index: number) { void scanLatexMathAt(text, index); return null; }',
    ''
  ].join('\n'));
  const discardedPointResult = runCheck();
  assert.equal(discardedPointResult.ok, false, 'discarded shared point result must be rejected');
  assert.match(discardedPointResult.output, /ARCH011/);

  write('webview/src/helpers/math.ts', [
    "import { scanLatexMath, scanLatexMathAt } from '../../../src/shared/latexMathScanner';",
    'export function collect(text: string) { return scanLatexMath(text); }',
    'export function find(text: string, index: number) { const range = scanLatexMathAt(text, index); return null; }',
    ''
  ].join('\n'));
  const boundThenDiscarded = runCheck();
  assert.equal(boundThenDiscarded.ok, false, 'bound shared point result must reach a non-null return path');
  assert.match(boundThenDiscarded.output, /ARCH011/);

  write('webview/src/helpers/math.ts', [
    "import { scanLatexMath, scanLatexMathAt } from '../../../src/shared/latexMathScanner';",
    'export function collect(text: string) { let ranges = scanLatexMath(text); ranges = []; return ranges; }',
    'export function find(text: string, index: number) { const range = scanLatexMathAt(text, index); if (!range) return null; return range; }',
    ''
  ].join('\n'));
  const reboundCollection = runCheck();
  assert.equal(reboundCollection.ok, false, 'reassigned shared collection result must be rejected');
  assert.match(reboundCollection.output, /ARCH011/);

  write('webview/src/helpers/math.ts', [
    "import { scanLatexMath, scanLatexMathAt } from '../../../src/shared/latexMathScanner';",
    'export function collect(text: string, baseOffset: number) {',
    '  const ranges = scanLatexMath(text);',
    '  if (baseOffset === 0) { const ranges: unknown[] = []; return ranges; }',
    '  return ranges;',
    '}',
    'export function find(text: string, index: number) { const range = scanLatexMathAt(text, index); if (!range) return null; return range; }',
    ''
  ].join('\n'));
  const shadowedCollection = runCheck();
  assert.equal(shadowedCollection.ok, false, 'shadowed shared result binding must be rejected');
  assert.match(shadowedCollection.output, /ARCH011/);

  write('webview/src/helpers/math.ts', [
    "import { scanLatexMath, scanLatexMathAt } from '../../../src/shared/latexMathScanner';",
    'export function collect(text: string, baseOffset: number) {',
    '  const ranges = scanLatexMath(text);',
    '  if (baseOffset === 0) { const { ranges } = { ranges: [] as unknown[] }; return ranges; }',
    '  if (baseOffset === 1) { const [ranges] = [[] as unknown[]]; return ranges; }',
    '  return ranges;',
    '}',
    'export function find(text: string, index: number) { const range = scanLatexMathAt(text, index); if (!range) return null; return range; }',
    ''
  ].join('\n'));
  const destructuredShadow = runCheck();
  assert.equal(destructuredShadow.ok, false, 'destructured shared result shadow must be rejected');
  assert.match(destructuredShadow.output, /ARCH011/);

  write('webview/src/helpers/math.ts', [
    "import { scanLatexMath, scanLatexMathAt } from '../../../src/shared/latexMathScanner';",
    'export function collect(text: string) {',
    '  const ranges = scanLatexMath(text);',
    '  try { throw []; } catch (ranges) { return ranges; }',
    '}',
    'export function find(text: string, index: number) { const range = scanLatexMathAt(text, index); if (!range) return null; return range; }',
    ''
  ].join('\n'));
  const catchShadow = runCheck();
  assert.equal(catchShadow.ok, false, 'catch binding shared result shadow must be rejected');
  assert.match(catchShadow.output, /ARCH011/);

  write('webview/src/helpers/math.ts', [
    "import { scanLatexMath, scanLatexMathAt } from '../../../src/shared/latexMathScanner';",
    'export function collect(text: string) {',
    '  const renamedDuplicateScanner = () => { for (let i = 0; i < text.length; i += 1) void text[i]; };',
    '  renamedDuplicateScanner();',
    '  return scanLatexMath(text);',
    '}',
    'export function find(text: string, index: number) { const range = scanLatexMathAt(text, index); if (!range) return null; return range; }',
    ''
  ].join('\n'));
  const renamedDuplicate = runCheck();
  assert.equal(renamedDuplicate.ok, false, 'renamed or nested scanner loops must be rejected');
  assert.match(renamedDuplicate.output, /ARCH011/);

  write('webview/src/helpers/math.ts', [
    "import { scanLatexMath, scanLatexMathAt } from '../../../src/shared/latexMathScanner';",
    'export function collect(text: string) {',
    '  const ignored = scanLatexMath(text);',
    "  const duplicate = (cursor: number): number => text.indexOf('$', cursor) < 0 ? cursor : duplicate(cursor + 1);",
    '  return duplicate(0) < 0 ? ignored : ignored;',
    '}',
    'export function find(text: string, index: number) { const range = scanLatexMathAt(text, index); if (!range) return null; return range; }',
    ''
  ].join('\n'));
  const deadDelegate = runCheck();
  assert.equal(deadDelegate.ok, false, 'dead delegation plus recursive scanner must be rejected');
  assert.match(deadDelegate.output, /ARCH011/);

  write('webview/src/helpers/math.ts', [
    "import { scanLatexMath, scanLatexMathAt } from '../../../src/shared/latexMathScanner';",
    'export function collect(text: string) { return /\\$/.test(text) ? scanLatexMath(text) : []; }',
    'export function find(text: string, index: number) { const range = scanLatexMathAt(text, index); if (!range) return null; return range; }',
    ''
  ].join('\n'));
  const regexDuplicate = runCheck();
  assert.equal(regexDuplicate.ok, false, 'caller-owned delimiter regex must be rejected');
  assert.match(regexDuplicate.output, /ARCH011/);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('Shared Module architecture contract checks passed');
