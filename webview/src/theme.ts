import { HighlightStyle } from '@codemirror/language';
import { styleTags, tags } from '@lezer/highlight';
import { darkBuiltInVisuals, SYNTAX_TAG_SPECS, type SyntaxTokenStyleSpec } from '../../src/shared/builtInVisualBaseline';

const defaultTheme = darkBuiltInVisuals;
const liveDecoratedMarkdownTokenIds = new Set(['heading', 'emphasis', 'strong', 'strikethrough']);

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

// VS Code's Markdown grammar gives ATX heading punctuation and heading text
// the same markup.heading scope. Lezer classifies HeaderMark as a generic
// processing instruction, so Source must correct that one parser tag before
// applying the native palette.
export const sourceMarkdownHighlightProps = styleTags({
  HeaderMark: tags.heading
});

// Live Mode owns rendered Markdown presentation through decorations and line styles.
// Excluding these parser tags prevents their styles from leaking onto Markdown markers.
export const liveHighlightStyle = createHighlightStyle(liveDecoratedMarkdownTokenIds);
