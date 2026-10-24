import { darkCssVariableOverrides } from '../themes/editorDarkTheme';
import { lightCssVariableOverrides } from '../themes/editorLightTheme';
import { defaultUiColors } from '../themes/defaultUiColors';
import type { UiColorOverrides } from '../../../src/foundation/uiColors';

export const contentVariable = (name: string): string => name.replace('--vscode-', '--meo-content-');

/** Freeze existing document colors independently of native UI tokens. */
export function contentColor(value: string): string {
  return value.replace(/--vscode-[\w-]+/g, name => name !== '--vscode-editor-background' && name in darkCssVariableOverrides ? contentVariable(name) : name);
}

type Rgb = readonly [number, number, number];
const black: Rgb = [0, 0, 0];
const white: Rgb = [255, 255, 255];
const rgb = (value: Rgb): string => `rgb(${value.join(' ')})`;
const linear = (channel: number): number => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};
const luminance = (value: Rgb): number => 0.2126 * linear(value[0]) + 0.7152 * linear(value[1]) + 0.0722 * linear(value[2]);
const contrast = (first: Rgb, second: Rgb): number => (Math.max(luminance(first), luminance(second)) + 0.05) / (Math.min(luminance(first), luminance(second)) + 0.05);
const neutral = (value: Rgb): Rgb => {
  const light = luminance(value);
  const channel = Math.round(255 * (light <= 0.0031308 ? light * 12.92 : 1.055 * light ** (1 / 2.4) - 0.055));
  return [channel, channel, channel];
};

// The cache is only a projection of resolved inputs, never theme state. Theme
// events invalidate it by changing the key; mode switches reuse the same roles.
let paletteCache: { key: string; roles: Record<string, string>; documentRoles: Record<string, string> } | undefined;

function createColorTools(appearance: 'light' | 'dark') {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  // Let the browser resolve native CSS values and perform gamut mapping. A
  // one-pixel canvas also handles alpha and OKLab without another color library.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const sample = (value: string, underlay: Rgb = appearance === 'light' ? white : black): Rgb => {
    probe.style.color = value;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = getComputedStyle(probe).color;
    context.fillRect(0, 0, 1, 1);
    const pixel = context.getImageData(0, 0, 1, 1).data;
    const alpha = pixel[3]! / 255;
    const channel = (index: number): number => Math.round(pixel[index]! * alpha + underlay[index]! * (1 - alpha));
    return [channel(0), channel(1), channel(2)];
  };
  const mixSpace = CSS.supports('color', 'color-mix(in oklab, black, white)') ? 'oklab' : 'srgb';
  const mix = (first: Rgb, second: Rgb, amount: number): Rgb => sample(`color-mix(in ${mixSpace}, ${rgb(first)} ${(1 - amount) * 100}%, ${rgb(second)} ${amount * 100}%)`);
  const minimumContrast = (value: Rgb, surfaces: readonly Rgb[]): number => Math.min(...surfaces.map(surface => contrast(value, surface)));
  const endpoint = (surfaces: readonly Rgb[]): Rgb => minimumContrast(black, surfaces) >= minimumContrast(white, surfaces) ? black : white;
  const fit = (value: Rgb, surfaces: readonly Rgb[], target: number): Rgb => {
    if (minimumContrast(value, surfaces) >= target) return value;
    const end = endpoint(surfaces);
    if (minimumContrast(end, surfaces) < target) return end;
    let lower = 0, upper = 1;
    for (let step = 0; step < 12; step += 1) {
      const middle = (lower + upper) / 2;
      if (minimumContrast(mix(value, end, middle), surfaces) >= target) upper = middle;
      else lower = middle;
    }
    return mix(value, end, upper);
  };
  return { sample, mix, minimumContrast, endpoint, fit, dispose: () => probe.remove() };
}

