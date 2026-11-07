import { createAboutSettings } from '../webview/src/adapters/aboutSettings';
import { bindTooltips } from '../webview/src/adapters/tooltip';
import { aboutCatalog } from '../webview/src/application/settingsCatalog';
import { applyBuiltInVisualBaseline } from '../webview/src/helpers/theme';
import { createVersionInformation, createVersionInformationSource } from '../webview/src/adapters/versionInformation';
import { createFeedbackVersionPopover } from '../webview/src/adapters/feedbackVersionPopover';

// Keep the browser fixture on the production seams. The test owns the page
// and clipboard callback; this entry only exposes the real renderer helpers.
(window as any).AboutCopyHarness = {
  createAboutSettings,
  bindTooltips,
  aboutCatalog,
  applyBuiltInVisualBaseline,
  createVersionInformation, createVersionInformationSource, createFeedbackVersionPopover
};
