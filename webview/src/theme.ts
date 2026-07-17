import { HighlightStyle } from '@codemirror/language';
import { resolveTheme, SYNTAX_TAG_SPECS, type SyntaxTokenStyleSpec } from '../../src/shared/themeDefaults';

const defaultTheme = resolveTheme();
const liveDecoratedInlineTokenIds = new Set(['emphasis', 'strong', 'strikethrough']);

const buildSpec = (spec: SyntaxTokenStyleSpec) => {
  const color = `var(--meo-token-${spec.id}-color, ${defaultTheme.syntaxTokens[spec.id]})`;
  const fontWeight = spec.id === 'heading'
    ? `var(--meo-heading-token-weight, ${spec.style.fontWeight ?? '600'})`
    : spec.style.fontWeight;

  return {
    tag: spec.tags,
    color,
    fontStyle: spec.style.fontStyle,
    fontWeight,
    textDecoration: spec.style.textDecoration,
    borderBottom: spec.style.borderBottom
  };
};

function createHighlightStyle(excludedTokenIds: ReadonlySet<string> = new Set()) {
  return HighlightStyle.define(
    SYNTAX_TAG_SPECS
      .filter((spec) => !excludedTokenIds.has(spec.id))
      .map(buildSpec)
  );
}

export const sourceHighlightStyle = createHighlightStyle();

// Live Mode owns rendered inline presentation through liveMode decorations.
// Excluding these parser tags prevents their styles from leaking onto Markdown markers.
export const liveHighlightStyle = createHighlightStyle(liveDecoratedInlineTokenIds);
