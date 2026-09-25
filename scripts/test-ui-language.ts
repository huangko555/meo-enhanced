import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeUiLanguagePreference,
  resolveUiLanguage
} from '../src/foundation/uiLanguage';
import { getReadingUiStrings } from '../src/export/readingUiLanguage';
import { getUiStrings } from '../webview/src/application/uiLanguage';

assert.equal(normalizeUiLanguagePreference('en'), 'en');
assert.equal(normalizeUiLanguagePreference('zh-CN'), 'zh-CN');
assert.equal(normalizeUiLanguagePreference('zh-cn'), 'auto');
assert.equal(normalizeUiLanguagePreference(null), 'auto');

assert.equal(resolveUiLanguage('en', 'zh-cn'), 'en');
assert.equal(resolveUiLanguage('zh-CN', 'en'), 'zh-CN');
assert.equal(resolveUiLanguage('auto', 'zh-CN'), 'zh-CN');
assert.equal(resolveUiLanguage('auto', 'ZH-cn'), 'zh-CN');
assert.equal(resolveUiLanguage('auto', 'zh-TW'), 'en');
assert.equal(resolveUiLanguage('invalid', 'en'), 'en');
assert.deepEqual(
  [getReadingUiStrings('zh-CN').properties, getReadingUiStrings('zh-CN').alertLabel('WARNING')],
  ['Properties', '警告']
);

