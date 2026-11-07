import { Check, Copy, ExternalLink, Heart, createElement } from 'lucide';
import type { EditorEnvironment } from '../../../src/protocol/editorServices';
import type { UiLanguage } from '../../../src/foundation/uiLanguage';
import { aboutCatalog, settingsText } from '../application/settingsCatalog';
import { createPaymentIcon } from './paymentIcons';

type AboutItem = typeof aboutCatalog[number];
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
  const value = document.createElement(tag); value.className = className; if (text !== undefined) value.textContent = text; return value;
};

/** Owns the About presentation and its lazy environment/clipboard feedback. */
export function createAboutSettings(options: {
  readonly productVersion: string; readonly logoUrl: string;
  readonly openLink: (href: string) => void;
  readonly readEnvironment: () => Promise<EditorEnvironment | null>;
  readonly copyText: (text: string) => Promise<boolean>;
}) {
  let language: UiLanguage = 'en', environment: EditorEnvironment | null = null;
  let reading = false, readFailed = false, copying = false, copied = false, copyFailed = false;
  let disposed = false, visible = false, generation = 0;
  let updateValues = () => {};
  const t = (zh: string, en: string) => settingsText(language, zh, en);
  const external = (item: { readonly title: readonly [string, string]; readonly href: string }, className = 'settings-about-link') => {
    const link = node('a', className, t(item.title[0], item.title[1]));
    link.href = item.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.append(createElement(ExternalLink, { width: 13, height: 13, 'aria-hidden': 'true' }));
    link.addEventListener('click', event => { event.preventDefault(); options.openLink(item.href); }); return link;
  };
  async function readEnvironment() {
    if (reading || environment || disposed) return;
    reading = true; readFailed = false; updateValues();
    try { environment = await options.readEnvironment(); } catch { environment = null; }
    reading = false; readFailed = !environment;
    if (!disposed && visible) updateValues();
  }
  function render(nextLanguage: UiLanguage, items: readonly AboutItem[]) {
    language = nextLanguage;
    const page = node('div', 'settings-about-page');
    const project = items.find(item => item.id === 'project'), feedback = items.find(item => item.id === 'feedback');
    if (project || feedback) {
      const brand = node('header', 'settings-about-brand');
      if (options.logoUrl) { const logo = node('img', 'settings-about-logo'); logo.src = options.logoUrl; logo.alt = ''; logo.width = 72; logo.height = 72; brand.append(logo); }
      const identity = node('div', 'settings-about-identity');
      identity.append(node('h3', 'settings-about-name', 'MEO Enhanced'), node('p', 'settings-about-tagline', t(aboutCatalog[0].description[0], aboutCatalog[0].description[1])));
      const links = node('div', 'settings-about-project-links');
      if (project) links.append(external(project));
      if (feedback) links.append(external(feedback));
      identity.append(links); brand.append(identity); page.append(brand);
    }
    updateValues = () => {};
    if (project) {
      const runtime = node('section', 'settings-about-runtime'); runtime.setAttribute('aria-label', t('版本信息', 'Version information'));
      const header = node('div', 'settings-about-runtime-header');
      header.append(node('h4', 'settings-about-section-title', t('版本信息', 'Version information')));
      const copy = node('button', 'settings-button settings-about-copy'); copy.type = 'button';
      copy.dataset.tooltipPlacement = 'left'; copy.dataset.tooltipLiveUpdate = 'true';
      let iconCopied: boolean | undefined;
      header.append(copy);
      const values = node('dl', 'settings-about-versions');
      const row = (label: string, value: string) => { const term = node('dt', '', label), detail = node('dd', '', value); values.append(term, detail); return detail; };
      row('MEO Enhanced', options.productVersion);
      const appVersion = row('VS Code', ''), system = row(t('系统', 'System'), '');
      const remoteLabel = node('dt', '', t('远程环境', 'Remote')), remote = node('dd', ''); values.append(remoteLabel, remote);
      const status = node('p', 'settings-about-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      const retry = node('button', 'settings-button settings-about-retry', t('重新读取', 'Retry')); retry.type = 'button'; retry.addEventListener('click', () => void readEnvironment());
      runtime.append(header, values, status, retry); page.append(runtime);
      updateValues = () => {
        const waiting = t('读取中…', 'Loading…'), unavailable = t('暂时无法读取', 'Unavailable');
        appVersion.textContent = environment ? environment.appVersion : readFailed ? unavailable : waiting;
        appVersion.previousElementSibling!.textContent = environment?.appName.replace(/^Visual Studio Code$/, 'VS Code') ?? 'VS Code';
        system.textContent = environment ? `${environment.system} · ${environment.architecture}` : readFailed ? unavailable : waiting;
        remoteLabel.hidden = remote.hidden = !environment?.remoteName;
        remote.textContent = environment?.remoteName ?? '';
        copy.disabled = !environment;
        if (copying) copy.setAttribute('aria-busy', 'true'); else copy.removeAttribute('aria-busy');
        const copyLabel = copied ? t('已复制', 'Copied') : t('复制版本信息', 'Copy version info');
        if (copy.getAttribute('aria-label') !== copyLabel) copy.setAttribute('aria-label', copyLabel);
        if (copy.dataset.tooltip !== copyLabel) copy.dataset.tooltip = copyLabel;
        if (iconCopied !== copied) {
          copy.replaceChildren(createElement(copied ? Check : Copy, { width: 16, height: 16, 'aria-hidden': 'true' }));
          iconCopied = copied;
        }
        const statusText = copyFailed ? t('复制失败，请重试。', 'Unable to copy. Please retry.') : readFailed ? t('版本信息读取失败，请重试。', 'Unable to load version information. Please retry.') : copied ? t('版本信息已复制，可粘贴到问题反馈中。', 'Version information copied. Paste it into your feedback.') : environment?.remoteName ? t('系统信息来自远程扩展运行环境。', 'System information is from the remote extension environment.') : '';
        if (status.textContent !== statusText) status.textContent = statusText;
        status.hidden = !status.textContent; status.classList.toggle('is-error', copyFailed || readFailed); status.classList.toggle('is-copy-success', copied); retry.hidden = !readFailed;
      };
      copy.addEventListener('click', async () => {
        if (!environment || copying || disposed) return;
        const current = generation;
        const text = [`MEO Enhanced: ${options.productVersion}`, `${environment.appName}: ${environment.appVersion}`, `OS: ${environment.system} (${environment.architecture})`, ...(environment.remoteName ? [`Remote: ${environment.remoteName}`] : [])].join('\n');
        copying = true; updateValues();
        let success = false;
        try { success = await options.copyText(text); } catch { /* The same inline retry state handles clipboard failure. */ }
        if (disposed || current !== generation) return;
        copying = false; copied = success; copyFailed = !success; updateValues();
      });
      updateValues();
    }
    const platforms = items.filter(item => item.id === 'afdian' || item.id === 'kofi');
    if (platforms.length) {
      const support = node('section', 'settings-about-support');
      const heading = node('h4', 'settings-about-section-title'); heading.append(createElement(Heart, { width: 16, height: 16, 'aria-hidden': 'true' }), node('span', '', t('支持持续开发', 'Support development')));
      support.append(heading, node('p', 'settings-about-support-description', t('如果 MEO Enhanced 对你有帮助，欢迎支持项目的持续开发与维护。', 'If MEO Enhanced helps you, support its ongoing development and maintenance.')));
      const actions = node('div', 'settings-about-support-links');
      for (const item of platforms) {
        const link = external(item, 'settings-about-link settings-about-platform');
        const title = node('span', 'settings-about-platform-title', item.id === 'afdian' ? t('爱发电', 'Afdian') : 'Ko-fi');
        const payments = node('span', 'settings-about-payments');
        const methods = item.id === 'afdian'
          ? [['alipay', t('支付宝', 'Alipay')], ['wechat', t('微信支付', 'WeChat Pay')]] as const
          : [['paypal', 'PayPal'], ['visa', t('Visa 信用卡 / 借记卡（通过 PayPal）', 'Visa credit / debit card (via PayPal)')], ['mastercard', t('Mastercard 信用卡 / 借记卡（通过 PayPal）', 'Mastercard credit / debit card (via PayPal)')]] as const;
        for (const [name, label] of methods) payments.append(createPaymentIcon(name, label));
        const text = node('span', 'settings-about-platform-text'); text.append(title, payments);
        link.replaceChildren(text, createElement(ExternalLink, { width: 15, height: 15, 'aria-hidden': 'true' })); actions.append(link);
      }
      support.append(actions);
      support.append(node('p', 'settings-about-legal', t('免费开源。赞助完全自愿，不附带会员权益或服务承诺。', 'Free and open source. Tips are voluntary and do not include membership benefits or service commitments.'))); page.append(support);
    }
    return page;
  }
  function close() { visible = false; generation++; copying = copied = copyFailed = false; }
  return { render, open() { visible = true; updateValues(); void readEnvironment(); }, close, dispose() { close(); disposed = true; updateValues = () => {}; } };
}
