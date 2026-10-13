(() => {
  function create({ runtime, document, fetch: fetcher = globalThis.fetch, queue = globalThis.MendoPackageQueue }) {
    let current = null;
    let picker = null;
    let rememberedSelection = null;
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
    const processorRoutes = new Set([
      'mendosave-warmup', 'mendosave-begin', 'mendosave-stage-open', 'mendosave-stage',
      'mendosave-chunk', 'mendosave-abort', 'mendosave-finalize',
      'mendosave-live-begin', 'mendosave-live-chunk', 'mendosave-live-abort', 'mendosave-live-finalize',
      'mendosave-package-begin', 'mendosave-package-next', 'mendosave-package-complete', 'mendosave-package-finish', 'mendosave-package-cancel',
      'mendosave-blob-open', 'mendosave-blob-chunk', 'mendosave-blob-finish', 'mendosave-blob-abort',
      'mendosave-save-source', 'mendosave-save-text', 'mendosave-flush',
      'mendosave-host-probe', 'mendosave-host-close', 'mendosave-host-resume',
    ]);
    const sendOwned = async (message, state, binding) => {
      const maintenance = /abort|cancel|mendosave-log|mendosave-error/.test(message.t || '');
      if (processorRoutes.has(message.t) && !binding) throw new Error('Processor command requires an acquired producer');
      if (!maintenance && state && (state !== current || state.controller.signal.aborted)) interrupted('USER_CANCELED');
      const targeted = binding && processorRoutes.has(message.t) ? { ...message, instanceId: binding.instanceId } : message;
      const response = await raw(state ? { ...targeted, packageId: state.id,
        packageIndex: binding ? binding.packageIndex : state.index } : targeted);
      if (state && !maintenance && (state !== current || state.controller.signal.aborted)) interrupted('USER_CANCELED');
      if (state === current && state && response?.ok && /mendosave-(?:live-)?begin$/.test(message.t)) state.jobs.add(message.jobId);
      if (state === current && state && response?.ok && message.t === 'mendosave-save' && Number.isInteger(response.id)) state.downloads.add(response.id);
      if (state === current && state && response?.ok && message.t === 'mendosave-download-state' && response.totalBytes) {
        state.progress?.(response.bytesReceived / response.totalBytes);
      }
      return response;
    };
    const api = {
      get running() { return Boolean(current); },
      get signal() { return current?.controller.signal || null; },
      cancel() { return current?.abort?.(); },
      check,
      interruption: interrupted,
      acquireProcessor({ signal, onDisconnect } = {}) {
        const state = current, packageIndex = state?.index;
        if (signal?.aborted) {
          try { interrupted('USER_CANCELED'); } catch (error) { return Promise.reject(error); }
        }
        return new Promise((resolve, reject) => {
          let port, timer, ready = false, released = false;
          const detach = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            port?.onMessage.removeListener(message);
            port?.onDisconnect.removeListener(disconnect);
          };
          const release = () => {
            if (released) return;
            released = true;
            detach();
            try { port?.disconnect(); } catch (error) {}
          };
          const fail = (error) => {
            if (released) return;
            const wasReady = ready;
            release();
            if (wasReady) onDisconnect?.(error);
            else reject(error);
          };
          const abort = () => {
            const error = new Error('Подготовка обработчика отменена');
            error.name = 'AbortError'; error.cancelled = true;
            fail(error);
          };
          const disconnect = () => fail(new Error('Связь с обработчиком медиа прервана'));
          const message = (response) => {
            if (released || ready) return;
            if (response?.ok !== true || typeof response.instanceId !== 'string'
              || !/^[a-zA-Z0-9_-]{1,128}$/.test(response.instanceId)) {
              fail(new Error(response?.error || 'Обработчик не подтвердил готовность'));
              return;
            }
            ready = true;
            clearTimeout(timer);
            // Once ready, cancellation must finish the caller's abort/drain
            // cleanup before release disconnects the producer reservation.
            signal?.removeEventListener('abort', abort);
            port.onMessage.removeListener(message);
            const instanceId = response.instanceId;
            resolve({ instanceId, release, send(packet) {
              if (released && !/abort|cancel|mendosave-log|mendosave-error/.test(packet.t || '')) {
                return Promise.reject(new Error('Producer lease has been released'));
              }
              return sendOwned(packet, state, { instanceId, packageIndex });
            } });
          };
          port = runtime.connect({ name: 'mendosave-producer' });
          port.onMessage.addListener(message);
          port.onDisconnect.addListener(disconnect);
          signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => fail(new Error('Обработчик медиа не подтвердил готовность вовремя')), 30_000);
          if (signal?.aborted) abort();
        });
      },
      async send(message) {
        return sendOwned(message, current, null);
      },
      fetch(url, options = {}) {
        check();
        return fetcher(url, current ? { ...options, signal: options.signal
          ? AbortSignal.any([options.signal, current.controller.signal]) : current.controller.signal } : options);
      },
      async saveBlob(blob, filename) {
        check();
        const controller = new AbortController();
        const signal = current?.controller.signal || controller.signal;
        let disconnectedError;
        const checkTransfer = () => {
          check();
          if (disconnectedError) throw disconnectedError;
          if (signal.aborted) interrupted('USER_CANCELED');
        };
        const producer = await api.acquireProcessor({ signal, onDisconnect(error) {
          disconnectedError = error; controller.abort();
        } });
        let transferId, finished = false, opened = false, port;
        try {
          transferId = globalThis.crypto.randomUUID();
          checkTransfer();
          requireOk(await producer.send({ t: 'mendosave-ensure' }));
          checkTransfer();
          opened = true;
          requireOk(await producer.send({ t: 'mendosave-blob-open', transferId, filename, mime: blob.type, size: blob.size }));
          port = runtime.connect({ name: `mendosave-transfer:${transferId}` });
          let sequence = 0;
          for (let offset = 0; offset < blob.size; offset += 1024 ** 2) {
            checkTransfer();
            const fetchedBytes = new Uint8Array(await blob.slice(offset, offset + 1024 ** 2).arrayBuffer());
            checkTransfer();
            // Gecko may keep the buffer view in the page's compartment. Own the
            // bytes before subarray performs its protected constructor lookup.
            const bytes = new Uint8Array(fetchedBytes);
            let binary = '';
            for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            requireOk(await producer.send({ t: 'mendosave-blob-chunk', transferId, sequence: sequence++, data: btoa(binary) }));
          }
          checkTransfer();
          const result = requireOk(await producer.send({ t: 'mendosave-blob-finish', transferId }));
          checkTransfer();
          finished = true;
          return result.filename || filename;
        } finally {
          if (opened && !finished) await producer.send({ t: 'mendosave-blob-abort', transferId }).catch(() => {});
          try { port?.disconnect(); } catch (error) {}
          producer.release();
        }
      },
      add(menu, { title, source = title, options, close, back }) {
        if (!document || (typeof options !== 'function' && (!Array.isArray(options) || options.length < 2))) return null;
        const opener = document.createElement('button');
        opener.type = 'button'; opener.className = 'mendo-package-open'; opener.textContent = 'Выбрать несколько…';
        opener.addEventListener('click', (event) => {
          event.preventDefault(); event.stopPropagation();
          if (picker && current) { close?.(); picker.show(); return; }
          const choices = typeof options === 'function' ? options() : options;
          if (!Array.isArray(choices) || choices.length < 2) return;
          const available = choices.map((item, index) => Object.freeze({ id: String(item.id ?? index),
            compatibilityKey: String(item.compatibilityKey ?? item.id ?? index), group: String(item.group || ''),
            label: String(item.label), run: item.run }));
          if (picker?.source === String(source)) {
            close?.(); picker.refresh(available, title, back); picker.show(); return;
          }
          picker?.dispose();
          close?.();
          let returnToMenu = back;
          let panel;
          const dialog = document.createElement('dialog');
          dialog.className = 'mendo-package-dialog';
          dialog.setAttribute('aria-label', `Пакет: ${title}`);
          const heading = document.createElement('h2'); heading.textContent = 'Пакет форматов';
          const caption = document.createElement('p'); caption.textContent = title;
          const header = document.createElement('div'); header.className = 'mendo-package-header';
          const windowBar = document.createElement('div'); windowBar.className = 'mendo-package-windowbar';
          const dragHandle = document.createElement('div'); dragHandle.className = 'mendo-package-drag-handle';
          dragHandle.title = 'Перетащить окно'; dragHandle.setAttribute('aria-hidden', 'true');
          const closeDialog = document.createElement('button'); closeDialog.type = 'button'; closeDialog.dataset.action = 'close';
          closeDialog.className = 'mendo-package-close'; closeDialog.textContent = '×';
          windowBar.append(dragHandle, closeDialog);
          const goBack = document.createElement('button'); goBack.type = 'button'; goBack.dataset.action = 'back'; goBack.textContent = '← Назад';
          const headingGroup = document.createElement('div'); headingGroup.append(heading, caption);
          header.append(windowBar, goBack, headingGroup);
          const list = document.createElement('div'); list.className = 'mendo-package-list';
          const status = document.createElement('p'); status.setAttribute('role', 'status');
          status.setAttribute('aria-live', 'polite'); status.textContent = 'Выберите файлы. Они будут обработаны по очереди.';
          const progress = document.createElement('progress'); progress.max = 1; progress.value = 0;
          progress.setAttribute('aria-label', 'Общий прогресс пакета');
          const actions = document.createElement('div'); actions.className = 'mendo-package-actions';
          const makeRows = items => {
            let previousGroup = '';
            return items.map(item => {
              if (item.group && item.group !== previousGroup) {
                const heading = document.createElement('h3'); heading.className = 'mendo-package-group'; heading.textContent = item.group;
                list.append(heading);
              }
              previousGroup = item.group;
              const row = document.createElement('label');
              const input = document.createElement('input'); input.type = 'checkbox'; input.value = item.id;
              input.checked = rememberedSelection?.source === String(source)
                && rememberedSelection.choices.get(item.id) === item.compatibilityKey;
              const text = document.createElement('span'); text.textContent = item.label;
              row.append(input, text); list.append(row);
              return { item, input, text };
            });
          };
          let rows = makeRows(available);
          const files = document.createElement('button'); files.type = 'button'; files.dataset.mode = 'files'; files.textContent = 'Скачать файлы';
          const zip = document.createElement('button'); zip.type = 'button'; zip.dataset.mode = 'zip'; zip.textContent = 'Скачать ZIP';
          const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Отменить пакет'; cancel.hidden = true;
          cancel.dataset.action = 'cancel';
          const hide = document.createElement('button'); hide.type = 'button'; hide.textContent = 'Скрыть'; hide.dataset.action = 'hide';
          const resume = document.createElement('div'); resume.className = 'mendo-package-resume';
          resume.hidden = true; resume.setAttribute('role', 'group'); resume.setAttribute('aria-label', 'Скрытый пакет'); resume.setAttribute('aria-live', 'polite');
          const resumeOpen = document.createElement('button'); resumeOpen.type = 'button'; resumeOpen.dataset.action = 'resume';
          const closeResume = document.createElement('button'); closeResume.type = 'button'; closeResume.dataset.action = 'close';
          closeResume.className = 'mendo-package-close'; closeResume.textContent = '×';
          resume.append(resumeOpen, closeResume);
          const view = document.defaultView;
          let position = null, drag = null;
          const place = (left, top) => {
            if (!dialog.hasAttribute('open')) return false;
            const box = dialog.getBoundingClientRect?.();
            const width = view?.innerWidth, height = view?.innerHeight;
            if (!box || ![left, top, box.width, box.height, width, height].every(Number.isFinite)
              || box.width <= 0 || box.height <= 0 || width <= 0 || height <= 0) return false;
            const spaceX = Math.max(0, width - box.width), spaceY = Math.max(0, height - box.height);
            const marginX = Math.min(12, spaceX / 2), marginY = Math.min(12, spaceY / 2);
            position = { left: Math.max(marginX, Math.min(left, spaceX - marginX)),
              top: Math.max(marginY, Math.min(top, spaceY - marginY)) };
            dialog.style.margin = '0'; dialog.style.right = 'auto'; dialog.style.bottom = 'auto';
            dialog.style.left = `${position.left}px`; dialog.style.top = `${position.top}px`;
            return true;
          };
          const fit = () => { if (position) place(position.left, position.top); };
          const stopDrag = () => {
            const previous = drag; drag = null;
            document.removeEventListener('pointermove', moveDrag);
            document.removeEventListener('pointerup', endDrag);
            document.removeEventListener('pointercancel', endDrag);
            dialog.classList.remove('mendo-package-dragging');
            if (previous) { try { dragHandle.releasePointerCapture?.(previous.id); } catch (error) {} }
          };
          const moveDrag = event => {
            if (!drag || event.pointerId !== drag.id) return;
            if (!(event.buttons & 1)) { stopDrag(); return; }
            if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
            event.preventDefault();
            place(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
          };
          const endDrag = event => { if (drag && event.pointerId === drag.id) stopDrag(); };
          dragHandle.addEventListener('pointerdown', event => {
            if (picker !== panel || drag || event.button !== 0 || event.isPrimary === false
              || !Number.isInteger(event.pointerId) || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)
              || event.target.closest?.('button,input,select,textarea,a,[role="button"],[contenteditable]')) return;
            const box = dialog.getBoundingClientRect?.();
            if (!box || !place(box.left, box.top)) return;
            event.preventDefault();
            drag = { id: event.pointerId, x: event.clientX, y: event.clientY, ...position };
            dialog.classList.add('mendo-package-dragging');
            document.addEventListener('pointermove', moveDrag);
            document.addEventListener('pointerup', endDrag);
            document.addEventListener('pointercancel', endDrag);
            try { dragHandle.setPointerCapture?.(drag.id); } catch (error) {}
          });
          dragHandle.addEventListener('lostpointercapture', endDrag);
          const resize = () => { stopDrag(); fit(); };
          view?.addEventListener('resize', resize);
          view?.addEventListener('blur', stopDrag);
          const updateClose = () => {
            const label = current ? 'Закрытие недоступно до завершения пакета или отмены' : 'Закрыть окно пакета полностью';
            for (const button of [closeDialog, closeResume]) {
              button.disabled = Boolean(current); button.title = label; button.setAttribute('aria-label', label);
            }
          };
          const updateResume = () => {
            resumeOpen.textContent = `Пакет · ${status.textContent.slice(0, 180)}`;
            resumeOpen.setAttribute('aria-label', `Открыть окно пакета: ${status.textContent.slice(0, 180)}`);
            updateClose(); fit();
          };
          const show = () => {
            if (picker !== panel) return;
            resume.hidden = true;
            if (!dialog.hasAttribute('open')) { if (dialog.show) dialog.show(); else dialog.setAttribute('open', ''); }
            updateClose(); fit();
            (current ? hide : rows.find(row => row.input.checked)?.input || rows[0]?.input)?.focus();
          };
          const conceal = () => {
            if (picker !== panel) return;
            stopDrag();
            dialog.close?.(); dialog.removeAttribute('open');
            updateResume(); resume.hidden = false; resumeOpen.focus();
          };
          hide.addEventListener('click', conceal);
          resume.addEventListener('click', show);
          const selection = () => rows.filter(row => row.input.checked);
          const update = () => { files.disabled = selection().length === 0; zip.disabled = selection().length < 2; };
          const bindRows = () => { rows.forEach(row => row.input.addEventListener('change', update)); update(); };
          const remember = () => { rememberedSelection = { source: String(source),
            choices: new Map(selection().map(row => [row.item.id, row.item.compatibilityKey])) }; };
          bindRows();
          const dispose = () => {
            if (picker !== panel || current) return;
            stopDrag(); view?.removeEventListener('resize', resize); view?.removeEventListener('blur', stopDrag);
            remember(); dialog.close?.(); dialog.remove(); resume.remove(); picker = null;
          };
          const closePicker = event => {
            event.preventDefault(); event.stopPropagation();
            if (current || picker !== panel) return;
            dispose();
            if (opener.isConnected) opener.focus();
          };
          closeDialog.addEventListener('click', closePicker);
          closeResume.addEventListener('click', closePicker);
          const refresh = (items, nextTitle, nextBack) => {
            if (current || picker !== panel) return;
            remember(); list.replaceChildren(); rows = makeRows(items); bindRows();
            title = nextTitle; caption.textContent = title; returnToMenu = nextBack;
            dialog.setAttribute('aria-label', `Пакет: ${title}`);
            progress.value = 0; status.textContent = 'Выберите файлы. Они будут обработаны по очереди.'; updateResume();
          };
          panel = { source: String(source), show, dispose, refresh };
          picker = panel;
          const dismiss = async () => {
            if (current || picker !== panel) return;
            dispose();
            const target = await returnToMenu?.();
            if (target?.isConnected) target.focus();
            else if (opener.isConnected) opener.focus();
          };
          goBack.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void dismiss(); });
          const abort = async () => {
            const running = current;
            if (!running || running.panel !== panel || running.controller.signal.aborted) return;
            running.controller.abort();
            status.textContent = 'Отменяю текущий файл и оставшуюся очередь…';
            updateResume();
            cancel.disabled = true;
            running.cancelPromise = Promise.allSettled([
              ...(running.producer ? [running.producer.send({ t: 'mendosave-package-cancel', packageId: running.id })] : []),
              ...[...running.jobs].map(jobId => running.producer.send({ t: 'mendosave-abort', jobId, packageId: running.id })),
              ...[...running.downloads].map(id => raw({ t: 'mendosave-download-cancel', id })),
            ]);
          };
          cancel.addEventListener('click', () => { if (current) void abort(); });
          dialog.addEventListener('cancel', (e) => { e.preventDefault(); conceal(); });
          dialog.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); conceal(); } });
          const start = async mode => {
            if (current || picker !== panel) return;
            const selected = selection();
            if (!selected.length || (mode === 'zip' && selected.length < 2)) return;
            const state = { id: globalThis.crypto.randomUUID(), index: -1, controller: new AbortController(), jobs: new Set(), downloads: new Set(), abort, panel };
            current = state;
            const checkState = () => {
              if (current !== state || picker !== panel || state.controller.signal.aborted) interrupted('USER_CANCELED');
            };
            progress.value = 0;
            status.textContent = 'Подготавливаю пакет…'; updateResume();
            files.disabled = true; zip.disabled = true; goBack.disabled = true; cancel.disabled = false; cancel.hidden = false;
            rows.forEach(row => { row.input.disabled = true; row.text.textContent = row.item.label; });
            const showProgress = fraction => {
              if (current !== state || state.controller.signal.aborted) return;
              const value = Math.max(0, Math.min(1, Number(fraction) || 0));
              progress.value = Math.min(1, (Math.max(0, state.index) + value) / selected.length);
            };
            state.progress = showProgress;
            const listener = message => {
              if (current !== state || state.controller.signal.aborted || (message?.t !== 'mendosave-progress' && message?.t !== 'mendosave-package-progress')) return;
              if (message.packageId !== state.id && !state.jobs.has(message.jobId)) return;
              showProgress(message.value);
              if (message.status) status.textContent = `${Math.min(state.index + 1, selected.length)}/${selected.length} · ${String(message.status).slice(0, 160)}`;
              updateResume();
            };
            runtime.onMessage?.addListener(listener);
            let port, producer;
            const result = await queue.run(selected.map(row => row.item), {
              signal: state.controller.signal,
              async start() {
                producer = await api.acquireProcessor({ signal: state.controller.signal,
                  onDisconnect() { if (current === state) void abort(); } });
                state.producer = producer;
                check();
                requireOk(await producer.send({ t: 'mendosave-ensure' }));
                check();
                requireOk(await producer.send({ t: 'mendosave-package-begin', packageId: state.id, mode, title: String(title).slice(0, 250),
                  items: selected.map(row => ({ id: row.item.id, label: row.item.label })) }));
                port = runtime.connect?.({ name: `mendosave-package:${state.id}` });
                port?.onDisconnect.addListener(() => { if (current === state) { state.controller.abort(); status.textContent = 'Связь с обработчиком прервана'; } });
              },
              async next(index) { checkState(); state.index = index; requireOk(await producer.send({ t: 'mendosave-package-next', packageId: state.id, index })); checkState(); },
              async complete(index) { checkState(); requireOk(await producer.send({ t: 'mendosave-package-complete', packageId: state.id, index })); checkState(); selected[index].text.textContent += mode === 'zip' ? ' · подготовлен' : ' · сохранён'; },
              async finish() { checkState(); const output = requireOk(await producer.send({ t: 'mendosave-package-finish', packageId: state.id })); checkState(); return output; },
              async cancel(reason) { await state.cancelPromise; if (producer) await producer.send({ t: 'mendosave-package-cancel', packageId: state.id, reason }); },
              onChange(snapshot) { if (current !== state || picker !== panel || state.controller.signal.aborted) return; state.index = snapshot.index; showProgress(0); status.textContent = snapshot.phase === 'saving'
                ? (mode === 'zip' ? 'Создаю и сохраняю ZIP…' : 'Завершаю очередь…')
                : `${snapshot.index + 1}/${selected.length} · ${selected[snapshot.index].item.label}`; updateResume(); },
            });
            runtime.onMessage?.removeListener(listener);
            const ownsPanel = current === state && picker === panel;
            if (current === state) current = null;
            try { port?.disconnect(); } catch (error) {}
            producer?.release();
            if (!ownsPanel) return;
            cancel.disabled = false; cancel.hidden = true; goBack.disabled = false;
            rows.forEach(row => { row.input.disabled = false; });
            update();
            if (result.phase === 'complete') {
              progress.value = 1;
              status.textContent = `Готово: ${mode === 'zip' ? result.filename : `${result.results.length} файлов`}`;
            } else {
              status.textContent = `${result.phase === 'cancelled' ? 'Пакет отменён' : `Ошибка: ${result.error}`}. Завершено ${result.results.length}/${selected.length}.`
                + (mode === 'zip' ? ' Подготовленные файлы можно сохранить через значок MendoSave.' : ' Уже сохранённые файлы остаются на диске.');
              for (const row of selected.slice(result.results.length)) row.text.textContent += ' · не завершён';
            }
            updateResume();
          };
          files.addEventListener('click', () => { void start('files'); }); zip.addEventListener('click', () => { void start('zip'); });
          const choiceGroup = document.createElement('div'); choiceGroup.className = 'mendo-package-choices'; choiceGroup.append(list, status, progress);
          actions.append(files, zip, hide, cancel); dialog.append(header, choiceGroup, actions); document.body.append(dialog, resume);
          show();
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
