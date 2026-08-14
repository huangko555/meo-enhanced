import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  darkBuiltInVisuals,
  getBuiltInVisuals,
  lightBuiltInVisuals
} from '../src/shared/builtInVisualBaseline';

const repoRoot = resolve(import.meta.dir, '..');
const fixtureRoot = mkdtempSync(join(repoRoot, '.tmp-architecture-shared-module-'));
const cleanupWait = new Int32Array(new SharedArrayBuffer(4));

const removeFixtureRoot = (): void => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(fixtureRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 9 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY')) throw error;
      Atomics.wait(cleanupWait, 0, 0, 500);
    }
  }
};

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
  const finalCodePaletteSource = readFileSync(
    join(repoRoot, 'webview/src/application/finalCodePalette.ts'),
    'utf8'
  );
  assert.doesNotMatch(finalCodePaletteSource, /@shikijs|\b(?:document|CSSStyleDeclaration)\b/);
  const builtInVisualsSource = readFileSync(join(repoRoot, 'src/shared/builtInVisualBaseline.ts'), 'utf8');
  for (const removedShape of [
    /\bThemeFonts\b/,
    /\bBuiltInVisualBaseline\b/,
    /\bh[1-6]Font(?:Size|Weight)\b/,
    /Partial<(?:Visual|Theme|Semantic|Syntax|BuiltIn)/
  ]) {
    assert.doesNotMatch(builtInVisualsSource, removedShape);
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
  const caughtSummaryIndex = architectureSource.indexOf('const caughtCompletionSummariesByContext =');
  const bindingLoopIndex = architectureSource.indexOf('for (const binding of bindings)');
  assert.ok(caughtSummaryIndex >= 0 && caughtSummaryIndex < bindingLoopIndex);
  const exitLoopIndex = architectureSource.indexOf('for (const exit of exits)');
  const exitLoopEnd = architectureSource.indexOf(
    'for (const positions of summary.blockerPositionsByAncestorPath.values())',
    exitLoopIndex
  );
  assert.doesNotMatch(
    architectureSource.slice(exitLoopIndex, exitLoopEnd),
    /throwsByFinallyBlock/,
    'ARCH015 exit processing must only associate finally blocks, not rescan their throws'
  );
  assert.match(architectureSource, /const associatedFinallyPrefixesByContext =/);
  assert.match(architectureSource, /allBlockerPositionsByAncestorPath/);
  assert.match(architectureSource, /catchesByPath/);
  assert.doesNotMatch(architectureSource, /caughtThrowsByContext|orderedCompletions/);
  const bindingLoopSource = architectureSource.slice(
    bindingLoopIndex,
    architectureSource.indexOf('\n  return ranges;', bindingLoopIndex)
  );
  assert.doesNotMatch(
    bindingLoopSource,
    /caughtThrowsByContext|orderedCompletions|completion\.pathPrefixes|\.sort\(\(left, right\) => left - right\)/,
    'ARCH015 binding processing must query prebuilt caught-completion summaries without rebuilding or sorting them'
  );
  assert.match(bindingLoopSource, /for \(const \[context, loopEvents\] of loopEntryEventsByContext\)/);
  assert.match(bindingLoopSource, /catchesByPath\.get\(event\.pathKey\)/);
  assert.match(bindingLoopSource, /firstPositionAfterExcluding\(/);
  assert.doesNotMatch(
    bindingLoopSource,
    /for \([^\n]+allBlockerPositionsByAncestorPath/,
    'bindings without catch-root events must binary-query the owner index without traversing all completions'
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

  write('scripts/architecture-baseline.json', JSON.stringify({
    targetRoots: ['webview/src/application'], knownLegacyTestFailures: []
  }));
  const applicationExternalDependencyFixtures = [
    "import fallback from '@shikijs/themes/github-light';\nexport const palette = fallback;\n",
    "import 'shiki';\nexport const palette = true;\n",
    "import { createHighlighter } from 'shiki';\nexport const palette = createHighlighter;\n",
    'export type Surface = HTMLElement;\n',
    'export type OwnerDocument = Document;\n',
    'export type SurfaceElement = Element;\n',
    'export const readStyle = (value: unknown) => getComputedStyle(value as Element);\n',
    'export const readStorage = () => localStorage.getItem("palette");\n',
    'export const observe = (callback: MutationCallback) => new MutationObserver(callback);\n',
    'export const root = globalThis.document;\n',
    "export const root = globalThis['document'];\n",
    'export const storage = globalThis["localStorage"];\n',
    'export const root = globalThis[`document`];\n',
    'export const root = (globalThis).document;\n',
    "export const Observer = ((globalThis))['MutationObserver'];\n"
  ] as const;
  for (const contents of applicationExternalDependencyFixtures) {
    write('webview/src/application/palette.ts', contents);
    const outcome = runCheck();
    assert.equal(outcome.ok, false, `Application external dependency must be rejected: ${contents}`);
    assert.match(outcome.output, /ARCH004/);
  }
  write('webview/src/application/palette.ts', [
    'export type SerializablePalette = { document: string; elementColor: string; storageKey: string };',
    'export const describeDocument = (palette: SerializablePalette) => palette.document;',
    'export const readOrdinaryObject = (value: { document: string }) => value.document;',
    "export const readDynamicGlobal = (key: string) => globalThis[key as keyof typeof globalThis];",
    ''
  ].join('\n'));
  const applicationDomainWords = runCheck();
  assert.equal(applicationDomainWords.ok, true, `ordinary serializable/domain words must pass: ${applicationDomainWords.output}`);
  write('webview/src/adapters/palette.ts', [
    "import 'shiki';",
    'export const attach = (element: HTMLElement) => getComputedStyle(element);',
    "export const root = ((globalThis))['document'];",
    ''
  ].join('\n'));
  const adapterExternalDependencies = runCheck();
  assert.equal(adapterExternalDependencies.ok, true, `Adapter Shiki/DOM dependencies must pass: ${adapterExternalDependencies.output}`);
  rmSync(join(fixtureRoot, 'webview/src/adapters/palette.ts'));
  rmSync(join(fixtureRoot, 'webview/src/application/palette.ts'));
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

  const removedVimCapabilityFixtures = [
    {
      label: 'CodeMirror Vim dependency',
      path: 'package.json',
      contents: JSON.stringify({ dependencies: { '@replit/codemirror-vim': '^6.3.0' } })
    },
    {
      label: 'Vim dependency lock entry',
      path: 'bun.lock',
      contents: '"codemirror-vim": ["codemirror-vim@6.3.0", ""]\n'
    },
    {
      label: 'Vim mode setting alias',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.viMode.behavior': { type: 'string' }
      } } } })
    },
    {
      label: 'VSCodeVim Host integration',
      path: 'src/host/vimIntegration.ts',
      contents: "export const extensionId = 'vscodevim.vim';\n"
    },
    {
      label: 'Vim Protocol state aliases',
      path: 'src/protocol/vimConfiguration.ts',
      contents: "export type VimConfiguration = { type: 'syncViKeybindings'; vimLeader: string };\n"
    },
    {
      label: 'Vim editor UI aliases',
      path: 'webview/src/editor/vimControls.ts',
      contents: "export const vimModePanel = { label: 'Enable Vim emulation' };\n"
    },
    {
      label: 'Vim capability in public docs',
      path: 'README.md',
      contents: 'Enable Vi keybindings in Source mode.\n'
    },
    {
      label: 'Vim configuration in MEO public docs',
      path: 'docs/editor-settings.md',
      contents: 'The Vim configuration in MEO controls editor behavior.\n'
    },
    {
      label: 'MEO Vim mode in public docs',
      path: 'docs/editor-mode.md',
      contents: 'MEO provides a Vim mode in the editor.\n'
    },
    {
      label: 'MEO Vim toolbar panel in public docs',
      path: 'docs/editor-toolbar.md',
      contents: 'The MEO toolbar exposes a Vim panel.\n'
    },
    {
      label: 'embedded Vim integration in public docs',
      path: 'docs/editor-integration.md',
      contents: 'Enable the embedded Vim integration in Live mode.\n'
    },
    {
      label: 'pure vimEnabled state alias',
      path: 'src/host/editorPreferences.ts',
      contents: 'export const vimEnabled = true;\n'
    },
    {
      label: 'pure viEnabled state alias',
      path: 'webview/src/editor/preferences.ts',
      contents: 'export const viEnabled = true;\n'
    },
    {
      label: 'pure VimState alias',
      path: 'src/protocol/editorState.ts',
      contents: 'export type VimState = { active: boolean };\n'
    },
    {
      label: 'pure VimConfiguration alias',
      path: 'src/host/editorConfiguration.ts',
      contents: 'export type VimConfiguration = { active: boolean };\n'
    },
    {
      label: 'dotted Vim active setting alias',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.vim.active': { type: 'boolean' }
      } } } })
    },
    {
      label: 'kebab Vim behavior state alias',
      path: 'webview/src/editor/preferences.ts',
      contents: "export const setting = { 'vim-behavior': 'active' };\n"
    },
    {
      label: 'path-only Vim state entry',
      path: 'webview/src/adapters/vimState.ts',
      contents: 'export const enabled = true;\n'
    }
  ];
  const missedVimCapabilities: string[] = [];
  for (const fixture of removedVimCapabilityFixtures) {
    write(fixture.path, fixture.contents);
    const outcome = runCheck();
    if (outcome.ok || !/ARCH016/.test(outcome.output)) {
      missedVimCapabilities.push(fixture.label);
    }
    rmSync(join(fixtureRoot, ...fixture.path.split('/')));
  }
  assert.deepEqual(missedVimCapabilities, [], `ARCH016 missed removed Vim capabilities: ${missedVimCapabilities.join(', ')}`);

  write('README.md', [
    'Open this document in Vim before comparing the Markdown output.',
    'Set Vim as your external editor if that is your preferred tool.',
    ''
  ].join('\n'));
  const ordinaryVimText = runCheck();
  assert.equal(ordinaryVimText.ok, true, `ordinary Vim text must remain allowed: ${ordinaryVimText.output}`);
  rmSync(join(fixtureRoot, 'README.md'));

  const ordinaryVimDocumentationFixtures = [
    {
      label: 'ordinary Vim configuration prose in README',
      path: 'README.md',
      contents: 'The Vim configuration lives in ~/.vimrc.\n'
    },
    {
      label: 'ordinary active Vim state prose in docs',
      path: 'docs/external-editor.md',
      contents: 'Check the active Vim state before editing.\n'
    },
    {
      label: 'ordinary external Vim documentation path',
      path: 'docs/vim-configuration.md',
      contents: '# External editor\n\nSee ~/.vimrc for setup.\n'
    },
    {
      label: 'ordinary external Vim keybindings prose',
      path: 'docs/external-vim.md',
      contents: 'Vim keybindings are configured in ~/.vimrc.\n'
    },
    {
      label: 'ordinary external Vim mode prose',
      path: 'docs/external-vim-mode.md',
      contents: 'Vim starts in normal mode.\n'
    },
    {
      label: 'ordinary external Vim integration prose',
      path: 'docs/external-vim-integration.md',
      contents: 'Vim integration with tmux is documented upstream.\n'
    },
    {
      label: 'ordinary external Vim emulation prose',
      path: 'docs/external-vim-emulation.md',
      contents: 'Vim emulation in a terminal is configured separately.\n'
    }
  ];
  for (const fixture of ordinaryVimDocumentationFixtures) {
    write(fixture.path, fixture.contents);
    const outcome = runCheck();
    assert.equal(outcome.ok, true, `${fixture.label} must remain allowed: ${outcome.output}`);
    rmSync(join(fixtureRoot, ...fixture.path.split('/')));
  }

  write('package.json', JSON.stringify({ description: 'The Vim configuration lives in ~/.vimrc.' }));
  const ordinaryVimPackageDescription = runCheck();
  assert.equal(ordinaryVimPackageDescription.ok, true, `ordinary package prose must remain allowed: ${ordinaryVimPackageDescription.output}`);
  rmSync(join(fixtureRoot, 'package.json'));

  const removedEmojiShortcodeFixtures = [
    {
      label: 'markdown-it Emoji dependency',
      path: 'package.json',
      contents: JSON.stringify({ dependencies: { 'markdown-it-emoji': '^3.0.0' } })
    },
    {
      label: 'Emoji shortcode lock entry',
      path: 'bun.lock',
      contents: '"markdown-it-emoji": ["markdown-it-emoji@3.0.0", ""]\n'
    },
    {
      label: 'Live Emoji shortcode conversion',
      path: 'webview/src/liveEmojiPresentation.ts',
      contents: 'export const collectEmojiShortcodeRanges = () => [];\n'
    },
    {
      label: 'table Emoji shortcode conversion',
      path: 'webview/src/tableInlinePresentation.ts',
      contents: 'export const tableEmojiShortcode = { render: true };\n'
    },
    {
      label: 'export Emoji plugin alias',
      path: 'src/export/emojiPresentation.ts',
      contents: 'export const renderEmojiShortcode = (value: string) => value;\n'
    },
    {
      label: 'Emoji selector UI',
      path: 'webview/src/editor/emojiControls.ts',
      contents: 'export const openEmojiPicker = () => undefined;\n'
    },
    {
      label: 'Emoji chooser open alias',
      path: 'webview/src/editor/emojiChooser.ts',
      contents: 'export const openEmojiChooser = () => undefined;\n'
    },
    {
      label: 'Emoji chooser show alias',
      path: 'webview/src/editor/emojiControls.ts',
      contents: 'export const showEmojiChooser = () => undefined;\n'
    },
    {
      label: 'Emoji setting',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.emojiShortcodes.enabled': { type: 'boolean' }
      } } } })
    },
    {
      label: 'Emoji chooser dotted setting',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.emoji.chooser.enabled': { type: 'boolean' }
      } } } })
    },
    {
      label: 'Emoji chooser camel setting',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.emojiChooser.enabled': { type: 'boolean' }
      } } } })
    },
    {
      label: 'root emoji-regex dependency',
      path: 'package.json',
      contents: JSON.stringify({ dependencies: { 'emoji-regex': '^8.0.0' } })
    },
    {
      label: 'root emoji-regex lock dependency',
      path: 'bun.lock',
      contents: '        "emoji-regex": "^8.0.0",\n'
    },
    {
      label: 'source emoji-regex owner',
      path: 'webview/src/editor/emojiText.ts',
      contents: [
        "import emojiRegex from 'emoji-regex';",
        'export const matchEmoji = (text: string) => emojiRegex().exec(text);',
        ''
      ].join('\n')
    },
    {
      label: 'Emoji Protocol command',
      path: 'src/protocol/emojiSelection.ts',
      contents: "export type EmojiCommand = { type: 'selectEmojiPicker' };\n"
    },
    {
      label: 'Emoji Host selector',
      path: 'src/host/emojiSelector.ts',
      contents: 'export const showEmojiPalette = () => undefined;\n'
    },
    {
      label: 'Emoji conversion docs',
      path: 'README.md',
      contents: 'Convert Emoji shortcodes such as :smile: into symbols.\n'
    },
    {
      label: 'Emoji selector docs',
      path: 'docs/editor-toolbar.md',
      contents: 'Open the Emoji picker to insert a symbol.\n'
    }
  ];
  const missedEmojiShortcodeCapabilities: string[] = [];
  for (const fixture of removedEmojiShortcodeFixtures) {
    write(fixture.path, fixture.contents);
    const outcome = runCheck();
    if (outcome.ok || !/ARCH017/.test(outcome.output)) {
      missedEmojiShortcodeCapabilities.push(fixture.label);
    }
    rmSync(join(fixtureRoot, ...fixture.path.split('/')));
  }
  assert.deepEqual(
    missedEmojiShortcodeCapabilities,
    [],
    `ARCH017 missed removed Emoji shortcode capabilities: ${missedEmojiShortcodeCapabilities.join(', ')}`
  );

  write('webview/src/editor/ordinaryEmojiText.ts', "export const ordinaryText = 'Unicode emoji stays ordinary text: 😄';\n");
  write('docs/unicode-text.md', 'Unicode emoji 😄 and the word emoji are ordinary document text.\n');
  write('docs/emoji-choice.md', 'Choose an emoji character in your operating system, then paste it as ordinary text.\n');
  write('bun.lock', [
    '"emoji-regex": ["emoji-regex@8.0.0", "", {}, "sha512-test"]',
    '"string-width": ["string-width@4.2.3", "", { "dependencies": { "emoji-regex": "^8.0.0" } }]',
    ''
  ].join('\n'));
  const retainedEmojiText = runCheck();
  assert.equal(
    retainedEmojiText.ok,
    true,
    `Unicode emoji prose and transitive emoji-regex lock records must remain allowed: ${retainedEmojiText.output}`
  );
  rmSync(join(fixtureRoot, 'webview', 'src', 'editor', 'ordinaryEmojiText.ts'));
  rmSync(join(fixtureRoot, 'docs', 'unicode-text.md'));
  rmSync(join(fixtureRoot, 'docs', 'emoji-choice.md'));
  rmSync(join(fixtureRoot, 'bun.lock'));

  const removedMermaidColonFixtures = [
    {
      label: 'Mermaid colon block cache',
      path: 'webview/src/helpers/mermaidColonBlocks.ts',
      contents: 'export const mermaidColonBlockCache = new WeakMap();\n'
    },
    {
      label: 'Mermaid colon blocks accessor',
      path: 'webview/src/helpers/mermaidColonBlocks.ts',
      contents: 'export const getMermaidColonBlocks = () => [];\n'
    },
    {
      label: 'Mermaid colon fence parser alias',
      path: 'src/export/markdownCompatibility.ts',
      contents: 'export const parseMermaidColonFenceOpenLine = (line: string) => line;\n'
    },
    {
      label: 'Mermaid colon fence detection alias',
      path: 'webview/src/editor/mermaidCompatibility.ts',
      contents: 'export const detectMermaidColonFences = (markdown: string) => markdown;\n'
    },
    {
      label: 'Mermaid colon export normalization',
      path: 'src/export/markdownCompatibility.ts',
      contents: 'export const normalizeMermaidColonFences = (markdown: string) => markdown;\n'
    },
    {
      label: 'Live Mermaid colon decoration',
      path: 'webview/src/liveMode.ts',
      contents: 'export const addMermaidColonFenceDecorations = () => undefined;\n'
    },
    {
      label: 'Source Mermaid colon CSS',
      path: 'webview/src/styles.css',
      contents: '.meo-md-colon-fence-marker { color: red; }\n'
    },
    {
      label: 'Mermaid colon container alias',
      path: 'webview/src/editor/mermaidContainer.ts',
      contents: 'export const renderColonMermaidBlock = (source: string) => source;\n'
    },
    {
      label: 'Mermaid colon Source action',
      path: 'webview/src/editor/mermaidCompatibility.ts',
      contents: 'export const renderMermaidColonBlockInSource = () => undefined;\n'
    },
    {
      label: 'Mermaid colon Live action',
      path: 'webview/src/editor/mermaidCompatibility.ts',
      contents: 'export const renderMermaidColonContainerInLive = () => undefined;\n'
    },
    {
      label: 'Mermaid colon Preview action',
      path: 'webview/src/editor/mermaidCompatibility.ts',
      contents: 'export const previewMermaidColonFence = () => undefined;\n'
    },
    {
      label: 'Mermaid colon export action',
      path: 'webview/src/editor/mermaidCompatibility.ts',
      contents: 'export const exportMermaidColonBlock = () => undefined;\n'
    },
    {
      label: 'Mermaid colon export syntax camel action',
      path: 'webview/src/editor/mermaidCompatibility.ts',
      contents: 'export const exportMermaidColonSyntax = () => undefined;\n'
    },
    {
      label: 'Mermaid colon dotted alias',
      path: 'webview/src/editor/mermaidCompatibility.ts',
      contents: "export const dottedCapability = 'mermaid.colon.fence';\n"
    },
    {
      label: 'Mermaid colon kebab alias',
      path: 'webview/src/editor/mermaidCompatibility.ts',
      contents: "export const kebabCapability = 'detect-mermaid-colon-containers';\n"
    },
    {
      label: 'Mermaid colon export syntax kebab action',
      path: 'webview/src/editor/mermaidCompatibility.ts',
      contents: "export const kebabCapability = 'export-mermaid-colon-syntax';\n"
    },
    {
      label: 'Mermaid colon setting',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.mermaidColonFences.enabled': { type: 'boolean' }
      } } } })
    },
    {
      label: 'Mermaid colon Protocol command',
      path: 'src/protocol/mermaidColon.ts',
      contents: "export type MermaidCommand = { type: 'enableMermaidColonSyntax' };\n"
    },
    {
      label: 'Mermaid colon Host capability',
      path: 'src/host/mermaidContainers.ts',
      contents: 'export const renderMermaidColonContainer = () => undefined;\n'
    },
    {
      label: 'Mermaid colon documentation',
      path: 'docs/mermaid.md',
      contents: 'MEO supports :::mermaid blocks in Live and Preview.\n'
    },
    {
      label: 'Mermaid colon semantic capability documentation',
      path: 'docs/mermaid.md',
      contents: 'Render Mermaid colon containers in Live and export.\n'
    },
    {
      label: 'Mermaid colon export syntax documentation action',
      path: 'docs/mermaid.md',
      contents: 'Export Mermaid colon syntax.\n'
    }
  ];
  const missedMermaidColonCapabilities: string[] = [];
  for (const fixture of removedMermaidColonFixtures) {
    write(fixture.path, fixture.contents);
    const outcome = runCheck();
    if (outcome.ok || !/ARCH018/.test(outcome.output)) {
      missedMermaidColonCapabilities.push(fixture.label);
    }
    rmSync(join(fixtureRoot, ...fixture.path.split('/')));
  }
  assert.deepEqual(
    missedMermaidColonCapabilities,
    [],
    `ARCH018 missed removed Mermaid colon capabilities: ${missedMermaidColonCapabilities.join(', ')}`
  );

  const removedHeadingFoldAndOutlineReorderFixtures = [
    {
      label: 'heading collapsed state owner',
      path: 'webview/src/editor/heading.ts',
      contents: 'export const headingCollapsedState = new Map();\n'
    },
    {
      label: 'heading folded state owner',
      path: 'webview/src/editor/heading.ts',
      contents: 'export const headingFoldedState = new Map();\n'
    },
    {
      label: 'heading expanded state owner',
      path: 'webview/src/editor/heading.ts',
      contents: 'export const headingExpandedState = new Map();\n'
    },
    {
      label: 'Markdown section folded state owner',
      path: 'webview/src/editor/markdown.ts',
      contents: 'export const markdownSectionFoldedState = new Map();\n'
    },
    {
      label: 'dotted heading collapsed state setting',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.heading.collapsed.state': { type: 'boolean' }
      } } } })
    },
    {
      label: 'kebab Markdown section folded state Host action',
      path: 'src/host/markdown.ts',
      contents: "export const capability = 'markdown-section-folded-state';\n"
    },
    {
      label: 'retained outline collapse with removed Markdown section fold',
      path: 'webview/src/editor/outline.ts',
      contents: "export const capabilities = ['outline-heading-collapse', markdownSectionFoldedState];\n"
    },
    {
      label: 'retained outline collapse with removed heading fold',
      path: 'webview/src/editor/outline.ts',
      contents: "export const capabilities = ['outline-heading-collapse', headingFoldedState];\n"
    },
    {
      label: 'outline section reordering owner',
      path: 'webview/src/helpers/outline.ts',
      contents: 'export const outlineSectionReordering = () => undefined;\n'
    },
    {
      label: 'outline item dragging owner',
      path: 'webview/src/helpers/outline.ts',
      contents: 'export const outlineItemDragging = () => undefined;\n'
    },
    {
      label: 'dotted outline node moving setting',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.outline.node.moving': { type: 'boolean' }
      } } } })
    },
    {
      label: 'kebab outline section dropping Host action',
      path: 'src/host/outline.ts',
      contents: "export const capability = 'outline-section-dropping';\n"
    },
    {
      label: 'outline node moved Protocol event',
      path: 'src/protocol/outline.ts',
      contents: "export type OutlineEvent = { type: 'outlineNodeMoved' };\n"
    },
    {
      label: 'outline item dragged documentation',
      path: 'docs/outline.md',
      contents: 'The outline item is dragged into a new document position.\n'
    },
    {
      label: 'outline section reordered owner',
      path: 'webview/src/helpers/outline.ts',
      contents: 'export const outlineSectionReordered = () => undefined;\n'
    },
    {
      label: 'dotted outline node dropped setting',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.outline.node.dropped': { type: 'boolean' }
      } } } })
    },
    {
      label: 'bare heading folding owner',
      path: 'webview/src/editor/heading.ts',
      contents: 'export const headingFolding = new Map();\n'
    },
    {
      label: 'heading folding path owner',
      path: 'webview/src/helpers/headingFolding.ts',
      contents: 'export const state = new Map();\n'
    },
    {
      label: 'heading folding owner suffix',
      path: 'webview/src/editor/heading.ts',
      contents: 'export const headingFoldingController = {};\n'
    },
    {
      label: 'dotted heading folding setting',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.heading.folding.enabled': { type: 'boolean' }
      } } } })
    },
    {
      label: 'kebab heading folding alias',
      path: 'webview/src/editor/heading.ts',
      contents: "export const capability = 'heading-folding-controller';\n"
    },
    {
      label: 'heading folding Protocol command',
      path: 'src/protocol/heading.ts',
      contents: "export type HeadingCommand = { type: 'toggleHeadingFolding' };\n"
    },
    {
      label: 'heading folding documentation',
      path: 'docs/editor.md',
      contents: 'Use heading folding in the editor.\n'
    },
    {
      label: 'camel Markdown section fold action',
      path: 'webview/src/editor/markdown.ts',
      contents: 'export const foldMarkdownSection = () => undefined;\n'
    },
    {
      label: 'dotted Markdown section collapse setting',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.markdown.section.collapse': { type: 'boolean' }
      } } } })
    },
    {
      label: 'kebab Markdown section fold Host action',
      path: 'src/host/markdown.ts',
      contents: "export const capability = 'fold-markdown-section';\n"
    },
    {
      label: 'outline section reorder owner',
      path: 'webview/src/helpers/outline.ts',
      contents: 'export const outlineSectionReorder = () => undefined;\n'
    },
    {
      label: 'outline section move owner',
      path: 'src/host/outline.ts',
      contents: 'export const outlineSectionMove = () => undefined;\n'
    },
    {
      label: 'drag outline item action',
      path: 'webview/src/editor/outline.ts',
      contents: 'export const dragOutlineItem = () => undefined;\n'
    },
    {
      label: 'dotted outline node drop setting',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.outline.node.drop': { type: 'boolean' }
      } } } })
    },
    {
      label: 'kebab outline node move alias',
      path: 'webview/src/editor/outline.ts',
      contents: "export const capability = 'move-outline-node';\n"
    },
    {
      label: 'outline item reorder Protocol command',
      path: 'src/protocol/outline.ts',
      contents: "export type OutlineCommand = { type: 'reorderOutlineItem' };\n"
    },
    {
      label: 'outline section drag documentation',
      path: 'README.md',
      contents: 'Drag an outline section to reorder the document.\n'
    },
    {
      label: 'outline section reorder documentation without drag wording',
      path: 'README.md',
      contents: 'Use the outline to reorder sections.\n'
    },
    {
      label: 'heading collapse state owner',
      path: 'webview/src/helpers/headingCollapse.ts',
      contents: 'export const headingCollapseState = new Map();\n'
    },
    {
      label: 'heading fold effect alias',
      path: 'webview/src/editor/heading.ts',
      contents: 'export const toggleHeadingFoldEffect = {};\n'
    },
    {
      label: 'heading fold gutter CSS',
      path: 'webview/src/styles.css',
      contents: '.meo-md-fold-gutter { display: block; }\n'
    },
    {
      label: 'dotted heading collapse setting',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.heading.collapse.enabled': { type: 'boolean' }
      } } } })
    },
    {
      label: 'kebab heading fold alias',
      path: 'webview/src/editor/heading.ts',
      contents: "export const capability = 'toggle-heading-fold';\n"
    },
    {
      label: 'heading fold Protocol command',
      path: 'src/protocol/headingFold.ts',
      contents: "export type HeadingCommand = { type: 'collapseHeadingSection' };\n"
    },
    {
      label: 'heading fold Host owner',
      path: 'src/host/headingCollapse.ts',
      contents: 'export const restoreCollapsedHeadings = () => undefined;\n'
    },
    {
      label: 'heading fold documentation',
      path: 'docs/editor.md',
      contents: 'Click the heading fold button to collapse a Markdown section.\n'
    },
    {
      label: 'outline move callback',
      path: 'webview/src/helpers/outline.ts',
      contents: 'export const moveHeadingSection = () => true;\n'
    },
    {
      label: 'outline drag state',
      path: 'webview/src/helpers/outline.ts',
      contents: 'export const outlineDragState = { sourceFrom: 1 };\n'
    },
    {
      label: 'outline drop indicator CSS',
      path: 'webview/src/styles.css',
      contents: '.outline-drop-before { display: block; }\n'
    },
    {
      label: 'dotted outline reorder setting',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.outline.heading.reorder': { type: 'boolean' }
      } } } })
    },
    {
      label: 'kebab outline drag alias',
      path: 'webview/src/editor/outline.ts',
      contents: "export const capability = 'outline-heading-drag';\n"
    },
    {
      label: 'outline reorder Protocol command',
      path: 'src/protocol/outline.ts',
      contents: "export type OutlineCommand = { type: 'reorderOutlineHeading' };\n"
    },
    {
      label: 'outline reorder Host owner',
      path: 'src/host/outline.ts',
      contents: 'export const applyOutlineHeadingMove = () => undefined;\n'
    },
    {
      label: 'outline reorder documentation',
      path: 'README.md',
      contents: 'Drag outline headings to reorder document sections.\n'
    }
  ];
  const missedHeadingFoldAndOutlineReorderCapabilities: string[] = [];
  for (const fixture of removedHeadingFoldAndOutlineReorderFixtures) {
    write(fixture.path, fixture.contents);
    const outcome = runCheck();
    if (outcome.ok || !/ARCH019/.test(outcome.output)) {
      missedHeadingFoldAndOutlineReorderCapabilities.push(fixture.label);
    }
    rmSync(join(fixtureRoot, ...fixture.path.split('/')));
  }
  assert.deepEqual(
    missedHeadingFoldAndOutlineReorderCapabilities,
    [],
    `ARCH019 missed removed heading fold/outline reorder capabilities: ${missedHeadingFoldAndOutlineReorderCapabilities.join(', ')}`
  );

  write('webview/src/editor/retainedFolding.ts', [
    "export const details = '<details><summary>More</summary>Body</details>';",
    "export const longCodeBlockFolding = 'fold long code blocks';",
    "export const outlineTreeCollapse = 'collapse outline tree nodes';",
    "export const ordinaryDrag = 'drag table column width';",
    ''
  ].join('\n'));
  const retainedFoldingAndDrag = runCheck();
  assert.equal(
    retainedFoldingAndDrag.ok,
    true,
    `HTML details, code folding, outline tree collapse and unrelated drag must remain allowed: ${retainedFoldingAndDrag.output}`
  );
  rmSync(join(fixtureRoot, 'webview', 'src', 'editor', 'retainedFolding.ts'));

  write('webview/src/styles.css', '.cm-line.meo-md-heading-collapsed { opacity: 0.95; }\n');
  const retainedHeadingSyntaxClass = runCheck();
  assert.equal(
    retainedHeadingSyntaxClass.ok,
    true,
    `heading syntax classes without folding capability state must remain allowed: ${retainedHeadingSyntaxClass.output}`
  );
  rmSync(join(fixtureRoot, 'webview', 'src', 'styles.css'));

  const retainedOutlineCollapseFixtures = [
    {
      label: 'kebab outline heading collapse capability',
      path: 'webview/src/editor/outline-heading-collapse.ts',
      contents: 'export const outlineTreeState = new Set();\n'
    },
    {
      label: 'dotted outline heading folding controller',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.outline.heading.folding.controller': { type: 'boolean' }
      } } } })
    },
    {
      label: 'outline heading collapsed state owner',
      path: 'webview/src/editor/outline.ts',
      contents: 'export const outlineHeadingCollapsedState = new Set();\n'
    },
    {
      label: 'dotted outline node expanded state',
      path: 'package.json',
      contents: JSON.stringify({ contributes: { configuration: { properties: {
        'meoEnhanced.outline.node.expanded.state': { type: 'boolean' }
      } } } })
    },
    {
      label: 'outline heading collapse owner',
      path: 'webview/src/editor/outlineHeadingCollapse.ts',
      contents: 'export const outlineHeadingCollapse = new Set();\n'
    },
    {
      label: 'outline heading folding controller',
      path: 'webview/src/editor/outline.ts',
      contents: 'export const outlineHeadingFoldingController = {};\n'
    },
    {
      label: 'ordinary outline heading collapse documentation',
      path: 'docs/outline.md',
      contents: 'Use outline heading collapse to hide children in the navigation tree.\n'
    },
    {
      label: 'outline section collapse owner',
      path: 'webview/src/editor/outline.ts',
      contents: 'export const outlineSectionCollapse = new Set();\n'
    }
  ];
  const rejectedRetainedOutlineCollapse: string[] = [];
  for (const fixture of retainedOutlineCollapseFixtures) {
    write(fixture.path, fixture.contents);
    const outcome = runCheck();
    if (!outcome.ok) rejectedRetainedOutlineCollapse.push(fixture.label);
    rmSync(join(fixtureRoot, ...fixture.path.split('/')));
  }
  assert.deepEqual(
    rejectedRetainedOutlineCollapse,
    [],
    `ARCH019 rejected retained outline tree collapse: ${rejectedRetainedOutlineCollapse.join(', ')}`
  );

  write('webview/src/editor/standardMermaid.ts', [
    "export const mermaidLanguage = 'mermaid';",
    "export const fencedMermaid = ['```mermaid', 'flowchart LR', '```'].join('\\n');",
    "export const mermaidColonLabel = 'Node: ready';",
    "export const ordinaryColonContainer = '::: warning';",
    ''
  ].join('\n'));
  write('docs/standard-mermaid.md', [
    'Use standard fenced Mermaid blocks; ordinary colon text remains ordinary Markdown.',
    'Standard Mermaid diagrams allow colon syntax inside labels.',
    'Ordinary colon container text remains ordinary Markdown.',
    ''
  ].join('\n'));
  const retainedStandardMermaid = runCheck();
  assert.equal(
    retainedStandardMermaid.ok,
    true,
    `standard fenced Mermaid and ordinary colon text must remain allowed: ${retainedStandardMermaid.output}`
  );
  rmSync(join(fixtureRoot, 'webview', 'src', 'editor', 'standardMermaid.ts'));
  rmSync(join(fixtureRoot, 'docs', 'standard-mermaid.md'));

  const retainedMermaidColonSourceDeclarations = [
    'export const mermaidColonSyntax = "Node: ready";',
    'export let mermaidColonSyntax = "Node: ready";',
    'export var mermaidColonSyntax = "Node: ready";',
    'export function mermaidColonSyntax() { return "Node: ready"; }',
    'export class MermaidColonSyntax {}',
    'export type MermaidColonSyntax = string;',
    'export interface MermaidColonSyntax { label: string }',
    'export enum MermaidColonSyntax { Label }',
    'export async function mermaidColonSyntax() { return "Node: ready"; }',
    'export default async function mermaidColonSyntax() { return "Node: ready"; }',
    'export declare const mermaidColonSyntax: string;',
    'export abstract class MermaidColonSyntax { abstract label(): string }',
    'export default function mermaidColonSyntax() { return "Node: ready"; }',
    'export default class MermaidColonSyntax {}',
    'export { mermaidColonSyntax };',
    'export { mermaidColonSyntax as standardMermaidColonSyntax };',
    'export = mermaidColonSyntax;'
  ];
  const rejectedMermaidColonSourceDeclarations: string[] = [];
  for (const [index, declaration] of retainedMermaidColonSourceDeclarations.entries()) {
    const path = `webview/src/editor/standardMermaidDeclaration${index}.ts`;
    write(path, `${declaration}\n`);
    const outcome = runCheck();
    if (!outcome.ok) rejectedMermaidColonSourceDeclarations.push(`${declaration}\n${outcome.output}`);
    rmSync(join(fixtureRoot, ...path.split('/')));
  }
  assert.deepEqual(
    rejectedMermaidColonSourceDeclarations,
    [],
    `source export declarations must remain allowed:\n${rejectedMermaidColonSourceDeclarations.join('\n')}`
  );

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
      label: 'inner labeled break does not hide reachable same-target continue',
      path: 'webview/src/helpers/conditionalNativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try { field = settings; continue; } finally {\n    inner: { break inner; }\n    continue;\n    field = document.createElement('input');\n  }\n}\n",
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
      label: 'inner labeled break preserves following mandatory DOM recovery',
      path: 'webview/src/helpers/nativeSpellcheck.ts',
      contents: "let field = document.createElement('input');\nwhile (ready) {\n  field.spellcheck = true;\n  try { field = settings; continue; } finally {\n    inner: { break inner; }\n    field = document.createElement('input');\n  }\n}\n"
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

  writeFileSync(join(stagedRoot, 'README.md'), 'meoEnhanced.import.theme\n');
  execFileSync('git', ['add', '--', 'README.md'], { cwd: stagedRoot });
  writeFileSync(join(stagedRoot, 'README.md'), 'No custom appearance capability here.\n');
  const stagedCustomThemeAlias = (() => {
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
  assert.equal(stagedCustomThemeAlias.ok, false, 'staged ARCH020 must reject normalized custom-theme aliases from the index');
  assert.match(stagedCustomThemeAlias.output, /ARCH020/);
  writeFileSync(join(stagedRoot, 'README.md'), 'No custom appearance capability here.\n');
  execFileSync('git', ['add', '--', 'README.md'], { cwd: stagedRoot });
  writeFileSync(join(stagedRoot, 'README.md'), 'MEO Enhanced exports HTML using the current VS Code theme.\n');
  execFileSync('git', ['add', '--', 'README.md'], { cwd: stagedRoot });
  writeFileSync(join(stagedRoot, 'README.md'), 'meoEnhanced.import.theme\n');
  const stagedOrdinaryThemeProse = execFileSync('bun', ['scripts/check-architecture.ts', '--staged'], {
    cwd: stagedRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.match(stagedOrdinaryThemeProse, /Architecture checks passed/);
  writeFileSync(join(stagedRoot, 'README.md'), 'No custom appearance capability here.\n');
  execFileSync('git', ['add', '--', 'README.md'], { cwd: stagedRoot });
  mkdirSync(join(stagedRoot, 'src', 'host'), { recursive: true });
  writeFileSync(join(stagedRoot, 'src', 'host', 'themeOwners.ts'), 'export const ImportedThemeRegistry = new Map();\n');
  execFileSync('git', ['add', '--', 'src/host/themeOwners.ts'], { cwd: stagedRoot });
  writeFileSync(join(stagedRoot, 'src', 'host', 'themeOwners.ts'), 'export const currentVscodeTheme = {};\n');
  const stagedProductionThemeOwner = (() => {
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
  assert.equal(stagedProductionThemeOwner.ok, false, 'staged ARCH020 must reject production custom-theme owners from the index');
  assert.match(stagedProductionThemeOwner.output, /ARCH020/);
  execFileSync('git', ['rm', '--cached', '--force', '--quiet', '--', 'src/host/themeOwners.ts'], { cwd: stagedRoot });
  rmSync(join(stagedRoot, 'src', 'host', 'themeOwners.ts'));

  writeFileSync(join(stagedRoot, 'README.md'), 'MEO Enhanced provides meoEnhanced.color-picker.\n');
  execFileSync('git', ['add', '--', 'README.md'], { cwd: stagedRoot });
  writeFileSync(join(stagedRoot, 'README.md'), 'Pick a color in an external design tool.\n');
  const stagedColorPickerAlias = (() => {
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
  assert.equal(stagedColorPickerAlias.ok, false, 'staged ARCH021 must reject color-picker aliases from the index');
  assert.match(stagedColorPickerAlias.output, /ARCH021/);
  writeFileSync(join(stagedRoot, 'README.md'), 'Pick a color in an external design tool.\n');
  execFileSync('git', ['add', '--', 'README.md'], { cwd: stagedRoot });

  writeFileSync(join(stagedRoot, 'README.md'), 'MEO Enhanced provides a color palette for choosing colors.\n');
  execFileSync('git', ['add', '--', 'README.md'], { cwd: stagedRoot });
  writeFileSync(join(stagedRoot, 'README.md'), 'Use the OS pick-a-color dialog in an external tool.\n');
  const stagedColorPaletteClaim = (() => {
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
  assert.equal(stagedColorPaletteClaim.ok, false, 'staged ARCH021 must reject current color-palette claims from the index');
  assert.match(stagedColorPaletteClaim.output, /ARCH021/);
  execFileSync('git', ['add', '--', 'README.md'], { cwd: stagedRoot });

  writeFileSync(join(stagedRoot, 'README.md'), 'MEO Enhanced provides meoEnhanced.pickColor.\n');
  execFileSync('git', ['add', '--', 'README.md'], { cwd: stagedRoot });
  writeFileSync(join(stagedRoot, 'README.md'), 'Pick a color in an external design tool.\n');
  const stagedPickColorAlias = (() => {
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
  assert.equal(stagedPickColorAlias.ok, false, 'staged ARCH021 must reject pickColor aliases from the index');
  assert.match(stagedPickColorAlias.output, /ARCH021/);
  execFileSync('git', ['add', '--', 'README.md'], { cwd: stagedRoot });

  mkdirSync(join(stagedRoot, 'src', 'host'), { recursive: true });
  writeFileSync(join(stagedRoot, 'src', 'host', 'choose-color-owner.ts'), 'export const chooseColorOwner = {};\n');
  execFileSync('git', ['add', '--', 'src/host/choose-color-owner.ts'], { cwd: stagedRoot });
  writeFileSync(join(stagedRoot, 'src', 'host', 'external-color-reference.ts'), 'export const externalColorReference = {};\n');
  const stagedChooseColorOwner = (() => {
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
  assert.equal(stagedChooseColorOwner.ok, false, 'staged ARCH021 must reject choose-color owner paths from the index');
  assert.match(stagedChooseColorOwner.output, /ARCH021/);
  execFileSync('git', ['rm', '--cached', '--force', '--quiet', '--', 'src/host/choose-color-owner.ts'], { cwd: stagedRoot });
  rmSync(join(stagedRoot, 'src', 'host', 'choose-color-owner.ts'));
  rmSync(join(stagedRoot, 'src', 'host', 'external-color-reference.ts'));

  writeFileSync(join(stagedRoot, 'README.md'), 'Configure meoEnhanced.export.html.imageMode for linked images.\n');
  execFileSync('git', ['add', '--', 'README.md'], { cwd: stagedRoot });
  writeFileSync(join(stagedRoot, 'README.md'), 'HTML embeds local images.\n');
  const stagedRemovedExportSetting = (() => {
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
  assert.equal(stagedRemovedExportSetting.ok, false, 'staged ARCH022 must read removed export settings from the index');
  assert.match(stagedRemovedExportSetting.output, /ARCH022/);

  execFileSync('git', ['add', '--', 'README.md'], { cwd: stagedRoot });
  writeFileSync(join(stagedRoot, 'README.md'), 'MEO Enhanced provides a configurable line numbers setting.\n');
  const unstagedRemovedLineNumbers = execFileSync('bun', ['scripts/check-architecture.ts', '--staged'], {
    cwd: stagedRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.match(unstagedRemovedLineNumbers, /Architecture checks passed/);
  writeFileSync(join(stagedRoot, 'README.md'), 'HTML embeds local images.\n');
  execFileSync('git', ['add', '--', 'README.md'], { cwd: stagedRoot });

  mkdirSync(join(stagedRoot, 'src', 'application'), { recursive: true });
  writeFileSync(join(stagedRoot, 'src', 'application', 'stage10Contract.ts'), 'export const setGlobalLineNumbersState = () => undefined;\n');
  execFileSync('git', ['add', '--', 'src/application/stage10Contract.ts'], { cwd: stagedRoot });
  writeFileSync(join(stagedRoot, 'src', 'application', 'stage10Contract.ts'), 'export const rememberViewportForModeSwitch = () => undefined;\n');
  const stagedRemovedStage10Alias = (() => {
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
  assert.equal(stagedRemovedStage10Alias.ok, false, 'staged ARCH022 must reject removed production aliases from the index');
  assert.match(stagedRemovedStage10Alias.output, /ARCH022/);
  execFileSync('git', ['add', '--', 'src/application/stage10Contract.ts'], { cwd: stagedRoot });
  writeFileSync(join(stagedRoot, 'src', 'application', 'stage10Contract.ts'), 'export const setGlobalLineNumbersState = () => undefined;\n');
  const unstagedRemovedStage10Alias = execFileSync('bun', ['scripts/check-architecture.ts', '--staged'], {
    cwd: stagedRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.match(unstagedRemovedStage10Alias, /Architecture checks passed/);
  writeFileSync(join(stagedRoot, 'src', 'application', 'stage10Contract.ts'), 'export const rememberViewportForModeSwitch = () => undefined;\n');
  execFileSync('git', ['add', '--', 'src/application/stage10Contract.ts'], { cwd: stagedRoot });

  writeFileSync(join(stagedRoot, 'bun.lock'), '"codemirror-vim": ["codemirror-vim@6.3.0", ""]\n');
  execFileSync('git', ['add', '--', 'bun.lock'], { cwd: stagedRoot });
  writeFileSync(join(stagedRoot, 'bun.lock'), '# clean working-tree lock\n');
  const stagedVimLock = (() => {
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
  assert.equal(stagedVimLock.ok, false, 'staged ARCH016 must read removed Vim dependencies from the index');
  assert.match(stagedVimLock.output, /ARCH016/);

  execFileSync('git', ['add', '--', 'bun.lock'], { cwd: stagedRoot });
  writeFileSync(join(stagedRoot, 'bun.lock'), '"codemirror-vim": ["codemirror-vim@6.3.0", ""]\n');
  const unstagedVimLock = execFileSync('bun', ['scripts/check-architecture.ts', '--staged'], {
    cwd: stagedRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.match(unstagedVimLock, /Architecture checks passed/);

  writeFileSync(join(stagedRoot, 'bun.lock'), '"markdown-it-emoji": ["markdown-it-emoji@3.0.0", ""]\n');
  execFileSync('git', ['add', '--', 'bun.lock'], { cwd: stagedRoot });
  writeFileSync(join(stagedRoot, 'bun.lock'), '# clean working-tree lock\n');
  const stagedEmojiLock = (() => {
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
  assert.equal(stagedEmojiLock.ok, false, 'staged ARCH017 must read removed Emoji dependencies from the index');
  assert.match(stagedEmojiLock.output, /ARCH017/);

  execFileSync('git', ['add', '--', 'bun.lock'], { cwd: stagedRoot });
  writeFileSync(join(stagedRoot, 'bun.lock'), '"markdown-it-emoji": ["markdown-it-emoji@3.0.0", ""]\n');
  const unstagedEmojiLock = execFileSync('bun', ['scripts/check-architecture.ts', '--staged'], {
    cwd: stagedRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.match(unstagedEmojiLock, /Architecture checks passed/);

  mkdirSync(join(stagedRoot, 'webview', 'src', 'editor'), { recursive: true });
  writeFileSync(
    join(stagedRoot, 'webview', 'src', 'editor', 'emojiText.ts'),
    "import emojiRegex from 'emoji-regex';\nexport const matchEmoji = (text) => emojiRegex().exec(text);\n"
  );
  execFileSync('git', ['add', '--', 'webview/src/editor/emojiText.ts'], { cwd: stagedRoot });
  writeFileSync(
    join(stagedRoot, 'webview', 'src', 'editor', 'emojiText.ts'),
    "export const ordinaryText = 'Unicode emoji 😄';\n"
  );
  const stagedEmojiRegexOwner = (() => {
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
  assert.equal(stagedEmojiRegexOwner.ok, false, 'staged ARCH017 must reject a direct emoji-regex source owner');
  assert.match(stagedEmojiRegexOwner.output, /ARCH017/);

  execFileSync('git', ['add', '--', 'webview/src/editor/emojiText.ts'], { cwd: stagedRoot });
  mkdirSync(join(stagedRoot, 'src', 'export'), { recursive: true });
  writeFileSync(
    join(stagedRoot, 'src', 'export', 'mermaidCompatibility.ts'),
    'export const normalizeMermaidColonFences = (markdown) => markdown;\n'
  );
  execFileSync('git', ['add', '--', 'src/export/mermaidCompatibility.ts'], { cwd: stagedRoot });
  writeFileSync(
    join(stagedRoot, 'src', 'export', 'mermaidCompatibility.ts'),
    "export const standardMermaidLanguage = 'mermaid';\n"
  );
  const stagedMermaidColonOwner = (() => {
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
  assert.equal(stagedMermaidColonOwner.ok, false, 'staged ARCH018 must reject Mermaid colon normalization');
  assert.match(stagedMermaidColonOwner.output, /ARCH018/);

  execFileSync('git', ['add', '--', 'src/export/mermaidCompatibility.ts'], { cwd: stagedRoot });
  writeFileSync(
    join(stagedRoot, 'src', 'export', 'mermaidCompatibility.ts'),
    'export const parseMermaidColonFenceOpenLine = (line) => line;\n'
  );
  const unstagedMermaidColonOwner = execFileSync('bun', ['scripts/check-architecture.ts', '--staged'], {
    cwd: stagedRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.match(unstagedMermaidColonOwner, /Architecture checks passed/);

  mkdirSync(join(stagedRoot, 'src', 'host'), { recursive: true });
  writeFileSync(
    join(stagedRoot, 'src', 'host', 'outlineCompatibility.ts'),
    'export const outlineItemDragging = () => true;\n'
  );
  execFileSync('git', ['add', '--', 'src/host/outlineCompatibility.ts'], { cwd: stagedRoot });
  writeFileSync(
    join(stagedRoot, 'src', 'host', 'outlineCompatibility.ts'),
    'export const headingFoldedState = new Map();\n'
  );
  const stagedOutlineReorderOwner = (() => {
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
  assert.equal(stagedOutlineReorderOwner.ok, false, 'staged ARCH019 must reject outline item dragging owners from the index');
  assert.match(stagedOutlineReorderOwner.output, /ARCH019/);

  writeFileSync(
    join(stagedRoot, 'src', 'host', 'outlineCompatibility.ts'),
    'export const headingFoldedState = new Map();\n'
  );
  execFileSync('git', ['add', '--', 'src/host/outlineCompatibility.ts'], { cwd: stagedRoot });
  writeFileSync(
    join(stagedRoot, 'src', 'host', 'outlineCompatibility.ts'),
    'export const navigateOutline = () => undefined;\n'
  );
  const stagedHeadingFoldedState = (() => {
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
  assert.equal(stagedHeadingFoldedState.ok, false, 'staged ARCH019 must reject heading folded state owners from the index');
  assert.match(stagedHeadingFoldedState.output, /ARCH019/);

  writeFileSync(
    join(stagedRoot, 'src', 'host', 'outlineCompatibility.ts'),
    "export const capability = 'outline-heading-collapse';\n"
  );
  execFileSync('git', ['add', '--', 'src/host/outlineCompatibility.ts'], { cwd: stagedRoot });
  writeFileSync(
    join(stagedRoot, 'src', 'host', 'outlineCompatibility.ts'),
    'export const headingFoldedState = new Map();\n'
  );
  const stagedRetainedOutlineCollapse = execFileSync('bun', ['scripts/check-architecture.ts', '--staged'], {
    cwd: stagedRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.match(stagedRetainedOutlineCollapse, /Architecture checks passed/);

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

  write('webview/src/helpers/math.ts', [
    "import { scanLatexMath, scanLatexMathAt } from '../../../src/shared/latexMathScanner';",
    'export function collect(text: string) { return scanLatexMath(text); }',
    'export function find(text: string, index: number) { const range = scanLatexMathAt(text, index); if (!range) return null; return range; }',
    ''
  ].join('\n'));
  const removedCustomThemeFixtures = [
    ['package.json', JSON.stringify({ contributes: { commands: [{ command: 'meoEnhanced.importTheme' }] } })],
    ['package.json', JSON.stringify({ contributes: { commands: [{ command: 'meoEnhanced.import-theme' }] } })],
    ['package.json', JSON.stringify({ contributes: { commands: [{ command: 'meoEnhanced.import.theme' }] } })],
    ['package.json', JSON.stringify({ contributes: { configuration: { properties: { 'meoEnhanced.theme': { type: 'object' } } } } })],
    ['package.json', JSON.stringify({ contributes: { configuration: { properties: { 'meoEnhanced.codeBlocks.useVscodeTheme': { type: 'boolean' } } } } })],
    ['package.json', JSON.stringify({ contributes: { configuration: { properties: { 'meoEnhanced.codeBlocks-use-vscode-theme': { type: 'boolean' } } } } })],
    ['src/host/customThemeStorage.ts', 'export const customThemes = [];\n'],
    ['src/host/customThemePalette.ts', 'export const palette = {};\n'],
    ['src/host/custom-theme-repository.ts', 'export const repository = {};\n'],
    ['src/host/themeOwners.ts', 'export const ImportedThemeRegistry = new Map();\n'],
    ['src/host/themeOwners.ts', 'export const customThemeService = {};\n'],
    ['src/host/themeOwners.ts', 'export const customThemeController = {};\n'],
    ['src/host/themeOwners.ts', 'export const customThemeConfig = {};\n'],
    ['src/host/themeOwners.ts', 'export const customThemeModel = {};\n'],
    ['src/host/themeOwners.ts', 'export const customThemeSchema = {};\n'],
    ['src/host/themeOwners.ts', 'export const customThemeJson = {};\n'],
    ['src/protocol/editorState.ts', 'export type ThemeSettingsDto = { colors: Record<string, string> };\n'],
    ['src/protocol/editorState.ts', 'export type BuiltInVisualBaselineDto = { colors: Record<string, string> };\n'],
    ['src/protocol/editorEvents.ts', "export const event = { type: 'themeChanged' };\n"],
    ['src/protocol/editorEvents.ts', "export const event = { type: 'previewAppearanceChanged' };\n"],
    ['src/protocol/editorEvents.ts', "export const event = { type: 'previewSourceColoringChanged' };\n"],
    ['webview/src/editor/themeControls.ts', 'export const importedThemeState = {};\n'],
    ['webview/src/editor/themeControls.ts', 'export const custom_theme_heading_size_editor = {};\n'],
    ['docs/appearance.md', 'Use MEO theme management to import a palette.\n']
  ] as const;
  for (const [fixturePath, contents] of removedCustomThemeFixtures) {
    write(fixturePath, contents);
    const outcome = runCheck();
    assert.equal(outcome.ok, false, `${fixturePath} custom-theme alias must be rejected`);
    assert.match(outcome.output, /ARCH020/);
    rmSync(join(fixtureRoot, ...fixturePath.split('/')));
  }

  write('README.md', 'Editor appearance follows the current VS Code theme and uses a built-in code palette when reversed.\n');
  const retainedAppearanceTheme = runCheck();
  assert.equal(retainedAppearanceTheme.ok, true, `retained appearance/theme prose must pass: ${retainedAppearanceTheme.output}`);
  rmSync(join(fixtureRoot, 'README.md'));

  const retainedThemeImportExportFixtures = [
    'MEO Enhanced exports HTML using the current VS Code theme.\n',
    'Import an external theme for another editor; export that external theme from its own settings.\n'
  ] as const;
  for (const contents of retainedThemeImportExportFixtures) {
    write('README.md', contents);
    const outcome = runCheck();
    assert.equal(outcome.ok, true, `ordinary theme import/export prose must pass: ${outcome.output}`);
  }
  write(
    'README.md',
    'MEO Enhanced exports HTML using the current VS Code theme; the custom-theme import command stays removed.\n'
  );
  const pairedCustomThemeCommand = runCheck();
  assert.equal(pairedCustomThemeCommand.ok, false, 'custom-theme command must still be rejected beside allowed prose');
  assert.match(pairedCustomThemeCommand.output, /ARCH020/);
  rmSync(join(fixtureRoot, 'README.md'));

  write('docs/history.md', 'The historical custom theme palette was removed before this release.\n');
  const customThemeHistory = runCheck();
  assert.equal(customThemeHistory.ok, true, `ordinary custom-theme history in docs must pass: ${customThemeHistory.output}`);
  rmSync(join(fixtureRoot, 'docs/history.md'));
  write('CHANGELOG.md', '- Removed the historical ImportedThemeRegistry implementation.\n');
  const customThemeChangelog = runCheck();
  assert.equal(customThemeChangelog.ok, true, `CHANGELOG history must remain allowed: ${customThemeChangelog.output}`);
  rmSync(join(fixtureRoot, 'CHANGELOG.md'));

  const currentCustomThemeDocsFixtures = [
    'MEO Enhanced supports custom theme palettes.\n',
    'MEO Enhanced includes a custom theme picker.\n',
    'Create and apply custom themes in MEO Enhanced.\n',
    'MEO Enhanced provides an imported theme controller.\n'
  ] as const;
  for (const contents of currentCustomThemeDocsFixtures) {
    write('docs/appearance.md', contents);
    const outcome = runCheck();
    assert.equal(outcome.ok, false, `current custom-theme product claim must be rejected: ${contents}`);
    assert.match(outcome.output, /ARCH020/);
  }
  const historicalCustomThemeDocsFixtures = [
    'MEO Enhanced no longer supports custom themes.\n',
    'MEO Enhanced does not support custom themes.\n',
    'MEO Enhanced previously supported custom theme palettes.\n',
    'The former MEO Enhanced custom theme picker was removed.\n'
  ] as const;
  for (const contents of historicalCustomThemeDocsFixtures) {
    write('docs/appearance.md', contents);
    const outcome = runCheck();
    assert.equal(outcome.ok, true, `historical/negative custom-theme prose must pass: ${outcome.output}`);
  }
  const coordinatedHistoricalAndCurrentClaimFixtures = [
    'MEO Enhanced no longer supports custom themes and MEO Enhanced provides a custom theme picker.\n',
    'MEO Enhanced no longer supports custom themes, and MEO Enhanced provides a custom theme picker.\n',
    'MEO Enhanced previously supported custom themes while MEO Enhanced now exposes a custom theme controller.\n',
    'MEO Enhanced removed custom themes whereas MEO Enhanced now includes a custom theme palette.\n',
    'MEO Enhanced deprecated imported themes yet MEO Enhanced enables an imported theme picker.\n'
  ] as const;
  for (const contents of coordinatedHistoricalAndCurrentClaimFixtures) {
    write('docs/appearance.md', contents);
    const outcome = runCheck();
    assert.equal(outcome.ok, false, `coordinated current custom-theme claim must be rejected: ${contents}`);
    assert.match(outcome.output, /ARCH020/);
  }
  write('docs/appearance.md', 'Create and apply custom themes in MEO Enhanced.\n');
  const compoundCurrentClaim = runCheck();
  assert.equal(compoundCurrentClaim.ok, false, 'compound create-and-apply claim must remain rejected');
  assert.match(compoundCurrentClaim.output, /ARCH020/);
  write(
    'docs/appearance.md',
    'MEO Enhanced no longer supports custom themes. MEO Enhanced provides a custom theme picker.\n'
  );
  const mixedHistoricalAndCurrentClaim = runCheck();
  assert.equal(mixedHistoricalAndCurrentClaim.ok, false, 'historical sentence must not hide a current claim on the same line');
  assert.match(mixedHistoricalAndCurrentClaim.output, /ARCH020/);
  rmSync(join(fixtureRoot, 'docs/appearance.md'));

  const removedColorCapabilityFixtures = [
    ['package.json', JSON.stringify({ contributes: { commands: [{ command: 'meoEnhanced.openColorPicker' }] } })],
    ['package.json', JSON.stringify({ contributes: { configuration: { properties: { 'meoEnhanced.color-swatches.rgb': { type: 'boolean' } } } } })],
    ['src/host/color-picker-service.ts', 'export const owner = {};\n'],
    ['src/protocol/editorEvents.ts', "export const event = { type: 'colorPicked' };\n"],
    ['webview/src/helpers/colorSwatches.ts', 'const FUNCTION_COLOR_REGEX = /rgb/;\n'],
    ['webview/src/helpers/rgbColorDecorator.ts', 'export const decorate = () => undefined;\n'],
    ['webview/src/helpers/named-color-swatch.ts', 'export const swatch = {};\n'],
    ['webview/src/helpers/gradientColorWidget.ts', 'export const widget = {};\n'],
    ['webview/src/editor/colorChooserState.ts', 'export const state = {};\n'],
    ['webview/src/editor/colorDialog.ts', 'export const dialog = {};\n'],
    ['webview/src/editor/colorInput.ts', "const input = '<input type=\"color\">';\n"],
    ['src/host/pickColor.ts', 'export const pickColor = () => undefined;\n'],
    ['src/host/color.choose.owner.ts', 'export const owner = {};\n'],
    ['src/host/choose-color-owner.ts', 'export const owner = {};\n'],
    ['webview/src/helpers/rgbSwatchParser.ts', 'export const parse = () => undefined;\n'],
    ['webview/src/helpers/namedSwatchWidget.ts', 'export const widget = {};\n'],
    ['webview/src/helpers/gradientDecorator.ts', 'export const decorate = () => undefined;\n'],
    ['webview/src/editor/colorEditor.ts', 'export const editor = {};\n'],
    ['webview/src/editor/palette.ts', 'export class ColorPalette {}\n'],
    ['webview/src/editor/paletteColorOwner.ts', 'export const paletteColorOwner = {};\n'],
    ['docs/colors.md', 'MEO Enhanced supports RGB and HSL color swatches.\n'],
    ['docs/colors.md', 'MEO Enhanced provides a color picker.\n'],
    ['docs/colors.md', 'MEO Enhanced provides a color palette for choosing colors.\n'],
    ['docs/colors.md', 'MEO Enhanced includes a palette for choosing colors.\n'],
    ['docs/colors.md', 'MEO Enhanced provides a palette to choose colors.\n'],
    ['docs/colors.md', 'MEO Enhanced provides a palette to choose a color.\n'],
    ['docs/colors.md', 'MEO Enhanced provides a palette for choosing a color.\n'],
    ['docs/colors.md', 'MEO Enhanced provides a palette to pick the color.\n'],
    ['docs/colors.md', 'MEO Enhanced no longer supports RGB swatches, and MEO Enhanced provides a color picker.\n']
  ] as const;
  for (const [fixturePath, contents] of removedColorCapabilityFixtures) {
    write(fixturePath, contents);
    const outcome = runCheck();
    assert.equal(outcome.ok, false, `${fixturePath} removed color capability alias must be rejected: ${contents}`);
    assert.match(outcome.output, /ARCH021/);
    rmSync(join(fixtureRoot, ...fixturePath.split('/')));
  }

  const retainedColorFixtures = [
    ['src/shared/hexColorSwatches.ts', 'export const collectHexColorRangesFromText = () => [];\n'],
    ['webview/src/helpers/colorSwatches.ts', 'export const createColorSwatchElement = () => document.createElement(\'span\');\n'],
    ['webview/src/styles.css', '.sample { color: rgb(1 2 3); background: linear-gradient(red, blue); }\n'],
    ['src/shared/themePalette.ts', 'export const currentThemePalette = {};\n'],
    ['webview/src/theme/codePalette.ts', 'export const codePalette = {};\n'],
    ['webview/src/theme/built-in-palette.ts', 'export const builtInPalette = {};\n'],
    ['webview/src/theme/final.palette.ts', 'export const finalPalette = {};\n'],
    ['docs/colors.md', 'Pick a color in an external design tool. MEO Enhanced shows read-only HEX swatches.\n'],
    ['docs/colors.md', 'Use the OS pick-a-color dialog in an external tool.\n'],
    ['docs/colors.md', 'MEO Enhanced provides a color palette for code highlighting.\n'],
    ['docs/colors.md', 'MEO Enhanced color palette is used for code highlighting.\n'],
    ['docs/colors.md', 'MEO Enhanced color palette for code highlighting.\n'],
    ['docs/colors.md', 'MEO Enhanced uses the current theme palette and built-in code palette.\n'],
    ['docs/history.md', 'MEO Enhanced no longer supports RGB swatches or a color picker.\n'],
    ['docs/history.md', 'MEO Enhanced no longer provides a color palette for choosing colors.\n']
  ] as const;
  for (const [fixturePath, contents] of retainedColorFixtures) {
    write(fixturePath, contents);
    const outcome = runCheck();
    assert.equal(outcome.ok, true, `${fixturePath} retained color semantics must pass: ${outcome.output}`);
    rmSync(join(fixtureRoot, ...fixturePath.split('/')));
  }

  const removedStage10Fixtures = [
    ['package.json', JSON.stringify({ contributes: { configuration: { properties: { 'meoEnhanced.rememberPosition.lines': { type: 'number' } } } } })],
    ['package.json', JSON.stringify({ contributes: { configuration: { properties: { 'meoEnhanced.lineNumbers.visible': { type: 'boolean' } } } } })],
    ['package.json', JSON.stringify({ contributes: { configuration: { properties: { 'meoEnhanced.export.html.imageMode': { type: 'string' } } } } })],
    ['package.json', JSON.stringify({ contributes: { configuration: { properties: { 'meoEnhanced.export.browserPath': { type: 'string' } } } } })],
    ['package.json', JSON.stringify({ contributes: { configuration: { properties: { 'meoEnhanced.export.pdf.browserPath': { type: 'string' } } } } })],
    ['src/host/remembered-view-position-store.ts', 'export type RememberedViewport = { line: number };\n'],
    ['src/host/view-position-settings.ts', 'export const rememberPositionLines = 40;\n'],
    ['src/host/view-position-settings.ts', "export const setting = 'remember.position.lines';\n"],
    ['src/host/stage10-owner.ts', 'export const rememberedViewportStore = new Map();\n'],
    ['webview/src/application/stage10-owner.ts', 'export const setGlobalLineNumbersState = {};\n'],
    ['src/shared/stage10-owner.ts', 'export const exportBrowserPathSetting = undefined;\n'],
    ['src/protocol/stage10-owner.ts', "export const command = 'set.global.line.numbers.controller';\n"],
    ['src/host/remembered-viewport-owner.ts', 'export const owner = {};\n'],
    ['webview/src/export/export-browser-path-manager.ts', 'export const manager = {};\n'],
    ['src/shared/stage10-owner.ts', 'export const exportBrowserPathConfig = {};\n'],
    ['webview/src/editor.ts', 'export type CreateEditorOptions = { initialTopLine?: number };\n'],
    ['src/protocol/editorEvents.ts', "export const event = { type: 'viewPositionChanged' };\n"],
    ['webview/src/editor/line-numbers-toggle.ts', 'export const setLineNumbersVisible = () => undefined;\n'],
    ['webview/src/editor/line-numbers-toggle.ts', 'export const setGlobalLineNumbers = () => undefined;\n'],
    ['webview/src/styles.css', '.meo-line-numbers-hidden { display: none; }\n'],
    ['src/export/html-image-mode.ts', "export const htmlImageMode = 'linked';\n"],
    ['src/shared/extensionConfig.ts', 'export const getExportPdfBrowserPath = () => undefined;\n'],
    ['src/shared/extensionConfig.ts', 'export const exportBrowserPath = undefined;\n'],
    ['src/host/vscodeRetiredWorkspaceStateCleanup.ts', "const RETIRED_VIEW_POSITIONS_STATE_KEY = 'rememberedViewPositionsByDocument';\nexport const restore = (workspaceState) => workspaceState.get(RETIRED_VIEW_POSITIONS_STATE_KEY);\n"],
    ['src/host/vscodeRetiredWorkspaceStateCleanup.ts', "const RETIRED_VIEW_POSITIONS_STATE_KEY = 'rememberedViewPositionsByDocument';\nexport const retain = (workspaceState) => workspaceState.update(RETIRED_VIEW_POSITIONS_STATE_KEY, { line: 5 });\n"],
    ['docs/position.md', 'MEO Enhanced remembers the cross-session scroll position.\n'],
    ['docs/line-numbers.md', 'MEO Enhanced provides a configurable line numbers setting.\n'],
    ['docs/export.md', 'MEO Enhanced lets users choose embedded or linked HTML images.\n'],
    ['docs/export.md', 'Configure meoEnhanced.export.browserPath for PDF export.\n']
  ] as const;
  for (const [fixturePath, contents] of removedStage10Fixtures) {
    write(fixturePath, contents);
    const outcome = runCheck();
    assert.equal(outcome.ok, false, `${fixturePath} removed stage-10 alias must be rejected: ${contents}`);
    assert.match(outcome.output, /ARCH022/);
    rmSync(join(fixtureRoot, ...fixturePath.split('/')));
  }

  const retainedStage10Fixtures = [
    ['src/application/navigation.ts', 'export const revealSelection = (_preserveViewport: boolean) => undefined;\n'],
    ['webview/src/editor.ts', 'export const extensions = [lineNumbers()];\n'],
    ['webview/src/helpers/codeBlocks.ts', 'export const addCodeBlockLineNumbers = () => undefined;\n'],
    ['webview/src/helpers/codeBlocks.ts', 'export const previewCodeBlockLineNumbersEnabled = true;\n'],
    ['src/application/navigation.ts', 'export const rememberViewportForModeSwitch = () => undefined;\n'],
    ['src/application/remember-viewport-for-mode-switch.ts', 'export const preserve = () => undefined;\n'],
    ['webview/src/helpers/preview-code-block-line-numbers-enabled.ts', 'export const enabled = true;\n'],
    ['src/host/vscodeRetiredWorkspaceStateCleanup.ts', "const RETIRED_VIEW_POSITIONS_STATE_KEY = 'rememberedViewPositionsByDocument';\nexport const cleanup = (workspaceState) => workspaceState.update(RETIRED_VIEW_POSITIONS_STATE_KEY, undefined);\n"],
    ['src/export/assetPaths.ts', 'export const embeddedImageDataUrlCache = new Map();\n'],
    ['src/export/pdfRenderer.ts', 'export const browserExecutablePath = findPdfBrowserExecutablePath();\n'],
    ['docs/retained.md', 'MEO Enhanced preserves the viewport during same-session mode switching.\n'],
    ['docs/retained.md', 'Live uses source-mapped line numbers and Preview code blocks have their own line numbers.\n'],
    ['docs/retained.md', 'HTML embeds local images; PDF automatically discovers Edge, Chrome, or Chromium.\n']
  ] as const;
  for (const [fixturePath, contents] of retainedStage10Fixtures) {
    write(fixturePath, contents);
    const outcome = runCheck();
    assert.equal(outcome.ok, true, `${fixturePath} retained stage-10 semantics must pass: ${outcome.output}`);
    rmSync(join(fixtureRoot, ...fixturePath.split('/')));
  }
} finally {
  removeFixtureRoot();
}

console.log('Shared Module architecture contract checks passed');
