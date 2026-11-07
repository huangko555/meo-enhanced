import { Check, Copy, createElement } from 'lucide';
import type { EditorEnvironment } from '../../../src/protocol/editorServices';
import type { UiLanguage } from '../../../src/foundation/uiLanguage';
import { settingsText } from '../application/settingsCatalog';

type VersionInformationOptions = {
  readonly productVersion: string;
  readonly readEnvironment: () => Promise<EditorEnvironment | null>;
  readonly copyText: (text: string) => Promise<boolean>;
};

/** Both surfaces share the same successful snapshot and in-flight host request. Failures remain retryable. */
export function createVersionInformationSource(options: VersionInformationOptions): VersionInformationOptions {
  let pending: Promise<EditorEnvironment | null> | undefined;
  return { ...options, readEnvironment() {
    return pending ??= Promise.resolve().then(options.readEnvironment).catch(() => null).then(value => {
      if (!value) pending = undefined;
      return value;
    });
  } };
}

/** Shared version presentation and clipboard formatting for About and the feedback popover. */
export function createVersionInformation(options: VersionInformationOptions & { readonly compact?: boolean }) {
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
    const value = document.createElement(tag); value.className = className; if (text !== undefined) value.textContent = text; return value;
  };
  let language: UiLanguage = 'en', environment: EditorEnvironment | null = null;
  let reading = false, readFailed = false, copying = false, copied = false, copyFailed = false;
  let disposed = false, visible = false, generation = 0, iconCopied: boolean | undefined;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  const t = (zh: string, en: string) => settingsText(language, zh, en);
  const element = node('section', options.compact ? 'feedback-version-information' : 'settings-about-runtime');
  const header = node('div', options.compact ? 'feedback-version-header' : 'settings-about-runtime-header');
  const heading = node('h4', options.compact ? 'feedback-version-title' : 'settings-about-section-title');
  const copy = node('button', 'settings-button ' + (options.compact ? 'feedback-version-copy' : 'settings-about-copy')); copy.type = 'button';
  copy.dataset.tooltipPlacement = options.compact ? 'top' : 'left'; copy.dataset.tooltipLiveUpdate = 'true';
  header.append(heading, copy);
  const values = node('dl', options.compact ? 'feedback-version-values' : 'settings-about-versions');
  const row = (label: string, value: string) => { const term = node('dt', '', label), detail = node('dd', '', value); values.append(term, detail); return detail; };
  row('MEO Enhanced', options.productVersion);
  const appVersion = row('VS Code', ''), system = row('', '');
  const remoteLabel = node('dt', ''), remote = node('dd', ''); values.append(remoteLabel, remote);
  const status = node('p', options.compact ? 'feedback-version-status' : 'settings-about-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const retry = node('button', 'settings-button ' + (options.compact ? 'feedback-version-retry' : 'settings-about-retry')); retry.type = 'button';
  element.append(header, values, status, retry);
  const copyStatus = node('span', 'feedback-version-copy-status'); copyStatus.setAttribute('role', 'status'); copyStatus.setAttribute('aria-live', 'polite');
  if (options.compact) element.append(copyStatus);

  function present() {
    heading.textContent = t('版本信息', 'Version information'); element.setAttribute('aria-label', heading.textContent);
    retry.textContent = t('重新读取', 'Retry');
    const waiting = t('读取中…', 'Loading…'), unavailable = t('暂时无法读取', 'Unavailable');
    appVersion.textContent = environment ? environment.appVersion : readFailed ? unavailable : waiting;
    appVersion.previousElementSibling!.textContent = environment?.appName.replace(/^Visual Studio Code$/, 'VS Code') ?? 'VS Code';
    system.previousElementSibling!.textContent = options.compact && environment?.remoteName ? t('远程系统', 'Remote OS') : t('系统', 'System');
    system.textContent = environment ? `${environment.system} · ${environment.architecture}` : readFailed ? unavailable : waiting;
    remoteLabel.textContent = t('远程环境', 'Remote');
    remoteLabel.hidden = remote.hidden = !environment?.remoteName; remote.textContent = environment?.remoteName ?? '';
    copy.disabled = !environment;
    if (copying) copy.setAttribute('aria-busy', 'true'); else copy.removeAttribute('aria-busy');
    const label = copied ? t('已复制', 'Copied') : t('复制版本信息', 'Copy version info');
    copy.setAttribute('aria-label', label);
    copy.dataset.tooltip = label;
    if (iconCopied !== copied) {
      copy.replaceChildren(createElement(copied ? Check : Copy, { width: 16, height: 16, 'aria-hidden': 'true' }));
      iconCopied = copied;
    }
    if (options.compact) copyStatus.textContent = copied ? label : '';
    const message = copyFailed ? t('复制失败，请重试。', 'Unable to copy. Please retry.')
      : readFailed ? t('版本信息读取失败，请重试。', 'Unable to load version information. Please retry.')
      : options.compact ? t('反馈时可附上这些信息', 'Include this in your feedback.')
      : copied ? t('版本信息已复制，可粘贴到问题反馈中。', 'Version information copied. Paste it into your feedback.')
      : environment?.remoteName ? t('系统信息来自远程扩展运行环境。', 'System information is from the remote extension environment.') : '';
    if (status.textContent !== message) status.textContent = message;
    status.hidden = !message; status.classList.toggle('is-error', copyFailed || readFailed); status.classList.toggle('is-copy-success', copied);
    retry.hidden = !readFailed;
  }
  async function readEnvironment() {
    if (reading || environment || disposed) return;
    reading = true; readFailed = false; present();
    try { environment = await options.readEnvironment(); } catch { environment = null; }
    reading = false; readFailed = !environment;
    if (!disposed && visible) present();
  }
  retry.addEventListener('click', () => void readEnvironment());
  copy.addEventListener('click', async () => {
    if (!environment || copying || disposed) return;
    const current = generation;
    const text = [`MEO Enhanced: ${options.productVersion}`, `${environment.appName}: ${environment.appVersion}`, `OS: ${environment.system} (${environment.architecture})`, ...(environment.remoteName ? [`Remote: ${environment.remoteName}`] : [])].join('\n');
    // The new copy owns feedback until its result; the previous success cannot expire mid-request.
    clearTimeout(copiedTimer);
    copying = true; present();
    let success = false;
    try { success = await options.copyText(text); } catch { /* Keep the existing inline retry feedback. */ }
    if (disposed || current !== generation) return;
    copying = false; copied = success; copyFailed = !success; present();
    if (options.compact && copied) copiedTimer = setTimeout(() => { copied = false; if (!disposed && visible) present(); }, 2000);
  });
  function close() { visible = false; generation++; clearTimeout(copiedTimer); copying = copied = copyFailed = false; }
  present();
  return { element,
    setLanguage(value: UiLanguage) { language = value; present(); },
    open() { if (disposed) return; visible = true; present(); void readEnvironment(); },
    close,
    dispose() { close(); disposed = true; }
  };
}
