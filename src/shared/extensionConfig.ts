import * as vscode from 'vscode';
import { getActiveVscodeRawTheme, type RawVscodeTheme } from './vscodeTheme';
import { DEFAULT_OUTLINE_WIDTH, normalizeOutlineWidth } from './outlineWidth';
export { normalizeOutlineWidth } from './outlineWidth';

export const EXTENSION_CONFIG_SECTION = 'meoEnhanced';
export const GIT_CHANGES_GUTTER_SETTING_KEY = 'gitChanges.visible';
export const GIT_DIFF_LINE_HIGHLIGHTS_SETTING_KEY = 'gitChanges.lineHighlights';
export const DIFF_BASELINE_MODE_SETTING_KEY = 'changes.baseline';
export const CONTENT_MAX_WIDTH_SETTING_KEY = 'contentMaxWidth.visible';
export const LARGE_DOCUMENT_OPTIMIZATION_SETTING_KEY = 'performance.largeDocumentOptimization';
export const GIT_CHANGES_GUTTER_LEGACY_VISIBLE_SETTING_KEY = 'gitChanges.visibility';
export const GIT_CHANGES_GUTTER_LEGACY_VISIBILITY_SETTING_KEY = 'gitChangesGutter.visibility';
export const GIT_CHANGES_GUTTER_LEGACY_SETTING_KEY = 'gitChangesGutter.enabled';
export const GIT_CHANGES_GUTTER_KEY = 'gitChangesGutterEnabled';
export const OUTLINE_VISIBLE_KEY = 'outlineVisible';
export const OUTLINE_WIDTH_KEY = 'outlineWidth';
export const CONTENT_MAX_WIDTH_ENABLED_KEY = 'contentMaxWidthEnabled';
export const MARKDOWN_FILE_EXTENSIONS = ['.md', '.markdown', '.mdx', '.mdc'] as const;

export type OutlinePosition = 'left' | 'right';
export type DiffBaselineMode = 'current-edit' | 'recent-save' | 'git-head';

export function getGitChangesGutterEnabled(context: vscode.ExtensionContext): boolean {
  return getToggleSettingValue(context, GIT_CHANGES_GUTTER_SETTING_KEY, GIT_CHANGES_GUTTER_KEY, [
    GIT_CHANGES_GUTTER_LEGACY_VISIBLE_SETTING_KEY,
    GIT_CHANGES_GUTTER_LEGACY_VISIBILITY_SETTING_KEY,
    GIT_CHANGES_GUTTER_LEGACY_SETTING_KEY
  ]);
}

export function getGitDiffLineHighlightsEnabled(): boolean {
  return vscode.workspace.getConfiguration(EXTENSION_CONFIG_SECTION).get<boolean>(GIT_DIFF_LINE_HIGHLIGHTS_SETTING_KEY, true);
}

export function getCurrentVscodeCodeTheme(): RawVscodeTheme | null {
  return getActiveVscodeRawTheme();
}

export function getOutlinePosition(): OutlinePosition {
  const value = vscode.workspace.getConfiguration(EXTENSION_CONFIG_SECTION).get<string>('outline.position', 'right');
  return value === 'left' ? 'left' : 'right';
}

export function getOutlineVisible(context: vscode.ExtensionContext): boolean {
  return context.globalState.get<boolean>(OUTLINE_VISIBLE_KEY, false);
}

export function getDiffBaselineMode(): DiffBaselineMode {
  const value = vscode.workspace
    .getConfiguration(EXTENSION_CONFIG_SECTION)
    .get<string>(DIFF_BASELINE_MODE_SETTING_KEY, 'current-edit');
  if (value === 'recent-save' || value === 'git-head') {
    return value;
  }
  return 'current-edit';
}

export function getOutlineWidth(context: vscode.ExtensionContext): number {
  return normalizeOutlineWidth(context.globalState.get<number>(OUTLINE_WIDTH_KEY, DEFAULT_OUTLINE_WIDTH));
}

export function getContentMaxWidthEnabled(context: vscode.ExtensionContext): boolean {
  return getToggleSettingValue(context, CONTENT_MAX_WIDTH_SETTING_KEY, CONTENT_MAX_WIDTH_ENABLED_KEY, [], false);
}

export function getLargeDocumentOptimizationEnabled(): boolean {
  return vscode.workspace
    .getConfiguration(EXTENSION_CONFIG_SECTION)
    .get<boolean>(LARGE_DOCUMENT_OPTIMIZATION_SETTING_KEY, true);
}

export function getExportEditorFontEnvironment(): { editorFontFamily?: string; editorFontWeight?: string; editorFontSizePx?: number } {
  const editorConfig = vscode.workspace.getConfiguration('editor');
  const fontFamily = `${editorConfig.get<string>('fontFamily', '') ?? ''}`.trim() || undefined;
  const editorFontWeight = `${editorConfig.get<string>('fontWeight', 'normal') ?? 'normal'}`.trim() || 'normal';
  const fontSize = editorConfig.get<number>('fontSize');
  return {
    editorFontFamily: fontFamily,
    editorFontWeight: editorFontWeight,
    editorFontSizePx: typeof fontSize === 'number' && Number.isFinite(fontSize) ? fontSize : undefined
  };
}