export function applyUiTheme(appearance: 'light' | 'dark', matchesHost: boolean, overrides: UiColorOverrides = {}): void {
  const style = document.documentElement.style;
  const fallback = appearance === 'light' ? lightCssVariableOverrides : darkCssVariableOverrides;
  const defaults = defaultUiColors[appearance];
  const color = (id: string, legacy: string): string => matchesHost ? `var(--vscode-${id.replace(/\./g, '-')}, ${legacy})` : legacy;
  const highContrast = matchesHost && (document.body.classList.contains('vscode-high-contrast')
    || document.body.classList.contains('vscode-high-contrast-light'));
  document.documentElement.dataset.meoUiContrast = highContrast ? 'high' : 'normal';
  document.documentElement.dataset.meoUiColorSource = matchesHost ? 'vscode' : 'default';
  const custom = highContrast ? {} : overrides;
  const { sample, mix, minimumContrast, endpoint, fit, dispose } = createColorTools(appearance);
  const read = (id: string, legacy: string, underlay?: Rgb): Rgb => sample(color(id, legacy), underlay);

  try {
    const documentSurface = custom.documentBackground ? sample(custom.documentBackground) : read('editor.background', defaults.documentBackground);
    // Document and UI carriers are independent. Color previews update CSS only,
    // leaving native Source tokens and document parsing untouched.
    style.setProperty('--meo-background', rgb(documentSurface));
    const nativeSurface = custom.surface ? sample(custom.surface) : read('editorWidget.background', defaults.surface, documentSurface);
    // Large UI areas share the toolbar's low-chroma family. Native menu fills
    // can have an unrelated, strong tint and are not another default input.
    const surface = highContrast || custom.surface ? nativeSurface : mix(nativeSurface, neutral(nativeSurface), 0.30);
    const foreground = custom.text ? sample(custom.text) : neutral(read('foreground', defaults.text, surface));
    const accent = custom.accent ? sample(custom.accent) : read('button.background', defaults.accent, surface);
    const success = custom.success ? sample(custom.success) : read('testing.iconPassed', defaults.success, surface);
    const warning = custom.warning ? sample(custom.warning) : read('editorWarning.foreground', defaults.warning, surface);
    const danger = custom.danger ? sample(custom.danger) : read('errorForeground', defaults.danger, surface);
    const contentSurface = sample(`var(--meo-background, ${rgb(documentSurface)})`, documentSurface);
    const documentInk = sample('var(--meo-token-foreground-color, var(--meo-content-editor-foreground))', contentSurface);
    const documentDark = luminance(contentSurface) < 0.18;
    const documentTint = documentDark ? white : black;
    // A perceptible floor also covers pure black, where a small OKLab mix alone
    // is almost invisible. Limit the shift when the existing ink is readable.
    const documentLayer = (amount: number, floor: number): Rgb => {
      let layer = fit(mix(contentSurface, documentTint, amount), [contentSurface], floor);
      if (contrast(documentInk, contentSurface) >= 4.55 && contrast(documentInk, layer) < 4.55) {
        // Keep the strongest readable layer; halving can make a stronger
        // requested background weaker than its previous, readable value.
        let lower = 0, upper = 1;
        for (let step = 0; step < 8; step += 1) {
          const middle = (lower + upper) / 2;
          if (contrast(documentInk, mix(contentSurface, layer, middle)) >= 4.55) lower = middle;
          else upper = middle;
        }
        layer = mix(contentSurface, layer, lower);
      }
      return highContrast ? contentSurface : layer;
    };
    // Match the pre-migration Live distinction, not its fixed RGB values:
    // inline/body was ~1.79 in dark mode and ~1.23 in light mode.
    const inlineSurface = documentLayer(0, documentDark ? 1.80 : 1.23);
    const blockReference = documentLayer(documentDark ? 0.10 : 0.055, 1.12);
    // Keep 75%/60% of the preview reference's OKLab shift. Its 1.12 floor
    // belongs to the reference only; reapplying it would undo the softer fill.
    let blockSurface = mix(contentSurface, blockReference, documentDark ? 0.75 : 0.60);
    const codeInk = sample('var(--meo-code-palette-foreground, var(--meo-token-foreground-color))', contentSurface);
    const codeComment = sample('var(--meo-code-palette-comment, var(--meo-token-comment-color))', contentSurface);
    const codeCarrier = sample('var(--meo-code-palette-background, var(--meo-content-editor-background))', contentSurface);
    const codeReadable = (carrier: Rgb) => contrast(codeInk, carrier) >= Math.min(4.5, contrast(codeInk, codeCarrier))
      && contrast(codeComment, carrier) >= Math.min(3, contrast(codeComment, codeCarrier));
    let pairedCodeSurface = false;
    if (!highContrast) {
      for (let step = 0; step < 8 && !codeReadable(blockSurface); step += 1) blockSurface = mix(blockSurface, contentSurface, 0.5);
      if (!codeReadable(blockSurface)) { blockSurface = codeCarrier; pairedCodeSurface = true; }
    }
    document.documentElement.dataset.meoDocumentCodeSurface = pairedCodeSurface ? 'paired' : 'derived';
    // Legacy header/stripe fills were ~1.09/1.05 against the document. Derive
    // this separately so a code-token readability fallback cannot erase them.
    const tableSurface = documentLayer(0, documentDark ? 1.09 : 1.05);
    document.documentElement.dataset.meoDocumentContrast = contrast(documentInk, contentSurface) < 4.5
      || documentDark !== (appearance === 'dark') ? 'low' : 'normal';
    // Matches start from the final heading ink. Keep it unchanged when readable,
    // otherwise apply only the existing contrast correction for the menu carrier.
    const contentInput = (kind: 'heading' | 'link', fallbackColor: string): Rgb => highContrast
      ? read('textLink.foreground', fallbackColor, contentSurface)
      : sample(`var(--meo-content-${kind}-input, ${color('textLink.foreground', fallbackColor)})`, contentSurface);
    const textEmphasis = custom.textEmphasis ? sample(custom.textEmphasis) : contentInput('heading', defaults.textEmphasis);
    const link = custom.link ? sample(custom.link) : contentInput('link', defaults.link);
    const footnoteBackground = `color-mix(in srgb, ${rgb(link)} 12%, transparent)`;
    const contentSurfaces = [contentSurface, inlineSurface, tableSurface];
    const linkSurfaces = [...contentSurfaces, sample(footnoteBackground, contentSurface)];
    const tint = endpoint([surface]);
    // All ordinary surfaces must admit one shared neutral foreground. Near
    // middle luminance, a fixed hover mix can otherwise cross that boundary.
    const compatibleSurface = (value: Rgb): Rgb => fit(value, [tint], 4.55);
    const raised = highContrast ? surface : compatibleSurface(mix(surface, tint, appearance === 'light' ? 0.015 : 0.04));
    const nativeFocus = highContrast ? read('focusBorder', rgb(accent), surface) : undefined;
    const nativeBorder = highContrast ? read('contrastBorder', color('widget.border', rgb(tint)), raised) : undefined;
    const nativeActiveBorder = highContrast ? read('contrastActiveBorder', color('focusBorder', rgb(accent)), raised) : undefined;
    const nativeSelection = highContrast ? read('list.activeSelectionBackground', rgb(raised), raised) : undefined;
    const nativeSelectionText = highContrast ? read('list.activeSelectionForeground', rgb(foreground), nativeSelection) : undefined;
    const key = JSON.stringify([appearance, highContrast, surface, raised, foreground, accent, success, warning, danger, !!custom.success, !!custom.warning, !!custom.danger, textEmphasis, link, contentSurfaces, linkSurfaces, documentInk, blockSurface,
      nativeFocus, nativeBorder, nativeActiveBorder, nativeSelection, nativeSelectionText]);

    if (paletteCache?.key !== key) {
      const hover = highContrast ? raised : compatibleSurface(mix(raised, tint, appearance === 'light' ? 0.04 : 0.08));
      // A brief press needs a stronger fill than hover, including when high
      // contrast keeps hover on the base surface and press outlines are absent.
      const pressed = compatibleSurface(mix(raised, tint, appearance === 'light' ? 0.14 : 0.22));
      const selected = nativeSelection ?? compatibleSurface(mix(raised, tint, appearance === 'light' ? 0.10 : 0.17));
      const field = highContrast ? raised : compatibleSurface(mix(raised, appearance === 'light' ? white : black, appearance === 'light' ? 0.30 : 0.08));
      const track = highContrast ? surface : compatibleSurface(mix(surface, tint, appearance === 'light' ? 0.12 : 0.17));
      const switchOff = mix(raised, tint, appearance === 'light' ? 0.28 : 0.32);
      const surfaces = [surface, raised, field, hover, pressed, track, ...(highContrast ? [] : [selected])];
      const text = fit(foreground, surfaces, 4.55);
      // Gray selection surfaces can lift both text levels to the same minimum.
      // A stronger label restores hierarchy without reducing detail readability.
      const strongText = highContrast ? text : fit(text, surfaces, 7);
      const muted = highContrast ? text : fit(mix(text, neutral(raised), 0.34), surfaces, 4.55);
      const separator = nativeBorder ?? mix(raised, tint, appearance === 'light' ? 0.13 : 0.12);
      const floatBorder = nativeBorder ?? fit(mix(raised, tint, appearance === 'light' ? 0.20 : 0.19), [surface, raised], 1.3);
      const controlBorder = nativeBorder ?? fit(mix(raised, tint, appearance === 'light' ? 0.35 : 0.30), [surface, raised, field], 3.05);
      const accentHover = fit(mix(accent, endpoint([accent]), appearance === 'light' ? 0.08 : 0.06), [endpoint([accent])], 4.55);
      const onAccent = fit(endpoint([accent, accentHover]), [accent, accentHover], 4.55);
      const accentText = fit(accent, surfaces, 4.55);
      const selectedText = fit(custom.text ? text : neutral(nativeSelectionText ?? text), [selected], 4.55);
      const contentEmphasis = fit(textEmphasis, contentSurfaces, 4.55);
      // Preserve semantic hue/chroma when raising contrast. Mixing toward white
      // makes status colors pastel, especially on dark selected surfaces.
      const vividSemantics = !highContrast && CSS.supports('color', 'oklch(from red l calc(c * 1.4) h)');
      // Status labels use ordinary fields and hover carriers, not segmented
      // tracks. The selected comparison warning is an icon (3:1 contrast).
      const semanticSurfaces = [surface, raised, field, hover];
      const semanticColor = (value: Rgb, overridden?: string, carriers: readonly Rgb[] = semanticSurfaces): Rgb => {
        if (!vividSemantics || overridden) return fit(value, surfaces, 4.55);
        const vivid = sample(`oklch(from ${rgb(value)} l calc(c * 1.4) h)`);
        if (minimumContrast(vivid, carriers) >= 4.55) return vivid;
        const end = endpoint(carriers);
        if (minimumContrast(end, carriers) < 4.55) return end;
        const shift = (amount: number) => sample(`oklch(from ${rgb(value)} calc(l + ${end === white ? amount : -amount}) calc(c * 1.4) h)`);
        let lower = 0, upper = 1;
        for (let step = 0; step < 12; step += 1) {
          const middle = (lower + upper) / 2;
          if (minimumContrast(shift(middle), carriers) >= 4.55) upper = middle;
          else lower = middle;
        }
        return shift(upper);
      };
      const roles: Record<string, string> = Object.fromEntries(Object.entries({
        surface, 'document-background': documentSurface, 'surface-raised': raised, 'surface-field': field, 'surface-hover': hover,
        'surface-pressed': pressed, 'surface-selected': selected, 'segmented-track': track,
        text, 'text-strong': strongText, 'text-muted': muted, 'text-disabled': mix(text, neutral(raised), 0.55),
        'text-selected': selectedText, separator, 'border-float': floatBorder, 'border-control': controlBorder,
        focus: nativeFocus ?? fit(accent, [surface, raised, field], 3.05),
        'selection-border': nativeActiveBorder ?? selected,
        accent, 'accent-hover': accentHover, 'on-accent': onAccent, 'accent-text': accentText,
        'text-emphasis': fit(contentEmphasis, highContrast ? [raised, hover] : [raised, hover, selected], 4.55),
        'text-emphasis-content': contentEmphasis,
        link: fit(link, linkSurfaces, 4.55),
        'text-emphasis-selected': fit(contentEmphasis, [selected], 4.55),
        success: semanticColor(success, custom.success), warning: semanticColor(warning, custom.warning), danger: semanticColor(danger, custom.danger),
        'success-emphasis': semanticColor(success, custom.success, [surface, raised, hover]),
        'danger-emphasis': semanticColor(danger, custom.danger, [surface, raised, hover]),
        'switch-off': switchOff, 'on-switch-off': fit(mix(text, neutral(raised), 0.20), [switchOff], 3.05)
      }).map(([role, value]) => [role, rgb(value)]));
      roles['link-background'] = footnoteBackground;
      roles.shadow = appearance === 'light' ? '0 4px 12px rgb(0 0 0 / 14%)' : '0 4px 14px rgb(0 0 0 / 38%)';
      roles.scrim = appearance === 'light' ? 'rgb(0 0 0 / 28%)' : 'rgb(0 0 0 / 45%)';
      roles.scrollbar = `color-mix(in srgb, ${rgb(text)} 32%, transparent)`;
      roles['scrollbar-hover'] = `color-mix(in srgb, ${rgb(text)} 48%, transparent)`;
      roles['scrollbar-active'] = `color-mix(in srgb, ${rgb(text)} 62%, transparent)`;
      const documentSurfaces = [contentSurface, inlineSurface, blockSurface, tableSurface];
      const documentLine = nativeBorder ?? fit(mix(contentSurface, documentTint, 0.06), [contentSurface, blockSurface, tableSurface], 1.4);
      const blockHover = highContrast ? blockSurface : mix(blockSurface, documentTint, documentDark ? 0.07 : 0.04);
      const blockPressed = highContrast ? blockSurface : mix(blockSurface, documentTint, documentDark ? 0.11 : 0.07);
      const actionSurfaces = [blockSurface, blockHover, blockPressed];
      const actionText = fit(neutral(documentInk), actionSurfaces, 4.55);
      const softenLightActions = appearance === 'light' && !highContrast;
      // Resting light controls sit on the block itself. Hover/pressed carriers
      // have their own stronger foreground and should not constrain this tone.
      const actionMuted = fit(mix(actionText, blockSurface, softenLightActions ? 0.50 : 0.22), softenLightActions ? [blockSurface] : actionSurfaces, softenLightActions ? 3.55 : 4.55);
      const actionHover = fit(mix(actionText, endpoint(actionSurfaces), 0.82), actionSurfaces, 4.55);
      const documentRoles = Object.fromEntries(Object.entries({
        inline: inlineSurface, block: blockSurface, table: tableSurface, separator: documentLine,
        'inline-border': nativeBorder ?? mix(documentLine, inlineSurface, 0.65),
        'block-border': nativeBorder ?? fit(documentLine, [blockSurface, contentSurface], documentDark ? 1.75 : 1.65),
        'border-control': nativeBorder ?? fit(documentLine, documentSurfaces, 3.05),
        focus: nativeFocus ?? fit(accent, [...documentSurfaces, blockHover, blockPressed], 3.05),
        'block-hover': blockHover, 'block-pressed': blockPressed,
        'action-text': actionMuted, 'action-hover-text': actionHover,
        'active-line': highContrast ? contentSurface : mix(contentSurface, documentTint, documentDark ? 0.06 : 0.025)
      }).map(([role, value]) => [role, rgb(value)]));
      paletteCache = { key, roles, documentRoles };
    }
    for (const [role, value] of Object.entries(paletteCache.roles)) style.setProperty('--meo-ui-' + role, value);
    for (const [role, value] of Object.entries(paletteCache.documentRoles)) style.setProperty('--meo-document-' + role, value);
    // Existing Live consumers share the resolved roles. Store final values so
    // the export style environment can carry them without browser-only vars.
    for (const [property, role] of Object.entries({
      'code-background': 'block', 'inset-background': 'inline', 'inline-code-background': 'inline',
      'active-line-bg': 'active-line', 'code-block-active-line-bg': 'block-hover',
      'code-action-foreground': 'action-text', 'code-action-hover-foreground': 'action-hover-text',
      'semantic-codeBlockBackground': 'block', 'semantic-codeBlockActiveLineBackground': 'block-hover',
      'semantic-inlineCodeBackground': 'inline',
      'semantic-imageBackground': 'block', 'semantic-imageBorder': 'separator',
      'semantic-frontmatterPillBackground': 'inline', 'semantic-tableHeaderBackground': 'table',
      'semantic-tableBorder': 'separator', 'semantic-horizontalRule': 'separator',
      'semantic-blockquoteBorder': 'separator', 'semantic-listGuide': 'separator', 'semantic-kbdBorder': 'separator',
      'semantic-codeCopyForeground': 'action-text', 'semantic-codeCopyHoverForeground': 'action-hover-text',
      'semantic-codeLanguageLabelForeground': 'action-text',
      'semantic-codeCopyHoverBackground': 'block-hover'
    })) style.setProperty('--meo-' + property, paletteCache.documentRoles[role]!);
  } finally {
    dispose();
  }
  for (const id of ['font-family', 'editor-font-family']) style.setProperty('--meo-ui-' + id, `var(--vscode-${id})`);
  // Notifications keep their existing component contract, backed by the same
  // roles as menus and controls rather than a second native color mapping.
  for (const [property, role] of Object.entries({
    'notice-surface': 'surface-raised', 'notice-foreground': 'text', 'notice-action-surface': 'accent',
    'notice-action-foreground': 'on-accent', 'notice-action-hover-surface': 'accent-hover',
    'notice-info': 'accent-text', 'notice-warning': 'warning', 'notice-error': 'danger',
    'fixed-baseline-active-background': 'surface-selected', 'fixed-baseline-active-foreground': 'text-selected',
    'fixed-baseline-standby-foreground': 'text-muted'
  })) style.setProperty('--meo-' + property, `var(--meo-ui-${role})`);
  // Source chrome and document navigation retain their native content palette.
  style.setProperty('--meo-outline-foreground', color('editor.foreground', fallback['--vscode-editor-foreground']));
  for (const [name, id, legacy] of [
    ['selection', 'editor.selectionBackground', fallback['--vscode-editor-selectionBackground']],
    ['inactive-selection', 'editor.inactiveSelectionBackground', fallback['--vscode-editor-selectionBackground']],
    ['caret', 'editorCursor.foreground', fallback['--vscode-editor-foreground']],
    ['line', 'editor.lineHighlightBackground', matchesHost ? 'transparent' : 'var(--meo-document-active-line)'],
    ['line-border', 'editor.lineHighlightBorder', 'transparent'],
    ['line-number', 'editorLineNumber.foreground', fallback['--vscode-editorLineNumber-foreground']],
    ['active-line-number', 'editorLineNumber.activeForeground', fallback['--vscode-editor-foreground']]
  ] as const) style.setProperty('--meo-source-' + name, color(id, legacy));
}

