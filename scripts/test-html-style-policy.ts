import assert from 'node:assert/strict';
import { inspectHtmlStyle, sanitizeHtmlStyle } from '../src/shared/htmlPolicy';

export function checkHtmlStylePolicy(): void {
  const supported: Record<string, string[]> = {
    border: ['3px', 'solid', 'red', '3px solid red', 'rgb(10 20 30 / 50%) dashed .1em', '0'],
    'border-left': ['thick double rebeccapurple'], 'border-block': ['2pt solid #1234'],
    'border-inline-end-width': ['1.5px'], 'border-width': ['1px 2pt 0 .25em'],
    'border-style': ['solid dashed none double'], 'border-color': ['red rgb(1, 2, 3) transparent #aabbccdd'],
    'border-radius': ['12px', '1em 2em 3em 4em / 10% 20%'], 'border-top-left-radius': ['2px 10%'],
    margin: ['0 auto', '-1em 2px .5rem auto'], 'margin-inline': ['auto', '2em 3em'],
    'margin-block-start': ['-.25em'], padding: ['1cm 2mm 3pt 4px'], 'padding-inline': ['1ch 2%'],
    width: ['80%', '0.0', '20vw', 'max-content'], 'max-width': ['none'], 'min-height': ['auto'],
    'inline-size': ['40ch'], 'min-block-size': ['10lh'], 'box-sizing': ['border-box'],
    'font-family': ['"Noto Sans CJK SC", serif', "'Example; Family', monospace", 'system-ui, sans-serif', '宋体, serif'],
    'font-size': ['large', 'smaller', '12pt'], 'font-weight': ['450', '562.5', 'bolder'],
    'font-variant': ['small-caps'], 'line-height': ['1.6', '150%', 'normal'],
    'letter-spacing': ['-.05em'], 'word-spacing': ['.2em'], 'text-indent': ['2em'],
    'text-transform': ['uppercase'], 'text-align': ['start'], 'text-align-last': ['justify'],
    'text-decoration': ['underline wavy red 2px', 'red double overline underline', 'none'],
    'text-decoration-thickness': ['from-font', '10%'], 'text-underline-offset': ['.2em'],
    'text-decoration-line': ['underline overline'], 'overflow-wrap': ['anywhere'], 'word-break': ['keep-all'],
    'white-space': ['nowrap'], 'hyphens': ['auto'], 'tab-size': ['4', '2em'],
    'vertical-align': ['-.2em'], opacity: ['.5', '50%'],
    'list-style': ['upper-roman inside', 'outside square', 'none'], 'list-style-type': ['decimal-leading-zero'],
    'border-collapse': ['collapse'], 'border-spacing': ['2px 4pt'],
    'caption-side': ['bottom'], 'empty-cells': ['hide'], 'object-fit': ['cover'],
    'object-position': ['right top', '25% 75%', 'center'], 'aspect-ratio': ['16 / 9', '1', 'auto 4 / 3'],
    color: ['#1234', 'rgba(10, 20, 30, .5)', 'hsl(120deg 50% 20% / .2)', 'currentColor'],
    'background-color': ['transparent'], background: ['#fff'],
  };
  let checks = 0;
  for (const [name, values] of Object.entries(supported)) for (const value of [...values, 'inherit', 'initial', 'unset']) {
    const result = inspectHtmlStyle(`${name}:${value}`);
    assert.equal(result.style, `${name}: ${value}`, `${name}:${value}`);
    assert.deepEqual([result.invalid, result.unsupported], [[], []]); checks += 1;
  }
  for (const source of ['border:2px solid dotted', 'border:2px 4px solid', 'border:-1px solid red', 'border-color:imaginarycolor',
    'border-radius:-1px', 'padding:-1px', 'padding:1px 2px 3px 4px 5px', 'width:5', 'width:none',
    'border-width:2%', 'font-weight:1001', 'font-weight:0', 'text-decoration:underline underline',
    'text-decoration:none underline', 'border-spacing:2px -1px', 'aspect-ratio:1/0',
    'object-position:left right', 'font-family:url(https://example.com/font)', 'color:rgb(bad)',
    'background:url(https://example.com/image)', 'color:var(--vscode-editor-foreground)',
    'width:calc(100% - 1px)', 'margin:clamp(0px,1vw,10px)', 'color:red !important', 'color:r\\65 d']) {
    const result = inspectHtmlStyle(source);
    assert.equal(result.style, '', source); assert.equal(result.invalid.length, 1, source); checks += 1;
  }
  for (const name of ['position', 'left', 'z-index', 'animation', 'transition', 'filter', 'background-image', 'table-layout', '--custom', 'constructor', '__proto__']) {
    assert.deepEqual(inspectHtmlStyle(`${name}:bad`).unsupported, [name]); checks += 1;
  }
  const ordered = 'border: 1px solid red; border-left: 4px dashed blue; border: 2px dotted green; border-top-width: 5px';
  const border = inspectHtmlStyle(ordered);
  assert.equal(border.style, ordered, 'duplicate declarations must retain their cascade position');
  assert.equal(border.properties['border-left-width'], '2px');
  assert.equal(border.properties['border-left-style'], 'dotted');
  assert.equal(border.properties['border-top-width'], '5px');
  assert.equal(inspectHtmlStyle('background:red;background-color:blue;background:transparent').properties['background-color'], 'transparent');
  assert.equal(inspectHtmlStyle('margin:1px 2px;margin-left:3px;margin:4px').properties['margin-left'], '4px');
  assert.equal(inspectHtmlStyle('border-left:solid;border-inline-start:none', 'rtl').properties['border-left-style'], 'solid');
  assert.equal(inspectHtmlStyle('border-left:solid;border-inline-start:none', 'ltr').properties['border-left-style'], 'none');
  assert.equal(sanitizeHtmlStyle('color:red; border:solid('), 'color: red', 'an incomplete declaration must not discard its accepted prefix');
  assert.equal(sanitizeHtmlStyle('color:/* note */red; padding:2px'), 'color: red; padding: 2px');
  assert.equal(sanitizeHtmlStyle('color:red;color:bad'), 'color: red', 'an invalid later value must not reset an accepted value');
  console.log(`HTML style policy: ${checks} value checks, declaration order, logical sides and invalid-source recovery passed`);
}

if (import.meta.main) checkHtmlStylePolicy();
