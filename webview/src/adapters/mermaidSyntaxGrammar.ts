import type { LanguageRegistration } from 'shiki';

/** Shiki bundles Mermaid as a Markdown injection; code surfaces pass the body. */
export function withMermaidBodySyntax(grammars: LanguageRegistration[]): LanguageRegistration[] {
  return grammars.map(grammar => {
    if (grammar.name !== 'mermaid') return grammar;
    const { injectionSelector: _injectionSelector, ...standalone } = grammar;
    return { ...standalone, patterns: [{ include: '#mermaid' }] };
  });
}
