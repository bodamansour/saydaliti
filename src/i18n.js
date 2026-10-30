// English for the whole app, without touching each screen: the pages are written in Arabic, and in
// English mode every piece of text on the page (and placeholders, titles, labels) is looked up in
// src/i18n-en.js as it appears. Numbers and «quoted names» inside a sentence are kept as they are
// and put back into the English sentence ({n}, {q}). Anything with no translation stays Arabic.
// Loaded as a plain script in <head>, before the page's own code, so the direction is right at once.
(function () {
  const KEY = 'saydaliti-lang';
  let lang = 'ar';
  try { lang = localStorage.getItem(KEY) === 'en' ? 'en' : 'ar'; } catch { /* blocked */ }
  const AR = /[؀-ۿ]/;
  const DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '٫': '.', '٬': ',' };
  const latin = (s) => s.replace(/[٠-٩٫٬]/g, (c) => DIGITS[c]);
  const NUM = /[-+−]?[0-9٠-٩][0-9٠-٩٫٬.,:/]*%?/g;
  const QUOTE = /«[^»]*»/g;
  // A sentence as a key: spaces squeezed, numbers → {n}, «names» → {q}.
  function keyOf(text) {
    const vals = [];
    const k = text.replace(/\s+/g, ' ').trim()
      .replace(QUOTE, (m) => { vals.push({ q: m }); return '{q}'; })
      .replace(NUM, (m) => { vals.push({ n: m }); return '{n}'; });
    return { k, vals };
  }
  const months = [['يناير', 'Jan'], ['فبراير', 'Feb'], ['مارس', 'Mar'], ['أبريل', 'Apr'], ['إبريل', 'Apr'], ['مايو', 'May'], ['يونيو', 'Jun'], ['يوليو', 'Jul'], ['أغسطس', 'Aug'], ['سبتمبر', 'Sep'], ['أكتوبر', 'Oct'], ['نوفمبر', 'Nov'], ['ديسمبر', 'Dec'],
    ['السبت', 'Sat'], ['الأحد', 'Sun'], ['الاثنين', 'Mon'], ['الإثنين', 'Mon'], ['الثلاثاء', 'Tue'], ['الأربعاء', 'Wed'], ['الخميس', 'Thu'], ['الجمعة', 'Fri'], ['ص', 'AM'], ['م', 'PM'], ['ج', 'EGP']];
  const WORD = new Map(months);
  const seen = new Set();
  function tr(text) {
    if (!text || !AR.test(text)) return lang === 'en' ? latin(text) : text;
    const lead = text.match(/^\s*/)[0], tail = text.match(/\s*$/)[0];
    const { k, vals } = keyOf(text);
    if (window.__i18nRecord && !seen.has(k)) { seen.add(k); try { window.__i18nRecord(k); } catch { /* collector gone */ } }
    if (lang !== 'en') return text;
    const dict = window.SAYDALITI_EN || {};
    let en = dict[k];
    // «Name» · role and similar: translate each part on its own.
    if (en === undefined && k.includes(' · ')) return lead + text.trim().split(/\s+·\s+/).map(tr).join(' · ') + tail;
    if (en === undefined) {
      // Dates and short words the browser wrote in Arabic (month and day names, ص/م, ج).
      const words = latin(text).replace(/[؀-ۿ]+/g, (w) => WORD.get(w) ?? w);
      return AR.test(words) ? latin(text) : words;
    }
    let i = 0;
    en = en.replace(/\{[nq]\}/g, () => { const v = vals[i++]; if (!v) return ''; if (v.n) return latin(v.n); const inner = v.q.slice(1, -1); return `"${dict[inner] ?? latin(inner)}"`; });
    return lead + en + tail;
  }
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  function walk(root) {
    if (root.nodeType === 3) { const t = tr(root.nodeValue); if (t !== root.nodeValue) root.nodeValue = t; return; }
    if (root.nodeType !== 1 || root.closest?.('[data-no-i18n], script, style, textarea')) return;
    for (const a of ATTRS) if (root.hasAttribute?.(a)) { const v = root.getAttribute(a); const t = tr(v); if (t !== v) root.setAttribute(a, t); }
    if (root.tagName === 'INPUT' && /^(button|submit)$/.test(root.type)) { const t = tr(root.value); if (t !== root.value) root.value = t; }
    if (root.tagName === 'OPTION') { const t = tr(root.text); if (t !== root.text) root.text = t; return; }
    for (const c of [...root.childNodes]) walk(c);
  }
  function button() {
    if (document.querySelector('[data-langbtn]')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'langbtn'; b.dataset.langbtn = '1'; b.dataset.noI18n = '1';
    b.textContent = lang === 'en' ? 'عربي' : 'English';
    b.setAttribute('aria-label', lang === 'en' ? 'التحويل للعربي' : 'Switch to English');
    b.addEventListener('click', () => { try { localStorage.setItem(KEY, lang === 'en' ? 'ar' : 'en'); } catch { /* blocked */ } location.reload(); });
    // In the page header next to the other buttons; pages without one get it at the bottom.
    const bar = document.querySelector('header .bar, header .src, header .row');
    if (bar) bar.append(b); else { b.classList.add('end'); document.body.append(b); }
  }
  function start() {
    button();
    if (lang !== 'en' && !window.__i18nRecord) return; // Arabic: nothing to translate
    walk(document.body);
    document.title = tr(document.title);
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'characterData') walk(m.target);
        else if (m.type === 'attributes') walk(m.target);
        else for (const n of m.addedNodes) walk(n);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  window.saydalitiLang = { lang, t: tr };
  if (lang === 'en') { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; }
  if (lang === 'en') {
    // The browser's own dialogs (confirm / prompt / alert) in English too.
    for (const f of ['alert', 'confirm', 'prompt']) { const o = window[f].bind(window); window[f] = (msg, ...rest) => o(tr(String(msg ?? '')), ...rest); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}());
