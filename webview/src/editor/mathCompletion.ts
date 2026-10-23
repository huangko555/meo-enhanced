import type { EditorState } from '@codemirror/state';

export type MathCompletion = {
  readonly label: string;
  readonly zh: string;
  readonly en: string;
  readonly insert: string;
  /** Fixed menu example, independent of the document and never inserted. */
  readonly preview: string;
  readonly fields: readonly number[];
  readonly environment?: string;
};

// Command names follow the KaTeX supported-functions reference. Templates are
// maintained here and checked against the project's installed KaTeX version.
// https://katex.org/docs/supported.html
const symbols: readonly [string, string, string][] = [
  ['alpha', 'α · 阿尔法', 'α · alpha'], ['beta', 'β · 贝塔', 'β · beta'],
  ['gamma', 'γ · 伽马', 'γ · gamma'], ['delta', 'δ · 德尔塔', 'δ · delta'],
  ['epsilon', 'ϵ · 艾普西龙', 'ϵ · epsilon'], ['varepsilon', 'ε · 艾普西龙变体', 'ε · epsilon variant'],
  ['zeta', 'ζ · 泽塔', 'ζ · zeta'], ['eta', 'η · 伊塔', 'η · eta'],
  ['theta', 'θ · 西塔', 'θ · theta'], ['vartheta', 'ϑ · 西塔变体', 'ϑ · theta variant'],
  ['iota', 'ι · 约塔', 'ι · iota'], ['kappa', 'κ · 卡帕', 'κ · kappa'],
  ['lambda', 'λ · 兰姆达', 'λ · lambda'], ['mu', 'μ · 缪', 'μ · mu'],
  ['nu', 'ν · 纽', 'ν · nu'], ['xi', 'ξ · 克西', 'ξ · xi'],
  ['pi', 'π · 派', 'π · pi'], ['varpi', 'ϖ · 派变体', 'ϖ · pi variant'],
  ['rho', 'ρ · 柔', 'ρ · rho'], ['sigma', 'σ · 西格玛', 'σ · sigma'],
  ['tau', 'τ · 陶', 'τ · tau'], ['upsilon', 'υ · 宇普西龙', 'υ · upsilon'],
  ['phi', 'ϕ · 斐', 'ϕ · phi'], ['varphi', 'φ · 斐变体', 'φ · phi variant'],
  ['chi', 'χ · 希', 'χ · chi'], ['psi', 'ψ · 普西', 'ψ · psi'], ['omega', 'ω · 欧米伽', 'ω · omega'],
  ['Gamma', 'Γ · 大写伽马', 'Γ · capital gamma'], ['Delta', 'Δ · 大写德尔塔', 'Δ · capital delta'],
  ['Theta', 'Θ · 大写西塔', 'Θ · capital theta'], ['Lambda', 'Λ · 大写兰姆达', 'Λ · capital lambda'],
  ['Xi', 'Ξ · 大写克西', 'Ξ · capital xi'], ['Pi', 'Π · 大写派', 'Π · capital pi'],
  ['Sigma', 'Σ · 大写西格玛', 'Σ · capital sigma'], ['Upsilon', 'Υ · 大写宇普西龙', 'Υ · capital upsilon'],
  ['Phi', 'Φ · 大写斐', 'Φ · capital phi'], ['Psi', 'Ψ · 大写普西', 'Ψ · capital psi'],
  ['Omega', 'Ω · 大写欧米伽', 'Ω · capital omega'],
  ['infty', '∞ · 无穷', '∞ · infinity'], ['partial', '∂ · 偏导', '∂ · partial derivative'],
  ['nabla', '∇ · 梯度', '∇ · nabla'], ['ell', 'ℓ · 花体 l', 'ℓ · script l'],
  ['hbar', 'ℏ · 约化普朗克常量', 'ℏ · reduced Planck constant'],
  ['times', '× · 乘号', '× · multiplication'], ['cdot', '· · 点乘', '· · dot product'],
  ['div', '÷ · 除号', '÷ · division'], ['pm', '± · 正负号', '± · plus or minus'],
  ['mp', '∓ · 负正号', '∓ · minus or plus'], ['circ', '∘ · 复合运算', '∘ · composition'],
  ['leq', '≤ · 小于等于', '≤ · less than or equal'], ['geq', '≥ · 大于等于', '≥ · greater than or equal'],
  ['neq', '≠ · 不等于', '≠ · not equal'], ['approx', '≈ · 约等于', '≈ · approximately equal'],
  ['equiv', '≡ · 恒等', '≡ · equivalent'], ['sim', '∼ · 相似', '∼ · similar'],
  ['propto', '∝ · 正比于', '∝ · proportional'], ['ll', '≪ · 远小于', '≪ · much less than'],
  ['gg', '≫ · 远大于', '≫ · much greater than'],
  ['in', '∈ · 属于', '∈ · element of'], ['notin', '∉ · 不属于', '∉ · not an element of'],
  ['subset', '⊂ · 子集', '⊂ · subset'], ['subseteq', '⊆ · 子集或相等', '⊆ · subset or equal'],
  ['supset', '⊃ · 超集', '⊃ · superset'], ['supseteq', '⊇ · 超集或相等', '⊇ · superset or equal'],
  ['cup', '∪ · 并集', '∪ · union'], ['cap', '∩ · 交集', '∩ · intersection'],
  ['emptyset', '∅ · 空集', '∅ · empty set'], ['setminus', '∖ · 差集', '∖ · set difference'],
  ['forall', '∀ · 任意', '∀ · for all'], ['exists', '∃ · 存在', '∃ · exists'],
  ['neg', '¬ · 非', '¬ · negation'], ['land', '∧ · 且', '∧ · logical and'], ['lor', '∨ · 或', '∨ · logical or'],
  ['rightarrow', '→ · 右箭头', '→ · right arrow'], ['leftarrow', '← · 左箭头', '← · left arrow'],
  ['leftrightarrow', '↔ · 双向箭头', '↔ · left-right arrow'], ['Rightarrow', '⇒ · 推出', '⇒ · implies'],
  ['Leftarrow', '⇐ · 被推出', '⇐ · implied by'], ['Leftrightarrow', '⇔ · 等价', '⇔ · if and only if'],
  ['mapsto', '↦ · 映射到', '↦ · maps to'], ['to', '→ · 趋向', '→ · tends to'],
  ['uparrow', '↑ · 上箭头', '↑ · up arrow'], ['downarrow', '↓ · 下箭头', '↓ · down arrow'],
  ['ldots', '… · 水平省略号', '… · ellipsis'], ['cdots', '⋯ · 居中省略号', '⋯ · centered dots'],
  ['vdots', '⋮ · 垂直省略号', '⋮ · vertical dots'], ['ddots', '⋱ · 对角省略号', '⋱ · diagonal dots'],
  ['sin', '正弦', 'sine'], ['cos', '余弦', 'cosine'], ['tan', '正切', 'tangent'],
  ['arcsin', '反正弦', 'arcsine'], ['arccos', '反余弦', 'arccosine'], ['arctan', '反正切', 'arctangent'],
  ['sinh', '双曲正弦', 'hyperbolic sine'], ['cosh', '双曲余弦', 'hyperbolic cosine'],
  ['log', '对数', 'logarithm'], ['ln', '自然对数', 'natural logarithm'], ['exp', '指数函数', 'exponential'],
  ['min', '最小值', 'minimum'], ['max', '最大值', 'maximum'], ['det', '行列式', 'determinant'],
  ['langle', '⟨ · 左角括号', '⟨ · left angle bracket'], ['rangle', '⟩ · 右角括号', '⟩ · right angle bracket'],
  ['lceil', '⌈ · 左上取整', '⌈ · left ceiling'], ['rceil', '⌉ · 右上取整', '⌉ · right ceiling'],
  ['lfloor', '⌊ · 左下取整', '⌊ · left floor'], ['rfloor', '⌋ · 右下取整', '⌋ · right floor'],
  ['quad', '宽空格', 'wide space'], ['qquad', '双宽空格', 'double wide space']
];

