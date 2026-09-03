import {
  Bot,
  Camera,
  Check,
  ChevronDown,
  CircleAlert,
  Diff,
  FileClock,
  GitCommitHorizontal,
  MapPin,
  Save,
  createElement
} from 'lucide';
import type { GitBaselinePayload } from '../../../src/protocol/git';
import type {
  ChangesReviewDiffSummary,
  ChangesReviewUnavailableReason
} from '../application/changesReview';
import {
  getUiStrings,
  type GitHeadDisplayStatus,
  type UiLanguage
} from '../application/uiLanguage';

export type ChangesReviewBaseline = 'current-edit' | 'recent-save' | 'git-head' | 'manual';

export type ChangesReviewState = {
  readonly mode: 'live' | 'source' | 'preview';
  readonly baseline: ChangesReviewBaseline;
  readonly summary: ChangesReviewDiffSummary;
  readonly markersVisible: boolean;
  readonly beforeContentVisible: boolean;
  readonly gitBaseline: Pick<GitBaselinePayload, 'available' | 'tracked' | 'headOid' | 'reason'> | null;
  readonly manualSnapshot: { readonly exists: boolean; readonly updatedAt: number | null };
};

export type ChangesReviewIntent =
  | { readonly type: 'selectBaseline'; readonly baseline: Exclude<ChangesReviewBaseline, 'manual'> }
  | { readonly type: 'selectManualSnapshot' }
  | { readonly type: 'createManualSnapshot' }
  | { readonly type: 'updateManualSnapshot' }
  | { readonly type: 'setMarkersVisible'; readonly visible: boolean }
  | { readonly type: 'setBeforeContentVisible'; readonly visible: boolean };

export type ChangesReviewControl = {
  readonly element: HTMLElement;
  present(state: ChangesReviewState): void;
  setUiLanguage(language: UiLanguage): void;
  destroy(): void;
};

function appendIcon(target: HTMLElement, icon: Parameters<typeof createElement>[0], size = 16): void {
  target.appendChild(createElement(icon, { width: size, height: size, 'aria-hidden': 'true' }));
}

