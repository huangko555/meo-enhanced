import assert from 'node:assert/strict';
import darkPlus from '@shikijs/themes/dark-plus';
import lightPlus from '@shikijs/themes/light-plus';
import {
  activateShikiCodeHighlighting, getShikiTokens, requestShikiTokens, setShikiTheme,
  type ShikiSurface, type ShikiToken
} from '../webview/src/helpers/shikiHighlighter';

type TokenLines = readonly (readonly ShikiToken[])[];
const tokensFor = async (surface: ShikiSurface, language: string, text: string): Promise<TokenLines> => {
  requestShikiTokens(language, text, surface);
  for (let attempt = 0; attempt < 2000; attempt++) {
    const tokens = getShikiTokens(language, text, surface);
    if (tokens) return tokens;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out: ${surface} ${language}`);
};

const projection = (line: readonly ShikiToken[]) => line.map(({ content, color, fontStyle, scopeNames }) => (
  { content, color, fontStyle, scopeNames }
));
const markdownTail = ['## Recovered heading', '**Recovered bold** and `inline code`', '- Recovered list'];
const htmlPrefixes = ['</table>', '<table>\n<tr><td>cell</td></tr>\n</table>', '<div>\nbody\n</div>'];
let checked = 0;
for (const theme of [darkPlus, lightPlus]) {
  for (const surface of ['source', 'editor', 'preview'] as const) {
    setShikiTheme(theme, surface);
    const release = activateShikiCodeHighlighting(surface);
    try {
      const baseline = await tokensFor(surface, 'markdown', markdownTail.join('\n'));
      assert.ok(baseline[0].some(syntax => syntax.scopeNames?.some(scope => scope.startsWith('markup.heading'))));
      for (const diagram of ['sequenceDiagram\nparticipant User\nUser->>Editor: Edit', 'flowchart TD\nA[Start] --> B[End]']) {
        const tokens = await tokensFor(surface, 'mermaid', diagram);
        assert.equal(tokens.map(line => line.map(syntax => syntax.content).join('')).join('\n'), diagram);
        assert.ok(tokens.flat().some(syntax => syntax.scopeNames?.includes('keyword.control.mermaid')),
          `${theme.type}/${surface}: Mermaid body receives real keyword scopes`);
        assert.ok(new Set(tokens.flat().map(syntax => syntax.color)).size > 1,
          `${theme.type}/${surface}: Mermaid source is not a single plain-text color`);
        checked++;
      }
      const plainMermaidWords = await tokensFor(surface, 'markdown', 'sequenceDiagram\nUser->>Editor: prose');
      assert.ok(plainMermaidWords.flat().every(syntax => !syntax.scopeNames?.some(scope => scope.endsWith('.mermaid'))),
        'Loading Mermaid must not inject Mermaid syntax into ordinary Markdown paragraphs');
      // Loading HTML in another code block used to change whether Markdown
      // recovered after a raw HTML block. Source loads these embeddings eagerly.
      for (const language of ['html', 'html-derivative', 'vue']) {
        await tokensFor(surface, language, '<div class="sample">HTML</div>');
      }
      for (const prefix of htmlPrefixes) {
        for (const padding of [0, 126, 127, 254]) {
          for (const newline of ['\n', '\r\n']) {
            const lines = [...Array<string>(padding).fill('plain text'), ...prefix.split('\n'), '', ...markdownTail, ''];
            const text = lines.join(newline);
            const tokens = await tokensFor(surface, 'markdown', text);
            const firstTail = lines.length - markdownTail.length - 1;
            assert.equal(tokens.length, lines.length, 'Blank and trailing lines retain their positions');
            for (let index = 0; index < lines.length; index++) {
              assert.equal(tokens[index].map(syntax => syntax.content).join(''), lines[index]);
              for (const syntax of tokens[index]) {
                assert.equal(text.slice(syntax.offset, syntax.offset + syntax.content.length), syntax.content);
              }
            }
            for (let index = 0; index < markdownTail.length; index++) {
              assert.deepEqual(projection(tokens[firstTail + index]), projection(baseline[index]),
                `${surface} ${theme.name}: Markdown must recover after HTML at line ${firstTail + 1}`);
            }
            checked++;
          }
        }
      }
      for (const prefix of ['> quote', '- list item']) {
        const tokens = await tokensFor(surface, 'markdown', prefix + '\n\n' + markdownTail.join('\n'));
        assert.deepEqual(projection(tokens[2]), projection(baseline[0]), 'Blank lines end quote/list continuations');
        checked++;
      }
      for (const marker of ['`', '~']) for (const width of [3, 4]) {
        for (const [language, payload] of [
          ['javascript', '/* unfinished comment'], ['python', 'value = """unfinished string'],
          ['text', 'literal payload'], ['mermaid', 'flowchart LR'], ['math', String.raw`\frac{x`]
        ]) {
          const opening = marker.repeat(width);
          const text = [opening + language, payload, opening + marker.repeat(2), '', ...markdownTail].join('\n');
          const tokens = await tokensFor(surface, 'markdown', text);
          for (let index = 0; index < markdownTail.length; index++) {
            assert.deepEqual(projection(tokens[4 + index]), projection(baseline[index]),
              `${surface} ${theme.name}: ${language} must end at a longer ${marker} fence`);
          }
          checked++;
        }
      }
      for (const [opening, invalidClose] of [['````', '```'], ['~~~~', '~~~'], ['```', '~~~'], ['~~~', '```'], ['```', '```~']]) {
        const tokens = await tokensFor(surface, 'markdown', opening + 'text\nliteral\n' + invalidClose + '\n## still literal');
        assert.ok(tokens[3].every(syntax => !syntax.scopeNames?.some(scope => scope.startsWith('markup.heading'))),
          `${opening}: a short or mismatched fence cannot close the block`);
        checked++;
      }
      // Empty lines must advance the grammar, without resetting open constructs.
      for (const [language, text, scope] of [
        ['typescript', '/* start\n\ncontinued\n*/\nconst value = 1;', 'comment'],
        ['python', 'value = """start\n\ncontinued\nend"""\nresult = 1', 'string'],
        ['html', '<script>\n/* start\n\ncontinued\n*/\nconst value = 1;\n</script>', 'comment']
      ]) {
        const tokens = await tokensFor(surface, language, text);
        assert.ok(tokens.flat().some(syntax => syntax.content.includes('continued')
          && syntax.scopeNames?.some(name => name.startsWith(scope))), `${language}: preserve open ${scope}`);
        const last = tokens.at(-1)!;
        assert.ok(last.every(syntax => !syntax.scopeNames?.some(name => name.startsWith(scope))), `${language}: exit closed ${scope}`);
        checked++;
      }
    } finally {
      release();
      setShikiTheme(null, surface);
    }
  }
}
console.log(`Shiki empty-line recovery passed (${checked} cases across Source, Live and Preview)`);
