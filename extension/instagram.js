(() => {
  const schema = globalThis.MendoInstagramSource;
  const media = globalThis.MendoInstagramMedia;
  const packages = globalThis.MendoPackageUI;
  const readerAPI = globalThis.MendoInstagramReader;
  if (!schema || !media || !packages || !readerAPI || window.__mendosaveInstagramUI) return;
  window.__mendosaveInstagramUI = true;
  let button, menu, status, pending, sourceHref = '', revision = 0, work = null, snapshot = null;
  let observedMedia = null;
  const geometryObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => positionButton()) : null;
  const executor = media.create({ schema, packageUI: packages, runtime: chrome.runtime });
  const reader = readerAPI.create({ schema });
  const element = (tag, className, text) => {
    const node = document.createElement(tag); node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  function abortPending() { pending?.abort(); pending = null; }
  function closeMenu() {
    if (snapshot && menu) snapshot.scrollTop = menu.scrollTop || 0;
    ++revision; abortPending(); menu?.remove(); menu = null; status = null;
  }
  function updateStatus(text) { if (status) status.textContent = text; }
  async function readPost(selected, { signal } = {}) {
    if (signal?.aborted) throw new DOMException('Запрос отменён', 'AbortError');
    if (snapshot?.href === selected.href && !snapshot.invalid) return snapshot.post;
    if (!signal) abortPending();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (!signal) pending = controller;
    try {
      const post = await reader.read(selected, { signal: controller.signal });
      if (controller.signal.aborted) throw new DOMException('Запрос отменён', 'AbortError');
      if (!schema.same(selected, schema.source(location.href))) throw schema.error('SOURCE_MISMATCH');
      const validated = schema.projection(post, selected);
      const previous = snapshot?.href === selected.href ? snapshot : null;
      snapshot = { href: selected.href, post: validated, qualities: new Map(previous?.qualities),
        extrasOpen: previous?.extrasOpen || false, scrollTop: previous?.scrollTop || 0 };
      return validated;
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (pending === controller) pending = null;
    }
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
    for (const control of menu.querySelectorAll('.mendosave-instagram-item,.mendo-package-open,.mendosave-instagram-quality')) {
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
  function describeChoices(post, choices) {
    const aspectRatios = new Map();
    return choices.map(choice => {
      const kind = choice.kind || (choice.group === 'Текст' ? 'caption' : 'photo');
      const index = Number.isInteger(choice.itemIndex) ? choice.itemIndex : 0;
      const item = post.items[index];
      const primary = kind === 'photo' || kind === 'video';
      const family = kind === 'caption' ? 'caption' : `${kind}:${index}`;
      const title = kind === 'caption' ? 'Описание автора' : `${kind === 'audio' ? 'Аудио' : kind === 'video' ? 'Видео' : 'Фото'} ${index + 1}`;
      const thumbnail = primary ? item?.imageVersions?.[0]?.url || '' : '';
      let detail = choice.label.replace(/^(?:Фото|Видео)\s*·\s*/, '');
      if (kind === 'photo' && choice.version?.width > 0 && choice.version?.height > 0) {
        const ratio = choice.version.width / choice.version.height;
        if (!aspectRatios.has(family)) aspectRatios.set(family, ratio);
        if (Math.abs(ratio / aspectRatios.get(family) - 1) > 0.01) detail += ' · другие пропорции';
      }
      return { ...choice, kind, family, title, thumbnail, secondary: !primary,
        detail };
    });
  }
  function addChoices(post, choices) {
    const families = new Map();
    for (const choice of choices) {
      if (!families.has(choice.family)) families.set(choice.family, []);
      families.get(choice.family).push(choice);
    }
    const extras = element('div', 'mendosave-instagram-extras');
    const extraChoices = choices.filter(choice => choice.secondary);
    extras.hidden = !snapshot.extrasOpen;
    for (const [family, variants] of families) {
      if (variants[0].secondary) {
        for (const choice of variants) {
          const item = element('button', 'mendosave-instagram-item mendosave-instagram-extra', choice.label);
          item.type = 'button';
          if (choice.kind === 'audio' && post.items.length > 1) item.append(element('small', '', `Элемент ${(choice.itemIndex || 0) + 1}`));
          globalThis.MendoMenu.onActivate(item, () => { void run(post, choice); }); extras.append(item);
        }
        continue;
      }
      let active = variants.find(choice => choice.id === snapshot.qualities.get(family)) || variants[0];
      const card = element('section', 'mendosave-instagram-card'); card.dataset.family = family;
      card.append(element('h3', 'mendosave-instagram-group', active.title));
      const item = element('button', 'mendosave-instagram-item'); item.type = 'button';
      const copy = element('span', 'mendosave-instagram-copy');
      const action = element('span', 'mendosave-instagram-action', active.kind === 'video' ? 'Скачать видео' : 'Скачать фото');
      const detail = element('small', 'mendosave-instagram-detail', active.label);
      copy.append(action, detail); item.append(globalThis.MendoMenu.icon(document), copy);
      globalThis.MendoMenu.onActivate(item, () => { void run(post, active); }); card.append(item);
      if (variants.length > 1) {
        const label = element('label', 'mendosave-instagram-quality-label', 'Качество');
        const select = element('select', 'mendosave-instagram-quality');
        select.setAttribute('aria-label', `Качество: ${active.title}`);
        variants.forEach((choice, index) => {
          const option = element('option', '', `${index === 0 ? 'Лучшее доступное · ' : ''}${choice.detail}`);
          option.value = choice.id; option.selected = choice.id === active.id; select.append(option);
        });
        select.addEventListener('change', event => {
          const next = variants.find(choice => choice.id === select.value);
          if (event.isTrusted && next && !select.disabled) {
            active = next; snapshot.qualities.set(family, active.id); detail.textContent = active.label;
          } else for (const option of select.options) option.selected = option.value === active.id;
        });
        label.append(select); card.append(label);
      }
      menu.append(card);
    }
    if (extraChoices.length) {
      const toggle = element('button', 'mendosave-instagram-extras-toggle mendo-menu-control', `Аудио и описание · ${extraChoices.length}`);
      toggle.type = 'button'; toggle.setAttribute('aria-expanded', String(!extras.hidden));
      toggle.append(globalThis.MendoMenu.icon(document, 'chevron'));
      globalThis.MendoMenu.onActivate(toggle, () => {
        extras.hidden = !extras.hidden; snapshot.extrasOpen = !extras.hidden;
        toggle.setAttribute('aria-expanded', String(!extras.hidden)); positionMenu();
      });
      menu.append(toggle, extras);
    }
  }
  function positionMenu() {
    if (!menu || !button || typeof menu.getBoundingClientRect !== 'function') return;
    const anchor = button.getBoundingClientRect();
    const available = window.innerWidth - anchor.right - 16;
    if (available >= 288) {
      menu.style.width = `${Math.min(360, available)}px`;
      menu.style.left = `${anchor.right + 8}px`;
      menu.style.top = `${Math.max(8, Math.min(anchor.top - 16, window.innerHeight - menu.getBoundingClientRect().height - 8))}px`;
    } else {
      menu.style.width = '';
      globalThis.MendoMenu.place(menu, anchor, window.innerWidth, window.innerHeight);
    }
  }
  function positionButton() {
    if (!button) return;
    const width = window.innerWidth, height = window.innerHeight;
    const visible = node => {
      const rect = node.getBoundingClientRect?.();
      if (!rect || rect.width < 20 || rect.height < 20) return null;
      const area = Math.max(0, Math.min(width, rect.right) - Math.max(0, rect.left))
        * Math.max(0, Math.min(height, rect.bottom) - Math.max(0, rect.top));
      return area ? { node, rect, area } : null;
    };
    const reel = /(?:^|\/)reels?\//.test(location.pathname);
    const candidates = [...document.querySelectorAll(reel ? 'video' : 'article video,article img,main video,main img,[role="dialog"] video,[role="dialog"] img')]
      .slice(0, 200).map(visible).filter(candidate => candidate && candidate.rect.width >= 100 && candidate.rect.height >= 100)
      .sort((a, b) => b.area - a.area);
    const active = candidates[0];
    if (observedMedia !== (active?.node || null)) {
      geometryObserver?.disconnect(); observedMedia = active?.node || null;
      if (observedMedia) geometryObserver?.observe(observedMedia);
    }
    let left = width - 60, top = 80;
    if (active) {
      left = active.rect.right + 12; top = active.rect.top + 12;
      const article = active.node.closest('article')?.getBoundingClientRect?.();
      if (article && article.width >= active.rect.width && article.right + 64 <= width) {
        left = article.right + 12; top = article.top + 12;
      }
      if (active.node.tagName === 'VIDEO') {
        let parent = active.node.parentElement;
        for (let depth = 0; parent && parent !== document.body && depth < 20; depth++, parent = parent.parentElement) {
          if (parent.querySelectorAll('video').length > 1) break;
          const like = [...parent.querySelectorAll('svg[aria-label]')].slice(0, 256)
            .filter(node => /^(?:Like|Unlike|Нравится|Не нравится|Отметка «Нравится»|Отменить отметку «Нравится»)$/i.test(node.getAttribute('aria-label')))
            .map(visible).find(candidate => candidate && candidate.rect.left >= active.rect.right - 48
              && candidate.rect.left <= active.rect.right + 160 && candidate.rect.top >= active.rect.top
              && candidate.rect.top < active.rect.bottom);
          if (like) { left = like.rect.left + like.rect.width / 2 - 22; top = like.rect.top - 58; break; }
        }
      }
    }
    button.style.left = `${Math.max(8, Math.min(left, width - 52))}px`;
    button.style.top = `${Math.max(8, Math.min(top, height - 52))}px`;
    positionMenu();
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
      post = await readPost(schema.source(location.href), { signal: state.controller.signal });
      const fresh = media.choices(post).find(candidate => candidate.id === choice.id
        && (candidate.compatibilityKey || candidate.id) === (choice.compatibilityKey || choice.id));
      if (!fresh) throw new Error('Этот вариант изменился. Вернитесь к меню публикации и выберите качество заново.');
      choice = fresh;
      report('Подготовка файла…');
      const filename = await executor.run(post, choice, { signal: state.controller.signal,
        onProgress: value => report(`${value.text || 'Загрузка'}${Number.isFinite(value.value) ? ` · ${Math.round(value.value * 100)}%` : ''}`) });
      report(`Готово: ${filename}`);
      return filename;
    } catch (failure) {
      if (failure.name !== 'AbortError' && snapshot?.post.shortcode === state.source) snapshot.invalid = true;
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
    globalThis.MendoMenu.decorate(menu, { title: 'MendoSave', subtitle: 'Instagram', close: () => { closeMenu(); button?.focus(); } });
    status = element('p', 'mendosave-instagram-status', work ? 'Загрузка выполняется…' : 'Читаю публикацию…');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    menu.append(status); addCancel(); document.body.append(menu); positionMenu();
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
      const choices = describeChoices(post, media.choices(post));
      if (!choices.length) throw new Error('В публикации нет доступных файлов');
      addChoices(post, choices);
      const notices = [post.items.some(item => item.type === 'video' && item.hasAudio === false)
        ? 'Выберите файл. В публикации есть видео без звука.' : 'Выберите файл или несколько результатов в пакете.'];
      if (!post.caption.trim()) notices.push('Описания нет.');
      updateStatus(notices.join(' '));
      if (choices.length > 1) packages.add(menu, { title: `${post.username ? post.username + ' · ' : ''}${post.shortcode}`,
        source: `instagram:${post.shortcode}`, options: choices.map(choice => ({ ...choice, run: () => run(post, choice) })),
        close: closeMenu, back: async () => { closeMenu(); await openMenu(); return menu?.querySelector('.mendosave-instagram-item') || button; } });
      bindMenu(); positionMenu(); menu.scrollTop = snapshot.scrollTop;
    } catch (failure) {
      if (currentRevision === revision && failure.name !== 'AbortError') updateStatus(`Ошибка: ${String(failure.message).slice(0, 200)}`);
    }
  }
  function refresh() {
    const selected = schema.source(location.href);
    const nextHref = selected?.href || '';
    if (sourceHref !== nextHref) {
      sourceHref = nextHref; closeMenu(); snapshot = null;
      if (work) { work.controller.abort(); packages.cancel?.(); }
    }
    if (!selected || !document.body) {
      button?.remove(); button = null; geometryObserver?.disconnect(); observedMedia = null; return;
    }
    if (!button?.isConnected) {
      button = element('button', 'mendosave-instagram-btn'); button.type = 'button'; button.title = 'MendoSave';
      button.setAttribute('aria-label', 'MendoSave: скачать публикацию Instagram');
      button.append(globalThis.MendoMenu.icon(document));
      globalThis.MendoMenu.onActivate(button, () => { void openMenu(); });
      button.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); globalThis.MendoMenu.activate(button, event); }
      });
      document.body.append(button);
    }
    positionButton();
  }
  document.addEventListener('click', event => {
    if (menu && !menu.contains(event.target) && !button?.contains(event.target)) closeMenu();
  });
  window.addEventListener('popstate', refresh);
  window.addEventListener('resize', () => { positionButton(); window.requestAnimationFrame?.(positionButton); });
  window.addEventListener('scroll', positionButton, { capture: true, passive: true });
  new MutationObserver(refresh).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(refresh, 800);
  refresh();
})();
