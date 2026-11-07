import { ExternalLink, Heart, createElement } from 'lucide';
import type { EditorEnvironment } from '../../../src/protocol/editorServices';
import type { UiLanguage } from '../../../src/foundation/uiLanguage';
import { aboutCatalog, settingsText } from '../application/settingsCatalog';
import { createPaymentIcon } from './paymentIcons';
import { createVersionInformation } from './versionInformation';

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
  let language: UiLanguage = 'en';
  const versionInformation = createVersionInformation(options);
  const t = (zh: string, en: string) => settingsText(language, zh, en);
  const external = (item: { readonly title: readonly [string, string]; readonly href: string }, className = 'settings-about-link') => {
    const link = node('a', className, t(item.title[0], item.title[1]));
    link.href = item.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.append(createElement(ExternalLink, { width: 13, height: 13, 'aria-hidden': 'true' }));
    link.addEventListener('click', event => { event.preventDefault(); options.openLink(item.href); }); return link;
  };
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
    versionInformation.setLanguage(language);
    if (project) {
      page.append(versionInformation.element);
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
  return { render, open: versionInformation.open, close: versionInformation.close, dispose: versionInformation.dispose };
}
