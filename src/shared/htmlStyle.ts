import { parse, type Container } from 'postcss';
import { isSafeHtmlStyleUrl, mapHtmlStyleUrls, htmlFontFaceName, namespaceHtmlFontFamilies, namespaceHtmlFontVariables } from './htmlStyleResources';

type StyleValidator = (value: string) => boolean;
export type HtmlStyleInspection = {
  style: string;
  unsupported: string[];
  invalid: string[];
  /** Local box/ink projection for HTML result discovery; rendering keeps source order. */
  properties: Readonly<Record<string, string>>;
};

const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const wide = /^(?:inherit|initial|unset|revert|revert-layer)$/i;
const namedColors = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent currentcolor').split(' '));

/** Delimiters inside a quoted family or color function belong to that value. */
function split(source: string, delimiter: ';' | ',' | '/' | ' '): string[] | null {
  const result: string[] = [];
  let start = 0, depth = 0, quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === '\\') { index += 1; continue; }
    if (/[{}<>\u0000]/.test(char) && delimiter !== ';') return null;
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(') depth += 1;
    else if (char === ')') { if (--depth < 0) { if (delimiter !== ';') return null; depth = 0; } }
    else if (!depth && (delimiter === ' ' ? /\s/.test(char) : char === delimiter)) {
      const part = source.slice(start, index).trim();
      if (part || delimiter !== ' ') result.push(part);
      start = index + 1;
    }
  }
  if ((quote || depth) && delimiter !== ';') return null;
  const final = source.slice(start).trim();
  if (final || delimiter !== ' ') result.push(final);
  return result;
}

