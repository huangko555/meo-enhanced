import { bindTooltips, createTooltip } from '../webview/src/adapters/tooltip';
import { focusRenderedBlockAction } from '../webview/src/helpers/renderedBlockActionFocus';
(window as any).TooltipLatencyHarness = { bindTooltips, createTooltip, focusRenderedBlockAction };
