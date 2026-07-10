import {
  semanticColorKeys,
  serializeThemeSettings,
  type SemanticColorKey,
  type ThemeSettings
} from './themeDefaults';

const semanticColorDescriptions: Record<SemanticColorKey, string> = {
  foreground: '主文字颜色。',
  mutedForeground: '弱化文字颜色，例如标记、辅助说明。',
  background: '编辑器正文背景。',
  surfaceBackground: '工具栏、侧边区域等表面背景。',
  insetBackground: '内嵌块背景，例如表头、kbd。',
  selectionBackground: '普通文本选区背景。',
  activeLineBackground: '光标所在行的高亮背景。',
  caret: '输入光标颜色。',
  codeBlockBackground: '代码块和 Mermaid 块背景。',
  codeBlockActiveLineBackground: '代码块内光标所在行背景。',
  codeLanguageLabelForeground: '代码块左上角语言名字文字颜色。',
  codeLanguageLabelBackground: '代码块左上角语言名字背景。',
  codeCopyForeground: '代码块右上角 copy 文字颜色。',
  codeCopyBackground: '代码块右上角 copy 背景。',
  codeCopyHoverForeground: 'copy 按钮悬浮文字颜色。',
  codeCopyHoverBackground: 'copy 按钮悬浮背景。',
  inlineCodeBackground: '行内代码背景。',
  markdownSyntax: 'Markdown 语法符号颜色，例如 #、**、~~、`、```。',
  tagForeground: '标签文字颜色，例如 #tag。',
  tagBackground: '标签背景。',
  tagBorder: '标签边框。',
  headingForeground: '标题正文颜色，Markdown 标记本身不跟着改。',
  orderedListMarker: '有序列表序号颜色。',
  unorderedListMarker: '无序列表圆点颜色。',
  listPrefix: '源码里的列表前缀颜色。',
  listGuide: '嵌套列表引导线颜色。',
  taskCheckboxBackground: '任务勾选框背景。',
  taskCheckboxBorder: '任务勾选框描边。',
  taskCheckboxBorderHover: '任务勾选框悬浮描边。',
  taskCheckboxCheck: '任务勾选框里的对勾、进度点或删除线。',
  taskCheckboxDoneBackground: '已完成任务勾选框填充。',
  taskCheckboxDoneBorder: '已完成任务勾选框描边。',
  taskCheckboxDoneCheck: '已完成任务勾选框里的对勾。',
  taskCompleteForeground: '已完成任务文字颜色。',
  taskDroppedForeground: '已放弃任务文字颜色。',
  blockquoteBorder: '引用左侧竖线颜色。',
  blockquoteForeground: '引用文字颜色。',
  horizontalRule: '分割线颜色。',
  tableBorder: '表格单元格边框。',
  tableHeaderBackground: '表格表头背景。',
  tableSelectionBorder: '表格选中单元格描边。',
  tableDelimiterForeground: '源码表格分隔行颜色。',
  imageBackground: '图片加载失败/占位背景。',
  imageBorder: '图片加载失败/占位边框。',
  imageFallbackForeground: '图片加载/失败提示文字。',
  linkForeground: '普通链接颜色。',
  wikiLinkForeground: 'Wiki 链接颜色。',
  footnoteForeground: '脚注引用文字颜色。',
  footnoteBackground: '脚注引用背景。',
  kbdBackground: 'kbd 键帽背景。',
  kbdBorder: 'kbd 键帽边框。',
  frontmatterKey: 'Frontmatter key 颜色。',
  frontmatterValue: 'Frontmatter value 颜色。',
  frontmatterPillBackground: 'Frontmatter 数组 pill 背景。',
  searchMatchForeground: '搜索命中的文字颜色。',
  searchMatchBackground: '搜索命中的背景颜色。',
  searchMatchBorder: '搜索命中的描边颜色。',
  searchMatchActiveForeground: '当前选中搜索命中文字颜色。',
  searchMatchActiveBackground: '当前选中搜索命中背景颜色。',
  searchMatchActiveBorder: '当前选中搜索命中描边颜色。',
  scrollbarThumb: '滚动条滑块颜色。',
  scrollbarThumbHover: '滚动条滑块悬浮颜色。',
  scrollbarThumbActive: '滚动条滑块按下颜色。',
  alertNoteForeground: 'NOTE 提示文字和图标颜色。',
  alertNoteBackground: 'NOTE 提示背景。',
  alertNoteBorder: 'NOTE 提示左边框。',
  alertTipForeground: 'TIP 提示文字和图标颜色。',
  alertTipBackground: 'TIP 提示背景。',
  alertTipBorder: 'TIP 提示左边框。',
  alertImportantForeground: 'IMPORTANT 提示文字和图标颜色。',
  alertImportantBackground: 'IMPORTANT 提示背景。',
  alertImportantBorder: 'IMPORTANT 提示左边框。',
  alertWarningForeground: 'WARNING 提示文字和图标颜色。',
  alertWarningBackground: 'WARNING 提示背景。',
  alertWarningBorder: 'WARNING 提示左边框。',
  alertCautionForeground: 'CAUTION 提示文字和图标颜色。',
  alertCautionBackground: 'CAUTION 提示背景。',
  alertCautionBorder: 'CAUTION 提示左边框。'
};

export function parseThemeJsonc(text: string): unknown {
  return JSON.parse(stripJsonComments(text));
}

export function serializeAnnotatedThemeJsonc(theme: ThemeSettings): string {
  const payload = serializeThemeSettings(theme);
  const lines: string[] = [
    '{',
    '  // 主题基本信息。',
    `  "id": ${JSON.stringify(payload.id)},`,
    `  "name": ${JSON.stringify(payload.name)},`,
    '  // 编辑器正文背景。',
    `  "backgroundColor": ${JSON.stringify(payload.backgroundColor)},`,
    '  // 基础调色板：主要用于语法 token。语义颜色请优先改 semanticColors。',
    '  "colors": {'
  ];
  appendObject(lines, payload.colors, 4);
  lines.push('  },');
  lines.push('  // 独立语义色：Markdown 和编辑器 UI 的各个部件都在这里单独配置。');
  lines.push('  "semanticColors": {');
  const semanticColors = payload.semanticColors ?? {};
  const semanticEntries = semanticColorKeys.map((key) => [key, theme.semanticColors[key]] as const);
  for (const [index, [key, value]] of semanticEntries.entries()) {
    lines.push(`    // ${semanticColorDescriptions[key]}`);
    lines.push(`    ${JSON.stringify(key)}: ${JSON.stringify(semanticColors[key] ?? value)}${index === semanticEntries.length - 1 ? '' : ','}`);
  }
  lines.push('  },');
  lines.push('  // 语法 token 颜色。留空字符串表示使用基础调色板默认值。');
  lines.push('  "syntaxTokens": {');
  appendObject(lines, payload.syntaxTokens, 4);
  lines.push('  },');
  lines.push('  // 字体和字号设置。');
  lines.push('  "fonts": {');
  appendObject(lines, payload.fonts, 4);
  lines.push('  }');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function appendObject(lines: string[], value: Record<string, unknown>, indent: number): void {
  const entries = Object.entries(value);
  const pad = ' '.repeat(indent);
  for (const [index, [key, item]] of entries.entries()) {
    lines.push(`${pad}${JSON.stringify(key)}: ${JSON.stringify(item)}${index === entries.length - 1 ? '' : ','}`);
  }
}

function stripJsonComments(text: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') {
        index += 1;
      }
      result += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        result += text[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      index += 1;
      continue;
    }
    result += char;
  }
  return result;
}
