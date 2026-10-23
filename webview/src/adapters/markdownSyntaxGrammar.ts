import type { LanguageRegistration } from 'shiki/core';
import math from './grammars/md-math.json';
import inline from './grammars/md-math-inline.json';
import block from './grammars/md-math-block.json';

/** VS Code's math-body scopes, also used for exposed Live formula source. */
export const mathSyntaxGrammar: LanguageRegistration = { ...math, name: 'meo-math' };

/** Keep Markdown's multiline stack, standard fence endings and embedded math. */
export function withMarkdownSyntax(grammars: readonly LanguageRegistration[]): LanguageRegistration[] {
  const single = structuredClone(inline.repository.math_inline_single);
  const double = structuredClone(inline.repository.math_inline_double);
  // Escaped dollars remain prose; an unfinished inline formula stops at EOL.
  single.match = String.raw`(?<![\\$])(\$)(?![\s$])((?:\\.|[^$\\\r\n\x60])+?)(?<!\s)(\$)(?![$\w])`;
  double.match = String.raw`(?<![\\$])(\${2})(?![\s$])((?:\\.|[^$\\\r\n\x60])+?)(?<!\s)(\${2})(?!\$)`;
  const inlinePatterns: LanguageRegistration['patterns'] = [
    { include: '#math_inline_double' }, { include: '#math_inline_single' }, {
      name: 'markup.math.inline.markdown', contentName: 'meta.embedded.math.markdown',
      begin: String.raw`(?<![\\$])(\$)(?![\s$\d])`, end: String.raw`(\$)|$`,
      beginCaptures: { 1: { name: 'punctuation.definition.math.begin.markdown' } },
      endCaptures: { 1: { name: 'punctuation.definition.math.end.markdown' } },
      patterns: [{ include: math.scopeName + '#math' }]
    }
  ];
  const display = structuredClone(block.repository.double_dollar_math_block);
  display.begin = String.raw`(?<=^[ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?)(\${2})[ \t]*$`;
  // The outer while rule unwinds unfinished TeX before tokenizing a boundary.
  // Ending a child rule there loses TextMate's quote/list anchor for that line.
  const boundary = String.raw`(?:#{1,6}(?:[ \t]|$)|\x60{3,}|~{3,})`;
  display.end = String.raw`(?:^|\G)([ \t]*(?:>[ \t]*)*)(\${2})[ \t]*$`;
  display.patterns[0].begin = String.raw`(^|\G)([ \t]*(?:>[ \t]*)*)`;
  display.patterns[0].while = String.raw`(^|\G)(?![ \t]*(?:>[ \t]*)*\${2}[ \t]*$)([ \t]*(?:>[ \t]*)*)`;
  const quoteCaptures = { 2: { name: 'punctuation.definition.quote.begin.markdown' } };
  const displayRule = {
    ...display,
    endCaptures: {
      1: { name: 'punctuation.definition.quote.begin.markdown' },
      2: { name: 'punctuation.definition.math.end.markdown' }
    },
    patterns: [{ ...display.patterns[0], beginCaptures: quoteCaptures, whileCaptures: quoteCaptures }]
  };
  const markdown = grammars.map(grammar => {
    if (grammar.name !== 'markdown') return grammar;
    // TextMate's bundled rules require the exact opening fence length. Markdown
    // accepts a longer closer of the same type; keep the existing capture slots.
    const repository = Object.fromEntries(Object.entries(grammar.repository!).map(([name, rule]) => [name,
      name.startsWith('fenced_code_block') && typeof rule.end === 'string'
        ? { ...rule, end: rule.end.replace(String.raw`(\3)`, String.raw`((?=\3)(?:\x60+|~+))`) } : rule
    ]));
    const fence = repository.fenced_code_block_latex;
    return { ...grammar,
      // Local injections survive later lazy language loads in Shiki's registry.
      injections: { ...grammar.injections,
        [inline.injectionSelector]: { patterns: inlinePatterns },
        // MEO uses $$ for multiline math, never a single-dollar block.
        [block.injectionSelector + ' - meta.math.recovery.markdown']: { patterns: [{ include: '#double_dollar_math_block' }] },
        // Reuse one recovery frame across later formulas in the same container.
        [block.injectionSelector.replace('text.html.markdown', 'meta.math.recovery.markdown')]: { patterns: [displayRule] }
      },
      repository: {
        ...repository, math_inline_single: single, math_inline_double: double,
        double_dollar_math_block: {
          name: 'meta.math.recovery.markdown',
          begin: `(?=${display.begin})`,
          while: String.raw`(^|\G)(?![ \t]*(?:>[ \t]*)*${boundary})`,
          patterns: [displayRule, { include: '#block' }]
        },
        fenced_code_block_latex: {
          ...fence,
          begin: typeof fence.begin === 'string' ? fence.begin.replace('(?:la|)tex', '(?:math|latex|tex|katex)') : fence.begin,
          patterns: [{ ...fence.patterns![0], patterns: [{ include: math.scopeName + '#math' }] }, ...fence.patterns!.slice(1)]
        }
      }
    };
  });
  return [mathSyntaxGrammar, ...markdown];
}
