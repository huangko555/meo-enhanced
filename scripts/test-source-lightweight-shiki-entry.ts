import darkPlus from '@shikijs/themes/dark-plus';
import { Transaction } from '@codemirror/state';
import { createEditor } from './test-editor-factory';
import { setShikiTheme, activateShikiCodeHighlighting, requestShikiTokens, getShikiTokens } from '../webview/src/helpers/shikiHighlighter';

(globalThis as typeof globalThis & {
  SourceLightweightShikiHarness?: {
    createEditor: typeof createEditor;
    applyTheme(): void;
    verifyBatchedTokens(): Promise<number>;
    pasteText(editor: ReturnType<typeof createEditor>, from: number, to: number, text: string): void;
  };
}).SourceLightweightShikiHarness = {
  createEditor,
  verifyBatchedTokens,
  applyTheme() {
    setShikiTheme(darkPlus);
  },
  pasteText(editor, from, to, text) {
    editor.view.dispatch({
      changes: { from, to, insert: text },
      annotations: Transaction.userEvent.of('input.paste')
    });
  }
};

// Compare the public asynchronous cache with the library's unchanged whole-block
// result, including metadata used by bracket coloring and injected grammars.
async function verifyBatchedTokens(): Promise<number> {
  const [{ createHighlighterCore }, { createOnigurumaEngine }, { bundledLanguages }] = await Promise.all([
    import('shiki/core'), import('shiki/engine/oniguruma'), import('shiki/langs')
  ]);
  const pad = (count: number) => Array.from({ length: count }, () => '').join('\n');
  const fixtures = [
    ['typescript', pad(126) + '/*跨行 😀\n' + pad(140) + '*/\nconst x = \u0060line\n' + pad(140) + '\u0060;\nconst y = /[{}]/g;'],
    ['html', '<script>\n/*' + pad(260) + '*/\nconst x = "{}";\n</script>\n<style>\n.a { color: red; }\n</style>'],
    ['markdown', '# Header\n\u0060\u0060\u0060typescript\n/*' + pad(260) + '*/\nconst x = 1;\n\u0060\u0060\u0060'],
    ['python', 'value = """' + pad(260) + 'end"""\ndef run():\n    return {"text": "{}"}'],
    ['sql', '/*' + pad(260) + '*/\nSELECT \'{}\', 1;'],
    ['vue', '<template><div>😀</div></template>\n<script setup lang="ts">\n/*' + pad(260) + '*/\nconst x = {a: 1};\n</script>']
  ] as const;
  let checked = 0;
  for (const type of ['dark', 'light'] as const) {
    const palette = { ...darkPlus, type, colors: { ...darkPlus.colors, 'editor.foreground': type === 'dark' ? '#cccccc' : '#222222' } };
    for (const surface of ['editor', 'preview'] as const) {
      setShikiTheme(palette, surface);
      const release = activateShikiCodeHighlighting(surface);
      const highlighter = await createHighlighterCore({ themes: [{ ...palette, name: 'meo-code-theme', settings: palette.tokenColors }],
        langs: [], engine: await createOnigurumaEngine(import('shiki/wasm')) });
      const waitTokens = async (lang: string, code: string) => {
        requestShikiTokens(lang, code, surface);
        for (let attempt = 0; attempt < 2000; attempt++) {
          const tokens = getShikiTokens(lang, code, surface);
          if (tokens) return tokens;
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        throw new Error('Timed out waiting for ' + surface + ' ' + lang);
      };
      const expectedTokens = (lang: string, code: string) => highlighter.codeToTokens(code, {lang, theme: 'meo-code-theme', includeExplanation: 'scopeName'}).tokens.map(line => line.map(syntaxToken => {
        const scopeNames = [...new Set((syntaxToken.explanation ?? []).flatMap(part => (part.scopes ?? []).map(scope => scope.scopeName).filter(Boolean)))];
        return {offset: syntaxToken.offset, content: syntaxToken.content, color: syntaxToken.color, fontStyle: syntaxToken.fontStyle,
          isStringComment: scopeNames.some(name => name.startsWith('string') || name.startsWith('comment')), scopeNames};
      }));
      try {
        // Match grammar registration order before checking any lazy embeddings.
        for (const [lang] of fixtures) {
          await highlighter.loadLanguage((await bundledLanguages[lang]()).default);
          await waitTokens(lang, 'prime');
        }
        for (const [lang, source] of fixtures) {
          for (const code of [source, source.replace(/\n/g, '\r\n') + '\r\n']) {
            const expected = expectedTokens(lang, code);
            const actual = await waitTokens(lang, code);
            if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Token parity failed: ' + surface + ' ' + lang + ' ' + type);
            checked++;
          }
        }
        for (const code of ['', '\n', '\r\n', 'const single = "😀";']) {
          const actual = await waitTokens('typescript', code);
          if (actual.length !== code.split(/\r?\n/).length) throw new Error('Empty or trailing line lost');
          if (JSON.stringify(actual) !== JSON.stringify(expectedTokens('typescript', code))) throw new Error('Empty or single-line token parity failed');
          checked++;
        }
      } finally { release(); setShikiTheme(null, surface); highlighter.dispose(); }
    }
  }
  return checked;
}
