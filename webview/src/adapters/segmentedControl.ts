type SegmentedControlOption<Value extends string> = {
  value: Value;
  label: string;
  title?: string;
  renderLeading?: () => Node;
};

type SegmentedControlOptions<Value extends string> = {
  ariaLabel: string;
  className: string;
  buttonClassName: string;
  datasetKey: string;
  role: 'group' | 'tablist';
  /** CSS width for the whole control; omitted controls size to their content. */
  width?: string;
  buttonTitles?: boolean;
  options: readonly SegmentedControlOption<Value>[];
};

export const createSegmentedControl = <Value extends string>(options: SegmentedControlOptions<Value>) => {
  const element = document.createElement('div');
  element.className = `segmented-control ${options.className}`;
  if (options.width !== undefined) {
    element.classList.add('has-explicit-width');
    element.style.width = options.width;
  }
  element.setAttribute('role', options.role);
  element.setAttribute('aria-label', options.ariaLabel);

  const buttons = new Map<Value, HTMLButtonElement>();
  for (const option of options.options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `segmented-control-button ${options.buttonClassName}`;
    button.dataset[options.datasetKey] = option.value;
    if (options.buttonTitles !== false) button.title = option.title ?? option.label;
    if (options.role === 'tablist') {
      button.setAttribute('role', 'tab');
    }
    const indicator = document.createElement('span');
    indicator.className = 'segmented-control-button-indicator';
    indicator.setAttribute('aria-hidden', 'true');

    const content = document.createElement('span');
    content.className = 'segmented-control-button-content';
    if (option.renderLeading) {
      content.append(option.renderLeading());
    }
    const label = document.createElement('span');
    label.className = 'segmented-control-button-label';
    label.textContent = option.label;
    content.append(label);
    button.append(indicator, content);
    buttons.set(option.value, button);
    element.append(button);
  }

  return {
    element,
    getButton(value: Value) {
      const button = buttons.get(value);
      if (!button) {
        throw new Error(`Unknown segmented control value: ${value}`);
      }
      return button;
    },
    setActive(value: Value) {
      const previousButton = element.querySelector<HTMLButtonElement>('.segmented-control-button.is-active');
      const nextButton = buttons.get(value);
      const previousIndicator = previousButton?.querySelector<HTMLElement>('.segmented-control-button-indicator');
      const nextIndicator = nextButton?.querySelector<HTMLElement>('.segmented-control-button-indicator');
      const previousBounds = previousButton !== nextButton ? previousIndicator?.getBoundingClientRect() : undefined;
      if (previousBounds) nextIndicator?.getAnimations?.().forEach((animation) => animation.cancel());
      for (const [buttonValue, button] of buttons) {
        const active = buttonValue === value;
        button.classList.toggle('is-active', active);
        if (options.role === 'tablist') {
          button.setAttribute('aria-selected', active ? 'true' : 'false');
          button.tabIndex = active ? 0 : -1;
        } else {
          button.setAttribute('aria-pressed', active ? 'true' : 'false');
        }
      }
      if (!previousBounds || !nextIndicator || !element.isConnected || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      const nextBounds = nextIndicator.getBoundingClientRect();
      if (previousBounds.width === 0 || nextBounds.width === 0 || typeof nextIndicator.animate !== 'function') return;
      // Keep the pill's dimensions and corner radius unchanged throughout the slide.
      nextIndicator.animate([
        { transform: `translateX(${previousBounds.left - nextBounds.left}px)` },
        { transform: 'translateX(0)' }
      ], { duration: 150, easing: 'ease-out' });
    },
    setLabels(labels: Readonly<Partial<Record<Value, string>>>) {
      for (const [value, button] of buttons) {
        const label = labels[value];
        if (label === undefined) continue;
        if (options.buttonTitles !== false) button.title = label;
        const labelElement = button.querySelector<HTMLElement>('.segmented-control-button-label');
        if (labelElement) labelElement.textContent = label;
      }
    }
  };
};
