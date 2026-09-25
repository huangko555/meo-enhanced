export const createMenuSwitch = (): HTMLSpanElement => {
  const toggle = document.createElement('span');
  toggle.className = 'menu-switch';
  toggle.setAttribute('aria-hidden', 'true');
  return toggle;
};
