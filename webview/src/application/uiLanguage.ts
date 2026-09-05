import type { UiLanguage } from '../../../src/foundation/uiLanguage';
import type { ChangesReviewUnavailableReason } from './changesReview';

export type { UiLanguage } from '../../../src/foundation/uiLanguage';

export type GitHeadDisplayStatus =
  | 'git-unavailable'
  | 'not-repo'
  | 'ignored'
  | 'untracked'
  | 'no-commits'
  | 'not-file'
  | 'too-large'
  | 'binary'
  | 'error';

export type UiStrings = Readonly<{
  auto: string;
  light: string;
  dark: string;
  previewTitle: string;
  previewAppearance: string;
  previewSourceColoring: string;
  previewCodeColors: string;
  previewCodeColorsOn: string;
  previewCodeColorsOff: string;
  previewFontFamily: string;
  previewFontPlaceholder: string;
  previewFontUnavailable: string;
  previewGenerating: string;
  previewFailed: string;
  previewTools: string;
  exportHtml: string;
  exportPdf: string;
  exportAsHtml: string;
  exportAsPdf: string;
  findAndReplace: string;
  more: string;
  moreTools: string;
  toolbarOverflow: string;
  feedbackPrompt: string;
  reportIssue: string;
  editorAppearance: string;
  editorFontSize: string;
  custom: string;
  decreaseFontSize: string;
  increaseFontSize: string;
  interfaceLanguage: string;
  showLineNumbers: string;
  foldLongCodeBlocks: string;
  findAndReplacePanel: string;
  find: string;
  replace: string;
  clearFind: string;
  clearReplace: string;
  wholeWord: string;
  caseSensitive: string;
  previousMatch: string;
  nextMatch: string;
  closeFind: string;
  replaceCurrentMatch: string;
  replaceAllMatches: string;
  noMatches: string;
  enterText: string;
  replaced: string;
  findMatches: (count: number) => string;
  replacedCurrent: (current: number, total: number) => string;
  replacedRemaining: (count: number) => string;
  replacedMatches: (count: number) => string;
  documentOutline: string;
  outline: string;
  outlineCollapseTopTwo: string;
  outlineExpandAll: string;
  outlineSwitchFixed: string;
  outlineSwitchFloating: string;
  outlineSwitchLeft: string;
  outlineSwitchRight: string;
  outlineClose: string;
  outlineResize: string;
  outlineEmptyHeading: string;
  outlineExpand: string;
  outlineCollapse: string;
  outlineNoHeadings: string;
  untitled: string;
  backToTop: string;
  editorToolbar: string;
  formatting: string;
  markdownMode: string;
  live: string;
  source: string;
  preview: string;
  inlineMarkdownFormatting: string;
  bold: string;
  italic: string;
  lineover: string;
  highlight: string;
  inlineCode: string;
  kbd: string;
  underline: string;
  markTaskComplete: string;
  markTaskIncomplete: string;
  clearLinkUrl: string;
  jumpWithinDocument: string;
  openLink: string;
  missingWikiLink: string;
  missingLocalLink: string;
  expandDetails: string;
  collapseDetails: string;
  showHtmlSource: string;
  jumpToFootnote: (number: number) => string;
  jumpToFootnoteReference: (number: number) => string;
  copyCode: string;
  copied: string;
  copy: string;
  selectAllCode: string;
  all: string;
  codeLines: (count: number) => string;
  showMoreCode: (count: number) => string;
  showMoreLines: (count: number) => string;
  showLessCode: string;
  showLess: string;
  mermaidBlockControls: (line: number) => string;
  mermaidEditor: (line: number) => string;
  editMermaidSplit: string;
  showMermaidSource: string;
  showMermaidPreview: string;
  formulaBlockControls: (line: number) => string;
  formulaEditor: (line: number) => string;
  editFormulaSplit: string;
  showFormulaSource: string;
  showFormulaPreview: string;
  loading: string;
  zoomIn: string;
  zoomOut: string;
  resetZoom: string;
  fullscreen: string;
  exitFullscreen: string;
  mermaidError: (message: string) => string;
  openWithSystemApp: string;
  fullscreenImage: string;
  colorLabel: (value: string) => string;
  beforeChange: string;
  deletedLines: (count: number) => string;
  moreDeletedContentHidden: string;
  moreOriginalContentHidden: string;
  showHtmlPreview: string;
  unsupportedHtmlSource: string;
  acceptCurrent: string;
  acceptIncoming: string;
  acceptBoth: string;
  currentVersion: (label: string) => string;
  incomingVersion: (label: string) => string;
  alertLabel: (type: string) => string;
  tableActions: string;
  insertRowAbove: string;
  insertRowBelow: string;
  deleteRow: string;
  insertColumnLeft: string;
  insertColumnRight: string;
  deleteColumn: string;
  alignColumnLeft: string;
  alignColumnCenter: string;
  alignColumnRight: string;
  heading: string;
  headingLevels: string;
  headingLevel: (level: number) => string;
  bulletList: string;
  numberedList: string;
  task: string;
  showOutlineLeft: string;
  showOutlineRight: string;
  codeBlock: string;
  quote: string;
  horizontalRule: string;
  link: string;
  wikiLink: string;
  image: string;
  table: string;
  line: string;
  goToLine: string;
  save: string;
  saveDocument: string;
  reloadDiskVersion: string;
  reloadDiskVersionDoubleClick: string;
  constrainContentWidth: string;
  constrainWidth: string;
  disableConstrainedWidth: string;
  currentEdits: string;
  recentSave: string;
  gitHead: string;
  compareWithVersion: string;
  displaySettings: string;
  currentDiskVersionOption: string;
  currentDiskVersionDescription: string;
  beforeLastSaveVersionOption: string;
  gitHeadOption: string;
  gitHeadStatus: (status: GitHeadDisplayStatus) => string;
  gitHeadWithStatus: (status: string) => string;
  gitHeadOptionWithStatus: (status: string) => string;
  manualSnapshot: string;
  manualSnapshotOption: string;
  disableComparison: string;
  createSnapshot: string;
  clickToCreateSnapshot: string;
  updateSnapshot: string;
  showChangeLocations: string;
  showBeforeChangeContent: string;
  sourceModeOnly: string;
  noChanges: string;
  noComparison: string;
  selectComparisonToEnable: string;
  comparisonUnavailable: string;
  comparisonUnavailableReason: (reason: ChangesReviewUnavailableReason) => string;
  addedCount: (count: number) => string;
  deletedCount: (count: number) => string;
  comparedWith: (baseline: string) => string;
  changesComparedWith: (summary: string, baseline: string) => string;
  dismissNotification: string;
  liveModeFailure: string;
  editorUpdateFailure: string;
  transientUpdateFailure: string;
  transientModeFailure: string;
  transientLoadRetry: string;
  transientLoadFailure: string;
  pasteImageFailure: (message: string) => string;
  properties: string;
  resyncFailureNotice: string;
  externalConflictNotice: string;
}>;

