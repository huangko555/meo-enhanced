import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');
const languageModulePath = path
  .join(repoRoot, 'node_modules', '@codemirror', 'language', 'dist', 'index.js')
  .replaceAll('\\', '/');

const instrumentedLanguageModule = `
  import * as actual from ${JSON.stringify(languageModulePath)};
  export * from ${JSON.stringify(languageModulePath)};

  function controls() {
    return globalThis.__meoSyntaxParseControls ?? {};
  }

  function calls() {
    return globalThis.__meoSyntaxParseCalls ??= [];
  }

  function phase() {
    return String(globalThis.__meoSyntaxParsePhase ?? 'unlabelled');
  }

  export function ensureSyntaxTree(state, upto, timeout = 50) {
    const startedAt = performance.now();
    const mode = controls().ensure ?? 'delegate';
    const result = mode === 'partial'
      ? actual.syntaxTree(state)
      : mode === 'null'
        ? null
        : actual.ensureSyntaxTree(state, upto, timeout);
    calls().push({
      kind: 'ensure',
      phase: phase(),
      docLength: state.doc.length,
      upto,
      timeout,
      result: result === null ? 'partial' : 'tree',
      duration: performance.now() - startedAt
    });
    return result;
  }

  export function forceParsing(view, upto = view.viewport.to, timeout = 100) {
    const startedAt = performance.now();
    const mode = controls().force ?? 'delegate';
    const result = mode === 'false'
      ? false
      : mode === 'true'
        ? true
        : actual.forceParsing(view, upto, timeout);
    calls().push({
      kind: 'force',
      phase: phase(),
      docLength: view.state.doc.length,
      viewportFrom: view.viewport.from,
      viewportTo: view.viewport.to,
      upto,
      timeout,
      result: result ? 'complete' : 'partial',
      duration: performance.now() - startedAt
    });
    return result;
  }
`;

export function syntaxParsingBuildPlugin() {
  return {
    name: 'codemirror-syntax-parsing-seam',
    setup(builder: any) {
      builder.onResolve({ filter: /^@codemirror\/language$/ }, () => ({
        path: 'instrumented-language',
        namespace: 'syntax-parsing-test'
      }));
      builder.onLoad({ filter: /.*/, namespace: 'syntax-parsing-test' }, () => ({
        loader: 'js',
        contents: instrumentedLanguageModule
      }));
    }
  };
}
