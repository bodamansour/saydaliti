// Light or dark, on every page. Loaded as a plain script in <head>, before anything is drawn, so the page
// never flashes the wrong colours. The choice is kept on this device: «زي الجهاز» (follow the system
// setting), «فاتح» (light) or «غامق» (dark). Any button with data-theme-toggle cycles through the three
// and shows the current one.
(function () {
  const KEY = 'saydaliti-theme';
  const ORDER = ['system', 'light', 'dark'];
  const NAME = { system: 'الألوان: زي الجهاز', light: 'الألوان: فاتح', dark: 'الألوان: غامق' };
  const dark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  let choice = 'system';
  try { const v = localStorage.getItem(KEY); if (ORDER.includes(v)) choice = v; } catch { /* storage blocked */ }
  const apply = () => {
    const isDark = choice === 'dark' || (choice === 'system' && !!dark?.matches);
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = isDark ? '#07110d' : '#0b3b2e';
    for (const b of document.querySelectorAll('[data-theme-toggle]')) {
      b.setAttribute('aria-label', NAME[choice]);
      b.title = NAME[choice];
      const t = b.querySelector('[data-theme-name]');
      if (t) t.textContent = NAME[choice];
    }
  };
  apply();
  dark?.addEventListener?.('change', apply);
  document.addEventListener('DOMContentLoaded', apply);
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-theme-toggle]');
    if (!b) return;
    choice = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length];
    try { localStorage.setItem(KEY, choice); } catch { /* storage blocked: this visit only */ }
    apply();
  });
})();
