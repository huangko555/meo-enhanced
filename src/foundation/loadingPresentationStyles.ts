/** Pure style values shared by the HTML startup shell and runtime surfaces. */
export const loadingPresentationStyles = `
:where(.surface-loading){position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--meo-preview-foreground,var(--meo-foreground,var(--vscode-editor-foreground)));background:var(--meo-preview-background,var(--meo-background,var(--vscode-editor-background)));font-size:13px}
.surface-loading[hidden]{display:none}
.surface-loading-spinner{width:22px;height:22px;box-sizing:border-box;border:2px solid color-mix(in srgb,currentColor 18%,transparent);border-top-color:var(--meo-ui-focus,currentColor);border-radius:50%;animation:preview-loading-spin .85s linear infinite}
@keyframes preview-loading-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.surface-loading-spinner{animation:none}}
`;
