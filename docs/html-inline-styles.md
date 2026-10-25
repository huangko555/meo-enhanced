# HTML inline styles

Live and the default Preview share the document-formatting rules in
[`htmlStyle.ts`](../src/shared/htmlStyle.ts), through the HTML policy entry point.
The same filtering applies to HTML source in the ordinary export pipeline.
GitHub README retains its separate HTML compatibility policy, which removes
author inline styles. A custom preset can also impose its own presentation.

Filtering affects the rendered result, never the Markdown source. Live reports
unsupported properties and invalid values through its existing HTML warning.
Tag and attribute completion continues to use the shared HTML language support;
there is no separate CSS property completion catalog to synchronize.

| Formatting | Supported properties and common values |
| --- | --- |
| Border | `border`, physical sides, `border-inline`/`border-block` and their start/end sides; `width`, `style`, and `color` longhands; one-to-four-value physical shorthands |
| Corners | `border-radius`, including elliptical radii separated by `/`, and the four physical corner properties |
| Spacing | `margin`, `padding`, physical sides, logical inline/block pairs and start/end sides; negative margins and `auto` margins are accepted; padding is nonnegative |
| Size | Physical and logical width/height, min/max variants, `box-sizing`; nonnegative lengths/percentages and applicable `auto`, `none`, `min-content`, `max-content`, `fit-content` keywords |
| Text | Literal `font-family` lists, `font-size`, `font-weight` (1–1000), `font-style`, `font-variant:normal/small-caps`, `line-height`, letter/word spacing, text indent, alignment, case and white space |
| Decoration | `text-decoration`, line/color/style/thickness longhands, underline offset and skip-ink |
| Wrapping | `overflow-wrap`, `word-break`, `hyphens`, `tab-size`, `text-align-last`, length/percentage `vertical-align` |
| Lists | Common built-in `list-style-type` values, `list-style-position`, and their image-free shorthand |
| Tables | `border-collapse`, `border-spacing`, `caption-side`, `empty-cells`; cell borders and padding use the same rules |
| Images | `object-fit`, common one/two-component `object-position`, `aspect-ratio`; image sizing remains with the existing image owner |
| Ink and visibility | `color`, `background-color`, color-only `background`, limited `display`, `visibility`, `opacity` including percentages |

These properties accept `inherit`, `initial` and `unset`. Supported lengths use
`px`, `em`, `rem`, `ex`, `ch`, `lh`, `rlh`, `cm`, `mm`, `q`, `in`, `pt`, `pc`,
`vw`, `vh`, `vmin`, `vmax`, and percentages where the property allows them.
Unitless zero is valid. Colors accept named colors, transparent/current color,
3/4/6/8-digit hex, and ordinary comma or space-form `rgb`/`rgba`/`hsl`/`hsla`.

## Examples and CSS semantics

```html
<div style="border:3px solid #3b82f6;border-radius:8px;padding:12px 16px;margin:0 auto;max-width:32em">
  <p style="line-height:1.6;text-indent:2em">Document text</p>
</div>
```

`border:3px` sets a width but resets the omitted line style to `none`, so it does
not create a visible border. Use `border:3px solid` or a separate `border-style`.
Declarations retain their original order, including duplicates: later valid
shorthands and longhands override earlier values according to browser CSS rules.
Invalid declarations do not replace accepted earlier values.
See the [CSS border specification](https://www.w3.org/TR/css-backgrounds-3/#border-shorthands).

Empty containers with visible borders or a sized/padded background render as
results in Live. Width-only borders and fully transparent empty boxes keep the
existing source-only presentation. Preview does not add editing UI.

Rendered tables continue to use the existing column-fitting owner. It fits the
actual parent container's content width, including authored padding. Table and
column widths, min/max widths and `table-layout` remain subject to that fit;
`table-layout` is not an author-controlled property in this policy.

## Deliberately outside this subset

This is a document-formatting subset, not an embedded webpage engine. It does
not enable positioning/offsets/z-index, Flex/Grid/multicolumn layout, clipping or
internal scrolling, vertical writing, animation/transitions, filters, gradients,
shadows, CSS computation functions, custom properties, editor variables,
`url()`, stylesheet imports, font loading, selectors, `<style>` or `!important`.
Source can retain these declarations; they are omitted from the rendered result.
Font lists select already available fonts and never load a font resource.

Style changes follow the existing HTML block and geometry consumers. No polling,
per-element scheduler, whole-document style scan or second layout engine is added.
