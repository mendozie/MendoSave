// Keyboard behavior and viewport placement shared by the watch-page menu.
function bind(menu, close) {
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'MendoSave');
  const controls = [...menu.querySelectorAll('.mendosave-menu-item, .mendosave-menu-radio')];
  for (const control of controls) {
    const disabled = control.classList.contains('disabled');
    control.tabIndex = disabled ? -1 : 0;
    control.setAttribute('role', control.classList.contains('mendosave-menu-radio') ? 'menuitemradio' : 'menuitem');
    control.setAttribute('aria-disabled', String(disabled));
    if (control.classList.contains('mendosave-menu-radio')) control.setAttribute('aria-checked', String(control.classList.contains('sel')));
  }
  const enabled = controls.filter((control) => !control.classList.contains('disabled'));
  menu.addEventListener('keydown', (event) => {
    if (!['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') { close(); return; }
    const current = enabled.find((control) => control.contains(event.target));
    const index = enabled.indexOf(current);
    if (event.key === 'Enter' || event.key === ' ') { current?.click(); return; }
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
      : (index + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length;
    enabled[target]?.focus();
  });
  enabled[0]?.focus();
}

function place(menu, anchor, width, height) {
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(anchor.right - rect.width, width - rect.width - 8))}px`;
  const above = anchor.top - rect.height - 8;
  menu.style.top = `${above >= 8 ? above : Math.max(8, Math.min(anchor.bottom + 8, height - rect.height - 8))}px`;
}

globalThis.MendoMenu = { bind, place };
if (typeof module !== 'undefined') module.exports = { bind, place };
