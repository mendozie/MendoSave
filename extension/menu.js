// Keyboard behavior and viewport placement shared by the watch-page menu.
const activationHandlers = new WeakMap();
const disclosureSetters = new WeakMap();
const observedViews = new WeakSet();

function fit(menu) {
  const rect = menu.getBoundingClientRect(), view = menu.ownerDocument.defaultView;
  if (view?.innerWidth > 0 && view?.innerHeight > 0) {
    menu.style.left = `${Math.max(8, Math.min(rect.left, view.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.top, view.innerHeight - rect.height - 8))}px`;
  }
}
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

function icon(document, name = 'download') {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', name === 'download' ? '0 0 36 36' : '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (name === 'download') {
    const ring = document.createElementNS(namespace, 'circle');
    for (const [key, value] of Object.entries({ cx: 18, cy: 18, r: 16.9, fill: 'none', stroke: '#35d477', 'stroke-width': 2.2 })) ring.setAttribute(key, value);
    const arrows = document.createElementNS(namespace, 'path');
    arrows.setAttribute('fill', '#35d477');
    arrows.setAttribute('d', 'M16 6h4v14l5-5 3 3-10 10L8 18l3-3 5 5V6z M7 28h22v3H7z');
    svg.append(ring, arrows);
  } else {
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('d', { back: 'm12 6-6 6 6 6M6 12h12', close: 'm6 6 12 12M18 6 6 18', chevron: 'm7 10 5 5 5-5',
      grip: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01' }[name] || 'm7 10 5 5 5-5');
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  }
  return svg;
}

function decorate(menu, { title = 'MendoSave', subtitle = '', close } = {}) {
  const document = menu.ownerDocument;
  menu.classList.add('mendo-menu');
  let header = menu.querySelector('.mendo-menu-header');
  if (!header) {
    header = document.createElement('div'); header.className = 'mendo-menu-header';
    const mark = document.createElement('span'); mark.className = 'mendo-menu-mark'; mark.append(icon(document));
    const text = document.createElement('div'); text.className = 'mendo-menu-titles';
    const heading = document.createElement('div'); heading.className = 'mendo-menu-title';
    const note = document.createElement('div'); note.className = 'mendo-menu-subtitle';
    text.append(heading, note); header.append(mark, text); menu.prepend(header);
  }
  header.querySelector('.mendo-menu-title').textContent = title;
  const note = header.querySelector('.mendo-menu-subtitle'); note.textContent = subtitle; note.hidden = !subtitle;
  if (close) {
    let button = header.querySelector('.mendo-menu-close');
    if (!button) {
      button = document.createElement('button'); button.type = 'button'; button.className = 'mendo-menu-close mendo-menu-control';
      button.setAttribute('aria-label', 'Закрыть меню'); button.title = 'Закрыть'; button.append(icon(document, 'close')); header.append(button);
    }
    onActivate(button, close);
  }
  return header;
}

function compact(menu, { groups = [], onToggle } = {}) {
  const document = menu.ownerDocument;
  for (const { title, items: input, limit = 2 } of groups) {
    const items = [...input].filter(item => menu.contains(item));
    if (!items.length) continue;
    const section = document.createElement('div'); section.className = 'mendo-menu-group';
    items[0].before(section);
    if (title) { const heading = document.createElement('div'); heading.className = 'mendo-menu-group-title'; heading.textContent = title; section.append(heading); }
    section.append(...items);
    const extra = items.slice(Math.max(1, limit));
    if (!extra.length) continue;
    const more = document.createElement('button'); more.type = 'button'; more.className = 'mendo-menu-more mendo-menu-control';
    const label = document.createElement('span'); more.append(label, icon(document, 'chevron'));
    let expanded = false;
    const setExpanded = value => {
      expanded = value;
      more.setAttribute('aria-expanded', String(expanded));
      label.textContent = expanded ? 'Свернуть' : `Ещё варианты · ${extra.length}`;
      for (const item of extra) { item.hidden = !expanded; item.tabIndex = expanded && !item.disabled && !item.classList.contains('disabled') ? 0 : -1; }
    };
    setExpanded(false);
    disclosureSetters.set(more, setExpanded);
    onActivate(more, () => {
      setExpanded(!expanded);
      if (onToggle) onToggle();
      else fit(menu);
    });
    section.append(more);
  }
}

// One current source per adapter. This stores successful UI metadata only;
// transport and job validation remain at their existing adapter boundaries.
function createState() {
  let route, source, metadata, view, validate;
  const attached = new WeakMap();
  const clear = () => { source = metadata = view = validate = undefined; };
  return {
    route(value) { if (route !== value || (validate && !validate())) clear(); route = value; },
    get(value) { if (source !== value || (validate && !validate())) { clear(); source = value; } return metadata; },
    set(value, data, guard) { if (source === value) { metadata = data; validate = guard; } },
    clear,
    remember(menu) {
      const context = menu && attached.get(menu);
      if (!context || context.source !== source) return;
      view = { signature: context.signature, expanded: [...menu.querySelectorAll('.mendo-menu-more')].map(control => control.getAttribute('aria-expanded') === 'true'),
        scrollTop: Math.max(0, Number(menu.scrollTop) || 0) };
    },
    attach(menu, value, signature) {
      attached.set(menu, { source: value, signature });
      if (source !== value) return;
      if (view?.signature !== signature) { view = undefined; return; }
      [...menu.querySelectorAll('.mendo-menu-more')].forEach((control, index) => disclosureSetters.get(control)?.(view.expanded[index] === true));
      menu.scrollTop = view.scrollTop;
    },
  };
}

function bind(menu, close, selector = '.mendosave-menu-item, .mendosave-menu-radio, .mendo-package-open') {
  const document = menu.ownerDocument, view = document.defaultView;
  if (view && !observedViews.has(view)) {
    observedViews.add(view);
    view.addEventListener('resize', () => { for (const openMenu of document.querySelectorAll('.mendo-menu')) fit(openMenu); });
  }
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'MendoSave');
  const controls = [...menu.querySelectorAll(`${selector}, .mendo-menu-control`)];
  const isDisabled = control => control.classList.contains('disabled') || control.disabled;
  const isHidden = control => Boolean(control.closest('[hidden]'));
  for (const control of controls) {
    const disabled = Boolean(isDisabled(control));
    control.tabIndex = disabled || isHidden(control) ? -1 : 0;
    control.setAttribute('role', control.classList.contains('mendosave-menu-radio') ? 'menuitemradio' : 'menuitem');
    control.setAttribute('aria-disabled', String(disabled));
    if (control.classList.contains('mendosave-menu-radio')) control.setAttribute('aria-checked', String(control.classList.contains('sel')));
  }
  const enabledControls = () => controls.filter(control => !isDisabled(control) && !isHidden(control));
  menu.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (event.key !== 'Escape' && event.target.closest?.('select,input,textarea,[contenteditable="true"]')) return;
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
  (enabledControls().find(control => !control.classList.contains('mendo-menu-close')) || enabledControls()[0])?.focus();
}

function place(menu, anchor, width, height) {
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(anchor.right - rect.width, width - rect.width - 8))}px`;
  const above = anchor.top - rect.height - 8;
  menu.style.top = `${above >= 8 ? above : Math.max(8, Math.min(anchor.bottom + 8, height - rect.height - 8))}px`;
}

globalThis.MendoMenu = { bind, place, activate, onActivate, icon, decorate, compact, createState };
if (typeof module !== 'undefined') module.exports = { bind, place, activate, onActivate, icon, decorate, compact, createState };
