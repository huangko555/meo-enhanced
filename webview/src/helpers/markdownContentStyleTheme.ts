import { EditorView } from '@codemirror/view';
import { darkDefaultLiveStrongForeground, markdownContentStyles, markdownHeadingStyle } from '../../../src/shared/markdownContentStyles';
import { mathReflowBaseStyle } from '../../../src/shared/mathStyles';

export const markdownContentStyleTheme = EditorView.baseTheme({
  '& :where(.meo-md-html-content *, .meo-md-html-inline)': markdownContentStyles.htmlContent,
  '&.meo-mode-live': {
    '--meo-content-highlight': 'var(--meo-live-highlight-background)',
    '--meo-content-heading-foreground': 'var(--meo-ui-text-emphasis-content)',
    '--meo-content-heading-weight': 'var(--meo-editor-heading-weight)',
    '--meo-content-code-font': 'var(--meo-font-source)',
    '--meo-content-code-weight': 'var(--meo-font-source-weight)',
    '--meo-content-code-background': 'var(--meo-inline-code-background)',
    '--meo-content-code-border': 'var(--meo-document-inline-border)',
    '--meo-content-quote-border': 'var(--meo-semantic-blockquoteBorder)',
    '--meo-content-quote-foreground': 'var(--meo-semantic-blockquoteForeground)'
  },
  '& :is(.meo-md-em, .meo-md-html-inline em, .meo-md-html-inline i, .meo-md-html-content em, .meo-md-html-content i)': markdownContentStyles.emphasis,
  '& :is(.meo-md-strong, .meo-md-html-inline strong, .meo-md-html-inline b, .meo-md-html-content strong, .meo-md-html-content b)': markdownContentStyles.strong,
  '& :is(.meo-md-html-inline s, .meo-md-html-inline del, .meo-md-html-content s, .meo-md-html-content del)': markdownContentStyles.strikethrough,
  '& :is(.meo-md-html-inline sub, .meo-md-html-content sub)': markdownContentStyles.subscript,
  '& :is(.meo-md-html-inline sup, .meo-md-html-content sup)': markdownContentStyles.superscript,
  '& :is(.meo-md-html-inline u, .meo-md-html-content u)': markdownContentStyles.underline,
  '& :is(.meo-md-html-inline mark, .meo-md-html-content mark)': markdownContentStyles.highlight,
  '&.meo-mode-live .meo-md-highlight': { ...markdownContentStyles.highlight, WebkitTextFillColor: 'inherit' },
  '&.meo-mode-live .meo-md-inline-code': markdownContentStyles.inlineCode,
  '&.meo-mode-live .meo-md-html-inline code:not(pre code), &.meo-mode-live .meo-md-html-content code:not(pre code)': markdownContentStyles.inlineCode,
  '&.meo-mode-live .meo-md-strong .meo-md-inline-code, &.meo-mode-live :is(.meo-md-html-inline, .meo-md-html-content) :is(strong, b) code:not(pre code)': { fontWeight: 'inherit' },
  '& .meo-md-html-content p': markdownContentStyles.paragraph,
  '& .meo-md-html-content blockquote': markdownContentStyles.blockquote,
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map(level => [`& .meo-md-html-content h${level}`, markdownHeadingStyle(level)])),
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map(level => [`& .meo-md-h${level}`, {
    fontSize: markdownHeadingStyle(level).fontSize,
    '--meo-heading-token-weight': `var(--meo-heading-${level}-weight)`
  }])),
  ["html[data-editor-appearance='dark'] &.meo-mode-live " +
    ':is(.meo-md-strong:not(.meo-live-strong-coloring *), .meo-md-html-inline strong, .meo-md-html-inline b, .meo-md-html-content strong, .meo-md-html-content b)' +
    ':not([data-meo-html-styled]):not([data-meo-html-styled] *)' +
    ':not(:is(.meo-md-strong, strong, b, .meo-md-heading-content, .meo-md-h1, .meo-md-h2, .meo-md-h3, .meo-md-h4, .meo-md-h5, .meo-md-h6, .meo-md-link, .meo-md-wiki-link, .meo-task-complete, h1, h2, h3, h4, h5, h6, a) *, ' +
    '.meo-md-link, .meo-md-wiki-link, .meo-task-complete)']: {
    color: `${darkDefaultLiveStrongForeground} !important`,
    WebkitTextFillColor: 'currentColor !important'
  },
  '& .meo-md-strike': { textDecoration: `${markdownContentStyles.strikethrough.textDecoration} !important` },
  '&.meo-mode-live .meo-md-subscript': markdownContentStyles.subscript,
  '&.meo-mode-live .meo-md-superscript': markdownContentStyles.superscript,
  '& .meo-md-math-display.meo-math-reflow .katex-display > .katex > .katex-html > .base': mathReflowBaseStyle
});
