import { isolateHistory } from '@codemirror/commands';
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  WidgetType,
  showTooltip,
  tooltips,
  type EditorView,
  type Rect,
  type Tooltip
} from '@codemirror/view';
import type { HexColorRange } from '../../../src/shared/hexColorSwatches';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';
import { UiLanguageSensitiveWidget, uiLanguageFacet } from '../editor/uiLanguage';

type RgbColor = { red: number; green: number; blue: number };
type HsvColor = { hue: number; saturation: number; brightness: number };
type ActiveHexColorAdjustment = HexColorRange & { anchor?: HTMLButtonElement };
type HexColorAdjustmentState = {
  range: ActiveHexColorAdjustment;
  tooltip: Tooltip;
};

const supportedHexColor = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;

const setActiveHexColorAdjustment = StateEffect.define<ActiveHexColorAdjustment | null>();

function hexColorTooltipSpace(view: EditorView): Rect {
  const documentElement = view.dom.ownerDocument.documentElement;
  const toolbar = view.dom.ownerDocument.querySelector('.mode-toolbar');
  const inset = 8;
  const toolbarBottom = toolbar instanceof HTMLElement ? toolbar.getBoundingClientRect().bottom : 0;
  const bottom = Math.max(inset, documentElement.clientHeight - inset);
  return {
    top: Math.min(bottom, Math.max(inset, toolbarBottom + inset)),
    left: inset,
    bottom,
    right: Math.max(inset, documentElement.clientWidth - inset)
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseHexColor(value: string): { rgb: RgbColor; alpha: number } | null {
  if (!supportedHexColor.test(value)) return null;
  return {
    rgb: {
      red: Number.parseInt(value.slice(1, 3), 16),
      green: Number.parseInt(value.slice(3, 5), 16),
      blue: Number.parseInt(value.slice(5, 7), 16)
    },
    alpha: value.length === 9 ? Number.parseInt(value.slice(7, 9), 16) : 255
  };
}

function rgbToHsv({ red, green, blue }: RgbColor): HsvColor {
  const normalized = [red, green, blue].map((channel) => channel / 255);
  const max = Math.max(...normalized);
  const min = Math.min(...normalized);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === normalized[0]) hue = 60 * (((normalized[1] - normalized[2]) / delta) % 6);
    else if (max === normalized[1]) hue = 60 * (((normalized[2] - normalized[0]) / delta) + 2);
    else hue = 60 * (((normalized[0] - normalized[1]) / delta) + 4);
  }
  if (hue < 0) hue += 360;
  return {
    hue: Math.round(hue),
    saturation: max === 0 ? 0 : Math.round((delta / max) * 100),
    brightness: Math.round(max * 100)
  };
}

function hsvToRgb({ hue, saturation, brightness }: HsvColor): RgbColor {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const normalizedSaturation = clamp(saturation, 0, 100) / 100;
  const normalizedBrightness = clamp(brightness, 0, 100) / 100;
  const chroma = normalizedBrightness * normalizedSaturation;
  const segment = normalizedHue / 60;
  const x = chroma * (1 - Math.abs((segment % 2) - 1));
  let channels: [number, number, number];
  if (segment < 1) channels = [chroma, x, 0];
  else if (segment < 2) channels = [x, chroma, 0];
  else if (segment < 3) channels = [0, chroma, x];
  else if (segment < 4) channels = [0, x, chroma];
  else if (segment < 5) channels = [x, 0, chroma];
  else channels = [chroma, 0, x];
  const match = normalizedBrightness - chroma;
  return {
    red: Math.round((channels[0] + match) * 255),
    green: Math.round((channels[1] + match) * 255),
    blue: Math.round((channels[2] + match) * 255)
  };
}

function usesUppercaseHex(value: string): boolean {
  return /[A-F]/.test(value) && !/[a-f]/.test(value);
}