export function createChangesReviewControl(options: {
  readonly uiLanguage: UiLanguage;
  readonly onIntent: (intent: ChangesReviewIntent) => void;
}): ChangesReviewControl {
  const element = document.createElement('div');
  element.className = 'changes-review-control';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'changes-review-trigger';
  trigger.setAttribute('aria-haspopup', 'menu');
  const triggerIcon = document.createElement('span');
  triggerIcon.className = 'changes-review-trigger-icon';
  appendIcon(triggerIcon, Diff, 16);
  const triggerSummary = document.createElement('span');
  triggerSummary.className = 'changes-review-counts';
  const triggerChevron = document.createElement('span');
  triggerChevron.className = 'changes-review-chevron';
  appendIcon(triggerChevron, ChevronDown, 12);
  trigger.append(triggerIcon, triggerSummary, triggerChevron);

  const panel = document.createElement('div');
  panel.className = 'changes-review-panel';
  panel.setAttribute('role', 'menu');
  panel.hidden = true;
  element.append(trigger, panel);

  let language = options.uiLanguage;
  let state: ChangesReviewState = {
    mode: 'source',
    baseline: 'current-edit',
    summary: { status: 'pending', added: 0, deleted: 0 },
    markersVisible: false,
    beforeContentVisible: false,
    gitBaseline: null,
    manualSnapshot: { exists: false, updatedAt: null }
  };
  let open = false;

  const strings = () => getUiStrings(language);

  const gitHeadDisplayStatus = (): GitHeadDisplayStatus | null => {
    const git = state.gitBaseline;
    if (!git) return null;
    if (!git.available) {
      if (git.reason === 'git-unavailable' || git.reason === 'not-repo'
        || git.reason === 'ignored' || git.reason === 'not-file') return git.reason;
      return 'error';
    }
    if (git.reason === 'too-large' || git.reason === 'binary' || git.reason === 'error') {
      return git.reason;
    }
    if (!git.headOid) return 'no-commits';
    if (!git.tracked) return 'untracked';
    return null;
  };

  const gitHeadLabel = (option: boolean): string => {
    const value = strings();
    const status = gitHeadDisplayStatus();
    if (!status) return option ? value.gitHeadOption : value.gitHead;
    const statusLabel = value.gitHeadStatus(status);
    return option ? value.gitHeadOptionWithStatus(statusLabel) : value.gitHeadWithStatus(statusLabel);
  };

  const gitHeadUnavailable = (): boolean => {
    const status = gitHeadDisplayStatus();
    return status !== null && status !== 'untracked' && status !== 'no-commits';
  };

  const shortBaselineLabel = (baseline: ChangesReviewBaseline): string => {
    const value = strings();
    if (baseline === 'current-edit') return value.currentEdits;
    if (baseline === 'recent-save') return value.recentSave;
    if (baseline === 'git-head') return 'Git HEAD';
    return value.manualSnapshot;
  };

  const formatSnapshotTime = (updatedAt: number): string => {
    const date = new Date(updatedAt);
    if (!Number.isFinite(date.getTime())) return '';
    const now = new Date();
    const dateDay = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const daysAgo = Math.round((today - dateDay) / 86_400_000);
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    if (daysAgo === 0) return time;
    if (daysAgo === 1) return language === 'zh-CN' ? '昨天' : 'Yesterday';
    return language === 'zh-CN' ? '较早' : 'Earlier';
  };

  const formatManualSnapshotLabel = (): string => {
    const value = strings();
    if (!state.manualSnapshot.exists) return value.manualSnapshot;
    const time = state.manualSnapshot.updatedAt === null ? '' : formatSnapshotTime(state.manualSnapshot.updatedAt);
    if (!time) return value.manualSnapshot;
    return language === 'zh-CN'
      ? `${value.manualSnapshot}（${time}）`
      : `${value.manualSnapshot} (${time})`;
  };

  const appendCounts = (target: HTMLElement, counts: Pick<ChangesReviewDiffSummary, 'added' | 'deleted'>): string => {
    const value = strings();
    target.replaceChildren();
    const accessible: string[] = [];
    if (counts.added > 0) {
      const added = document.createElement('span');
      added.className = 'changes-review-count is-added';
      const sign = document.createElement('span');
      sign.className = 'changes-review-count-sign';
      sign.textContent = '+';
      added.append(sign, document.createTextNode(`${counts.added}`));
      target.appendChild(added);
      accessible.push(value.addedCount(counts.added));
    }
    if (counts.deleted > 0) {
      const deleted = document.createElement('span');
      deleted.className = 'changes-review-count is-deleted';
      const sign = document.createElement('span');
      sign.className = 'changes-review-count-sign';
      sign.textContent = '−';
      deleted.append(sign, document.createTextNode(`${counts.deleted}`));
      target.appendChild(deleted);
      accessible.push(value.deletedCount(counts.deleted));
    }
    if (!accessible.length) {
      const empty = document.createElement('span');
      empty.className = 'changes-review-empty';
      empty.textContent = value.noChanges;
      target.appendChild(empty);
      return value.noChanges;
    }
    return accessible.join(', ');
  };

  const createRadioOption = (
    baseline: Exclude<ChangesReviewBaseline, 'manual'>,
    label: string,
    iconData: Parameters<typeof createElement>[0],
    warning = false
  ): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'changes-review-option changes-review-baseline-option';
    button.dataset.baseline = baseline;
    button.setAttribute('role', 'menuitemradio');
    const selected = state.baseline === baseline;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-checked', selected ? 'true' : 'false');
    const icon = document.createElement('span');
    icon.className = 'changes-review-option-icon';
    appendIcon(icon, iconData);
    const text = document.createElement('span');
    text.className = 'changes-review-option-label';
    text.textContent = label;
    const check = document.createElement('span');
    check.className = 'changes-review-check';
    if (warning) {
      check.classList.add('is-warning');
      appendIcon(check, CircleAlert, 14);
    } else if (selected) {
      appendIcon(check, Check, 14);
    }
    button.append(icon, text, check);
    return button;
  };

  const createToggleOption = (
    kind: 'markers' | 'before-content',
    label: string,
    checked: boolean
  ): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'changes-review-option changes-review-toggle';
    button.dataset.toggle = kind;
    button.setAttribute('role', 'menuitemcheckbox');
    button.setAttribute('aria-checked', checked ? 'true' : 'false');
    const icon = document.createElement('span');
    icon.className = 'changes-review-option-icon';
    appendIcon(icon, kind === 'markers' ? MapPin : FileClock);
    const text = document.createElement('span');
    text.className = 'changes-review-option-label';
    text.textContent = label;
    const check = document.createElement('span');
    check.className = 'changes-review-check';
    if (checked) appendIcon(check, Check, 14);
    button.append(icon, text, check);
    return button;
  };

  const render = (): void => {
    const value = strings();
    const unavailableGitBaseline = state.baseline === 'git-head' && gitHeadUnavailable();
    const unavailableReason: ChangesReviewUnavailableReason | null = state.summary.status === 'unavailable'
      ? state.summary.reason
      : unavailableGitBaseline
        ? (gitHeadDisplayStatus() as ChangesReviewUnavailableReason)
        : null;
    const comparisonUnavailable = unavailableReason !== null;
    let accessibleSummary: string;
    if (comparisonUnavailable) {
      triggerSummary.replaceChildren();
      const unavailable = document.createElement('span');
      unavailable.className = 'changes-review-empty';
      unavailable.textContent = value.comparisonUnavailable;
      triggerSummary.appendChild(unavailable);
      accessibleSummary = `${value.comparisonUnavailable}: ${value.comparisonUnavailableReason(unavailableReason)}`;
    } else {
      accessibleSummary = appendCounts(triggerSummary, state.summary);
    }
    trigger.title = accessibleSummary;
    trigger.setAttribute('aria-label', accessibleSummary);
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    trigger.classList.toggle('is-open', open);
    panel.hidden = !open;
    if (!open) return;

    panel.replaceChildren();
    const header = document.createElement('div');
    header.className = 'changes-review-header';
    const headerCounts = document.createElement('span');
    headerCounts.className = 'changes-review-counts';
    let headerSummary: string;
    if (comparisonUnavailable) {
      headerCounts.textContent = value.comparisonUnavailable;
      headerSummary = value.comparisonUnavailable;
    } else {
      headerSummary = appendCounts(headerCounts, state.summary);
    }
    const separator = document.createElement('span');
    separator.className = 'changes-review-header-separator';
    separator.textContent = '·';
    const comparison = document.createElement('span');
    comparison.className = 'changes-review-header-baseline';
    comparison.textContent = comparisonUnavailable
      ? value.comparisonUnavailableReason(unavailableReason)
      : value.comparedWith(shortBaselineLabel(state.baseline));
    header.setAttribute(
      'aria-label',
      comparisonUnavailable
        ? `${headerSummary}: ${value.comparisonUnavailableReason(unavailableReason)}`
        : value.changesComparedWith(headerSummary, shortBaselineLabel(state.baseline))
    );
    header.append(headerCounts, separator, comparison);

    const baselineSection = document.createElement('div');
    baselineSection.className = 'changes-review-section';
    const baselineHeading = document.createElement('div');
    baselineHeading.className = 'changes-review-section-label';
    baselineHeading.textContent = value.compareWithVersion;
    const gitHeadOption = createRadioOption(
      'git-head',
      gitHeadLabel(true),
      GitCommitHorizontal,
      state.baseline === 'git-head' && gitHeadUnavailable()
    );
    baselineSection.append(
      baselineHeading,
      createRadioOption('current-edit', value.currentDiskVersionOption, Save),
      createRadioOption('recent-save', value.beforeLastSaveVersionOption, Bot),
      gitHeadOption
    );

    const snapshotRow = document.createElement('div');
    snapshotRow.className = 'changes-review-snapshot-row';
    snapshotRow.classList.toggle('is-empty', !state.manualSnapshot.exists);
    const snapshotSelect = document.createElement('button');
    snapshotSelect.type = 'button';
    snapshotSelect.className = 'changes-review-snapshot-select';
    snapshotSelect.classList.toggle('is-empty', !state.manualSnapshot.exists);
    snapshotSelect.classList.toggle('is-selected', state.baseline === 'manual');
    snapshotSelect.dataset.action = state.manualSnapshot.exists ? 'select-snapshot' : 'create-snapshot';
    snapshotSelect.setAttribute('role', 'menuitemradio');
    snapshotSelect.setAttribute('aria-checked', state.baseline === 'manual' ? 'true' : 'false');
    const snapshotIcon = document.createElement('span');
    snapshotIcon.className = 'changes-review-option-icon';
    appendIcon(snapshotIcon, Camera);
    const snapshotLabel = document.createElement('span');
    snapshotLabel.className = 'changes-review-option-label';
    snapshotLabel.textContent = formatManualSnapshotLabel();
    const snapshotCheck = document.createElement('span');
    snapshotCheck.className = 'changes-review-check';
    if (!state.manualSnapshot.exists) {
      snapshotCheck.classList.add('changes-review-snapshot-create-hint');
      snapshotCheck.textContent = value.clickToCreateSnapshot;
      const createDescription = language === 'zh-CN'
        ? `${value.createSnapshot}${value.manualSnapshot}`
        : `${value.createSnapshot} ${value.manualSnapshot}`;
      snapshotSelect.title = createDescription;
      snapshotSelect.setAttribute('aria-label', createDescription);
    } else if (state.baseline === 'manual') {
      appendIcon(snapshotCheck, Check, 14);
    }
    snapshotSelect.append(snapshotIcon, snapshotLabel, snapshotCheck);
    const snapshotAction = document.createElement('button');
    snapshotAction.type = 'button';
    snapshotAction.className = 'changes-review-snapshot-action';
    snapshotAction.dataset.action = state.manualSnapshot.exists ? 'update-snapshot' : 'create-snapshot';
    const snapshotActionText = state.manualSnapshot.exists ? value.updateSnapshot : value.createSnapshot;
    const snapshotActionDescription = language === 'zh-CN'
      ? `${snapshotActionText}${value.manualSnapshot}`
      : `${snapshotActionText} ${value.manualSnapshot}`;
    snapshotAction.textContent = snapshotActionText;
    snapshotAction.title = snapshotActionDescription;
    snapshotAction.setAttribute('aria-label', snapshotActionDescription);
    snapshotRow.append(snapshotSelect);
    if (state.manualSnapshot.exists) snapshotRow.append(snapshotAction);
    baselineSection.appendChild(snapshotRow);

    const displaySection = document.createElement('div');
    displaySection.className = 'changes-review-section';
    const displayHeading = document.createElement('div');
    displayHeading.className = 'changes-review-section-label';
    displayHeading.textContent = value.displaySettings;
    const markers = createToggleOption('markers', value.showChangeLocations, state.markersVisible);
    const sourceOnly = state.mode !== 'source';
    const beforeContent = createToggleOption(
      'before-content', value.showBeforeChangeContent, state.beforeContentVisible
    );
    if (sourceOnly) beforeContent.title = value.sourceModeOnly;
    displaySection.append(displayHeading, markers, beforeContent);
    panel.append(header, baselineSection, displaySection);
  };

  const setOpen = (nextOpen: boolean): void => {
    open = nextOpen;
    render();
  };

  const onClick = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('.changes-review-trigger')) {
      setOpen(!open);
      return;
    }
    const baseline = target.closest<HTMLElement>('[data-baseline]')?.dataset.baseline;
    if (baseline === 'current-edit' || baseline === 'recent-save' || baseline === 'git-head') {
      options.onIntent({ type: 'selectBaseline', baseline });
      return;
    }
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'select-snapshot') options.onIntent({ type: 'selectManualSnapshot' });
    if (action === 'create-snapshot') options.onIntent({ type: 'createManualSnapshot' });
    if (action === 'update-snapshot') options.onIntent({ type: 'updateManualSnapshot' });
    const toggle = target.closest<HTMLElement>('[data-toggle]')?.dataset.toggle;
    if (toggle === 'markers') options.onIntent({ type: 'setMarkersVisible', visible: !state.markersVisible });
    if (toggle === 'before-content') {
      options.onIntent({ type: 'setBeforeContentVisible', visible: !state.beforeContentVisible });
    }
  };

  const onDocumentPointerDown = (event: PointerEvent): void => {
    if (open && event.target instanceof Node && !element.contains(event.target)) setOpen(false);
  };
  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (open && event.key === 'Escape') {
      setOpen(false);
      trigger.focus();
    }
  };
  element.addEventListener('click', onClick);
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onDocumentKeyDown);
  render();

  return {
    element,
    present(nextState) {
      state = nextState;
      render();
    },
    setUiLanguage(nextLanguage) {
      language = nextLanguage;
      render();
    },
    destroy() {
      element.removeEventListener('click', onClick);
      document.removeEventListener('pointerdown', onDocumentPointerDown, true);
      document.removeEventListener('keydown', onDocumentKeyDown);
    }
  };
}
