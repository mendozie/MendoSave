(() => {
  const schema = globalThis.MendoInstagramSource;
  const media = globalThis.MendoInstagramMedia;
  const packages = globalThis.MendoPackageUI;
  const readerAPI = globalThis.MendoInstagramReader;
  if (!schema || !media || !packages || !readerAPI || window.__mendosaveInstagramUI) return;
  window.__mendosaveInstagramUI = true;
  let button, menu, status, pending, sourceHref = '', revision = 0, work = null;
  const executor = media.create({ schema, packageUI: packages, runtime: chrome.runtime });
  const reader = readerAPI.create({ schema });
  const element = (tag, className, text) => {
    const node = document.createElement(tag); node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  function abortPending() { pending?.abort(); pending = null; }
  function closeMenu() { ++revision; abortPending(); menu?.remove(); menu = null; status = null; }
  function updateStatus(text) { if (status) status.textContent = text; }
  async function readPost(selected) {
    abortPending();
    const controller = new AbortController();
    pending = controller;
    try {
      const post = await reader.read(selected, { signal: controller.signal });
      if (controller.signal.aborted) throw new DOMException('Запрос отменён', 'AbortError');
      if (!schema.same(selected, schema.source(location.href))) throw schema.error('SOURCE_MISMATCH');
      return schema.projection(post, selected);
    } finally { if (pending === controller) pending = null; }
  }
  function bindMenu() {
    globalThis.MendoMenu.bind(menu, closeMenu, '.mendosave-instagram-item,.mendo-package-open,.mendosave-instagram-cancel');
  }
  function addCancel() {
    const cancel = element('button', 'mendosave-instagram-cancel', 'Отменить загрузку'); cancel.type = 'button';
    cancel.hidden = true; cancel.disabled = true;
    globalThis.MendoMenu.onActivate(cancel, () => { work?.controller.abort(); packages.cancel?.(); updateStatus('Отмена…'); });
    menu.append(cancel);
  }
  function setBusy(busy) {
    if (!menu) return;
    for (const control of menu.querySelectorAll('.mendosave-instagram-item,.mendo-package-open')) {
      control.disabled = busy; control.tabIndex = busy ? -1 : 0;
      control.setAttribute('aria-disabled', String(busy));
    }
    const cancel = menu.querySelector('.mendosave-instagram-cancel');
    const restoreFocus = cancel === document.activeElement;
    cancel.hidden = !busy; cancel.disabled = !busy; cancel.tabIndex = busy ? 0 : -1;
    cancel.setAttribute('aria-disabled', String(!busy));
    if (busy) cancel.focus();
    else if (restoreFocus) menu.querySelector('.mendosave-instagram-item')?.focus();
  }
  async function run(post, choice) {
    if (work) throw new Error('Другая загрузка Instagram уже выполняется');
    if (!schema.same(schema.source(location.href), { shortcode: post.shortcode })) throw schema.error('SOURCE_MISMATCH');
    let finishWork;
    const state = { controller: new AbortController(), source: post.shortcode,
      done: new Promise(resolve => { finishWork = resolve; }) };
    work = state;
    const report = text => {
      if (work === state && schema.source(location.href)?.shortcode === state.source) updateStatus(text);
    };
    setBusy(true);
    try {
      report('Подготовка файла…');
      const filename = await executor.run(post, choice, { signal: state.controller.signal,
        onProgress: value => report(`${value.text || 'Загрузка'}${Number.isFinite(value.value) ? ` · ${Math.round(value.value * 100)}%` : ''}`) });
      report(`Готово: ${filename}`);
      return filename;
    } catch (failure) {
      report(failure.name === 'AbortError' ? 'Загрузка отменена' : `Ошибка: ${String(failure.message).slice(0, 200)}`);
      if (packages.running) throw failure;
    } finally {
      if (work === state) work = null;
      setBusy(false);
      finishWork();
    }
  }
  async function openMenu() {
    if (menu) { closeMenu(); return; }
    const selected = schema.source(location.href);
    if (!selected) return;
    const currentRevision = ++revision;
    menu = element('div', 'mendosave-instagram-menu');
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'MendoSave');
    menu.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); closeMenu(); button?.focus();
    });
    menu.append(element('strong', 'mendosave-instagram-heading', 'MendoSave · Instagram'));
    status = element('p', 'mendosave-instagram-status', work ? 'Загрузка выполняется…' : 'Читаю публикацию…');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    menu.append(status); addCancel(); document.body.append(menu);
    if (work) {
      const previous = work;
      setBusy(true); bindMenu();
      if (previous.source !== selected.shortcode) updateStatus('Завершаю предыдущую загрузку…');
      await previous.done;
      if (menu && currentRevision === revision && schema.same(selected, schema.source(location.href))) {
        closeMenu(); await openMenu();
      }
      return;
    }
    try {
      const post = await readPost(selected);
      if (!menu || currentRevision !== revision || !schema.same(selected, schema.source(location.href))) return;
      const choices = media.choices(post);
      if (!choices.length) throw new Error('В публикации нет доступных файлов');
      let previousGroup = '';
      for (const choice of choices) {
        if (choice.group !== previousGroup) menu.append(element('h3', 'mendosave-instagram-group', choice.group));
        previousGroup = choice.group;
        const item = element('button', 'mendosave-instagram-item', choice.label); item.type = 'button';
        globalThis.MendoMenu.onActivate(item, () => { void run(post, choice); }); menu.append(item);
      }
      const notices = [post.items.some(item => item.type === 'video' && item.hasAudio === false)
        ? 'Выберите файл. В публикации есть видео без звука.' : 'Выберите файл или несколько результатов в пакете.'];
      if (!post.caption.trim()) notices.push('Описания нет.');
      updateStatus(notices.join(' '));
      if (choices.length > 1) packages.add(menu, { title: `${post.username ? post.username + ' · ' : ''}${post.shortcode}`,
        source: `instagram:${post.shortcode}`, options: choices.map(choice => ({ ...choice, run: () => run(post, choice) })),
        close: closeMenu, back: async () => { closeMenu(); await openMenu(); return menu?.querySelector('.mendosave-instagram-item') || button; } });
      bindMenu();
    } catch (failure) {
      if (currentRevision === revision && failure.name !== 'AbortError') updateStatus(`Ошибка: ${String(failure.message).slice(0, 200)}`);
    }
  }
  function refresh() {
    const selected = schema.source(location.href);
    const nextHref = selected?.href || '';
    if (sourceHref !== nextHref) {
      sourceHref = nextHref; closeMenu();
      if (work) { work.controller.abort(); packages.cancel?.(); }
    }
    if (!selected || !document.body) { button?.remove(); button = null; return; }
    if (button?.isConnected) return;
    button = element('button', 'mendosave-instagram-btn', 'MendoSave ↓'); button.type = 'button';
    button.setAttribute('aria-label', 'MendoSave: скачать публикацию Instagram');
    globalThis.MendoMenu.onActivate(button, () => { void openMenu(); });
    button.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); globalThis.MendoMenu.activate(button, event); }
    });
    document.body.append(button);
  }
  document.addEventListener('click', event => {
    if (menu && !menu.contains(event.target) && !button?.contains(event.target)) closeMenu();
  });
  window.addEventListener('popstate', refresh);
  new MutationObserver(refresh).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(refresh, 800);
  refresh();
})();