export interface OutlinePaletteInput {
  background: string;
  foreground: string;
}

const outlinePaletteKeys = new WeakMap<HTMLElement, string>();

/** Derive navigation colors against its adjacent document, preserving shared emphasis and contrast rules. */
export function applyOutlinePalette(sidebar: HTMLElement, input: OutlinePaletteInput): void {
  const rootStyles = getComputedStyle(document.documentElement);
  const highContrast = document.documentElement.dataset.meoUiContrast === 'high';
  const inputs = Object.fromEntries(['text-emphasis-content', 'focus', 'danger', 'border-control'].map(role =>
    [role, rootStyles.getPropertyValue('--meo-ui-' + role).trim()]));
  const key = JSON.stringify([input, highContrast, inputs]);
  if (outlinePaletteKeys.get(sidebar) === key) return;
  const { sample, mix, fit, dispose } = createColorTools('dark');
  try {
    const background = sample(input.background);
    const dark = luminance(background) < 0.18;
    const ink = sample(input.foreground, background);
    const hover = highContrast ? background : mix(background, ink, 0.08);
    const visible = highContrast ? background : mix(background, ink, 0.05);
    const surfaces = [background, hover, visible];
    const text = fit(ink, surfaces, 4.55);
    const roles = {
      background, foreground: text,
      'muted-foreground': fit(mix(text, background, 0.30), surfaces, 4.55),
      'hover-background': hover, 'visible-background': visible,
      emphasis: fit(sample(inputs['text-emphasis-content'] || rgb(text), background), surfaces, 4.55),
      border: highContrast ? fit(sample(inputs['border-control'] || rgb(text), background), [background], 3.05)
        : mix(background, text, 0.20),
      focus: fit(sample(inputs.focus || rgb(text), background), surfaces, 3.05),
      danger: fit(sample(inputs.danger || rgb(text), background), surfaces, 4.55)
    };
    for (const [role, value] of Object.entries(roles)) sidebar.style.setProperty('--meo-outline-' + role, rgb(value));
    for (const [role, amount] of [['scrollbar-thumb', 38], ['scrollbar-thumb-hover', 50], ['scrollbar-thumb-active', 62]] as const) {
      sidebar.style.setProperty('--meo-outline-' + role, `color-mix(in srgb, ${rgb(text)} ${amount}%, transparent)`);
    }
    sidebar.style.setProperty('--meo-outline-shadow', `0 8px 28px rgb(0 0 0 / ${dark ? 45 : 16}%)`);
    sidebar.style.colorScheme = dark ? 'dark' : 'light';
    sidebar.dataset.outlineContrast = highContrast ? 'high' : 'normal';
    outlinePaletteKeys.set(sidebar, key);
  } finally {
    dispose();
  }
}