function template(command: string, zh: string, en: string, insert: string, preview: string): MathCompletion {
  // A marker is an empty, editable field; it never becomes document content.
  const fields: number[] = [];
  let text = '';
  for (const part of insert.split('◊')) { if (text) fields.push(text.length); text += part; }
  return { label: '\\' + command, zh, en, insert: text, fields, preview };
}

function symbolPreview(command: string): string {
  if (['sin', 'cos', 'tan', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'log', 'ln', 'exp', 'min', 'max'].includes(command)) return '\\' + command + ' x';
  if (command === 'det') return '\\det A';
  if (command === 'quad' || command === 'qquad') return 'a\\' + command + ' b';
  return '\\' + command;
}

const mathCompletions: readonly MathCompletion[] = [
  ...symbols.map(([command, zh, en]) => ({ label: '\\' + command, zh, en, insert: '\\' + command, fields: [], preview: symbolPreview(command) })),
  ...['frac', 'dfrac', 'tfrac'].map(command => template(command, '分式 · 分子 / 分母', 'fraction · numerator / denominator', '\\' + command + '{◊}{◊}', '\\' + command + '{a}{b}')),
  template('sqrt', '根式', 'square root', '\\sqrt{◊}', '\\sqrt{x}'),
  ...[['sum', '求和', 'sum', '\\sum_{i=1}^{n} x_i'], ['prod', '连乘', 'product', '\\prod_{i=1}^{n} x_i'],
    ['int', '积分', 'integral', '\\int_a^b f(x)'], ['oint', '环路积分', 'contour integral', '\\oint_C f(z)']]
    .map(([command, zh, en, preview]) => template(command, zh + ' · 下限 / 上限', en + ' · lower / upper bound', '\\' + command + '_{◊}^{◊} ◊', preview)),
  template('lim', '极限', 'limit', '\\lim_{◊} ◊', '\\lim_{x\\to 0} f(x)'),
  ...[['text', '公式内文本', 'text', 'abc'], ['mathbf', '粗体', 'bold', 'A'], ['mathbb', '黑板粗体', 'blackboard bold', 'R'],
    ['mathcal', '花体', 'calligraphic', 'F'], ['mathrm', '直立字体', 'upright', 'ABC'], ['operatorname', '自定义运算符', 'operator name', 'op'],
    ['vec', '向量', 'vector', 'v'], ['hat', '尖帽', 'hat accent', 'x'], ['bar', '上横线', 'bar accent', 'x'],
    ['overline', '上划线', 'overline', 'AB'], ['underline', '下划线', 'underline', 'AB'], ['boxed', '方框', 'boxed expression', 'x']]
    .map(([command, zh, en, sample]) => template(command, zh, en, '\\' + command + '{◊}', '\\' + command + '{' + sample + '}')),
  template('left', '成对可伸缩括号', 'paired scalable parentheses', '\\left(◊\\right)', '\\left(x+y\\right)'),
  ...[['aligned', '对齐公式', 'aligned equations', '\\begin{smallmatrix}x&=&y\\\\u&=&v\\end{smallmatrix}'],
    ['cases', '分段函数', 'piecewise function', '\\left\\{\\begin{smallmatrix}\\cdot&\\cdot\\\\\\cdot&\\cdot\\end{smallmatrix}\\right.'],
    ['matrix', '矩阵', 'matrix', '\\begin{smallmatrix}\\cdot&\\cdot\\\\\\cdot&\\cdot\\end{smallmatrix}'],
    ['pmatrix', '圆括号矩阵', 'parenthesized matrix', '\\left(\\begin{smallmatrix}\\cdot&\\cdot\\\\\\cdot&\\cdot\\end{smallmatrix}\\right)'],
    ['bmatrix', '方括号矩阵', 'bracketed matrix', '\\left[\\begin{smallmatrix}\\cdot&\\cdot\\\\\\cdot&\\cdot\\end{smallmatrix}\\right]']]
    .map(([environment, zh, en, preview]) => ({ ...template('begin{' + environment + '}', zh, en,
      '\\begin{' + environment + '}\n  ◊\n\\end{' + environment + '}', preview), environment }))
];