function formatHexColor(rgb: RgbColor, alpha: number, includeAlpha: boolean, uppercase: boolean): string {
  const byte = (value: number) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
  const digits = `${byte(rgb.red)}${byte(rgb.green)}${byte(rgb.blue)}${includeAlpha ? byte(alpha) : ''}`;
  return `#${uppercase ? digits.toUpperCase() : digits}`;
}

function replaceActiveHexColor(view: EditorView, current: ActiveHexColorAdjustment, value: string): void {
  if (!supportedHexColor.test(value)) return;
  if (view.state.doc.sliceString(current.from, current.to) !== current.value) {
    closeHexColorAdjustment(view);
    return;
  }
  view.dispatch({
    ...(value === current.value ? {} : { changes: { from: current.from, to: current.to, insert: value } }),
    effects: setActiveHexColorAdjustment.of(null),
    annotations: isolateHistory.of('full'),
    userEvent: 'change.color'
  });
}

function closeHexColorAdjustment(view: EditorView): void {
  view.dispatch({ effects: setActiveHexColorAdjustment.of(null) });
}

function createHexColorAdjustmentTooltip(active: ActiveHexColorAdjustment): Tooltip {
  return {
    pos: active.from,
    end: active.to,
    above: true,
    create(view) {
      const strings = getUiStrings(view.state.facet(uiLanguageFacet));
      const dom = document.createElement('div');
      dom.className = 'meo-hex-color-adjustment';
      dom.setAttribute('role', 'dialog');
      dom.setAttribute('aria-label', strings.colorControls(active.value));

      const header = document.createElement('div');
      header.className = 'meo-hex-color-adjustment-header';
      const preview = document.createElement('span');
      preview.className = 'meo-hex-color-adjustment-preview';
      preview.setAttribute('role', 'img');
      preview.setAttribute('aria-label', strings.colorControls(active.value));
      const originalPreviewFill = document.createElement('span');
      originalPreviewFill.className = 'meo-hex-color-adjustment-preview-fill is-original';
      originalPreviewFill.style.backgroundColor = active.value;
      const currentPreviewFill = document.createElement('span');
      currentPreviewFill.className = 'meo-hex-color-adjustment-preview-fill is-current';
      currentPreviewFill.style.backgroundColor = active.value;
      preview.append(originalPreviewFill, currentPreviewFill);
      const valueInput = document.createElement('input');
      valueInput.className = 'meo-hex-color-adjustment-value';
      valueInput.type = 'text';
      valueInput.spellcheck = false;
      valueInput.autocomplete = 'off';
      valueInput.setAttribute('aria-label', strings.hexColorValue);
      const closeButton = document.createElement('button');
      closeButton.className = 'meo-hex-color-adjustment-close';
      closeButton.type = 'button';
      closeButton.textContent = '×';
      closeButton.title = strings.closeColorControls;
      closeButton.setAttribute('aria-label', strings.closeColorControls);
      header.append(preview, valueInput, closeButton);

      const controls = document.createElement('div');
      controls.className = 'meo-hex-color-adjustment-controls';
      const makeRange = (labelText: string, min: number, max: number) => {
        const row = document.createElement('label');
        row.className = 'meo-hex-color-adjustment-row';
        const label = document.createElement('span');
        label.textContent = labelText;
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(min);
        input.max = String(max);
        input.step = '1';
        input.setAttribute('aria-label', labelText);
        const output = document.createElement('output');
        row.append(label, input, output);
        controls.appendChild(row);
        return { row, input, output };
      };
      const hue = makeRange(strings.hue, 0, 359);
      hue.input.classList.add('meo-hex-color-adjustment-hue');
      const saturation = makeRange(strings.saturation, 0, 100);
      const brightness = makeRange(strings.brightness, 0, 100);
      const opacity = makeRange(strings.opacity, 0, 255);
      opacity.input.classList.add('meo-hex-color-adjustment-opacity');
      const actions = document.createElement('div');
      actions.className = 'meo-hex-color-adjustment-actions';
      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.textContent = strings.cancelColorAdjustment;
      const applyButton = document.createElement('button');
      applyButton.type = 'button';
      applyButton.className = 'meo-hex-color-adjustment-apply';
      applyButton.textContent = strings.applyColorAdjustment;
      actions.append(cancelButton, applyButton);
      dom.append(header, controls, actions);

      const sourceSwatch = active.anchor?.isConnected ? active.anchor : view.dom.querySelector<HTMLButtonElement>(
        `.meo-md-color-swatch-interactive[data-color-from="${active.from}"]`
      );
      const currentSourceSwatch = () => active.anchor?.isConnected
        ? active.anchor
        : view.dom.querySelector<HTMLButtonElement>(
          `.meo-md-color-swatch-interactive[data-color-from="${active.from}"]`
        );
      let draftValue = active.value;
      // Explicitly typed width remains the opaque format after later slider adjustments.
      let includeAlphaWhenOpaque = active.value.length === 9;
      const syncPreview = (next: string, syncSliders: boolean) => {
        const parsed = parseHexColor(next);
        if (!parsed) return;
        draftValue = next;
        valueInput.value = draftValue;
        valueInput.removeAttribute('aria-invalid');
        applyButton.disabled = false;
        currentPreviewFill.style.backgroundColor = draftValue;
        if (sourceSwatch) sourceSwatch.style.backgroundColor = draftValue;
        if (syncSliders) {
          const hsv = rgbToHsv(parsed.rgb);
          hue.input.value = String(hsv.hue);
          saturation.input.value = String(hsv.saturation);
          brightness.input.value = String(hsv.brightness);
          opacity.input.value = String(parsed.alpha);
        }
        const currentHue = Number(hue.input.value);
        const currentSaturation = Number(saturation.input.value);
        const currentBrightness = Number(brightness.input.value);
        hue.output.textContent = `${currentHue}°`;
        saturation.output.textContent = `${currentSaturation}%`;
        brightness.output.textContent = `${brightness.input.value}%`;
        opacity.output.textContent = `${Math.round((Number(opacity.input.value) / 255) * 100)}%`;
        const fullSaturation = hsvToRgb({ hue: currentHue, saturation: 100, brightness: currentBrightness });
        const fullBrightness = hsvToRgb({ hue: currentHue, saturation: currentSaturation, brightness: 100 });
        const neutral = Math.round((currentBrightness / 100) * 255);
        const currentColor = `rgb(${parsed.rgb.red} ${parsed.rgb.green} ${parsed.rgb.blue})`;
        hue.input.style.setProperty('--meo-range-thumb-color', `rgb(${fullSaturation.red} ${fullSaturation.green} ${fullSaturation.blue})`);
        saturation.input.style.setProperty('--meo-range-start', `rgb(${neutral} ${neutral} ${neutral})`);
        saturation.input.style.setProperty('--meo-range-end', `rgb(${fullSaturation.red} ${fullSaturation.green} ${fullSaturation.blue})`);
        saturation.input.style.setProperty('--meo-range-thumb-color', currentColor);
        brightness.input.style.setProperty('--meo-range-end', `rgb(${fullBrightness.red} ${fullBrightness.green} ${fullBrightness.blue})`);
        brightness.input.style.setProperty('--meo-range-thumb-color', currentColor);
        opacity.input.style.setProperty('--meo-range-opaque', currentColor);
        opacity.input.style.setProperty('--meo-range-thumb-color', draftValue);
      };

      const updateFromControls = () => {
        const rgb = hsvToRgb({
          hue: Number(hue.input.value),
          saturation: Number(saturation.input.value),
          brightness: Number(brightness.input.value)
        });
        syncPreview(formatHexColor(
          rgb, Number(opacity.input.value), includeAlphaWhenOpaque || Number(opacity.input.value) < 255,
          usesUppercaseHex(draftValue)
        ), false);
      };
      const updateOpacity = () => {
        const parsed = parseHexColor(draftValue);
        if (!parsed) return;
        const alpha = Number(opacity.input.value);
        syncPreview(formatHexColor(
          parsed.rgb, alpha, includeAlphaWhenOpaque || alpha < 255, usesUppercaseHex(draftValue)
        ), false);
      };
      const apply = () => {
        if (applyButton.disabled) return;
        replaceActiveHexColor(view, active, draftValue);
        view.focus();
      };

      hue.input.addEventListener('input', updateFromControls);
      saturation.input.addEventListener('input', updateFromControls);
      brightness.input.addEventListener('input', updateFromControls);
      opacity.input.addEventListener('input', updateOpacity);
      valueInput.addEventListener('input', () => {
        const next = valueInput.value.trim();
        const valid = supportedHexColor.test(next);
        if (valid) valueInput.removeAttribute('aria-invalid');
        else valueInput.setAttribute('aria-invalid', 'true');
        applyButton.disabled = !valid;
        if (valid) {
          includeAlphaWhenOpaque = next.length === 9;
          syncPreview(next, true);
        }
      });
      valueInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          apply();
        }
      });
      closeButton.addEventListener('click', () => {
        closeHexColorAdjustment(view);
        view.focus();
      });
      cancelButton.addEventListener('click', () => {
        closeHexColorAdjustment(view);
        view.focus();
      });
      applyButton.addEventListener('click', apply);

      const onDocumentPointerDown = (event: PointerEvent) => {
        const target = event.target;
        if (target instanceof Node && (dom.contains(target) || (target instanceof Element && target.closest('.meo-md-color-swatch')))) return;
        closeHexColorAdjustment(view);
      };
      const onDocumentKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        closeHexColorAdjustment(view);
        view.focus();
      };
      const onWheel = (event: WheelEvent) => {
        if (event.ctrlKey || event.deltaY === 0) return;
        const multiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? view.defaultLineHeight
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? view.scrollDOM.clientHeight
            : 1;
        const before = view.scrollDOM.scrollTop;
        const delta = event.deltaY * multiplier;
        const target = clamp(before + delta, 0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight);
        if (target === before) return;
        view.scrollDOM.scrollBy({ top: delta, behavior: 'smooth' });
        event.preventDefault();
        event.stopPropagation();
      };
      let visibilityFrame = 0;
      const onEditorScroll = () => {
        if (visibilityFrame) return;
        visibilityFrame = requestAnimationFrame(() => {
          visibilityFrame = 0;
          const anchor = currentSourceSwatch();
          if (!anchor) {
            closeHexColorAdjustment(view);
            return;
          }
          const anchorBounds = anchor.getBoundingClientRect();
          const scrollBounds = view.scrollDOM.getBoundingClientRect();
          const tooltipSpace = hexColorTooltipSpace(view);
          const visible = anchorBounds.bottom > Math.max(scrollBounds.top, tooltipSpace.top) &&
            anchorBounds.top < Math.min(scrollBounds.bottom, tooltipSpace.bottom) &&
            anchorBounds.right > Math.max(scrollBounds.left, tooltipSpace.left) &&
            anchorBounds.left < Math.min(scrollBounds.right, tooltipSpace.right);
          if (!visible) closeHexColorAdjustment(view);
        });
      };

      syncPreview(active.value, true);
      return {
        dom,
        getCoords: () => currentSourceSwatch()?.getBoundingClientRect()
          ?? view.coordsAtPos(active.from)
          ?? view.dom.getBoundingClientRect(),
        mount() {
          document.addEventListener('pointerdown', onDocumentPointerDown, true);
          document.addEventListener('keydown', onDocumentKeyDown, true);
          dom.addEventListener('wheel', onWheel, { passive: false });
          view.scrollDOM.addEventListener('scroll', onEditorScroll, { passive: true });
          valueInput.focus();
        },
        destroy() {
          document.removeEventListener('pointerdown', onDocumentPointerDown, true);
          document.removeEventListener('keydown', onDocumentKeyDown, true);
          dom.removeEventListener('wheel', onWheel);
          view.scrollDOM.removeEventListener('scroll', onEditorScroll);
          if (visibilityFrame) cancelAnimationFrame(visibilityFrame);
          if (sourceSwatch?.isConnected && view.state.doc.sliceString(active.from, active.to) === active.value) {
            sourceSwatch.style.backgroundColor = active.value;
          }
        }
      };
    }
  };
}

