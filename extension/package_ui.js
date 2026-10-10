(() => {
  function create({ runtime, document, fetch: fetcher = globalThis.fetch, queue = globalThis.MendoPackageQueue }) {
    let current = null;
    const interrupted = (code) => {
      const error = new Error(`Сохранение прервано: ${code || 'ошибка браузера'}`);
      if (code === 'USER_CANCELED' || code === 'USER_CANCELLED') { error.name = 'AbortError'; error.cancelled = true; }
      throw error;
    };
    const check = () => { if (current?.controller.signal.aborted) interrupted('USER_CANCELED'); };
    const raw = async (message) => {
      const response = await runtime.sendMessage(message);
      if (response?.cancelled) interrupted('USER_CANCELED');
      return response;
    };
    const requireOk = (response) => {
      if (!response?.ok) throw new Error(response?.error || 'Обработчик не подтвердил операцию');
      return response;
    };
    const api = {
      get running() { return Boolean(current); },
      get signal() { return current?.controller.signal || null; },
      check,
      interruption: interrupted,
      async send(message) {
        if (!/abort|cancel|mendosave-log|mendosave-error/.test(message.t || '')) check();
        const response = await raw(current ? { ...message, packageId: current.id, packageIndex: current.index } : message);
        if (current && response?.ok && /mendosave-(?:live-)?begin$/.test(message.t)) current.jobs.add(message.jobId);
        if (current && response?.ok && message.t === 'mendosave-save' && Number.isInteger(response.id)) current.downloads.add(response.id);
        if (current && response?.ok && message.t === 'mendosave-download-state' && response.totalBytes) {
          current.progress?.(response.bytesReceived / response.totalBytes);
        }
        return response;
      },
      fetch(url, options = {}) {
        check();
        return fetcher(url, current ? { ...options, signal: options.signal
          ? AbortSignal.any([options.signal, current.controller.signal]) : current.controller.signal } : options);
      },
      async saveBlob(blob, filename) {
        check();
        const transferId = globalThis.crypto.randomUUID();
        requireOk(await api.send({ t: 'mendosave-ensure' }));
        requireOk(await api.send({ t: 'mendosave-blob-open', transferId, filename, mime: blob.type, size: blob.size }));
        let finished = false;
        const port = runtime.connect?.({ name: `mendosave-transfer:${transferId}` });
        try {
          let sequence = 0;
          for (let offset = 0; offset < blob.size; offset += 1024 ** 2) {
            check();
            const fetchedBytes = new Uint8Array(await blob.slice(offset, offset + 1024 ** 2).arrayBuffer());
            // Gecko may keep the buffer view in the page's compartment. Own the
            // bytes before subarray performs its protected constructor lookup.
            const bytes = new Uint8Array(fetchedBytes);
            let binary = '';
            for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            requireOk(await api.send({ t: 'mendosave-blob-chunk', transferId, sequence: sequence++, data: btoa(binary) }));
          }
          check();
          const result = requireOk(await api.send({ t: 'mendosave-blob-finish', transferId }));
          finished = true;
          return result.filename || filename;
        } finally {
          if (!finished) await api.send({ t: 'mendosave-blob-abort', transferId }).catch(() => {});
          try { port?.disconnect(); } catch (error) {}
        }
      },
      add(menu, { title, options, close }) {
        if (!document || (typeof options !== 'function' && (!Array.isArray(options) || options.length < 2))) return null;
        const opener = document.createElement('button');
        opener.type = 'button'; opener.className = 'mendo-package-open'; opener.textContent = 'Выбрать несколько…';
        opener.addEventListener('click', (event) => {
          event.preventDefault(); event.stopPropagation();
          if (current) return;
          const choices = typeof options === 'function' ? options() : options;
          if (!Array.isArray(choices) || choices.length < 2) return;
          const available = choices.map((item, index) => Object.freeze({ id: String(item.id ?? index), label: String(item.label), run: item.run }));
          close?.();
          const dialog = document.createElement('dialog');
          dialog.className = 'mendo-package-dialog';
          dialog.setAttribute('aria-label', `Пакет: ${title}`);
          const heading = document.createElement('h2'); heading.textContent = 'Пакет форматов';
          const caption = document.createElement('p'); caption.textContent = title;
          const list = document.createElement('div'); list.className = 'mendo-package-list';
          const status = document.createElement('p'); status.setAttribute('role', 'status');
          status.setAttribute('aria-live', 'polite'); status.textContent = 'Выберите файлы. Они будут обработаны по очереди.';
          const progress = document.createElement('progress'); progress.max = 1; progress.value = 0;
          progress.setAttribute('aria-label', 'Общий прогресс пакета');
          const actions = document.createElement('div'); actions.className = 'mendo-package-actions';
          const rows = available.map(item => {
            const row = document.createElement('label');
            const input = document.createElement('input'); input.type = 'checkbox'; input.value = item.id;
            const text = document.createElement('span'); text.textContent = item.label;
            row.append(input, text); list.append(row);
            return { item, input, text };
          });
          const files = document.createElement('button'); files.type = 'button'; files.dataset.mode = 'files'; files.textContent = 'Отдельные файлы';
          const zip = document.createElement('button'); zip.type = 'button'; zip.dataset.mode = 'zip'; zip.textContent = 'Один ZIP';
          const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Закрыть';
          const selection = () => rows.filter(row => row.input.checked);
          const update = () => { files.disabled = selection().length === 0; zip.disabled = selection().length < 2; };
          rows.forEach(row => row.input.addEventListener('change', update)); update();
          const dismiss = () => { if (current) return; dialog.close?.(); dialog.remove(); };
          const abort = async () => {
            const running = current;
            if (!running || running.controller.signal.aborted) return;
            running.controller.abort();
            status.textContent = 'Отменяю текущий файл и оставшуюся очередь…';
            cancel.disabled = true;
            running.cancelPromise = raw({ t: 'mendosave-package-cancel', packageId: running.id }).catch(() => {});
            for (const jobId of running.jobs) void raw({ t: 'mendosave-abort', jobId, packageId: running.id }).catch(() => {});
            for (const id of running.downloads) void raw({ t: 'mendosave-download-cancel', id }).catch(() => {});
          };
          cancel.addEventListener('click', () => { if (current) void abort(); else dismiss(); });
          dialog.addEventListener('cancel', (e) => { e.preventDefault(); if (current) void abort(); else dismiss(); });
          const start = async mode => {
            if (current) return;
            const selected = selection();
            if (!selected.length || (mode === 'zip' && selected.length < 2)) return;
            const state = { id: globalThis.crypto.randomUUID(), index: -1, controller: new AbortController(), jobs: new Set(), downloads: new Set() };
            current = state;
            files.disabled = true; zip.disabled = true; cancel.textContent = 'Отменить пакет';
            rows.forEach(row => { row.input.disabled = true; });
            const showProgress = fraction => {
              const value = Math.max(0, Math.min(1, Number(fraction) || 0));
              progress.value = Math.min(1, (Math.max(0, state.index) + value) / selected.length);
            };
            state.progress = showProgress;
            const listener = message => {
              if (current !== state || (message?.t !== 'mendosave-progress' && message?.t !== 'mendosave-package-progress')) return;
              if (message.packageId !== state.id && !state.jobs.has(message.jobId)) return;
              showProgress(message.value);
              if (message.status) status.textContent = `${Math.min(state.index + 1, selected.length)}/${selected.length} · ${String(message.status).slice(0, 160)}`;
            };
            runtime.onMessage?.addListener(listener);
            let port;
            const result = await queue.run(selected.map(row => row.item), {
              signal: state.controller.signal,
              async start() {
                requireOk(await raw({ t: 'mendosave-ensure' }));
                requireOk(await raw({ t: 'mendosave-package-begin', packageId: state.id, mode, title: String(title).slice(0, 250),
                  items: selected.map(row => ({ id: row.item.id, label: row.item.label })) }));
                port = runtime.connect?.({ name: `mendosave-package:${state.id}` });
                port?.onDisconnect.addListener(() => { if (current === state) { state.controller.abort(); status.textContent = 'Связь с обработчиком прервана'; } });
              },
              async next(index) { state.index = index; requireOk(await raw({ t: 'mendosave-package-next', packageId: state.id, index })); },
              async complete(index) { requireOk(await raw({ t: 'mendosave-package-complete', packageId: state.id, index })); selected[index].text.textContent += mode === 'zip' ? ' · подготовлен' : ' · сохранён'; },
              async finish() { return requireOk(await raw({ t: 'mendosave-package-finish', packageId: state.id })); },
              async cancel(reason) { await state.cancelPromise; await raw({ t: 'mendosave-package-cancel', packageId: state.id, reason }); },
              onChange(snapshot) { state.index = snapshot.index; showProgress(0); status.textContent = snapshot.phase === 'saving'
                ? (mode === 'zip' ? 'Создаю и сохраняю ZIP…' : 'Завершаю очередь…')
                : `${snapshot.index + 1}/${selected.length} · ${selected[snapshot.index].item.label}`; },
            });
            runtime.onMessage?.removeListener(listener);
            current = null;
            try { port?.disconnect(); } catch (error) {}
            cancel.disabled = false; cancel.textContent = 'Закрыть';
            if (result.phase === 'complete') {
              progress.value = 1;
              status.textContent = `Готово: ${mode === 'zip' ? result.filename : `${result.results.length} файлов`}`;
            } else {
              status.textContent = `${result.phase === 'cancelled' ? 'Пакет отменён' : `Ошибка: ${result.error}`}. Завершено ${result.results.length}/${selected.length}.`
                + (mode === 'zip' ? ' Подготовленные файлы можно сохранить через значок MendoSave.' : ' Уже сохранённые файлы остаются на диске.');
              for (const row of selected.slice(result.results.length)) row.text.textContent += ' · не завершён';
            }
          };
          files.addEventListener('click', () => { void start('files'); }); zip.addEventListener('click', () => { void start('zip'); });
          actions.append(files, zip, cancel); dialog.append(heading, caption, list, status, progress, actions); document.body.append(dialog);
          if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
          rows[0]?.input.focus();
        });
        menu.append(opener);
        return opener;
      },
    };
    return api;
  }
  if (globalThis.chrome?.runtime) globalThis.MendoPackageUI = create({ runtime: chrome.runtime, document: globalThis.document });
  if (typeof module !== 'undefined') module.exports = { create };
})();