export type MathCompletionContext = {
  readonly type: 'math'; readonly query: string; readonly target: ''; readonly length: number; readonly wiki: false;
  readonly from: number; readonly to: number; readonly bodyFrom: number; readonly bodyTo: number;
  readonly environment: boolean; readonly display: boolean; readonly prefix: string;
};
export type MathCompletionBody = { from: number; to: number; display: boolean; prefix: string };
const contexts = new WeakMap<EditorState, Map<number, MathCompletionContext | null>>();
const escaped = (text: string, index: number) => (/\\+$/.exec(text.slice(0, index))?.[0].length ?? 0) % 2 === 1;

/** Only a TeX command prefix invokes the math scanner; ordinary typing does no
 * formula work. Repeated menu validation for the same state/position is cached. */
export function detectMathCompletion(state: EditorState, position: number, resolveBody: () => MathCompletionBody | null): MathCompletionContext | null {
  let cached = contexts.get(state);
  if (!cached) { cached = new Map(); contexts.set(state, cached); }
  if (cached.has(position)) return cached.get(position)!;
  const line = state.doc.lineAt(position), before = state.sliceDoc(line.from, position);
  const match = /\\(?:begin\{([A-Za-z]*)|([A-Za-z]+))$/.exec(before);
  let result: MathCompletionContext | null = null;
  if (match && !escaped(before, match.index)) {
    const body = resolveBody(), from = line.from + match.index;
    const sourceLine = body ? state.sliceDoc(Math.max(line.from, body.from), position) : '';
    const comment = [...sourceLine.matchAll(/%/g)].some(match => !escaped(sourceLine, match.index!));
    if (body && from >= body.from && position <= body.to && !comment) {
      const suffix = /^[A-Za-z]*/.exec(state.sliceDoc(position, line.to))![0];
      result = { type: 'math', query: match[1] ?? match[2]!, target: '', wiki: false,
        length: position - from, from, to: position + suffix.length, bodyFrom: body.from, bodyTo: body.to,
        display: body.display, prefix: body.prefix, environment: match[1] !== undefined };
    }
  }
  cached.set(position, result);
  return result;
}

export function mathCompletionSuggestions(context: MathCompletionContext): readonly MathCompletion[] {
  const query = context.query;
  const name = (item: MathCompletion) => context.environment ? item.environment ?? '' : item.label.slice(1);
  return mathCompletions.filter(item => (!item.environment || context.display)
    && (!context.environment || item.environment)
    && name(item).toLowerCase().startsWith(query.toLowerCase()))
    .sort((a, b) => Number(name(b) === query) - Number(name(a) === query)
      || Number(name(b).startsWith(query)) - Number(name(a).startsWith(query)));
}

/** Returns one literal document edit and its tab stops. Existing arguments and
 * an existing matching environment closer remain owned by the user's source. */
export function planMathCompletion(state: EditorState, context: MathCompletionContext, item: MathCompletion) {
  let to = context.to, insert = item.insert, fields = [...item.fields];
  const after = state.sliceDoc(to, context.bodyTo);
  if (item.environment) {
    if (context.environment && after.startsWith('}')) to++;
    if (hasEnvironmentCloser(state, context, to, item.environment)) {
      insert = item.label; fields = [];
    } else if (!context.environment && after.startsWith('{')) {
      insert = '\\begin'; fields = [];
    }
  } else if (fields.length && /^\s*[\{\[(]/.test(after)) {
    insert = item.label; fields = [];
  }
  const raw = insert;
  if (context.prefix) insert = insert.replaceAll('\n', '\n' + context.prefix);
  const positionAt = (offset: number) => context.from + offset + (raw.slice(0, offset).match(/\n/g)?.length ?? 0) * context.prefix.length;
  const pairs = [...insert.matchAll(/\{\}|\(\)|\[\]/g)].map(match => ({
    from: context.from + match.index!, to: context.from + match.index! + 2, open: match[0][0]!, close: match[0][1]!
  }));
  return { from: context.from, to, insert, fields: fields.map(offset => ({ from: positionAt(offset), to: positionAt(offset) })),
    end: context.from + insert.length, pairs };
}

function hasEnvironmentCloser(state: EditorState, context: MathCompletionContext, to: number, environment: string): boolean {
  // A closer reserved for an enclosing or a later nested environment cannot
  // replace the new template's own closer. Ignore TeX comments and escaped '\\'.
  const balance = (source: string, depth: number, stopAtZero: boolean) => {
    for (const match of source.matchAll(/\\(begin|end)\{([A-Za-z]+)\}/g)) {
      if (match[2] !== environment || escaped(source, match.index!)) continue;
      const line = source.slice(source.lastIndexOf('\n', match.index! - 1) + 1, match.index!);
      if ([...line.matchAll(/%/g)].some(comment => !escaped(line, comment.index!))) continue;
      depth = Math.max(0, depth + (match[1] === 'begin' ? 1 : -1));
      if (stopAtZero && !depth) return 0;
    }
    return depth;
  };
  const outer = balance(state.sliceDoc(context.bodyFrom, context.from), 0, false);
  return balance(state.sliceDoc(to, context.bodyTo), outer + 1, true) === 0;
}
