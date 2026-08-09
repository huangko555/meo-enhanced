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
      thinCallers: [
        { file: 'webview/src/helpers/math.ts', requiredCalls: ['scanLatexMath'], forbidIterations: true, forbidRegex: true },
        { file: 'src/export/math.ts', requiredCalls: ['scanLatexMath'], forbidIterations: true, forbidRegex: true }
      ]
    }],
    knownLegacyTestFailures: []
  }, null, 2));
  write('src/shared/latexMathScanner.ts', 'export const scanLatexMath = (_text: string) => [];\n');
  write('webview/src/helpers/math.ts', [
    "import { scanLatexMath } from '../../../src/shared/latexMathScanner';",
    'export const collect = (text: string) => scanLatexMath(text);',
    ''
  ].join('\n'));
  write('src/export/math.ts', [
    "import { scanLatexMath } from '../shared/latexMathScanner';",
    'export const collect = (text: string) => scanLatexMath(text);',
    ''
  ].join('\n'));

  const valid = runCheck();
  assert.equal(valid.ok, true, `valid thin callers should pass: ${valid.output}`);

  write('src/export/math.ts', 'export const collect = (_text: string) => [];\n');
  const missingImporter = runCheck();
  assert.equal(missingImporter.ok, false, 'missing required importer must be rejected');
  assert.match(missingImporter.output, /ARCH010/);
  write('src/export/math.ts', [
    "import { scanLatexMath } from '../shared/latexMathScanner';",
    'export const collect = (text: string) => scanLatexMath(text);',
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
    "import { scanLatexMath } from '../../../src/shared/latexMathScanner';",
    'export const collect = (text: string) => {',
    '  const renamedDuplicateScanner = () => { for (let i = 0; i < text.length; i += 1) void text[i]; };',
    '  renamedDuplicateScanner();',
    '  return scanLatexMath(text);',
    '};',
    ''
  ].join('\n'));
  const renamedDuplicate = runCheck();
  assert.equal(renamedDuplicate.ok, false, 'renamed or nested scanner loops must be rejected');
  assert.match(renamedDuplicate.output, /ARCH011/);

  write('webview/src/helpers/math.ts', [
    "import { scanLatexMath } from '../../../src/shared/latexMathScanner';",
    'export const collect = (text: string) => /\\$/.test(text) ? scanLatexMath(text) : [];',
    ''
  ].join('\n'));
  const regexDuplicate = runCheck();
  assert.equal(regexDuplicate.ok, false, 'caller-owned delimiter regex must be rejected');
  assert.match(regexDuplicate.output, /ARCH011/);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('Shared Module architecture contract checks passed');
