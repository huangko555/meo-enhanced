// KaTeX's top-level bases can wrap but provide no clearance between tall rows.
// Keep this outside the formula internals so fractions and matrices retain their spacing.
export const mathReflowBaseStyle = { marginBlock: '0.25em' } as const;

// Every reading preset and export uses the same wrapping and clearance rules.
export const readingMathReflowCss = `
.meo-export-math-display .katex-display > .katex { white-space: normal; }
.meo-export-math-display:not(.meo-math-nowrap) .katex-display > .katex > .katex-html > .base {
  margin-block: ${mathReflowBaseStyle.marginBlock};
}
.meo-export-math-display .katex-html > .tag { white-space: nowrap; }
.meo-export-math-display.meo-math-nowrap .katex-display > .katex { white-space: nowrap; }
.meo-export-math-display.meo-math-nowrap > .meo-export-math-canvas,
.meo-export-math-display.meo-math-nowrap > .meo-export-math-canvas > .katex-display { width: max-content; }
`;
