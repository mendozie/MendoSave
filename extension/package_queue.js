(() => {
  async function run(items, effects) {
    const results = [];
    const check = () => {
      if (effects.signal?.aborted) {
        const error = new Error('Пакет отменён');
        error.name = 'AbortError';
        throw error;
      }
    };
    try {
      check();
      await effects.start();
      for (const [index, item] of items.entries()) {
        check();
        effects.onChange?.({ phase: 'processing', index, results: [...results] });
        await effects.next(index);
        check();
        const filename = await item.run();
        check();
        if (filename !== true && (typeof filename !== 'string' || !filename.length)) {
          throw new Error('Файл не завершён: обработчик не подтвердил результат');
        }
        await effects.complete(index);
        results.push({ id: item.id, filename });
      }
      check();
      effects.onChange?.({ phase: 'saving', index: items.length, results: [...results] });
      const output = await effects.finish();
      return { phase: 'complete', results, ...output };
    } catch (error) {
      const cancelled = effects.signal?.aborted || error?.name === 'AbortError' || error?.cancelled;
      await effects.cancel(cancelled ? 'cancelled' : 'error').catch(() => {});
      return { phase: cancelled ? 'cancelled' : 'error', results, error: String(error?.message || error) };
    }
  }
  globalThis.MendoPackageQueue = { run };
  if (typeof module !== 'undefined') module.exports = { run };
})();