const activeHexColorAdjustmentField = StateField.define<HexColorAdjustmentState | null>({
  create: () => null,
  update(value, transaction) {
    let next = transaction.docChanged || transaction.startState.facet(uiLanguageFacet) !== transaction.state.facet(uiLanguageFacet)
      ? null : value;
    for (const effect of transaction.effects) {
      if (effect.is(setActiveHexColorAdjustment)) {
        const range = effect.value;
        next = range && transaction.state.doc.sliceString(range.from, range.to) === range.value
          ? { range, tooltip: createHexColorAdjustmentTooltip(range) } : null;
      }
    }
    return next;
  },
  provide: (field) => showTooltip.from(field, (value) => value?.tooltip ?? null)
});

export function hexColorAdjustmentExtension(): Extension {
  return [
    tooltips({ tooltipSpace: hexColorTooltipSpace }),
    activeHexColorAdjustmentField
  ];
}

export function createColorSwatchElement(value: string, uiLanguage: UiLanguage = 'en'): HTMLSpanElement {
  const swatch = document.createElement('span');
  swatch.className = 'meo-md-color-swatch';
  swatch.style.backgroundColor = value;
  swatch.title = value;
  swatch.setAttribute('role', 'img');
  swatch.setAttribute('aria-label', getUiStrings(uiLanguage).colorLabel(value));
  return swatch;
}