const CATALOG: Readonly<Record<UiLanguage, UiStrings>> = Object.freeze({
  en: Object.freeze({
    auto: 'Auto', light: 'Light', dark: 'Dark', previewTitle: 'Markdown Preview',
    previewAppearance: 'Theme', previewSourceColoring: 'Preview source coloring',
    previewCodeColors: 'Code color', previewCodeColorsOn: 'On', previewCodeColorsOff: 'Off',
    previewFontFamily: 'Font',
    previewFontPlaceholder: 'VS Code editor font',
    previewFontUnavailable: 'Local font list unavailable; type a family name',
    previewGenerating: 'Generating preview…',
    previewFailed: 'Preview generation failed', previewTools: 'Preview tools',
    exportHtml: 'Export HTML', exportPdf: 'Export PDF', exportAsHtml: 'Export as HTML',
    exportAsPdf: 'Export as PDF', findAndReplace: 'Find and Replace', more: 'Settings',
    moreTools: 'Settings', toolbarOverflow: 'More tools', feedbackPrompt: 'Having trouble?', reportIssue: 'Report an issue',
    editorAppearance: 'Editor appearance', editorFontSize: 'Font size',
    custom: 'Custom', decreaseFontSize: 'Decrease font size', increaseFontSize: 'Increase font size',
    interfaceLanguage: 'Interface language', showLineNumbers: 'Show line numbers',
    foldLongCodeBlocks: 'Fold long code blocks',
    findAndReplacePanel: 'Find and replace', find: 'Find', replace: 'Replace',
    clearFind: 'Clear Find', clearReplace: 'Clear Replace', wholeWord: 'Whole Word',
    caseSensitive: 'Case Sensitive', previousMatch: 'Previous Match', nextMatch: 'Next Match',
    closeFind: 'Close Find', replaceCurrentMatch: 'Replace Current Match',
    replaceAllMatches: 'Replace All Matches', noMatches: 'No matches', enterText: 'Enter text',
    replaced: 'Replaced', findMatches: (count: number) => `${count} matches`,
    replacedCurrent: (current: number, total: number) => `Replaced • ${current}/${total}`,
    replacedRemaining: (count: number) => `Replaced • ${count} remaining`,
    replacedMatches: (count: number) => `Replaced ${count} matches`,
    documentOutline: 'Document outline', outline: 'Outline', outlineCollapseTopTwo: 'Show top level only',
    outlineExpandAll: 'Expand all', outlineSwitchFixed: 'Switch to fixed outline',
    outlineSwitchFloating: 'Switch to floating outline', outlineSwitchLeft: 'Switch to left side',
    outlineSwitchRight: 'Switch to right side', outlineClose: 'Close outline',
    outlineResize: 'Drag to resize outline',
    outlineEmptyHeading: '(Empty heading)',
    outlineExpand: 'Expand', outlineCollapse: 'Collapse', outlineNoHeadings: 'No headings', untitled: 'Untitled',
    backToTop: 'Back to top',
    editorToolbar: 'Editor toolbar', formatting: 'Formatting', markdownMode: 'Markdown mode',
    live: 'Live', source: 'Source', preview: 'Preview',
    inlineMarkdownFormatting: 'Inline markdown formatting', bold: 'Bold', italic: 'Italic',
    lineover: 'Lineover', highlight: 'Highlight', inlineCode: 'Inline Code', kbd: 'Kbd',
    underline: 'Underline', markTaskComplete: 'Mark task as complete',
    markTaskIncomplete: 'Mark task as incomplete', clearLinkUrl: 'Clear link URL',
    jumpWithinDocument: 'Jump within document', openLink: 'Open link',
    missingWikiLink: 'Wiki link target not found locally', missingLocalLink: 'Local file link target not found',
    expandDetails: 'Expand details', collapseDetails: 'Collapse details', showHtmlSource: 'Show HTML source',
    jumpToFootnote: (number: number) => `Jump to footnote ${number}`,
    jumpToFootnoteReference: (number: number) => `Jump to footnote reference ${number}`,
    copyCode: 'Copy code', copied: 'copied', copy: 'copy', selectAllCode: 'Select all code', all: 'all',
    codeLines: (count: number) => `${count} lines`,
    showMoreCode: (count: number) => `Show ${count} more lines of code`,
    showMoreLines: (count: number) => `Show ${count} more lines`, showLessCode: 'Show less code', showLess: 'Show less',
    mermaidBlockControls: (line: number) => `Mermaid block controls at line ${line}`,
    mermaidEditor: (line: number) => `Mermaid editor at line ${line}`,
    editMermaidSplit: 'Edit Mermaid in split view', showMermaidSource: 'Show Mermaid code only',
    showMermaidPreview: 'Show Mermaid preview',
    formulaBlockControls: (line: number) => `Formula block controls at line ${line}`,
    formulaEditor: (line: number) => `Formula editor at line ${line}`,
    editFormulaSplit: 'Edit formula in split view', showFormulaSource: 'Show formula source only',
    showFormulaPreview: 'Show formula preview',
    loading: 'Loading...', zoomIn: 'Zoom in', zoomOut: 'Zoom out', resetZoom: 'Reset zoom',
    fullscreen: 'Fullscreen', exitFullscreen: 'Exit fullscreen',
    mermaidError: (message: string) => `Mermaid error: ${message}`,
    openWithSystemApp: 'Open with system app', fullscreenImage: 'Fullscreen image',
    colorLabel: (value: string) => `Color ${value}`, beforeChange: 'Before change',
    deletedLines: (count: number) => `Deleted ${count} ${count === 1 ? 'line' : 'lines'}`,
    moreDeletedContentHidden: 'More deleted content is not shown.',
    moreOriginalContentHidden: 'More original content is not shown.',
    showHtmlPreview: 'Show HTML preview',
    unsupportedHtmlSource: 'This HTML stays as source because it contains unsupported or invalid markup.',
    acceptCurrent: 'Accept Current', acceptIncoming: 'Accept Incoming', acceptBoth: 'Accept Both',
    currentVersion: (label: string) => `Current: ${label},`,
    incomingVersion: (label: string) => `Incoming: ${label}`,
    alertLabel: (type: string) => type,
    tableActions: 'Table actions', insertRowAbove: 'Insert row above', insertRowBelow: 'Insert row below',
    deleteRow: 'Delete row', insertColumnLeft: 'Insert column left', insertColumnRight: 'Insert column right',
    deleteColumn: 'Delete column', alignColumnLeft: 'Align selected column left',
    alignColumnCenter: 'Align selected column center', alignColumnRight: 'Align selected column right',
    heading: 'Heading',
    headingLevels: 'Heading levels', headingLevel: (level: number) => `Heading ${level}`,
    bulletList: 'Bullet List', numberedList: 'Numbered List', task: 'Task',
    showOutlineLeft: 'Show Outline on Left', showOutlineRight: 'Show Outline on Right',
    codeBlock: 'Code Block', quote: 'Quote', horizontalRule: 'Horizontal Rule',
    link: 'Link', wikiLink: 'Wiki Link', image: 'Image', table: 'Table', line: 'Lines',
    goToLine: 'Go to line', save: 'Save (Ctrl+S)', saveDocument: 'Save document',
    reloadDiskVersion: 'Reload from disk and discard unsaved changes', reloadDiskVersionDoubleClick: 'Click again to discard unsaved changes and reload from disk',
    constrainContentWidth: 'Constrain Content Width', constrainWidth: 'Constrain Width',
    disableConstrainedWidth: 'Disable Constrained Width',
    currentEdits: 'Last Saved Version', recentSave: 'Before Agent Edits',
    gitHead: 'Git HEAD (Latest Commit)',
    compareWithVersion: 'Compare Against', displaySettings: 'Display Settings',
    currentDiskVersionOption: 'Last Saved Version',
    currentDiskVersionDescription: 'Compare with the latest file contents saved on disk, including external changes',
    beforeLastSaveVersionOption: 'Before Agent Edits',
    gitHeadOption: 'Git HEAD', manualSnapshot: 'Manual Snapshot',
    manualSnapshotOption: 'Manual Snapshot', disableComparison: 'Turn Off Comparison',
    gitHeadStatus: (status: GitHeadDisplayStatus) => ({
      'git-unavailable': 'Git Unavailable',
      'not-repo': 'Not a Git Repo',
      ignored: 'Ignored by Git',
      untracked: 'Untracked File',
      'no-commits': 'No Commits',
      'not-file': 'Not a Local File',
      'too-large': 'File Too Large',
      binary: 'Binary File',
      error: 'Temporary Error'
    })[status],
    gitHeadWithStatus: (status: string) => `Git HEAD (${status})`,
    gitHeadOptionWithStatus: (status: string) => `Git HEAD · ${status}`,
    createSnapshot: 'Create',
    clickToCreateSnapshot: 'Click to Create', updateSnapshot: 'Update',
    showChangeLocations: 'Mark Change Locations',
    showBeforeChangeContent: 'Show Original · Source Only',
    sourceModeOnly: 'Available in Source mode only', noChanges: 'No Changes', noComparison: 'No comparison',
    comparisonUnavailable: 'Unable to Compare',
    selectComparisonToEnable: 'Select a comparison version to enable',
    comparisonUnavailableReason: (reason: ChangesReviewUnavailableReason) => ({
      'git-unavailable': 'Git Unavailable',
      'not-repo': 'Not a Git Repo',
      ignored: 'Ignored by Git',
      'not-file': 'Not a Local File',
      'too-large': 'File Too Large',
      binary: 'Binary File',
      error: 'Temporary Error',
      'no-baseline': 'No Comparison Version',
      timeout: 'Comparison Timed Out'
    })[reason],
    addedCount: (count: number) => `${count} added`, deletedCount: (count: number) => `${count} deleted`,
    comparedWith: (baseline: string) => `vs. ${baseline}`,
    changesComparedWith: (summary: string, baseline: string) => `${summary} · Compared with ${baseline}`,
    dismissNotification: 'Dismiss notification',
    liveModeFailure: 'Live mode failed to render this document. Switched to Source mode.',
    editorUpdateFailure: 'Editor failed to update this document. Try reopening the file.',
    transientUpdateFailure: 'Live mode hit a transient render error while updating. Try again.',
    transientModeFailure: 'Live mode hit a transient render error. Staying in current mode; try again.',
    transientLoadRetry: 'Live mode hit a transient render error while loading. Retrying...',
    transientLoadFailure: 'Live mode hit a transient render error while loading. Try reopening or switching modes.',
    pasteImageFailure: (message: string) => `Could not paste image: ${message}`,
    properties: 'Properties',
    resyncFailureNotice: 'Could not resynchronize the document. Local edits were kept.',
    externalConflictNotice: 'The document changed externally while local edits were pending. Local edits were kept.'
  }),
  'zh-CN': Object.freeze({
    auto: '自动', light: '浅色', dark: '深色', previewTitle: 'Markdown 预览',
    previewAppearance: '预览外观', previewSourceColoring: '预览源码着色',
    previewCodeColors: '代码着色', previewCodeColorsOn: '开启', previewCodeColorsOff: '关闭',
    previewFontFamily: '预览字体',
    previewFontPlaceholder: 'VS Code 编辑器字体',
    previewFontUnavailable: '无法获取本地字体列表；请手动输入字体名称',
    previewGenerating: '正在生成预览…',
    previewFailed: '预览生成失败', previewTools: '预览工具', exportHtml: '导出 HTML',
    exportPdf: '导出 PDF', exportAsHtml: '导出为 HTML', exportAsPdf: '导出为 PDF',
    findAndReplace: '查找和替换', more: '设置', moreTools: '设置', toolbarOverflow: '更多工具',
    feedbackPrompt: '使用中遇到问题？', reportIssue: '欢迎反馈',
    editorAppearance: '编辑器外观', editorFontSize: '字号大小', custom: '自定义',
    decreaseFontSize: '减小字号', increaseFontSize: '增大字号',
    interfaceLanguage: '界面语言', showLineNumbers: '显示行号',
    foldLongCodeBlocks: '折叠长代码块', findAndReplacePanel: '查找和替换', find: '查找',
    replace: '替换', clearFind: '清除查找内容', clearReplace: '清除替换内容',
    wholeWord: '全字匹配', caseSensitive: '区分大小写', previousMatch: '上一个匹配项',
    nextMatch: '下一个匹配项', closeFind: '关闭查找', replaceCurrentMatch: '替换当前匹配项',
    replaceAllMatches: '替换全部匹配项', noMatches: '无匹配项', enterText: '请输入文本',
    replaced: '已替换', findMatches: (count: number) => `${count} 个匹配项`,
    replacedCurrent: (current: number, total: number) => `已替换 • ${current}/${total}`,
    replacedRemaining: (count: number) => `已替换 • 剩余 ${count} 个`,
    replacedMatches: (count: number) => `已替换 ${count} 个匹配项`,
    documentOutline: '文档目录', outline: '目录', outlineCollapseTopTwo: '只显示一级标题',
    outlineExpandAll: '展开全部', outlineSwitchFixed: '切换到固定目录',
    outlineSwitchFloating: '切换到浮动目录', outlineSwitchLeft: '切换到左侧',
    outlineSwitchRight: '切换到右侧', outlineClose: '关闭目录',
    outlineResize: '拖动调整目录宽度',
    outlineEmptyHeading: '(空标题)',
    outlineExpand: '展开', outlineCollapse: '折叠', outlineNoHeadings: '暂无标题', untitled: '未命名',
    backToTop: '回到顶部',
    editorToolbar: '编辑器工具栏', formatting: '格式', markdownMode: 'Markdown 模式',
    live: '实时', source: '源码', preview: '预览', inlineMarkdownFormatting: '行内 Markdown 格式',
    bold: '加粗', italic: '斜体', lineover: '删除线', highlight: '高亮', inlineCode: '行内代码',
    kbd: '按键', underline: '下划线', markTaskComplete: '标记任务为已完成',
    markTaskIncomplete: '标记任务为未完成', clearLinkUrl: '清除链接地址',
    jumpWithinDocument: '在文档内跳转', openLink: '打开链接',
    missingWikiLink: '本地未找到 Wiki 链接目标', missingLocalLink: '未找到本地文件链接目标',
    expandDetails: '展开详细信息', collapseDetails: '折叠详细信息', showHtmlSource: '显示 HTML 源码',
    jumpToFootnote: (number: number) => `跳转到脚注 ${number}`,
    jumpToFootnoteReference: (number: number) => `跳转到脚注引用 ${number}`,
    copyCode: '复制代码', copied: '已复制', copy: '复制', selectAllCode: '全选代码', all: '全选',
    codeLines: (count: number) => `${count} 行`,
    showMoreCode: (count: number) => `显示其余 ${count} 行代码`,
    showMoreLines: (count: number) => `显示其余 ${count} 行`, showLessCode: '收起代码', showLess: '收起',
    mermaidBlockControls: (line: number) => `第 ${line} 行 Mermaid 块控件`,
    mermaidEditor: (line: number) => `第 ${line} 行 Mermaid 编辑器`,
    editMermaidSplit: '以分栏视图编辑 Mermaid', showMermaidSource: '仅显示 Mermaid 源码',
    showMermaidPreview: '显示 Mermaid 预览',
    formulaBlockControls: (line: number) => `第 ${line} 行公式块控件`,
    formulaEditor: (line: number) => `第 ${line} 行公式编辑器`,
    editFormulaSplit: '以分栏视图编辑公式', showFormulaSource: '仅显示公式源码',
    showFormulaPreview: '显示公式预览',
    loading: '正在加载…', zoomIn: '放大', zoomOut: '缩小', resetZoom: '重置缩放',
    fullscreen: '全屏', exitFullscreen: '退出全屏',
    mermaidError: (message: string) => `Mermaid 错误：${message}`,
    openWithSystemApp: '使用系统应用打开', fullscreenImage: '全屏查看图片',
    colorLabel: (value: string) => `颜色 ${value}`, beforeChange: '更改前',
    deletedLines: (count: number) => `已删除 ${count} 行`,
    moreDeletedContentHidden: '还有更多已删除内容未显示。',
    moreOriginalContentHidden: '还有更多原始内容未显示。',
    showHtmlPreview: '显示 HTML 预览',
    unsupportedHtmlSource: '此 HTML 包含不支持或无效的标记，因此保留为源码。',
    acceptCurrent: '接受当前更改', acceptIncoming: '接受传入更改', acceptBoth: '接受两者',
    currentVersion: (label: string) => `当前：${label}，`,
    incomingVersion: (label: string) => `传入：${label}`,
    alertLabel: (type: string) => ({ NOTE: '备注', TIP: '提示', IMPORTANT: '重要', WARNING: '警告', CAUTION: '注意' }[type] ?? type),
    tableActions: '表格操作', insertRowAbove: '在上方插入行', insertRowBelow: '在下方插入行',
    deleteRow: '删除行', insertColumnLeft: '在左侧插入列', insertColumnRight: '在右侧插入列',
    deleteColumn: '删除列', alignColumnLeft: '所选列左对齐',
    alignColumnCenter: '所选列居中对齐', alignColumnRight: '所选列右对齐',
    heading: '标题', headingLevels: '标题级别',
    headingLevel: (level: number) => `${level} 级标题`, bulletList: '无序列表',
    numberedList: '有序列表', task: '任务列表', showOutlineLeft: '在左侧显示目录',
    showOutlineRight: '在右侧显示目录', codeBlock: '代码块', quote: '引用',
    horizontalRule: '分隔线', link: '链接', wikiLink: 'Wiki 链接', image: '图片', table: '表格',
    line: '行号', goToLine: '跳转到行', save: '保存 (Ctrl+S)', saveDocument: '保存文档',
    reloadDiskVersion: '从磁盘重新加载，放弃未保存的更改', reloadDiskVersionDoubleClick: '再次点击将放弃未保存的更改，并从磁盘重新加载',
    constrainContentWidth: '限制内容宽度', constrainWidth: '限制宽度',
    disableConstrainedWidth: '取消内容宽度限制',
    currentEdits: '最近保存版本', recentSave: 'Agent 编辑前版本',
    gitHead: 'Git HEAD（最新提交）',
    compareWithVersion: '比较方式', displaySettings: '显示设置',
    currentDiskVersionOption: '与最近保存版本比较',
    currentDiskVersionDescription: '与磁盘上最新保存的文件内容比较，包含外部修改',
    beforeLastSaveVersionOption: '与 Agent 编辑前版本比较',
    gitHeadOption: '与 Git HEAD 比较', manualSnapshot: '手动快照',
    manualSnapshotOption: '与手动快照比较', disableComparison: '关闭比较',
    gitHeadStatus: (status: GitHeadDisplayStatus) => ({
      'git-unavailable': 'Git 不可用',
      'not-repo': '非 Git 仓库',
      ignored: 'Git 已忽略',
      untracked: '未跟踪文件',
      'no-commits': '暂无提交',
      'not-file': '非本地文件',
      'too-large': '文件过大',
      binary: '二进制文件',
      error: '暂不可用'
    })[status],
    gitHeadWithStatus: (status: string) => `Git HEAD（${status}）`,
    gitHeadOptionWithStatus: (status: string) => `与 Git HEAD 比较 · ${status}`,
    createSnapshot: '创建', clickToCreateSnapshot: '点击创建', updateSnapshot: '更新',
    showChangeLocations: '标记更改位置',
    showBeforeChangeContent: '显示修改前内容 · 仅源码模式', sourceModeOnly: '仅在源码模式下可用', noChanges: '无更改', noComparison: '不比较',
    comparisonUnavailable: '无法比较',
    selectComparisonToEnable: '选择比较版本后生效',
    comparisonUnavailableReason: (reason: ChangesReviewUnavailableReason) => ({
      'git-unavailable': 'Git 不可用',
      'not-repo': '非 Git 仓库',
      ignored: 'Git 已忽略',
      'not-file': '非本地文件',
      'too-large': '文件过大',
      binary: '二进制文件',
      error: '暂不可用',
      'no-baseline': '暂无比较版本',
      timeout: '比较超时'
    })[reason],
    addedCount: (count: number) => `新增 ${count} 行`, deletedCount: (count: number) => `删除 ${count} 行`,
    comparedWith: (baseline: string) => `与${baseline}对比`,
    changesComparedWith: (summary: string, baseline: string) => `${summary} · 与${baseline}对比`,
    dismissNotification: '关闭通知',
    liveModeFailure: '实时模式无法渲染此文档，已切换到源码模式。',
    editorUpdateFailure: '编辑器无法更新此文档，请重新打开文件。',
    transientUpdateFailure: '实时模式更新时遇到临时渲染错误，请重试。',
    transientModeFailure: '实时模式遇到临时渲染错误，将保持当前模式；请重试。',
    transientLoadRetry: '实时模式加载时遇到临时渲染错误，正在重试…',
    transientLoadFailure: '实时模式加载时遇到临时渲染错误，请重新打开文件或切换模式。',
    pasteImageFailure: (message: string) => `无法粘贴图片：${message}`,
    properties: 'Properties',
    resyncFailureNotice: '无法重新同步文档，已保留本地编辑。',
    externalConflictNotice: '存在本地编辑时文档发生了外部变更，已保留本地编辑。'
  })
});

export function getUiStrings(language: UiLanguage): UiStrings {
  return CATALOG[language];
}
