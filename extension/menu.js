// Keyboard behavior and viewport placement shared by the watch-page menu.
const activationHandlers = new WeakMap();
function activate(control, event) {
  if (event?.isTrusted !== true || event.repeat || control.disabled || control.classList.contains('disabled')) return;
  if (event.type !== 'click' && !(event.type === 'keydown' && (event.key === 'Enter' || event.key === ' '))) return;
  return activationHandlers.get(control)?.call(control, event);
}

function onActivate(control, action) {
  if (!activationHandlers.has(control)) control.addEventListener('click', event => {
    if (event.isTrusted !== true) { event.preventDefault(); event.stopPropagation(); return; }
    activate(control, event);
  });
  activationHandlers.set(control, action);
}

function bind(menu, close, selector = '.mendosave-menu-item, .mendosave-menu-radio, .mendo-package-open') {
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'MendoSave');
  const controls = [...menu.querySelectorAll(selector)];
  const isDisabled = control => control.classList.contains('disabled') || control.disabled;
  for (const control of controls) {
    const disabled = Boolean(isDisabled(control));
    control.tabIndex = disabled ? -1 : 0;
    control.setAttribute('role', control.classList.contains('mendosave-menu-radio') ? 'menuitemradio' : 'menuitem');
    control.setAttribute('aria-disabled', String(disabled));
    if (control.classList.contains('mendosave-menu-radio')) control.setAttribute('aria-checked', String(control.classList.contains('sel')));
  }
  const enabledControls = () => controls.filter(control => !isDisabled(control));
  menu.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (!['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') { close(); return; }
    const enabled = enabledControls();
    const current = enabled.find((control) => control.contains(event.target));
    const index = enabled.indexOf(current);
    if (event.key === 'Enter' || event.key === ' ') { if (current) activate(current, event); return; }
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
      : index < 0 ? (event.key === 'ArrowUp' ? enabled.length - 1 : 0)
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length;
    enabled[target]?.focus();
  });
  enabledControls()[0]?.focus();
}

function place(menu, anchor, width, height) {
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(anchor.right - rect.width, width - rect.width - 8))}px`;
  const above = anchor.top - rect.height - 8;
  menu.style.top = `${above >= 8 ? above : Math.max(8, Math.min(anchor.bottom + 8, height - rect.height - 8))}px`;
}

globalThis.MendoMenu = { bind, place, activate, onActivate };
if (typeof module !== 'undefined') module.exports = { bind, place, activate, onActivate };
