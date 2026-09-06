import { HighlightStyle } from '@codemirror/language';
import { styleTags, tags, Tag } from '@lezer/highlight';
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

// Source treats heading punctuation like heading text; Live keeps the default
// processing-instruction styling. A derived tag preserves both on one grammar.
const headerMarkTag = Tag.define(tags.processingInstruction);
export const sourceHighlightStyle = HighlightStyle.define([
  ...SYNTAX_TAG_SPECS.map(buildSpec),
  { ...buildSpec(SYNTAX_TAG_SPECS.find(spec => spec.id === 'heading')!), tag: headerMarkTag }
]);

// VS Code's Markdown grammar gives ATX heading punctuation and heading text
// the same markup.heading scope. Lezer classifies HeaderMark as a generic
// processing instruction, so Source must correct that one parser tag before
// applying the native palette.
export const sourceMarkdownHighlightProps = styleTags({
  HeaderMark: headerMarkTag
});

// Live Mode owns rendered Markdown presentation through decorations and line styles.
// Excluding these parser tags prevents their styles from leaking onto Markdown markers.
export const liveHighlightStyle = createHighlightStyle(liveDecoratedMarkdownTokenIds);
