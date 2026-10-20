// KaTeX's top-level bases can wrap but provide no clearance between tall rows.
// Keep this outside the formula internals so fractions and matrices retain their spacing.
export const mathReflowBaseStyle = { marginBlock: '0.25em' } as const;