/** The range must address the current document, including when rendered inside a table cell preview. */
export function createInteractiveColorSwatchElement(
  view: EditorView,
  range: HexColorRange
): HTMLButtonElement {
  const strings = getUiStrings(view.state.facet(uiLanguageFacet));
  const swatch = document.createElement('button');
  swatch.className = 'meo-md-color-swatch meo-md-color-swatch-interactive';
  swatch.type = 'button';
  swatch.style.backgroundColor = range.value;
  swatch.title = strings.adjustColor(range.value);
  swatch.dataset.colorValue = range.value;
  swatch.dataset.colorFrom = String(range.from);
  swatch.setAttribute('aria-label', strings.adjustColor(range.value));
  swatch.setAttribute('aria-haspopup', 'dialog');
  const openAdjustment = () => {
    view.dispatch({ effects: setActiveHexColorAdjustment.of({ ...range, anchor: swatch }) });
  };
  swatch.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    // Table selection finishes on pointerup and may refresh the cell preview
    // before click. Open while this button is still the authoritative anchor.
    openAdjustment();
  });
  swatch.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    // Keyboard and programmatic activation do not produce pointerdown.
    if (event.detail === 0) openAdjustment();
  });
  return swatch;
}

export class ColorSwatchWidget extends UiLanguageSensitiveWidget {
  readonly range: HexColorRange;

  constructor(range: HexColorRange) {
    super();
    this.range = range;
  }

  eq(other: WidgetType): boolean {
    return other instanceof ColorSwatchWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.range.from === this.range.from &&
      other.range.to === this.range.to &&
      other.range.value === this.range.value;
  }

  toDOM(view: EditorView): HTMLElement {
    return createInteractiveColorSwatchElement(view, this.range);
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export function addColorSwatchDecoration(
  ranges: Array<any>,
  colorRange: HexColorRange
): void {
  ranges.push(
    Decoration.widget({
      widget: new ColorSwatchWidget(colorRange),
      side: -1
    }).range(colorRange.from)
  );
}
