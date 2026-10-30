// English interface: the dictionary is well-formed, and the runtime layer translates sentences with
// numbers and «names» in them, keeps unknown text, and flips the page to LTR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const dictSrc = readFileSync(new URL('../src/i18n-en.js', import.meta.url), 'utf8');
const libSrc = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');

function load(lang) {
  const store = new Map(lang ? [['saydaliti-lang', lang]] : []);
  const html = { lang: 'ar', dir: 'rtl' };
  const window = {
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    alert() {}, confirm: (m) => m, prompt: (m) => m,
  };
  window.document = { readyState: 'loading', documentElement: html, addEventListener() {} };
  window.window = window;
  const ctx = vm.createContext(window);
  vm.runInContext(dictSrc, ctx);
  vm.runInContext(libSrc.replaceAll('localStorage', 'window.localStorage').replaceAll('document.', 'window.document.'), ctx);
  return { t: window.saydalitiLang.t, html, window };
}

test('every translation keeps the same {n}/{q} slots and has no Arabic', () => {
  const { window } = load('en');
  const dict = window.SAYDALITI_EN;
  assert.ok(Object.keys(dict).length > 1000);
  for (const [k, v] of Object.entries(dict)) {
    assert.deepEqual(v.match(/\{[nq]\}/g) ?? [], k.match(/\{[nq]\}/g) ?? [], k);
    assert.doesNotMatch(v, /[؀-ۿ]/, k);
  }
});

test('English mode translates labels, numbers and names, and switches to LTR', () => {
  const { t, html } = load('en');
  assert.equal(html.dir, 'ltr');
  assert.equal(html.lang, 'en');
  assert.equal(t('اطلب إيه'), 'What to order');
  assert.equal(t('  بحث  '), '  Search  ');
  assert.equal(t('١٢٫٥ ج'), '12.5 EGP');
  assert.equal(t('فاضل 3 يوم'), '3 days left');
  assert.equal(t('مفيش صنف اسمه «بانادول».'), 'No item named "بانادول".');
  assert.equal(t('السبت، 5 أكتوبر'), 'Sat, 5 Oct');
  assert.equal(t('شوف التفاصيل في «اطلب إيه»'), 'See details in "What to order"');
  assert.equal(t('صيدلية النور · صاحب الصيدلية'), 'صيدلية النور · Pharmacy owner');
  assert.equal(t('حاجة مش في القاموس'), 'حاجة مش في القاموس');
  assert.equal(t('Panadol'), 'Panadol');
});

test('Arabic mode leaves everything as it is', () => {
  const { t, html } = load(null);
  assert.equal(html.dir, 'rtl');
  assert.equal(t('اطلب إيه'), 'اطلب إيه');
});
