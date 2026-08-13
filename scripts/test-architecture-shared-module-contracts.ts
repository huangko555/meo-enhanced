import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const architectureSource = readFileSync(join(fixtureRoot, 'scripts', 'check-architecture.ts'), 'utf8');
  assert.match(architectureSource, /cat-file', '--batch/);
  assert.doesNotMatch(architectureSource, /runGit\(\['show'/, 'staged reads must not spawn Git once per file');
  assert.doesNotMatch(
    architectureSource,
    /continueExitsForEvent|hasBlockingContinueBetween|new Set<ContinueExit>/,
    'ARCH015 event processing must query an owner summary instead of scanning continue exits'
  );
  assert.match(architectureSource, /blockerPositionsByAncestorPath: Map<string, number\[]>/);
  assert.match(architectureSource, /unreachableRangesByPath: Map<string, NativeSpellcheckRange\[]>/);
  assert.match(architectureSource, /positions\.sort\(\(left, right\) => left - right\)/);
  assert.match(architectureSource, /const firstPositionAfter =/);
  assert.match(architectureSource, /const positionIsInRanges =/);
  assert.match(architectureSource, /targetContinuePositions/);
  assert.match(
    architectureSource,
    /filter\(\(exit\) => exit\.reachesBackedge && nodeIsReachableFromBoundaryEntry\(exit\.node, owner\)\)/
  );
  assert.doesNotMatch(
    architectureSource,
    /dominancePositionsByPath|finallyBlocksWithBypassingAbruptCompletion/,
    'ARCH015 must not reuse blocker positions or a block-level abrupt flag for completion paths'
  );
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

  write('README.md', 'The table toolbar can order columns.\n');
  const tableSortingAlias = runCheck();
  assert.equal(tableSortingAlias.ok, false, 'table sorting aliases in public docs must be rejected');
  assert.match(tableSortingAlias.output, /ARCH013/);
  rmSync(join(fixtureRoot, 'README.md'));

  write('package.json', JSON.stringify({ contributes: { configuration: { properties: {
    'meo.table.enableOrdering': { type: 'boolean' }
  } } } }));
  const tableOrderingSetting = runCheck();
  assert.equal(tableOrderingSetting.ok, false, 'dotted/camel table ordering setting aliases must be rejected');
  assert.match(tableOrderingSetting.output, /ARCH013/);
  rmSync(join(fixtureRoot, 'package.json'));

  write('README.md', 'Order the rows by name.\n');
  const tableOrderingSentence = runCheck();
  assert.equal(tableOrderingSentence.ok, false, 'non-adjacent natural-language table ordering must be rejected');
  assert.match(tableOrderingSentence.output, /ARCH013/);
  rmSync(join(fixtureRoot, 'README.md'));

  write('webview/src/helpers/retainedTableBehavior.ts', [
    'export const sortChanges = (rows: number[]) => rows.sort((left, right) => left - right);',
    'export const orderedList = true;',
    'export const sourceRowOrder = [0, 1];',
    ''
  ].join('\n'));
  const retainedOrdering = runCheck();
  assert.equal(retainedOrdering.ok, true, `ordinary sorting and retained ordering terms must pass: ${retainedOrdering.output}`);
  rmSync(join(fixtureRoot, 'webview', 'src', 'helpers', 'retainedTableBehavior.ts'));

  write('README.md', 'Show Git line authors and open the matching revision.\n');
  const gitLineAuthorDocs = runCheck();
  assert.equal(gitLineAuthorDocs.ok, false, 'Git Blame aliases in public docs must be rejected');
  assert.match(gitLineAuthorDocs.output, /ARCH014/);
  rmSync(join(fixtureRoot, 'README.md'));

  write('package.json', JSON.stringify({ contributes: { configuration: { properties: {
    'meoEnhanced.gitLineAuthors.enabled': { type: 'boolean' }
  } } } }));
  const gitLineAuthorSetting = runCheck();
  assert.equal(gitLineAuthorSetting.ok, false, 'Git line-author setting aliases must be rejected');
  assert.match(gitLineAuthorSetting.output, /ARCH014/);
  rmSync(join(fixtureRoot, 'package.json'));

  write('src/protocol/removedGitCapability.ts', [
    "export type GitRequest = { type: 'requestLineAuthor'; lineNumber: number };",
    "export type GitNavigation = { type: 'openGitRevisionForLine'; lineNumber: number };",
    ''
  ].join('\n'));
  const gitBlameProtocolAliases = runCheck();
  assert.equal(gitBlameProtocolAliases.ok, false, 'Git Blame request and navigation aliases must be rejected');
  assert.match(gitBlameProtocolAliases.output, /ARCH014/);
  rmSync(join(fixtureRoot, 'src', 'protocol', 'removedGitCapability.ts'));

  write('README.md', 'Enable Git annotate and line annotation to show who owns each line.\n');
  const gitAnnotateDocs = runCheck();
  assert.equal(gitAnnotateDocs.ok, false, 'Git annotate and line-annotation aliases must be rejected');
  assert.match(gitAnnotateDocs.output, /ARCH014/);
  rmSync(join(fixtureRoot, 'README.md'));

  write('README.md', 'Show line annotation from Git beside each source line.\n');
  const lineAnnotationDocs = runCheck();
  assert.equal(lineAnnotationDocs.ok, false, 'line-annotation Git aliases must be rejected');
  assert.match(lineAnnotationDocs.output, /ARCH014/);
  rmSync(join(fixtureRoot, 'README.md'));

  write('package.json', JSON.stringify({ contributes: { configuration: { properties: {
    'meoEnhanced.requestCommitInfoForLine': { type: 'boolean' }
  } } } }));
  const commitInfoForLineSetting = runCheck();
  assert.equal(commitInfoForLineSetting.ok, false, 'per-line commit-info API and setting aliases must be rejected');
  assert.match(commitInfoForLineSetting.output, /ARCH014/);
  rmSync(join(fixtureRoot, 'package.json'));

  write('webview/src/adapters/removedLineHistory.ts', [
    "export type LineHistoryCommand = { type: 'showLineHistory'; lineNumber: number };",
    ''
  ].join('\n'));
  const showLineHistoryProtocol = runCheck();
  assert.equal(showLineHistoryProtocol.ok, false, 'show-line-history Protocol aliases must be rejected');
  assert.match(showLineHistoryProtocol.output, /ARCH014/);
  rmSync(join(fixtureRoot, 'webview', 'src', 'adapters', 'removedLineHistory.ts'));

  write('webview/src/adapters/removedCommitNavigation.ts', [
    "export const command = { type: 'navigateToCommitForLine', lineNumber: 4 };",
    ''
  ].join('\n'));
  const commitNavigationForLine = runCheck();
  assert.equal(commitNavigationForLine.ok, false, 'per-line commit navigation aliases must be rejected');
  assert.match(commitNavigationForLine.output, /ARCH014/);
  rmSync(join(fixtureRoot, 'webview', 'src', 'adapters', 'removedCommitNavigation.ts'));

  const normalizedGitLineCapabilityFixtures = [
    {
      label: 'singular line-annotation setting',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.gitLineAnnotation.enabled': { type: 'boolean' }
      } } } }, null, 2)
    },
    {
      label: 'line-annotation source identifier',
      path: 'webview/src/adapters/lineAnnotation.ts',
      contents: 'export const lineAnnotationFromGit = true;\n'
    },
    {
      label: 'plural line-annotations setting',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.gitLineAnnotations.enabled': { type: 'boolean' }
      } } } }, null, 2)
    },
    {
      label: 'Git line-history setting',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.gitLineHistory.enabled': { type: 'boolean' }
      } } } }, null, 2)
    },
    {
      label: 'Git line commit-info source identifier',
      path: 'src/host/gitLineCommitInfo.ts',
      contents: 'export const getGitLineCommitInfo = () => null;\n'
    },
    {
      label: 'Git line-revision API',
      path: 'src/host/gitLineRevision.ts',
      contents: 'export const openGitLineRevision = () => undefined;\n'
    },
    {
      label: 'Git author-for-line API',
      path: 'src/host/gitAuthorForLine.ts',
      contents: 'export const getGitAuthorForLine = () => null;\n'
    },
    {
      label: 'author-for-Git-line API',
      path: 'src/host/authorForGitLine.ts',
      contents: 'export const getAuthorForGitLine = () => null;\n'
    },
    {
      label: 'Git-author-for-line identifier',
      path: 'webview/src/adapters/gitAuthorForLine.ts',
      contents: 'export const gitAuthorForLine = true;\n'
    }
  ];
  const missedNormalizedGitLineCapabilities: string[] = [];
  for (const fixture of normalizedGitLineCapabilityFixtures) {
    write(fixture.path, fixture.contents);
    const outcome = runCheck();
    if (outcome.ok || !/ARCH014/.test(outcome.output)) {
      missedNormalizedGitLineCapabilities.push(fixture.label);
    }
    rmSync(join(fixtureRoot, ...fixture.path.split('/')));
  }
  const allowedDistantGitAnnotateFixtures = [
    {
      label: 'source annotate helper with Git diff',
      path: 'webview/src/helpers/annotateDocument.ts',
      contents: 'export const annotateDocumentWithGitDiff = true;\n'
    },
    {
      label: 'package annotate test script running Git diff',
      path: 'package.json',
      contents: JSON.stringify({ scripts: { 'test:annotateDocument': 'git diff --check' } }, null, 2)
    },
    {
      label: 'README annotation sentence about Git diff',
      path: 'README.md',
      contents: 'Annotate the rendered document using retained Git diff metadata.\n'
    }
  ];
  const rejectedAllowedDistantGitAnnotateFixtures: string[] = [];
  for (const fixture of allowedDistantGitAnnotateFixtures) {
    write(fixture.path, fixture.contents);
    const outcome = runCheck();
    if (!outcome.ok) {
      rejectedAllowedDistantGitAnnotateFixtures.push(`${fixture.label}: ${outcome.output}`);
    }
    rmSync(join(fixtureRoot, fixture.path));
  }
  assert.deepEqual({
    missedGitLineCapabilities: missedNormalizedGitLineCapabilities,
    rejectedAllowedDistantGitAnnotateFixtures
  }, {
    missedGitLineCapabilities: [],
    rejectedAllowedDistantGitAnnotateFixtures: []
  }, 'Git line aliases must be rejected without rejecting distant annotate/Git diff text');

  const removedSpellDiagnosticFixtures: Array<{
    label: string;
    path: string;
    contents: string;
    expectedLine?: number;
  }> = [
    {
      label: 'built-in spell-check setting',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.proofreading.enabled': { type: 'boolean' }
      } } } }, null, 2)
    },
    {
      label: 'canonical MEO spell-check setting',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.spellCheck.enabled': { type: 'boolean' }
      } } } }, null, 2)
    },
    {
      label: 'lowercase MEO spellcheck setting',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.spellcheck.enabled': { type: 'boolean' }
      } } } }, null, 2)
    },
    {
      label: 'non-DOM settings spellcheck property',
      path: 'src/shared/spellPreferences.ts',
      contents: 'settings.spellcheck = true;\n'
    },
    {
      label: 'const spellcheck state owner',
      path: 'src/shared/spellcheckState.ts',
      contents: 'const spellcheck = true;\n'
    },
    {
      label: 'let spellcheck state owner',
      path: 'src/shared/spellcheckState.ts',
      contents: 'let spellcheck = false;\n'
    },
    {
      label: 'bare spellcheck state owner',
      path: 'src/shared/spellcheckState.ts',
      contents: 'spellcheck = true;\n'
    },
    {
      label: 'object spellcheck state owner',
      path: 'src/shared/spellcheckState.ts',
      contents: 'export const state = { spellcheck: true };\n'
    },
    {
      label: 'arbitrary receiver spellcheck state owner',
      path: 'src/shared/spellcheckState.ts',
      contents: 'widget.spellcheck = true;\n'
    },
    {
      label: 'shadowed DOM receiver spellcheck state owner',
      path: 'webview/src/helpers/shadowedNativeSpellcheck.ts',
      contents: "const field = document.createElement('input');\nfield.spellcheck = true;\nfunction update(field: { spellcheck: boolean }) {\n  field.spellcheck = false;\n}\n",
      expectedLine: 4
    },
    {
      label: 'locally shadowed DOM receiver spellcheck state owner',
      path: 'webview/src/helpers/shadowedNativeSpellcheck.ts',
      contents: "const field = document.createElement('input');\nfunction update() {\n  const field = settings;\n  field.spellcheck = false;\n}\n",
      expectedLine: 4
    },
    {
      label: 'DOM receiver invalidated by non-DOM reassignment',
      path: 'webview/src/helpers/reassignedNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nfield = settings;\nfield.spellcheck = true;\n",
      expectedLine: 3
    },
    {
      label: 'same-context const spellcheck use before DOM declaration',
      path: 'webview/src/helpers/tdzNativeSpellcheck.ts',
      contents: "field.spellcheck = true;\nconst field = document.createElement('input');\n",
      expectedLine: 1
    },
    {
      label: 'conditional DOM assignment before outer spellcheck use',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = settings;\nif (enabled) field = document.createElement('input');\nfield.spellcheck = true;\n",
      expectedLine: 3
    },
    {
      label: 'conditional non-DOM assignment after DOM initialization',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nif (enabled) field = settings;\nfield.spellcheck = true;\n",
      expectedLine: 3
    },
    {
      label: 'loop DOM assignment before outer spellcheck use',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = settings;\nfor (; enabled;) { field = document.createElement('input'); break; }\nfield.spellcheck = true;\n",
      expectedLine: 3
    },
    {
      label: 'for incrementor DOM assignment before outer spellcheck use',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = settings;\nfor (; ready; field = document.createElement('input')) {}\nfield.spellcheck = true;\n",
      expectedLine: 3
    },
    {
      label: 'logical-and RHS DOM assignment before outer spellcheck use',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = settings;\nready && (field = document.createElement('input'));\nfield.spellcheck = true;\n",
      expectedLine: 3
    },
    {
      label: 'logical-or RHS DOM assignment before outer spellcheck use',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = settings;\nready || (field = document.createElement('input'));\nfield.spellcheck = true;\n",
      expectedLine: 3
    },
    {
      label: 'nullish-coalescing RHS DOM assignment before outer spellcheck use',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = settings;\nvalue ?? (field = document.createElement('input'));\nfield.spellcheck = true;\n",
      expectedLine: 3
    },
    {
      label: 'short-circuit non-DOM assignment remains a possible outer state',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nready && (field = settings);\nfield.spellcheck = true;\n",
      expectedLine: 3
    },
    {
      label: 'while-loop carried non-DOM receiver state',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (enabled) {\n  field.spellcheck = true;\n  field = settings;\n}\n",
      expectedLine: 3
    },
    {
      label: 'loop entry joins previous iteration sibling branch state',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  if (ok) {\n    field.spellcheck = true;\n    field = document.createElement('input');\n  } else {\n    field = settings;\n  }\n}\n",
      expectedLine: 4
    },
    {
      label: 'conditional non-DOM after use carries into next iteration',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  if (ok) field = settings;\n}\n",
      expectedLine: 3
    },
    {
      label: 'short-circuit non-DOM after use carries into next iteration',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  ok && (field = settings);\n}\n",
      expectedLine: 3
    },
    {
      label: 'inner-loop possible non-DOM carries into outer next iteration',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (outerReady) {\n  field.spellcheck = true;\n  while (innerReady) {\n    if (ok) field = settings;\n  }\n}\n",
      expectedLine: 3
    },
    {
      label: 'continue bypasses later ancestor DOM before next iteration',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  if (disabled) { field = settings; continue; }\n  field = document.createElement('input');\n}\n",
      expectedLine: 3
    },
    {
      label: 'nested conditional continue bypasses later ancestor DOM',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  if (flag) {\n    field = settings;\n    if (skip) continue;\n  }\n  field = document.createElement('input');\n}\n",
      expectedLine: 3
    },
    {
      label: 'position ordering finds earlier branch continue before later ancestor continue',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  if (flag) { field = settings; continue; }\n  field = document.createElement('input');\n  continue;\n}\n",
      expectedLine: 3
    },
    {
      label: 'unlabeled continue only carries into nearest inner loop',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (outerReady) {\n  while (innerReady) {\n    field.spellcheck = true;\n    if (disabled) { field = settings; continue; }\n    field = document.createElement('input');\n  }\n  field = document.createElement('input');\n  field.spellcheck = true;\n}\n",
      expectedLine: 4
    },
    {
      label: 'labeled continue carries inner non-DOM into outer loop',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nouter: while (outerReady) {\n  field.spellcheck = true;\n  while (innerReady) {\n    if (disabled) { field = settings; continue outer; }\n  }\n  field = document.createElement('input');\n}\n",
      expectedLine: 3
    },
    {
      label: 'conditional DOM in finally does not recover continue exit',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try { field = settings; continue; } finally {\n    if (ok) field = document.createElement('input');\n  }\n}\n",
      expectedLine: 3
    },
    {
      label: 'abrupt finally keeps continue exit recovery conservative',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try { field = settings; continue; } finally {\n    if (abort) continue;\n    field = document.createElement('input');\n  }\n}\n",
      expectedLine: 3
    },
    {
      label: 'conditional return after non-DOM finally event can reach backedge',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "function update() {\n  let field = document.createElement('input');\n  while (ready) {\n    field.spellcheck = true;\n    try { continue; } finally {\n      field = settings;\n      if (abort) return;\n    }\n  }\n}\n",
      expectedLine: 4
    },
    {
      label: 'conditional return before non-DOM finally event can reach backedge',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "function update() {\n  let field = document.createElement('input');\n  while (ready) {\n    field.spellcheck = true;\n    try { continue; } finally {\n      if (abort) return;\n      field = settings;\n    }\n  }\n}\n",
      expectedLine: 4
    },
    {
      label: 'caught finally throw can carry non-DOM through catch fallthrough',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try {\n    try { field = settings; continue; } finally {\n      if (abort) throw new Error('caught');\n      field = document.createElement('input');\n    }\n  } catch { observe(); }\n}\n",
      expectedLine: 3
    },
    {
      label: 'caught finally throw can carry non-DOM through catch continue',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try {\n    try { field = settings; continue; } finally {\n      if (abort) throw new Error('caught');\n      field = document.createElement('input');\n    }\n  } catch { continue; }\n}\n",
      expectedLine: 3
    },
    {
      label: 'conditional continue preserves reachable outer fallthrough state',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  if (flag) continue;\n  field = settings;\n}\n",
      expectedLine: 3
    },
    {
      label: 'same-target continue in finally preserves target backedge',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try { field = settings; continue; } finally { continue; }\n}\n",
      expectedLine: 3
    },
    {
      label: 'break from target-internal labeled block preserves target backedge',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try { field = settings; continue; } finally {\n    innerBlock: { break innerBlock; }\n  }\n}\n",
      expectedLine: 3
    },
    {
      label: 'do-while-loop carried non-DOM receiver state',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\ndo {\n  field.spellcheck = true;\n  field = settings;\n} while (enabled);\n",
      expectedLine: 3
    },
    {
      label: 'for-loop carried non-DOM receiver state',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nfor (; enabled;) {\n  field.spellcheck = true;\n  field = settings;\n}\n",
      expectedLine: 3
    },
    {
      label: 'for-loop DOM binding must not pollute outer non-DOM receiver',
      path: 'webview/src/helpers/loopNativeSpellcheck.ts',
      contents: "const field = settings;\nfor (let field = document.createElement('input'); ready;) {\n  field.spellcheck = false;\n  break;\n}\nfield.spellcheck = true;\n",
      expectedLine: 6
    },
    {
      label: 'for-in DOM binding must not pollute outer non-DOM receiver',
      path: 'webview/src/helpers/loopNativeSpellcheck.ts',
      contents: "const field = settings;\nfor (let field: HTMLInputElement in fields) { field.spellcheck = false; }\nfield.spellcheck = true;\n",
      expectedLine: 3
    },
    {
      label: 'for-of DOM binding must not pollute outer non-DOM receiver',
      path: 'webview/src/helpers/loopNativeSpellcheck.ts',
      contents: "const field = settings;\nfor (const field: HTMLTextAreaElement of fields) { field.spellcheck = true; }\nfield.spellcheck = true;\n",
      expectedLine: 3
    },
    {
      label: 'catch parameter must shadow outer DOM receiver',
      path: 'webview/src/helpers/catchNativeSpellcheck.ts',
      contents: "const field = document.createElement('input');\ntry { run(); } catch (field) {\n  field.spellcheck = false;\n}\nfield.spellcheck = true;\n",
      expectedLine: 3
    },
    {
      label: 'switch case binding must shadow outer DOM receiver',
      path: 'webview/src/helpers/switchNativeSpellcheck.ts',
      contents: "const field = document.createElement('input');\nswitch (mode) { case 'edit': let field = settings;\n  field.spellcheck = false; break; default: break; }\nfield.spellcheck = true;\n",
      expectedLine: 3
    },
    {
      label: 'standalone spellcheck after unclosed tag candidate',
      path: 'webview/src/helpers/unclosedNativeSpellcheck.ts',
      contents: "const fragment = '<input';\nconst spellcheck = true;\nconst comparison = value > 0;\n"
    },
    {
      label: 'standalone spellcheck after whitespace-terminated unclosed tag candidate',
      path: 'webview/src/helpers/unclosedNativeSpellcheck.ts',
      contents: "const fragment = '<input ';\nconst spellcheck = true;\nconst comparison = 'value > zero';\n",
      expectedLine: 2
    },
    {
      label: 'emoji-prefixed standalone spellcheck state owner',
      path: 'webview/src/helpers/emojiSpellcheckState.ts',
      contents: "const marker = '😀';\nconst spellcheck = true;\n",
      expectedLine: 2
    },
    {
      label: 'TypeScript function generic spellcheck state',
      path: 'src/shared/spellcheckState.ts',
      contents: 'function read<Spellcheck = false>() {}\n'
    },
    {
      label: 'TypeScript type generic spellcheck state',
      path: 'src/shared/spellcheckState.ts',
      contents: 'type Flag<spellcheck = true> = boolean;\n'
    },
    {
      label: 'spell-check dependency',
      path: 'package.json',
      contents: JSON.stringify({ dependencies: { 'cspell-lib': '^10.0.1' } }, null, 2)
    },
    {
      label: 'diagnostic suggestion Protocol alias',
      path: 'src/protocol/removedDiagnosticSuggestions.ts',
      contents: "export type QuickFixRequest = { type: 'requestSuggestionsForDiagnostic'; from: number; to: number };\n"
    },
    {
      label: 'diagnostic suggestion result alias',
      path: 'src/protocol/diagnosticSuggestionResult.ts',
      contents: 'export type DiagnosticSuggestionsResult = { suggestions: string[] };\n'
    },
    {
      label: 'pure Protocol diagnostic suggestions DTO',
      path: 'src/protocol/diagnosticSuggestions.ts',
      contents: 'export type DiagnosticSuggestions = { suggestions: string[] };\n'
    },
    {
      label: 'removed diagnostic suggestions Protocol path',
      path: 'src/protocol/diagnosticSuggestions.ts',
      contents: 'export {};\n'
    },
    {
      label: 'diagnostic suggestion transport alias',
      path: 'webview/src/adapters/diagnosticSuggestionsTransport.ts',
      contents: 'export const diagnosticSuggestionsTransport = {};\n'
    },
    {
      label: 'diagnostic suggestion UI alias',
      path: 'webview/src/helpers/diagnosticSuggestionsMenu.ts',
      contents: 'export const showDiagnosticSuggestionsMenu = () => undefined;\n'
    },
    {
      label: 'pure MEO spell diagnostics phrase',
      path: 'README.md',
      contents: 'MEO spell diagnostics\n'
    },
    {
      label: 'pure meoSpellDiagnostics alias',
      path: 'src/host/meoSpellDiagnostics.ts',
      contents: 'export const meoSpellDiagnostics = [];\n'
    },
    {
      label: 'pure MEO spell diagnostic collection',
      path: 'src/host/meoSpellDiagnosticCollection.ts',
      contents: "createDiagnosticCollection('meo-spell');\n"
    },
    {
      label: 'pure diagnostic suggestions decoder function',
      path: 'src/protocol/decodeDiagnosticSuggestions.ts',
      contents: 'export const decodeDiagnosticSuggestions = undefined;\n'
    },
    {
      label: 'pure diagnostic suggestion decoder type',
      path: 'src/protocol/diagnosticSuggestionDecoder.ts',
      contents: 'export class DiagnosticSuggestionDecoder {}\n'
    },
    {
      label: 'spelling diagnostics Host alias',
      path: 'src/host/proofreadingAdapter.ts',
      contents: 'export const collectSpellingDiagnostics = () => [];\n'
    },
    {
      label: 'typo suggestions Webview alias',
      path: 'webview/src/adapters/typoQuickFix.ts',
      contents: 'export const showTypoSuggestions = () => undefined;\n'
    },
    {
      label: 'pure SpellingChecker alias',
      path: 'src/host/spellingChecker.ts',
      contents: 'export class SpellingChecker {}\n'
    },
    {
      label: 'pure TypoQuickFix alias',
      path: 'webview/src/helpers/typoQuickFix.ts',
      contents: 'export const applyTypoQuickFix = () => undefined;\n'
    },
    {
      label: 'dotted typo corrections setting alias',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.typo.corrections.enabled': { type: 'boolean' }
      } } } }, null, 2)
    },
    {
      label: 'natural-language spelling corrections capability',
      path: 'README.md',
      contents: 'Show spelling corrections in the editor menu.\n'
    },
    {
      label: 'natural-language spelling quick-fix capability',
      path: 'README.md',
      contents: 'Apply spelling quick fixes from the selection menu.\n'
    }
  ];
  const missedSpellDiagnosticCapabilities: string[] = [];
  for (const fixture of removedSpellDiagnosticFixtures) {
    write(fixture.path, fixture.contents);
    const outcome = runCheck();
    if (
      outcome.ok ||
      !/ARCH015/.test(outcome.output) ||
      (fixture.expectedLine !== undefined && !outcome.output.includes(`${fixture.path}:${fixture.expectedLine}`))
    ) {
      missedSpellDiagnosticCapabilities.push(fixture.label);
    }
    rmSync(join(fixtureRoot, ...fixture.path.split('/')));
  }

  const allowedNativeSpellcheckAndDiagnosticsFixtures = [
    {
      label: 'HTML native spellcheck attributes',
      path: 'webview/src/helpers/nativeSpellcheck.html',
      contents: '<textarea spellcheck="false"></textarea>\n<input spellcheck="true">\n<textarea spellcheck=false></textarea>\n<input spellcheck=true>\n<textarea\n  spellcheck=true\n></textarea>\n'
    },
    {
      label: 'HTML native spellcheck attributes in TypeScript strings',
      path: 'webview/src/helpers/nativeSpellcheckMarkup.ts',
      contents: "export const markup = '<input spellcheck=true>';\nexport const template = `<textarea spellcheck=\"false\"></textarea>`;\n"
    },
    {
      label: 'HTML spellcheck after quoted greater-than',
      path: 'webview/src/helpers/nativeSpellcheckMarkup.ts',
      contents: 'export const markup = `<input title="a > b" spellcheck=false>`;\n'
    },
    {
      label: 'HTML spellcheck before quoted greater-than',
      path: 'webview/src/helpers/nativeSpellcheckMarkup.ts',
      contents: "export const markup = `<input spellcheck='true' title='a > b'>`;\n"
    },
    {
      label: 'HTML spellcheck after an unclosed tag candidate',
      path: 'webview/src/helpers/nativeSpellcheckMarkup.ts',
      contents: "const fragment = '<input';\nconst markup = '<textarea spellcheck=true>';\n"
    },
    {
      label: 'HTML spellcheck after a whitespace-terminated unclosed tag candidate',
      path: 'webview/src/helpers/nativeSpellcheckMarkup.ts',
      contents: "const fragment = '<input ';\nconst markup = '<textarea spellcheck=true>';\n"
    },
    {
      label: 'emoji-prefixed HTML native spellcheck attribute',
      path: 'webview/src/helpers/nativeSpellcheckMarkup.ts',
      contents: "const marker = '😀';\nconst markup = '<textarea spellcheck=false>';\n"
    },
    {
      label: 'DOM native spellcheck properties',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "const input = document.createElement('input');\ninput.spellcheck = true;\nconst textarea = document.createElement('textarea');\ntextarea.spellcheck = false;\nlet element: HTMLElement;\nelement.spellcheck = true;\n"
    },
    {
      label: 'DOM createElement spellcheck receiver',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "const field = document.createElement('textarea');\nfield.spellcheck = true;\n"
    },
    {
      label: 'DOM annotated spellcheck receiver',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: 'let control: HTMLInputElement;\ncontrol.spellcheck = false;\n'
    },
    {
      label: 'DOM generic and cast spellcheck receivers',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "const selected = document.querySelector<HTMLInputElement>('#field');\nselected!.spellcheck = true;\nconst area = node as HTMLTextAreaElement;\narea.spellcheck = false;\n"
    },
    {
      label: 'emoji-prefixed DOM native spellcheck property',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "const marker = '😀';\nconst field = document.createElement('input');\nfield.spellcheck = true;\n"
    },
    {
      label: 'multiple DOM native spellcheck receivers',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "const first = document.createElement('input');\nconst second = document.createElement('textarea');\nlet third: HTMLElement;\nfirst.spellcheck = true;\nsecond.spellcheck = false;\nthird.spellcheck = true;\n"
    },
    {
      label: 'function-scoped var DOM native spellcheck receiver',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "{\n  var field = document.createElement('input');\n}\nfield.spellcheck = true;\n"
    },
    {
      label: 'forward closure capture of const DOM receiver',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "function later() {\n  field.spellcheck = true;\n}\nconst field = document.createElement('input');\n"
    },
    {
      label: 'declared-before closure capture of const DOM receiver',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "const field = document.createElement('input');\nfunction later() {\n  field.spellcheck = true;\n}\n"
    },
    {
      label: 'loop-scoped DOM receivers and unshadowed outer DOM receiver',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "const outer = document.createElement('input');\nfor (let field = document.createElement('input'); ready;) { field.spellcheck = false; break; }\nfor (let field: HTMLInputElement in fields) { field.spellcheck = false; }\nfor (const field: HTMLTextAreaElement of fields) { field.spellcheck = true; }\nouter.spellcheck = true;\n"
    },
    {
      label: 'loop var receiver and nested loop bindings',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "for (var outer = document.createElement('input'); ready;) {\n  for (const field: HTMLInputElement of fields) {\n    field.spellcheck = false;\n  }\n  break;\n}\nouter.spellcheck = true;\n"
    },
    {
      label: 'straight-line non-DOM to DOM reassignment',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = settings;\nfield = document.createElement('input');\nfield.spellcheck = true;\n"
    },
    {
      label: 'same-branch DOM reassignment before spellcheck use',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = settings;\nif (enabled) {\n  field = document.createElement('input');\n  field.spellcheck = true;\n}\n"
    },
    {
      label: 'while-loop non-DOM state restored before spellcheck use',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field = settings;\n  field = document.createElement('input');\n  field.spellcheck = true;\n}\n"
    },
    {
      label: 'finally DOM reassignment before outer spellcheck use',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = settings;\ntry { run(); } finally { field = document.createElement('input'); }\nfield.spellcheck = true;\n"
    },
    {
      label: 'early-return join requires DOM branch before spellcheck use',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = settings;\nif (enabled) field = document.createElement('input'); else return;\nfield.spellcheck = true;\n"
    },
    {
      label: 'for incrementor DOM reassignment and spellcheck use share a path',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = settings;\nfor (; ready; (field = settings, field = document.createElement('input'), field.spellcheck = true)) { break; }\n"
    },
    {
      label: 'nested-loop DOM recovery only kills its own carried state',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (outerReady) {\n  field = settings;\n  while (innerReady) {\n    field = document.createElement('input');\n    field.spellcheck = true;\n    break;\n  }\n  field = document.createElement('input');\n  field.spellcheck = true;\n}\n"
    },
    {
      label: 'continue after ancestor DOM does not bypass recovery',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  if (flag) field = settings;\n  field = document.createElement('input');\n  continue;\n}\n"
    },
    {
      label: 'unlabeled inner continue preserves outer ancestor DOM kill',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (outerReady) {\n  field.spellcheck = true;\n  while (innerReady) {\n    if (disabled) { field = settings; continue; }\n    field = document.createElement('input');\n  }\n  field = document.createElement('input');\n}\n"
    },
    {
      label: 'unreachable non-DOM after continue does not enter while state',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  field = document.createElement('input');\n  continue;\n  field = settings;\n}\n"
    },
    {
      label: 'unreachable non-DOM after labeled outer continue is excluded',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nouter: while (outerReady) {\n  field.spellcheck = true;\n  if (innerReady) {\n    field = document.createElement('input');\n    continue outer;\n    field = settings;\n  }\n}\n"
    },
    {
      label: 'continue exit includes mandatory finally DOM recovery',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try {\n    field = settings;\n    continue;\n  } finally {\n    field = document.createElement('input');\n  }\n}\n"
    },
    {
      label: 'conditional return path does not block backedge DOM recovery',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "function update() {\n  let field = document.createElement('input');\n  while (ready) {\n    field.spellcheck = true;\n    try { field = settings; continue; } finally {\n      if (abort) return;\n      field = document.createElement('input');\n    }\n  }\n}\n"
    },
    {
      label: 'conditional throw path does not block backedge DOM recovery',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try { field = settings; continue; } finally {\n    if (abort) throw new Error('stop');\n    field = document.createElement('input');\n  }\n}\n"
    },
    {
      label: 'caught throw does not block backedge DOM recovery',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try { field = settings; continue; } finally {\n    try { throw new Error('caught'); } catch {}\n    field = document.createElement('input');\n  }\n}\n"
    },
    {
      label: 'conditional outer continue does not block inner backedge DOM recovery',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nouter: while (outerReady) {\n  field = document.createElement('input');\n  while (innerReady) {\n    field.spellcheck = true;\n    try { field = settings; continue; } finally {\n      if (abort) continue outer;\n      field = document.createElement('input');\n    }\n  }\n}\n"
    },
    {
      label: 'conditional target break does not block target backedge DOM recovery',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nouter: while (outerReady) {\n  field = document.createElement('input');\n  while (innerReady) {\n    field.spellcheck = true;\n    try { field = settings; continue; } finally {\n      if (abort) break;\n      field = document.createElement('input');\n    }\n  }\n}\n"
    },
    {
      label: 'catch DOM recovery restores caught throw backedge',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try {\n    try { field = settings; continue; } finally {\n      if (abort) throw new Error('caught');\n      field = document.createElement('input');\n    }\n  } catch { field = document.createElement('input'); }\n}\n"
    },
    {
      label: 'catch return leaves target backedge',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "function update() {\n  let field = document.createElement('input');\n  while (ready) {\n    field.spellcheck = true;\n    try {\n      try { field = settings; continue; } finally {\n        if (abort) throw new Error('caught');\n        field = document.createElement('input');\n      }\n    } catch { return; }\n  }\n}\n"
    },
    {
      label: 'catch throw leaves target backedge',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try {\n    try { field = settings; continue; } finally {\n      if (abort) throw new Error('caught');\n      field = document.createElement('input');\n    }\n  } catch { throw new Error('leave'); }\n}\n"
    },
    {
      label: 'catch target break leaves target backedge',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try {\n    try { field = settings; continue; } finally {\n      if (abort) throw new Error('caught');\n      field = document.createElement('input');\n    }\n  } catch { break; }\n}\n"
    },
    {
      label: 'catch outer continue leaves inner target backedge',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nouter: while (outerReady) {\n  field = document.createElement('input');\n  while (innerReady) {\n    field.spellcheck = true;\n    try {\n      try { field = settings; continue; } finally {\n        if (abort) throw new Error('caught');\n        field = document.createElement('input');\n      }\n    } catch { continue outer; }\n  }\n}\n"
    },
    {
      label: 'unreachable same-target continue after inner break does not block DOM recovery',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try { field = settings; continue; } finally {\n    inner: { break inner; continue; }\n    field = document.createElement('input');\n  }\n}\n"
    },
    {
      label: 'same-target continue overridden by nested finally does not block DOM recovery',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "function update() {\n  let field = document.createElement('input');\n  while (ready) {\n    field.spellcheck = true;\n    try { field = settings; continue; } finally {\n      try { continue; } finally { return; }\n      field = document.createElement('input');\n    }\n  }\n}\n"
    },
    {
      label: 'inner break does not skip later mandatory finally DOM recovery',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try { field = settings; continue; } finally {\n    while (inner) { break; }\n    field = document.createElement('input');\n  }\n}\n"
    },
    {
      label: 'nested function return does not skip outer mandatory finally DOM recovery',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try { field = settings; continue; } finally {\n    function nested() { return; }\n    nested();\n    field = document.createElement('input');\n  }\n}\n"
    },
    {
      label: 'labeled outer continue includes mandatory finally recovery',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nouter: while (outerReady) {\n  field.spellcheck = true;\n  try {\n    if (innerReady) { field = settings; continue outer; }\n  } finally {\n    field = document.createElement('input');\n  }\n}\n"
    },
    {
      label: 'unconditional continue excludes descendant non-DOM state',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  field = document.createElement('input');\n  continue;\n  if (disabled) field = settings;\n}\n"
    },
    {
      label: 'continue through finally excludes after-try non-DOM state',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try {\n    field = document.createElement('input');\n    continue;\n  } finally {\n    observe();\n  }\n  field = settings;\n}\n"
    },
    {
      label: 'labeled outer continue through do excludes ancestor non-DOM state',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nouter: while (outerReady) {\n  field.spellcheck = true;\n  do {\n    field = document.createElement('input');\n    continue outer;\n  } while (innerReady);\n  field = settings;\n}\n"
    },
    {
      label: 'throwing finally overrides continue after DOM recovery',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try { field = settings; continue; } finally {\n    field = document.createElement('input');\n    throw new Error('stop');\n  }\n}\n"
    },
    {
      label: 'returning finally overrides continue after DOM recovery',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "function update() {\n  let field = document.createElement('input');\n  while (ready) {\n    field.spellcheck = true;\n    try { field = settings; continue; } finally {\n      field = document.createElement('input');\n      return;\n    }\n  }\n}\n"
    },
    {
      label: 'definite return excludes unreachable later finally state',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "function update() {\n  let field = document.createElement('input');\n  while (ready) {\n    field.spellcheck = true;\n    try { continue; } finally {\n      return;\n      field = settings;\n    }\n  }\n}\n"
    },
    {
      label: 'breaking finally overrides continue after DOM recovery',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try { field = settings; continue; } finally {\n    field = document.createElement('input');\n    break;\n  }\n}\n"
    },
    {
      label: 'throwing finally excludes its non-DOM state from loop entry',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try { continue; } finally {\n    field = settings;\n    throw new Error('stop');\n  }\n}\n"
    },
    {
      label: 'throwing finally removes ancestor non-DOM state from loop entry',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  field = settings;\n  try { continue; } finally { throw new Error('stop'); }\n}\n"
    },
    {
      label: 'returning finally removes ancestor non-DOM state from loop entry',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "function update() {\n  let field = document.createElement('input');\n  while (ready) {\n    field.spellcheck = true;\n    field = settings;\n    try { continue; } finally { return; }\n  }\n}\n"
    },
    {
      label: 'target break in finally removes ancestor non-DOM state from loop entry',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  field = settings;\n  try { continue; } finally { break; }\n}\n"
    },
    {
      label: 'outer continue in finally overrides inner loop backedge',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nouter: while (outerReady) {\n  field = document.createElement('input');\n  while (innerReady) {\n    field.spellcheck = true;\n    try { field = settings; continue; } finally { continue outer; }\n  }\n}\n"
    },
    {
      label: 'break to enclosing block overrides contained loop backedge',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nouterBlock: {\n  while (ready) {\n    field.spellcheck = true;\n    try { field = settings; continue; } finally { break outerBlock; }\n  }\n}\n"
    },
    {
      label: 'break to enclosing outer loop overrides inner loop backedge',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nouter: while (outerReady) {\n  field = document.createElement('input');\n  while (innerReady) {\n    field.spellcheck = true;\n    try { field = settings; continue; } finally { break outer; }\n  }\n}\n"
    },
    {
      label: 'for-of iteration binding resets before each loop body',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "for (let field: HTMLInputElement of fields) {\n  field.spellcheck = true;\n  field = settings;\n}\n"
    },
    {
      label: 'catch parameter does not pollute outer DOM receiver',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "const field = document.createElement('input');\ntry { run(); } catch (field) { consume(field); }\nfield.spellcheck = true;\n"
    },
    {
      label: 'switch case binding does not pollute outer DOM receiver',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "const field = document.createElement('input');\nswitch (mode) { case 'edit': let field = settings; consume(field); break; default: break; }\nfield.spellcheck = true;\n"
    },
    {
      label: 'DOM native spellcheck setAttribute calls',
      path: 'webview/src/helpers/nativeSpellcheckAttribute.ts',
      contents: "input.setAttribute('spellcheck', 'false');\ntextarea.setAttribute('spellcheck', 'true');\n"
    },
    {
      label: 'ordinary diagnostics logging suggestion',
      path: 'src/host/diagnosticLogging.ts',
      contents: "export const note = 'Suggest diagnostic logging improvements.';\n"
    },
    {
      label: 'ordinary DiagnosticSuggestions wording',
      path: 'README.md',
      contents: 'DiagnosticSuggestions is a generic example type.\n'
    },
    {
      label: 'platform diagnostic collections',
      path: 'src/host/platformDiagnostics.ts',
      contents: "vscode.languages.createDiagnosticCollection('compiler');\nexport class CompilerDiagnosticCollection {}\n"
    },
    {
      label: 'ordinary diagnostics decoders',
      path: 'src/protocol/platformDiagnostics.ts',
      contents: 'export const decodeDiagnostics = undefined;\nexport class CompilerDiagnosticDecoder {}\n'
    },
    {
      label: 'ordinary MEO diagnostics wording',
      path: 'README.md',
      contents: 'MEO diagnostics remain visible.\n'
    }
  ];
  const rejectedAllowedSpellDiagnosticFixtures: string[] = [];
  for (const fixture of allowedNativeSpellcheckAndDiagnosticsFixtures) {
    write(fixture.path, fixture.contents);
    const outcome = runCheck();
    if (!outcome.ok) {
      rejectedAllowedSpellDiagnosticFixtures.push(`${fixture.label}: ${outcome.output}`);
    }
    rmSync(join(fixtureRoot, ...fixture.path.split('/')));
  }

  const architectureCheckerSource = readFileSync(
    join(fixtureRoot, 'scripts', 'check-architecture.ts'),
    'utf8'
  );
  const perReceiverFullFileScan = /for \(const receiver of [^)]+\)[\s\S]{0,500}?\.replace\(/.test(
    architectureCheckerSource
  );
  const usesCodePointMask = /\[\.\.\.text\]/.test(architectureCheckerSource);
  const bindingCollection = architectureCheckerSource.indexOf('collectBindings(sourceFile, null)');
  const useCollection = architectureCheckerSource.indexOf(
    'collectUsesAndAssignments(sourceFile, scopeByNode.get(sourceFile)!'
  );
  const usesTwoPhaseSpellcheckBindingAnalysis = bindingCollection >= 0 && useCollection > bindingCollection;
  const routesVarToFunctionScope = /kind === 'var' \? nearestFunctionScope\(scope\) : scope/.test(
    architectureCheckerSource
  );
  const cachesSpellcheckControlPathMetadata =
    architectureCheckerSource.includes('controlPathMetadataCache.get(controlPath)') &&
    architectureCheckerSource.includes('controlPathMetadataCache.set(controlPath, metadata)');

  write('webview/src/helpers/retainedDiagnosticsAndSelection.ts', [
    "export const platformDiagnostics = 'VS Code diagnostics';",
    "export const compilerErrorsVisible = true;",
    "export const selectionCommands = ['bold', 'italic', 'strikethrough', 'highlight', 'inline-code', 'link', 'wiki', 'kbd', 'underline'];",
    ''
  ].join('\n'));
  const retainedDiagnosticsAndSelection = runCheck();
  assert.deepEqual({
    missedSpellDiagnosticCapabilities,
    rejectedAllowedSpellDiagnosticFixtures,
    perReceiverFullFileScan,
    usesCodePointMask,
    usesTwoPhaseSpellcheckBindingAnalysis,
    routesVarToFunctionScope,
    cachesSpellcheckControlPathMetadata,
    retainedDiagnosticsAndSelection: retainedDiagnosticsAndSelection.ok ? '' : retainedDiagnosticsAndSelection.output
  }, {
    missedSpellDiagnosticCapabilities: [],
    rejectedAllowedSpellDiagnosticFixtures: [],
    perReceiverFullFileScan: false,
    usesCodePointMask: false,
    usesTwoPhaseSpellcheckBindingAnalysis: true,
    routesVarToFunctionScope: true,
    cachesSpellcheckControlPathMetadata: true,
    retainedDiagnosticsAndSelection: ''
  }, 'MEO spell/diagnostic suggestion aliases must be rejected without rejecting platform diagnostics or selection commands');
  rmSync(join(fixtureRoot, 'webview', 'src', 'helpers', 'retainedDiagnosticsAndSelection.ts'));

  write('webview/src/helpers/retainedGitDiff.ts', [
    "export const gitChangesGutter = 'source-live';",
    "export const diffBaselineMode = 'git-head';",
    "export const blameCache = new Map<string, string>();",
    "export const blameHover = { hidden: true };",
    "export const gitRepository = { root: '/repo' };",
    "export const runGitCli = (args: string[]) => args;",
    "export const annotateDocument = (text: string) => text;",
    "export const commitInfo = { oid: 'abc' };",
    "export const documentHistory: string[] = [];",
    "export const retainedDiff = { modifiedLineColoring: true, gitAuthorInfo: true };",
    "export const retainedDescription = 'Optionally show subtle modified-line coloring and Git author information.';",
    "export const openDocumentLink = (href: string) => href.startsWith('#') ? href : `#${href}`;",
    ''
  ].join('\n'));
  const retainedGitDiff = runCheck();
  assert.equal(retainedGitDiff.ok, true, `private names and retained Git/document capabilities must pass: ${retainedGitDiff.output}`);
  rmSync(join(fixtureRoot, 'webview', 'src', 'helpers', 'retainedGitDiff.ts'));

  write('CHANGELOG.md', '- Removed the historical Git Blame command.\n');
  const changelogHistory = runCheck();
  assert.equal(changelogHistory.ok, true, `CHANGELOG history must remain allowed: ${changelogHistory.output}`);
  rmSync(join(fixtureRoot, 'CHANGELOG.md'));

  const stagedRoot = join(fixtureRoot, 'staged-index');
  mkdirSync(join(stagedRoot, 'scripts'), { recursive: true });
  cpSync(join(repoRoot, 'scripts', 'check-architecture.ts'), join(stagedRoot, 'scripts', 'check-architecture.ts'));
  writeFileSync(join(stagedRoot, 'scripts', 'architecture-baseline.json'), JSON.stringify({
    targetRoots: [], knownLegacyTestFailures: []
  }));
  writeFileSync(join(stagedRoot, 'README.md'), 'Order the rows by name.\n');
  mkdirSync(join(stagedRoot, 'docs'), { recursive: true });
  writeFileSync(join(stagedRoot, 'docs', '表 格.md'), 'Unicode path without a removed capability.\n');
  writeFileSync(join(stagedRoot, 'docs', 'deleted.md'), 'This file will be deleted from the index.\n');
  writeFileSync(join(stagedRoot, 'ignored-binary.bin'), Buffer.from([0, 255, 1, 254]));
  execFileSync('git', ['init', '--quiet'], { cwd: stagedRoot });
  execFileSync('git', ['add', '--', '.'], { cwd: stagedRoot });
  rmSync(join(stagedRoot, 'docs', 'deleted.md'));
  execFileSync('git', ['add', '--update'], { cwd: stagedRoot });
  writeFileSync(join(stagedRoot, 'README.md'), 'No table capability here.\n');
  const stagedAlias = (() => {
    try {
      execFileSync('bun', ['scripts/check-architecture.ts', '--staged'], {
        cwd: stagedRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
      });
      return { ok: true, output: '' };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
    }
  })();
  assert.equal(stagedAlias.ok, false, 'staged ARCH013 must read the alias from the index');
  assert.match(stagedAlias.output, /ARCH013/);

  execFileSync('git', ['add', '--', 'README.md'], { cwd: stagedRoot });
  writeFileSync(join(stagedRoot, 'README.md'), 'Order the rows by name.\n');
  const unstagedAlias = execFileSync('bun', ['scripts/check-architecture.ts', '--staged'], {
    cwd: stagedRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.match(unstagedAlias, /Architecture checks passed/);

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
