import type { HighlighterCore } from 'shiki/core';

/** Keep a cold scanner failure inside its engine instead of restarting its work. */
export function tokenizeShikiCode(
  highlighter: HighlighterCore,
  code: string,
  options: Parameters<HighlighterCore['codeToTokens']>[1]
): ReturnType<HighlighterCore['codeToTokens']> {
  try {
    return highlighter.codeToTokens(code, options);
  } catch (error) {
    // Shiki 4.2 merges separate scope and color passes. Their 500ms limits can
    // stop at different tokens during cold grammar compilation, exhausting the
    // scope array. Retry once with the compiled scanner still alive; keep the
    // same limits, grammar state and explanations. A second failure propagates
    // to the existing caller/worker watchdog instead of publishing partial data.
    if (!options.includeExplanation || !(error instanceof TypeError) || !error.message.includes('startIndex')) throw error;
    return highlighter.codeToTokens(code, options);
  }
}