const english = getUiStrings('en');
const chinese = getUiStrings('zh-CN');
assert.equal(english.properties, 'Properties');
assert.equal(chinese.properties, 'Properties');
assert.equal(getReadingUiStrings('en').properties, 'Properties');
assert.equal(english.exportHtml, 'Export HTML');
assert.equal(english.exportDocument, 'Export…');
assert.deepEqual(
  [english.previewFontFamily, english.previewCodeColors, english.previewAppearance],
  ['Font', 'Code color', 'Preview theme']
);
assert.deepEqual([english.more, english.moreTools], ['Settings', 'Settings']);
assert.deepEqual([chinese.more, chinese.moreTools], ['设置', '设置']);
assert.deepEqual(
  [english.editorSettings, chinese.editorSettings, english.displaySettings, chinese.displaySettings],
  ['Editor Settings', '编辑器设置', 'Display Settings', '显示设置']
);
assert.deepEqual([english.refreshImage, chinese.refreshImage], ['Refresh image', '刷新图片']);
assert.deepEqual(
  [english.constrainContentWidth, chinese.constrainContentWidth],
  ['Constrain Content Width', '限制内容宽度']
);
assert.deepEqual(
  [english.stickyTableHeader, chinese.stickyTableHeader],
  ['Keep table headers visible', '表格浮动表头']
);
assert.deepEqual(
  [english.largeDocumentStartup, chinese.largeDocumentStartup],
  ['Open large documents faster', '快速打开大文档']
);
assert.deepEqual(
  [english.resumeFromLastPosition, chinese.resumeFromLastPosition],
  ['Resume from last position', '打开时恢复上一次阅读位置']
);
assert.deepEqual([english.feedbackPrompt, english.reportIssue], ['Having trouble?', 'Report an issue']);
assert.deepEqual([chinese.feedbackPrompt, chinese.reportIssue], ['使用中遇到问题？', '欢迎反馈']);
assert.equal(english.line, 'Lines');
assert.equal(chinese.line, '行号');
assert.equal(chinese.exportHtml, '导出 HTML');
assert.equal(chinese.exportDocument, '导出…');
assert.equal(english.findMatches(2), '2 matches');
assert.equal(chinese.findMatches(2), '2 个匹配项');
assert.equal(chinese.replacedRemaining(3), '已替换 • 剩余 3 个');
assert.equal(chinese.outlineNoHeadings, '暂无标题');
assert.equal(chinese.outlineCollapseTopTwo, '只显示一级标题');
assert.equal(english.outlineCollapseTopTwo, 'Show top level only');
assert.equal(chinese.previewFontUnavailable, '无法获取本地字体列表；请手动输入字体名称');
assert.equal(chinese.untitled, '未命名');
assert.equal(chinese.backToTop, '回到顶部');
assert.equal(chinese.markTaskComplete, '标记任务为已完成');
assert.equal(chinese.jumpToFootnoteReference(2), '跳转到脚注引用 2');
assert.equal(chinese.copyCode, '复制代码');
assert.equal(chinese.showMoreCode(9), '显示其余 9 行代码');
assert.deepEqual(
  [chinese.loading, chinese.zoomIn, chinese.zoomOut, chinese.resetZoom, chinese.fullscreen, chinese.exitFullscreen],
  ['正在加载…', '放大', '缩小', '重置缩放', '全屏', '退出全屏']
);
assert.deepEqual(
  [chinese.colorLabel('#ff0000'), chinese.acceptCurrent, chinese.acceptIncoming, chinese.acceptBoth],
  ['颜色 #ff0000', '接受当前更改', '接受传入更改', '接受两者']
);
assert.deepEqual(
  [chinese.tableActions, chinese.insertRowAbove, chinese.alignColumnRight],
  ['表格操作', '在上方插入行', '所选列右对齐']
);
assert.equal(chinese.headingLevel(3), '3 级标题');
assert.deepEqual(
  [chinese.markdownMode, chinese.live, chinese.source, chinese.preview],
  ['Markdown 模式', '实时', '源码', '预览']
);
assert.deepEqual(
  [chinese.recentSave, chinese.beforeLastSaveVersionOption],
  ['Agent 编辑前版本', '与 Agent 编辑前版本比较']
);
assert.deepEqual(
  [english.recentSave, english.beforeLastSaveVersionOption],
  ['Before Agent Edits', 'Before Agent Edits']
);
assert.deepEqual(
  [english.currentDiskVersionOption, english.showBeforeChangeContent],
  ['Last Saved Version', 'Show Original · Source Only']
);
assert.deepEqual(
  [english.currentEdits, english.gitHeadStatus('not-repo'), english.gitHeadStatus('no-commits'), english.gitHeadStatus('error'), english.updateSnapshot],
  ['Last Saved Version', 'Not a Git Repo', 'No Commits', 'Temporary Error', 'Update']
);
assert.deepEqual(
  [chinese.clickToCreateSnapshot, english.clickToCreateSnapshot],
  ['点击创建', 'Click to Create']
);
assert.deepEqual(
  [chinese.gitHeadStatus('not-repo'), chinese.gitHeadStatus('ignored'), chinese.gitHeadStatus('untracked'), chinese.gitHeadStatus('error'), chinese.updateSnapshot],
  ['非 Git 仓库', 'Git 已忽略', '未跟踪文件', '暂不可用', '更新']
);
assert.equal(chinese.gitHeadStatus('not-repo'), '非 Git 仓库');
assert.equal(english.gitHeadStatus('git-unavailable'), 'Git Unavailable');
assert.deepEqual(
  [chinese.comparisonUnavailable, english.comparisonUnavailable],
  ['无法比较', 'Unable to Compare']
);
assert.deepEqual(
  [chinese.comparedWith('Git HEAD'), english.comparedWith('Git HEAD')],
  ['与Git HEAD对比', 'vs. Git HEAD']
);
assert.deepEqual(
  [chinese.inlineMarkdownFormatting, chinese.bold, chinese.inlineCode, chinese.underline],
  ['行内 Markdown 格式', '加粗', '行内代码', '下划线']
);
assert.equal(chinese.pasteImageFailure('格式错误'), '无法粘贴图片：格式错误');
assert.deepEqual(
  [english.dismissNotificationButton, english.noticeWarningTitle, english.retryLiveMode, english.restartEditor, english.switchToSourceMode],
  ['Dismiss', 'Action needed', 'Retry', 'Restart Editor', 'Switch to Source']
);
assert.deepEqual(
  [chinese.dismissNotificationButton, chinese.noticeWarningTitle, chinese.retryLiveMode, chinese.restartEditor, chinese.switchToSourceMode],
  ['关闭', '需要处理', '重试', '重启编辑器', '切换到源码']
);
assert.deepEqual(
  [
    english.noticeLiveModeUnavailableTitle,
    english.noticeEditorUpdateFailedTitle,
    english.noticeLiveRenderIssueTitle,
    english.noticeEditorLoadFailedTitle,
    english.noticeDocumentSyncFailedTitle,
    english.noticeExternalConflictTitle,
    english.noticeReloadDiskFailedTitle,
    english.noticeExternalFileModifiedTitle,
    english.noticeExternalFileDeletedTitle,
    english.noticePasteImageFailedTitle
  ],
  [
    'Live Mode unavailable',
    'Editor update failed',
    'Live rendering interrupted',
    'Editor failed to load',
    'Document sync failed',
    'External change detected',
    'Disk reload failed',
    'File changed on disk',
    'File deleted on disk',
    'Image paste failed'
  ]
);
assert.deepEqual(
  [
    chinese.noticeLiveModeUnavailableTitle,
    chinese.noticeEditorUpdateFailedTitle,
    chinese.noticeLiveRenderIssueTitle,
    chinese.noticeEditorLoadFailedTitle,
    chinese.noticeDocumentSyncFailedTitle,
    chinese.noticeExternalConflictTitle,
    chinese.noticeReloadDiskFailedTitle,
    chinese.noticeExternalFileModifiedTitle,
    chinese.noticeExternalFileDeletedTitle,
    chinese.noticePasteImageFailedTitle
  ],
  [
    '实时模式不可用',
    '编辑器更新失败',
    '实时渲染暂时中断',
    '编辑器加载失败',
    '文档同步失败',
    '检测到外部修改',
    '磁盘重新加载失败',
    '磁盘文件已修改',
    '磁盘文件已删除',
    '图片粘贴失败'
  ]
);
assert.deepEqual(
  [
    chinese.externalFileModifiedNotice,
    chinese.externalFileDeletedNotice,
    chinese.reloadDiskFailureNotice,
    chinese.externalConflictNotice,
    chinese.resyncFailureNotice
  ],
  [
    '磁盘文件已被外部修改。未保存的编辑已保留，请在保存前查看变更。',
    '磁盘文件已被外部删除。未保存的编辑已保留，请在保存前确认如何处理。',
    '无法从磁盘重新加载最新版本，已保留本地编辑。',
    '文档发生外部变化时，本地编辑尚未应用完成。当前编辑已保留。',
    '无法重新同步文档，已保留本地编辑。'
  ]
);
assert.equal(Object.isFrozen(english), true);
assert.equal(Object.isFrozen(chinese), true);