export function isMarkdownDocumentPath(filePath: string): boolean {
  return MARKDOWN_FILE_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

export function withMarkdownExtensions(basePath: string, preferExtensionlessFirst = false): string[] {
  const extensionCandidates = MARKDOWN_FILE_EXTENSIONS.map((extension) => `${basePath}${extension}`);
  return preferExtensionlessFirst ? [basePath, ...extensionCandidates] : [...extensionCandidates, basePath];
}

export async function migrateLegacyToggleSettings(context: vscode.ExtensionContext): Promise<void> {
  await migrateLegacyToggleSetting(context, GIT_CHANGES_GUTTER_SETTING_KEY, GIT_CHANGES_GUTTER_KEY);
  await migrateLegacyToggleSetting(context, CONTENT_MAX_WIDTH_SETTING_KEY, CONTENT_MAX_WIDTH_ENABLED_KEY);
}

export async function syncEditorAssociations(useAsDefault: boolean): Promise<void> {
  const config = vscode.workspace.getConfiguration('workbench');
  const inspected = config.inspect<Record<string, string>>('editorAssociations');
  const markdownAssociation = useAsDefault ? 'meoEnhanced.editor' : 'default';

  await syncEditorAssociationsForTarget(
    config,
    inspected?.globalValue,
    vscode.ConfigurationTarget.Global,
    markdownAssociation
  );
}

function getToggleSettingValue(
  context: vscode.ExtensionContext,
  settingKey: string,
  legacyStateKey: string,
  legacySettingKeys: readonly string[] = [],
  fallbackDefault = true
): boolean {
  const config = vscode.workspace.getConfiguration(EXTENSION_CONFIG_SECTION);
  if (hasExplicitConfigurationValue<boolean>(config, settingKey)) {
    return config.get<boolean>(settingKey, fallbackDefault);
  }
  for (const legacySettingKey of legacySettingKeys) {
    if (hasExplicitConfigurationValue<boolean>(config, legacySettingKey)) {
      return config.get<boolean>(legacySettingKey, fallbackDefault);
    }
  }
  return context.globalState.get<boolean>(legacyStateKey, fallbackDefault);
}

async function migrateLegacyToggleSetting(
  context: vscode.ExtensionContext,
  settingKey: string,
  legacyStateKey: string
): Promise<void> {
  const legacyValue = context.globalState.get<boolean | undefined>(legacyStateKey);
  if (typeof legacyValue !== 'boolean') {
    return;
  }

  const config = vscode.workspace.getConfiguration(EXTENSION_CONFIG_SECTION);
  if (hasExplicitConfigurationValue<boolean>(config, settingKey)) {
    return;
  }

  if (legacyValue === true) {
    return;
  }

  try {
    await config.update(settingKey, legacyValue, vscode.ConfigurationTarget.Global);
  } catch {
    // Ignore configuration write failures to avoid breaking editor startup.
  }
}

function hasExplicitConfigurationValue<T>(config: vscode.WorkspaceConfiguration, key: string): boolean {
  const inspected = config.inspect<T>(key);
  if (!inspected) {
    return false;
  }

  const languageScoped = inspected as typeof inspected & {
    globalLanguageValue?: T;
    workspaceLanguageValue?: T;
    workspaceFolderLanguageValue?: T;
  };

  return (
    inspected.globalValue !== undefined ||
    inspected.workspaceValue !== undefined ||
    inspected.workspaceFolderValue !== undefined ||
    languageScoped.globalLanguageValue !== undefined ||
    languageScoped.workspaceLanguageValue !== undefined ||
    languageScoped.workspaceFolderLanguageValue !== undefined
  );
}

async function syncEditorAssociationsForTarget(
  config: vscode.WorkspaceConfiguration,
  inspectedValue: Record<string, string> | undefined,
  target: vscode.ConfigurationTarget,
  markdownAssociation: string
): Promise<void> {
  const markdownAssociations = {
    ...inspectedValue,
    '*.md': markdownAssociation,
    '*.markdown': markdownAssociation,
    '*.mdx': markdownAssociation,
    '*.mdc': markdownAssociation,
    'git:/**/*.md': 'default',
    'git:/**/*.markdown': 'default',
    'git:/**/*.mdx': 'default',
    'git:/**/*.mdc': 'default',
    'git:**/*.md': 'default',
    'git:**/*.markdown': 'default',
    'git:**/*.mdx': 'default',
    'git:**/*.mdc': 'default',
    'chat-editing-text-model:/**/*.md': 'default',
    'chat-editing-text-model:/**/*.markdown': 'default',
    'chat-editing-text-model:/**/*.mdx': 'default',
    'chat-editing-text-model:/**/*.mdc': 'default',
    'chat-editing-text-model:**/*.md': 'default',
    'chat-editing-text-model:**/*.markdown': 'default',
    'chat-editing-text-model:**/*.mdx': 'default',
    'chat-editing-text-model:**/*.mdc': 'default'
  };

  await config.update('editorAssociations', markdownAssociations, target);
}
