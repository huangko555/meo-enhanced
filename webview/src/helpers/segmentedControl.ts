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
  options: readonly SegmentedControlOption<Value>[];
};

export const createSegmentedControl = <Value extends string>(options: SegmentedControlOptions<Value>) => {
  const element = document.createElement('div');
  element.className = `segmented-control ${options.className}`;
  element.setAttribute('role', options.role);
  element.setAttribute('aria-label', options.ariaLabel);

  const buttons = new Map<Value, HTMLButtonElement>();
  for (const option of options.options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `segmented-control-button ${options.buttonClassName}`;
    button.dataset[options.datasetKey] = option.value;
    button.title = option.title ?? option.label;
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
    }
  };
};