const repoRoot = path.resolve(import.meta.dir, '..');
const webviewIndexText = fs.readFileSync(path.join(repoRoot, 'webview/src/index.ts'), 'utf8');
assert.match(webviewIndexText, /appendMoreToolsOptionContent\([^\n]+constrainWidth\)/);
const packageText = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
const packageManifest = JSON.parse(packageText) as {
  contributes?: {
    commands?: Array<{ command?: string; title?: string }>;
    configuration?: { properties?: Record<string, { type?: string; default?: unknown }> };
  };
};
assert.equal(
  packageManifest.contributes?.commands?.find((command) => command.command === 'meoEnhanced.toggleEditor')?.title,
  'MEO+'
);
assert.deepEqual(
  packageManifest.contributes?.configuration?.properties?.['meoEnhanced.table.stickyHeader'],
  {
    type: 'boolean',
    default: true,
    order: 4,
    description: '%config.table.stickyHeader%'
  }
);
assert.deepEqual(
  packageManifest.contributes?.configuration?.properties?.['meoEnhanced.readingPosition.restoreOnOpen'],
  {
    type: 'boolean',
    default: true,
    order: 5,
    description: '%config.readingPosition.restoreOnOpen%'
  }
);
const englishNls = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.nls.json'), 'utf8')) as Record<string, string>;
const chineseNls = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.nls.zh-cn.json'), 'utf8')) as Record<string, string>;
const referencedNlsKeys = [...packageText.matchAll(/%([^%]+)%/g)].map((match) => match[1]);
assert.deepEqual(Object.keys(chineseNls).sort(), Object.keys(englishNls).sort());
for (const key of referencedNlsKeys) {
  assert.equal(typeof englishNls[key], 'string', `Missing English package NLS key: ${key}`);
  assert.equal(typeof chineseNls[key], 'string', `Missing Chinese package NLS key: ${key}`);
  assert.notEqual(englishNls[key], '');
  assert.notEqual(chineseNls[key], '');
}

console.log('UI language checks passed');