function length(value: string, percent = true, negative = false): boolean {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(px|em|rem|ex|ch|lh|rlh|cm|mm|q|in|pt|pc|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max)|%)?$/i.exec(value);
  return Boolean(match && Number.isFinite(+match[1]!) && (negative || +match[1]! >= 0)
    && (match[2] ? percent || match[2] !== '%' : +match[1]! === 0));
}
const scalar = (value: string): boolean => number.test(value) && Number.isFinite(+value);
const percent = (value: string): boolean => value.endsWith('%') && scalar(value.slice(0, -1));
const keywords = (words: string): StyleValidator => {
  const values = new Set(words.split(' '));
  return value => values.has(value.toLowerCase());
};
const sequence = (validate: StyleValidator, maximum: number): StyleValidator => value => {
  const values = split(value, ' ');
  return Boolean(values?.length && values.length <= maximum && values.every(validate));
};
const color: StyleValidator = value => {
  if (/^(?:oklch|oklab|lch|lab|color|color-mix|light-dark|hwb)\(/i.test(value)) return safeValue(value);
  if (namedColors.has(value.toLowerCase()) || /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return true;
  const match = /^(rgba?|hsla?)\(([^()]*)\)$/i.exec(value);
  if (!match) return false;
  const body = match[2]!, comma = body.includes(',');
  const parts = split(body, comma ? ',' : '/');
  if (!parts || parts.some(part => !part)) return false;
  const components = comma ? parts.slice(0, 3) : split(parts[0]!, ' ');
  const alpha = comma ? parts[3] : parts[1];
  if (!components || components.length !== 3 || parts.length > (comma ? 4 : 2)
    || comma && parts.length < 3 || alpha !== undefined && !scalar(alpha) && !percent(alpha)) return false;
  if (/^rgb/i.test(match[1]!)) return components.every(component => scalar(component) || percent(component))
    && (!comma || components.every(percent) || components.every(scalar));
  return /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:deg|grad|rad|turn)?$/i.test(components[0]!)
    && components.slice(1).every(percent);
};
const borderStyle = keywords('none hidden dotted dashed solid double groove ridge inset outset');
const widthKeyword = keywords('thin medium thick');
const borderWidth: StyleValidator = value => widthKeyword(value) || length(value, false);
function border(value: string): { width: string; style: string; color: string } | null {
  const values = split(value, ' ');
  if (!values?.length || values.length > 3) return null;
  const result = { width: 'medium', style: 'none', color: 'currentcolor' };
  const assigned = new Set<string>();
  for (const value of values) {
    const key = borderWidth(value) ? 'width' : borderStyle(value) ? 'style' : color(value) ? 'color' : null;
    if (!key || assigned.has(key)) return null;
    result[key] = value; assigned.add(key);
  }
  return result;
}
const line = keywords('underline overline line-through');
const decorationStyle = keywords('solid double dotted dashed wavy');
const thickness: StyleValidator = value => keywords('auto from-font')(value) || length(value);
const decoration: StyleValidator = value => {
  const values = split(value, ' '), used = new Set<string>();
  if (!values?.length || values.length > 6) return false;
  for (const value of values) {
    const key = line(value) || value.toLowerCase() === 'none' ? value.toLowerCase()
      : decorationStyle(value) ? 'style' : color(value) ? 'color' : thickness(value) ? 'thickness' : '';
    if (!key || used.has(key)) return false;
    used.add(key);
  }
  return !used.has('none') || !values.some(line);
};
const listType = keywords('none disc circle square decimal decimal-leading-zero lower-roman upper-roman lower-alpha upper-alpha lower-latin upper-latin lower-greek armenian georgian cjk-ideographic hiragana katakana hiragana-iroha katakana-iroha');
const listPosition = keywords('inside outside');
const sides = ['top', 'right', 'bottom', 'left'];
const logicalSides: Record<string, string> = { 'block-start': 'top', 'block-end': 'bottom', 'inline-start': 'left', 'inline-end': 'right' };
const margin: StyleValidator = value => value.toLowerCase() === 'auto' || length(value, true, true);
const safeValue: StyleValidator = value => {
  if (!value.length || /[\\{}<>\u0000]/.test(value) || /(?:expression|image-set|paint)\s*\(|@|(?:--(?:meo|vscode)-)/i.test(value)) return false;
  let safe = true;
  mapHtmlStyleUrls(value, url => { safe &&= isSafeHtmlStyleUrl(url); return url; });
  return safe;
};
const calculation: StyleValidator = value => /^(?:calc|min|max|clamp|var)\(/i.test(value) && safeValue(value)
  && split(value, ' ') !== null;
const rules: Record<string, StyleValidator> = {
  color, background: color, 'background-color': color,
  'font-family': value => {
    const families = split(value, ',');
    return Boolean(families?.length && families.every(family => /^(["'])[\p{L}\p{N}\s_.,;:-]+\1$/u.test(family)
      || /^[\p{L}_-][\p{L}\p{N}_-]*(?:\s+[\p{L}_-][\p{L}\p{N}_-]*)*$/u.test(family)));
  },
  'font-size': value => length(value) || keywords('xx-small x-small small medium large x-large xx-large xxx-large smaller larger')(value),
  'font-weight': value => keywords('normal bold bolder lighter')(value) || scalar(value) && +value >= 1 && +value <= 1000,
  'font-style': keywords('normal italic oblique'),
  'font-variant': keywords('normal small-caps'),
  'line-height': value => value.toLowerCase() === 'normal' || length(value) || scalar(value) && +value >= 0,
  'letter-spacing': value => value.toLowerCase() === 'normal' || length(value, false, true),
  'word-spacing': value => value.toLowerCase() === 'normal' || length(value, true, true),
  'text-indent': value => length(value, true, true),
  'text-align': keywords('left center right justify start end match-parent'),
  'text-align-last': keywords('auto left center right justify start end'),
  'text-transform': keywords('none capitalize uppercase lowercase full-width full-size-kana'),
  'text-decoration': decoration,
  'text-decoration-line': value => value.toLowerCase() === 'none' || sequence(line, 3)(value) && new Set(split(value.toLowerCase(), ' ')!).size === split(value, ' ')!.length,
  'text-decoration-color': color, 'text-decoration-style': decorationStyle, 'text-decoration-thickness': thickness,
  'text-underline-offset': value => value.toLowerCase() === 'auto' || length(value, true, true),
  'text-decoration-skip-ink': keywords('auto none all'),
  'white-space': keywords('normal nowrap pre pre-wrap pre-line break-spaces'),
  'vertical-align': value => keywords('baseline sub super top middle bottom text-top text-bottom')(value) || length(value, true, true),
  'overflow-wrap': keywords('normal break-word anywhere'), 'word-break': keywords('normal break-all keep-all break-word'),
  'hyphens': keywords('none manual auto'),
  'tab-size': value => length(value, false) || scalar(value) && +value >= 0,
  display: keywords('none block inline inline-block flow-root flex inline-flex grid inline-grid contents table inline-table table-row table-cell table-row-group table-header-group table-footer-group table-column table-column-group table-caption list-item'), visibility: keywords('visible hidden collapse'),
  opacity: value => scalar(value) && +value >= 0 && +value <= 1 || percent(value) && +value.slice(0, -1) >= 0 && +value.slice(0, -1) <= 100,
  'box-sizing': keywords('content-box border-box'),
  'fill-rule': keywords('nonzero evenodd'), 'clip-rule': keywords('nonzero evenodd'),
  'list-style-type': listType, 'list-style-position': listPosition,
  'list-style': value => {
    const values = split(value, ' ');
    return Boolean(values?.length && values.length <= 2 && values.every(part => listType(part) || listPosition(part))
      && values.filter(listType).length <= 1 && values.filter(listPosition).length <= 1);
  },
  'border-collapse': keywords('collapse separate'),
  'border-spacing': sequence(value => length(value, false), 2),
  'caption-side': keywords('top bottom'), 'empty-cells': keywords('show hide'),
  'object-fit': keywords('fill contain cover none scale-down'),
  'object-position': value => {
    const values = split(value, ' ');
    if (!values?.length || values.length > 2) return false;
    const axis = (value: string, horizontal: boolean) => length(value, true, true) || keywords(horizontal ? 'left center right' : 'top center bottom')(value);
    return values.length === 1 ? axis(values[0]!, true) || axis(values[0]!, false)
      : axis(values[0]!, true) && axis(values[1]!, false) || axis(values[1]!, true) && axis(values[0]!, false);
  },
  'aspect-ratio': value => {
    const ratio = value.replace(/^auto\s+/i, '');
    const values = split(ratio, '/');
    return value.toLowerCase() === 'auto' || Boolean(values?.length && values.length <= 2 && values.every(part => scalar(part) && +part > 0));
  },
  'border-radius': value => {
    const values = split(value, '/');
    return Boolean(values?.length && values.length <= 2 && values.every(sequence(value => length(value), 4)));
  }
};
// Values for these browser-native layout/paint properties stay declarations,
// rather than becoming a second CSS layout engine in either renderer.
for (const name of ('flex flex-basis flex-grow flex-shrink flex-direction flex-wrap flex-flow order gap row-gap column-gap '
  + 'align-content align-items align-self justify-content justify-items justify-self place-content place-items place-self '
  + 'grid grid-template grid-template-columns grid-template-rows grid-template-areas grid-auto-columns grid-auto-rows grid-auto-flow '
  + 'grid-area grid-column grid-row grid-column-start grid-column-end grid-row-start grid-row-end '
  + 'box-shadow text-shadow background-image background-size background-position background-repeat background-clip background-origin '
  + 'outline outline-width outline-style outline-color outline-offset float clear columns column-count column-width column-rule '
  + 'break-before break-after break-inside page-break-before page-break-after page-break-inside '
  + 'cursor user-select appearance accent-color caret-color color-scheme fill stroke stroke-width fill-opacity stroke-opacity text-anchor').split(' ')) rules[name] = safeValue;
rules.position = keywords('static relative absolute sticky');
for (const name of ['top', 'right', 'bottom', 'left', 'inset', 'inset-inline', 'inset-block']) rules[name] = safeValue;
rules['z-index'] = value => value === 'auto' || /^-?\d+$/.test(value);
rules.background = value => color(value) || /(?:gradient|url)\(/i.test(value) && safeValue(value);
for (const name of ('font font-stretch font-kerning font-feature-settings font-variation-settings font-optical-sizing '
  + 'transform transform-origin transform-box translate rotate scale filter backdrop-filter '
  + 'overflow overflow-x overflow-y overflow-clip-margin text-overflow white-space-collapse text-wrap text-wrap-mode text-wrap-style '
  + 'writing-mode text-orientation direction unicode-bidi content quotes counter-reset counter-increment counter-set '
  + 'list-style-image clip-path mask mask-image mask-size mask-position mask-repeat '
  + 'stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit fill-rule clip-rule '
  + 'border-start-start-radius border-start-end-radius border-end-start-radius border-end-end-radius').split(' ')) rules[name] ??= safeValue;
for (const axis of ['width', 'height', 'inline-size', 'block-size']) {
  for (const prefix of ['', 'min-', 'max-']) rules[prefix + axis] = value => length(value)
    || keywords(`${prefix === 'max-' ? 'none' : 'auto'} min-content max-content fit-content`)(value);
}
for (const kind of ['margin', 'padding']) {
  const validate = kind === 'margin' ? margin : (value: string) => length(value);
  rules[kind] = sequence(validate, 4);
  for (const side of [...sides, ...Object.keys(logicalSides)]) rules[`${kind}-${side}`] = validate;
  for (const axis of ['inline', 'block']) rules[`${kind}-${axis}`] = sequence(validate, 2);
}
for (const side of ['', ...sides, 'inline', 'block', ...Object.keys(logicalSides)]) {
  const name = side ? `border-${side}` : 'border';
  rules[name] = value => border(value) !== null;
  for (const [kind, validate] of Object.entries({ width: borderWidth, style: borderStyle, color })) {
    rules[`${name}-${kind}`] = sequence(validate, side === '' ? 4 : side === 'inline' || side === 'block' ? 2 : 1);
  }
}
for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) rules[`border-${corner}-radius`] = sequence(value => length(value), 2);

// Raw author declarations always pass inspectHtmlStyle before the final export
// sanitizer. This derived pass-list preserves those validated values alongside
// trusted renderer styles (KaTeX/Shiki); it is not an author-value validator.
export const htmlSanitizedStyleRules: Record<string, RegExp[]> = Object.fromEntries(
  Object.keys(rules).map(name => [name, [/^[^{}<>\\!]+$/]])
);

function boxProjection(properties: Record<string, string>, name: string, value: string, direction: 'ltr' | 'rtl'): void {
  properties[name] = value;
  if (name === 'background') {
    const lastLayer = split(value, ',')?.at(-1) ?? '';
    properties['background-color'] = wide.test(value) ? value : split(lastLayer, ' ')?.find(color) ?? 'transparent';
    properties['background-image'] = value;
    return;
  }
  const physical = (side: string): string => side === 'inline-start' ? direction === 'rtl' ? 'right' : 'left'
    : side === 'inline-end' ? direction === 'rtl' ? 'left' : 'right' : logicalSides[side] ?? side;
  const targets = (side: string): string[] => side === '' ? sides : side === 'block' ? ['top', 'bottom']
    : side === 'inline' ? [physical('inline-start'), physical('inline-end')] : [physical(side)];
  const distribute = (names: string[], values: string[], prefix: string, suffix = '') => {
    const expanded = names.length === 4 ? [values[0], values[1] ?? values[0], values[2] ?? values[0], values[3] ?? values[1] ?? values[0]]
      : names.map((_name, index) => values[index] ?? values[0]);
    names.forEach((side, index) => { properties[`${prefix}-${side}${suffix}`] = expanded[index]!; });
  };
  const spacing = /^(margin|padding)(?:-(.+))?$/.exec(name);
  if (spacing) { distribute(targets(spacing[2] ?? ''), wide.test(value) ? [value] : split(value, ' ')!, spacing[1]!); return; }
  const edge = /^border(?:-(top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?(?:-(width|style|color))?$/.exec(name);
  if (!edge) return;
  const names = targets(edge[1] ?? '');
  if (edge[2]) distribute(names, wide.test(value) ? [value] : split(value, ' ')!, 'border', `-${edge[2]}`);
  else {
    const components = wide.test(value) ? { width: value, style: value, color: value } : border(value);
    if (components) for (const [kind, component] of Object.entries(components)) distribute(names, [component], 'border', `-${kind}`);
  }
}

/** Document formatting only; source order, including duplicate declarations, is CSS semantics. */
export function inspectHtmlStyle(source: string, direction: 'ltr' | 'rtl' = 'ltr'): HtmlStyleInspection {
  // Comments separate CSS tokens; quoted family names retain their literal text.
  const withoutComments = source.replace(/(["'])(?:[^\\]|\\.)*?\1|\/\*[\s\S]*?\*\//g,
    value => value.startsWith('/*') ? ' ' : value);
  const declarations: string[] = [], properties: Record<string, string> = Object.create(null);
  const unsupported = new Set<string>(), invalid = new Set<string>(), priorities = new Set<string>();
  for (const declaration of split(withoutComments, ';') ?? [withoutComments]) {
    const colon = declaration.indexOf(':');
    if (colon < 0) { if (declaration.trim()) invalid.add(declaration.trim().split(/\s+/)[0]!); continue; }
    const rawName = declaration.slice(0, colon).trim();
    const name = rawName.startsWith('--') ? rawName : rawName.toLowerCase();
    const rawValue = declaration.slice(colon + 1).trim();
    const important = /!\s*important\s*$/i.test(rawValue);
    const value = rawValue.replace(/!\s*important\s*$/i, '').trim();
    const custom = /^--[a-z][\w-]*$/i.test(name) && !/^--(?:meo|vscode)-/i.test(name);
    const validate = custom ? safeValue : Object.hasOwn(rules, name) ? rules[name] : undefined;
    if (validate && !/[!\\{}<>\u0000]/.test(value) && (wide.test(value) || validate(value) || calculation(value))) {
      const rendered = name === 'font-family' ? namespaceHtmlFontFamilies(value)
        : name === 'font' ? value.replace(/(\b(?:\d*\.)?\d+(?:px|pt|pc|em|rem|%)(?:\s*\/\s*[\w.%]+)?\s+)(.+)$/i,
          (_match, prefix: string, family: string) => prefix + namespaceHtmlFontFamilies(family)) : value;
      declarations.push(`${name}: ${rendered}${important ? ' !important' : ''}`);
      const projection: Record<string, string> = Object.create(null);
      boxProjection(projection, name, value, direction);
      for (const [property, projected] of Object.entries(projection)) {
        if (important || !priorities.has(property)) properties[property] = projected;
        if (important) priorities.add(property);
      }
    } else (validate ? invalid : unsupported).add(name);
  }
  let style = declarations.join('; ');
  if (declarations.some(declaration => /^font-family:\s*var\(/.test(declaration))) {
    const sheet = parse(`x{${style}}`);
    namespaceHtmlFontVariables(sheet);
    style = sheet.first!.toString().slice(2,-1);
  }
  return { style, unsupported: [...unsupported], invalid: [...invalid], properties };
}

export function sanitizeHtmlStyle(source: string): string { return inspectHtmlStyle(source).style; }

/** Native CSS scope limits author selectors to document content, including
 * styles whose source block is outside a virtualized reading window. */
export function sanitizeHtmlStylesheet(source: string): string {
  try {
    const sheet = parse(source);
    namespaceHtmlFontVariables(sheet);
    type CssNode = NonNullable<Container['nodes']>[number];
    const imports = new Map<CssNode, string>(), fonts: string[] = [];
    const importOrder: CssNode[] = [], permittedImports = new Set<CssNode>();
    let acceptsImports = true;
    for (const node of [...sheet.nodes]) {
      if (node.type === 'comment' || node.type === 'atrule' && /^charset$/i.test(node.name)) continue;
      if (node.type === 'atrule' && /^layer$/i.test(node.name) && !node.nodes && acceptsImports && /^[\w.,\s-]+$/.test(node.params)) {
        imports.set(node,node.toString()); importOrder.push(node); node.remove(); continue;
      }
      if (node.type === 'atrule' && /^import$/i.test(node.name) && acceptsImports) { permittedImports.add(node); importOrder.push(node); }
      else acceptsImports = false;
    }
    const clean = (container: Container): void => {
      for (const node of [...(container.nodes ?? [])]) {
        if (node.type === 'comment') node.remove();
        else if (node.type === 'atrule') {
          if (/^import$/i.test(node.name)) {
            const match = /^(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)|"([^"]*)"|'([^']*)')(?:\s+([\s\S]*))?$/.exec(node.params);
            const url = match && (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]);
            if (permittedImports.has(node) && url && isSafeHtmlStyleUrl(url) && !/[{}<>\\]/.test(match![6] ?? '')) imports.set(node,`@meo-import ${JSON.stringify(url)}${match![6] ? ' ' + match![6] : ''};`);
            node.remove();
          } else if (/^font-face$/i.test(node.name)) {
            for (const child of [...(node.nodes ?? [])]) {
              if (child.type !== 'decl' || !/^(?:font-family|src|font-style|font-weight|font-stretch|font-display|unicode-range|size-adjust|ascent-override|descent-override|line-gap-override)$/i.test(child.prop) || !safeValue(child.value) || child.important) child.remove();
              else {
                child.prop = child.prop.toLowerCase();
                if (child.prop === 'font-family') child.value = `"${htmlFontFaceName(child.value)}"`;
              }
            }
            if (node.nodes?.some(child => child.type === 'decl' && child.prop === 'src')) {
              let font = node.toString(), parent = node.parent;
              while (parent?.type === 'atrule') {
                const condition = parent as import('postcss').AtRule;
                font = `@${condition.name} ${condition.params}{${font}}`;
                parent = parent.parent;
              }
              fonts.push(font);
            }
            node.remove();
          } else if (/^layer$/i.test(node.name) && !node.nodes && /^[\w.,\s-]+$/.test(node.params)) continue;
          else if (!/^(?:media|supports|container|layer|scope)$/i.test(node.name) || !node.nodes
            || /[{}<>\\]|url\s*\(/i.test(node.params)) node.remove();
          else clean(node);
        } else if (node.type === 'rule') {
          if (/[{}<>\\]|@|:host|::slotted|\b(?:cm-|meo-)|\bdata-(?:meo-|source-)/i.test(node.selector)) { node.remove(); continue; }
          node.selector = node.selector.replace(/:root\b|(^|[\s>,+~(])(?:html|body)(?=$|[\s>,+~.#[:)])/gi,
            (_match, prefix: string | undefined) => `${prefix ?? ''}:scope`)
            .replace(/:scope(?:\s*>\s*|\s+):scope/g, ':scope');
          clean(node);
          if (!node.nodes?.length) node.remove();
        } else if (node.type === 'decl') {
          if (!node.prop.startsWith('--')) node.prop = node.prop.toLowerCase();
          const accepted = inspectHtmlStyle(`${node.prop}:${node.value}`).style;
          if (!accepted) node.remove();
          else if (/^(?:font|font-family)$/.test(node.prop)) node.value = accepted.slice(accepted.indexOf(':') + 1).trim();
        }
      }
    };
    clean(sheet);
    const css = sheet.toString();
    return importOrder.map(node => imports.get(node) ?? '').join('\n') + fonts.join('\n') + (css.trim() ? `@scope (.meo-export-doc, .cm-content) to (.meo-md-html-source-range, .meo-md-html-invisible-source, .meo-md-html-result-status, .meo-md-block-header, .meo-md-html-comment, .meo-preview-code-copy, .meo-source-format-btn) {${css}}` : '');
  } catch { return ''; }
}
