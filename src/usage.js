// A public, approximate total. No files, filenames, cookies or identifiers are sent.
const API = 'https://countapi.mileshilliard.com/api/v1';
const KEY = 'heyfoz-gif-it-away-completed-8c3497a2';

export function startUsageCounter(output) {
  // Local copies and forks must not add development runs to the live total.
  if (location.origin !== 'https://heyfoz.github.io'
      || !location.pathname.startsWith('/gif-it-away/')) {
    output.textContent = 'Shared usage count is available on the live site.';
    return () => {};
  }

  async function update(action) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${API}/${action}/${KEY}`, {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      // The service creates a new counter on its first completed conversion.
      let count = 0;
      if (!(action === 'get' && response.status === 404)) {
        if (!response.ok) throw new Error('Counter unavailable');
        const data = await response.json();
        if (!/^[0-9]+$/.test(String(data.value))) throw new Error('Invalid counter');
        count = Number(data.value);
        if (!Number.isSafeInteger(count)) throw new Error('Invalid counter');
      }
      output.textContent = `${count.toLocaleString()} ${count === 1 ? 'GIF' : 'GIFs'} made worldwide · approximate`;
    } catch {
      // A blocked or unavailable counter must never interrupt GIF creation.
      output.textContent = 'Usage count is temporarily unavailable.';
    } finally {
      clearTimeout(timer);
    }
  }

  // Serialize updates so a slow initial read cannot overwrite a newer count.
  let pending = update('get');
  return () => {
    pending = pending.then(() => update('hit'));
  };
}
