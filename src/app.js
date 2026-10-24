import { analyze, profitAt, targetFloor, suggestOffer, parseSheet, startOfDay, addDays, partnerSummary, ownersOf } from './core.js';

const $ = (id) => document.getElementById(id);
const TODAY = startOfDay();
const fmt = (n, d = 0) => (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const egp = (n) => `<span class="n">${fmt(n)}</span> ج`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Example data (synthetic, clearly labelled in the UI) ----------
function rng(seed) { return () => (seed = (seed * 16807) % 2147483647) / 2147483647; }
function exampleData() {
  const r = rng(42);
  // [code, name, category, cost, price, stock, expiryInDays, dailyRate]
  const base = [
    ['M001', 'باراسيتامول 500 مجم ×20', 'دواء', 26, 32, 140, 420, 4.2],
    ['M002', 'أموكسيسيلين 500 مجم ×16', 'دواء', 61, 76, 25, 300, 1.6],
    ['M003', 'أملوديبين 5 مجم ×30', 'دواء', 52, 68, 18, 500, 1.4],
    ['M004', 'ميتفورمين 850 مجم ×50', 'دواء', 44, 57, 60, 260, 1.9],
    ['M005', 'أوميبرازول 20 مجم ×14', 'دواء', 38, 50, 9, 380, 1.3],
    ['M006', 'شراب كحة أطفال 100 مل', 'دواء', 31, 41, 32, 75, 0.25],
    ['M007', 'فيتامين د 50,000 ×4', 'دواء', 33, 45, 40, 600, 0.7],
    ['M008', 'نقط أنف ملحية 30 مل', 'دواء', 17, 23, 26, 50, 0.2],
    ['M009', 'مضاد حيوي مستورد ×10', 'دواء', 175, 215, 6, 240, 0.35],
    ['M010', 'لوسارتان 50 مجم ×30', 'دواء', 70, 90, 30, 410, 0.9],
    ['M011', 'أقراص حموضة ×24', 'دواء', 22, 29, 80, 700, 0.15],
    ['C001', 'كريم مرطب للوجه 50 مل', 'تجميل', 210, 320, 14, 120, 0.12],
    ['C002', 'واقي شمس SPF50 50 مل', 'تجميل', 290, 420, 11, 80, 0.15],
    ['C003', 'سيروم فيتامين سي 30 مل', 'تجميل', 360, 520, 9, 65, 0.05],
    ['C004', 'شامبو ضد القشرة 200 مل', 'تجميل', 115, 165, 22, 400, 0.45],
    ['C005', 'غسول وجه للبشرة الدهنية', 'تجميل', 140, 205, 16, 210, 0.3],
    ['C006', 'مزيل عرق رول', 'تجميل', 70, 105, 30, 500, 0.6],
    ['C007', 'كريم تفتيح 30 جم', 'تجميل', 180, 260, 12, 300, 0],
    ['C008', 'زيت شعر طبيعي 100 مل', 'تجميل', 95, 140, 18, 420, 0],
    ['S001', 'جهاز قياس ضغط ديجيتال', 'مستلزمات', 820, 1050, 4, 2000, 0.03],
    ['S002', 'شرايط سكر ×50', 'مستلزمات', 310, 380, 15, 160, 0.4],
    ['S003', 'سرنجات 5 مل ×100', 'مستلزمات', 120, 160, 6, 900, 0.3],
    ['S004', 'رباط ضاغط 10 سم', 'مستلزمات', 22, 32, 40, 1200, 0.05],
    ['S005', 'حفاضات كبار ×10', 'مستلزمات', 175, 220, 10, 700, 0.35],
    ['S006', 'ترمومتر ديجيتال', 'مستلزمات', 85, 120, 14, 1500, 0.02],
  ];
  const ownerFor = (code, cat, i) => (cat === 'دواء' ? 'الشريك أ' : cat === 'تجميل' ? 'الشريك ب' : i % 2 ? 'الشريك أ' : 'الشريك ب');
  const items = base.map(([code, name, category, cost, price, qty, exp], i) => ({ code, name, category, owner: ownerFor(code, category, i), cost, price, qty, expiry: addDays(TODAY, exp) }));
  const sales = [];
  for (let d = 90; d >= 1; d--) {
    const date = addDays(TODAY, -d);
    for (const [code, , , , , , , rate] of base) {
      if (!rate) continue;
      const L = Math.exp(-rate); let p = 1, k = 0;
      do { k++; p *= r(); } while (p > L && k < 50); // Poisson draw
      if (k - 1 > 0) sales.push({ date, code, qty: k - 1 });
    }
  }
  return { items, sales, real: false };
}

async function readFiles(files) {
  if (typeof XLSX === 'undefined') throw new Error('مكتبة قراية Excel مش محمّلة. اتأكد من النت وجرّب تاني.');
  const items = [], sales = [];
  for (const f of files) {
    const wb = XLSX.read(await f.arrayBuffer(), { cellDates: true });
    for (const name of wb.SheetNames) {
      const parsed = parseSheet(XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' }));
      items.push(...parsed.items); sales.push(...parsed.sales);
    }
  }
  if (!items.length) throw new Error('ملقتش أصناف في الملف. اتأكد إن فيه أعمدة زي «الصنف» و«سعر الشراء» و«الكمية».');
  return { items, sales, real: true };
}

// ---------- Settings & saved prices (this device only) ----------
const SKEY = 'saydaliti-settings-v1';
const MKEY = 'saydaliti-market-v1';
const fields = ['phName', 'taxMode', 'customTax', 'exRent', 'exUtil', 'exSal', 'exOther', 'target', 'expWin', 'lead', 'cover'];
const store = {
  get(k, fb) { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};
const num = (id) => Math.max(0, +$(id).value || 0);
function settings() {
  return {
    taxMode: $('taxMode').value, customTax: num('customTax'),
    expenses: num('exRent') + num('exUtil') + num('exSal') + num('exOther'),
    target: num('target'), expWin: num('expWin') || 90, lead: num('lead') || 3, cover: num('cover') || 30,
  };
}
let MARKET = store.get(MKEY, {});
const setMarket = (code, v) => { if (v > 0) MARKET[code] = v; else delete MARKET[code]; store.set(MKEY, MARKET); };

// ---------- State ----------
let DATA = exampleData();
let CALC_CODE = null;
let TAB = 'reorder';
let OWNER = 'all';
const OFFERS = new Map(); // code -> { on, price }

const TABS = [['reorder', 'اطلب إيه'], ['expiry', 'قرب ينتهي'], ['dead', 'راكد'], ['offers', 'العروض'], ['movers', 'الأكتر سحباً'], ['partners', 'الشركاء'], ['calc', 'حاسبة المكسب']];

function taxNote(A, s) {
  if (s.taxMode === 'simplified') {
    if (A.aboveSimplifiedCeiling) return 'مبيعاتك السنوية المتوقعة فوق 20 مليون، يعني غالباً مش داخل النظام المبسط. اختار «نسبة أكتبها بنفسي».';
    return `مبيعاتك السنوية المتوقعة حوالي ${fmt(A.monthlySales * 12)} ج، فالضريبة ${fmt(A.taxRate * 100, 2)}% من المبيعات (قانون 6 لسنة 2025). اتأكد من المحاسب إنك مسجّل على النظام ده.`;
  }
  if (s.taxMode === 'custom') return `بنحسب ${fmt(A.taxRate * 100, 2)}% من المبيعات ضرايب.`;
  return 'الضرايب مش داخلة في الحسبة. اسأل محاسبك عن نظام صيدليتك وغيّر الاختيار.';
}

const nameCell = (r) => `<td class="name">${esc(r.name)}<span class="cat">${esc(r.category)} · ${esc(r.owner)}</span></td>`;
const table = (head, body) => body.length
  ? `<div class="tablebox"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body.join('')}</tbody></table></div>`
  : '<div class="tablebox"><p class="empty">مفيش أصناف هنا دلوقتي.</p></div>';

function render() {
  const s = settings();
  const full = analyze(DATA, s, TODAY);
  const owners = ownersOf(DATA.items);
  if (OWNER !== 'all' && !owners.includes(OWNER)) OWNER = 'all';
  $('ownerSel').innerHTML = `<option value="all">كل الشركاء</option>${owners.map((o) => `<option value="${esc(o)}" ${o === OWNER ? 'selected' : ''}>${esc(o)}</option>`).join('')}`;
  $('ownerWrap').hidden = owners.length < 2;
  const only = (arr) => (OWNER === 'all' ? arr : arr.filter((r) => r.owner === OWNER));
  const A = { ...full, rows: only(full.rows), reorder: only(full.reorder), expiring: only(full.expiring), deadStock: only(full.deadStock), movers: only(full.movers) };
  $('taxNote').textContent = taxNote(A, s);
  $('customTaxWrap').hidden = s.taxMode !== 'custom';
  const offerRows = [...new Map([...A.expiring, ...A.deadStock].map((r) => [r.code, r])).values()];
  const stockVal = A.rows.reduce((a, r) => a + r.qty * r.cost, 0);
  const riskVal = A.expiring.reduce((a, r) => a + r.atRisk * r.cost, 0);
  const deadVal = A.deadStock.reduce((a, r) => a + r.qty * r.cost, 0);

  $('tiles').innerHTML = `
    <div class="tile acc"><span class="k">بضاعة على الرف (بسعر الشراء)</span><span class="v">${fmt(stockVal)}</span><span class="s">${A.rows.length} صنف</span></div>
    <div class="tile crit"><span class="k">ممكن تنتهي قبل ما تتباع</span><span class="v">${fmt(riskVal)}</span><span class="s">${A.expiring.length} صنف خلال ${s.expWin} يوم</span></div>
    <div class="tile warn"><span class="k">فلوس واقفة في راكد</span><span class="v">${fmt(deadVal)}</span><span class="s">${A.deadStock.length} صنف من غير بيع 45+ يوم</span></div>
    <div class="tile"><span class="k">محتاج تطلبه</span><span class="v">${A.reorder.length}</span><span class="s">مبيعات الشهر حوالي ${fmt(A.rows.reduce((a, r) => a + r.monthly * r.price, 0))} ج</span></div>`;

  const counts = { reorder: A.reorder.length, expiry: A.expiring.length, dead: A.deadStock.length, offers: offerRows.length, movers: A.movers.length, partners: owners.length };
  $('tabs').innerHTML = TABS.map(([id, t]) => `<button class="tab" role="tab" data-tab="${id}" aria-selected="${id === TAB}">${t}${counts[id] !== undefined ? `<span class="cnt">${counts[id]}</span>` : ''}</button>`).join('');

  let html;
  if (TAB === 'reorder') {
    html = `<p>أصناف هتخلص خلال ${s.lead + 7} يوم أو أقل على حسب سرعة سحبها. الكمية المقترحة تكفيك ${s.cover} يوم.</p>` + table(
      ['الصنف', 'في الرف', 'بيتسحب في الشهر', 'هيخلص بعد', 'اطلب', 'التكلفة'],
      A.reorder.map((r) => `<tr>${nameCell(r)}<td class="n">${fmt(r.qty)}</td><td class="n">${fmt(r.monthly, 1)}</td><td><span class="pill ${r.daysCover <= s.lead ? 'crit' : 'warn'}">${r.daysCover < 1 ? 'خلص تقريباً' : `${fmt(r.daysCover)} يوم`}</span></td><td class="n"><b>${fmt(r.order)}</b></td><td>${egp(r.order * r.cost)}</td></tr>`));
  } else if (TAB === 'expiry') {
    html = '<p>الكمية اللي غالباً مش هتتباع قبل الصلاحية على حسب سرعة السحب. اعمل عليها عرض، أو رجّعها للمخزن لو ينفع.</p>' + table(
      ['الصنف', 'الصلاحية', 'في الرف', 'متوقع يتباع', 'في خطر', 'قيمتها', ''],
      A.expiring.map((r) => `<tr>${nameCell(r)}<td><span class="pill ${r.expDays <= 30 ? 'crit' : 'warn'}">${r.expDays <= 0 ? 'منتهي' : `بعد ${fmt(r.expDays)} يوم`}</span></td><td class="n">${fmt(r.qty)}</td><td class="n">${fmt(r.qty - r.atRisk)}</td><td class="n"><b>${fmt(r.atRisk)}</b></td><td>${egp(r.atRisk * r.cost)}</td><td><button class="btn" data-calc="${esc(r.code)}">احسب عرض</button></td></tr>`));
  } else if (TAB === 'dead') {
    html = '<p>أصناف متباعتش من 45 يوم أو أكتر. متطلبش منها تاني، وفكّر في عرض عليها.</p>' + table(
      ['الصنف', 'آخر بيع', 'في الرف', 'فلوس واقفة', ''],
      A.deadStock.map((r) => `<tr>${nameCell(r)}<td>${r.lastSale === null ? '<span class="pill crit">ولا مرة</span>' : `<span class="pill warn">من ${fmt(r.lastSale)} يوم</span>`}</td><td class="n">${fmt(r.qty)}</td><td>${egp(r.qty * r.cost)}</td><td><button class="btn" data-calc="${esc(r.code)}">احسب عرض</button></td></tr>`));
  } else if (TAB === 'movers') {
    html = `<p>مرتبة بالفلوس اللي دخلت منها في آخر ${A.periodDays} يوم.</p>` + table(
      ['الصنف', 'اتباع', 'في الشهر', 'المبيعات', 'مكسبك الصافي في العلبة'],
      A.movers.map((r) => { const p = profitAt(r.price, r, A); return `<tr>${nameCell(r)}<td class="n">${fmt(r.sold)}</td><td class="n">${fmt(r.monthly, 1)}</td><td>${egp(r.revenue)}</td><td><span class="pill ${p.net < 0 ? 'crit' : p.pct < s.target ? 'warn' : 'ok'}"><span class="n">${fmt(p.net, 2)}</span> ج · <span class="n">${fmt(p.pct, 0)}%</span></span></td></tr>`; }));
  } else if (TAB === 'offers') {
    html = renderOffers(A, offerRows);
  } else if (TAB === 'partners') {
    const ps = partnerSummary(full);
    const tot = ps.reduce((a, p) => ({ s: a.s + p.monthlySales, n: a.n + p.monthlyNet }), { s: 0, n: 0 });
    html = `<p>كل شريك وبضاعته. المصاريف والضرايب متقسمة على الشركاء بنسبة مبيعات كل واحد. صاحب كل صنف بيتحدد من عمود «الشريك» في ملف الأصناف.</p>` + table(
      ['الشريك', 'أصناف', 'بضاعته (بسعر الشراء)', 'مبيعاته في الشهر', 'مكسبه الصافي في الشهر', 'في خطر الصلاحية', 'راكد'],
      ps.map((p) => `<tr><td><b>${esc(p.owner)}</b></td><td class="n">${fmt(p.items)}</td><td>${egp(p.stockVal)}</td><td>${egp(p.monthlySales)} <span class="muted n">${fmt(tot.s ? p.monthlySales / tot.s * 100 : 0)}%</span></td><td><span class="pill ${p.monthlyNet < 0 ? 'crit' : 'ok'}"><span class="n">${fmt(p.monthlyNet)}</span> ج</span></td><td>${egp(p.riskVal)}</td><td>${egp(p.deadVal)}</td></tr>`));
  } else {
    html = renderCalc(A, s);
  }
  $('panel').innerHTML = html;
  if (TAB === 'calc') bindCalc(A, s);
  if (TAB === 'offers') bindOffers(offerRows);
}

function offerState(r, A) {
  if (!OFFERS.has(r.code)) OFFERS.set(r.code, { on: r.category !== 'دواء', price: suggestOffer(r, A) });
  return OFFERS.get(r.code);
}

function renderOffers(A, rows) {
  const body = rows.map((r) => {
    const o = offerState(r, A);
    const p = profitAt(o.price, r, A);
    const m = MARKET[r.code];
    const why = r.atRisk > 0 ? `<span class="pill ${r.expDays <= 30 ? 'crit' : 'warn'}">ينتهي بعد ${fmt(Math.max(0, r.expDays))} يوم</span>` : '<span class="pill warn">راكد</span>';
    return `<tr class="${o.on ? '' : 'off'}">
      <td><input type="checkbox" data-on="${esc(r.code)}" ${o.on ? 'checked' : ''} aria-label="ضمّن ${esc(r.name)}"></td>
      ${nameCell(r)}<td>${why}</td><td class="n">${fmt(r.price, 2)}</td>
      <td><input class="offer-in n" type="number" min="0" step="0.5" data-price="${esc(r.code)}" value="${o.price}"></td>
      <td><span class="pill ${p.net < 0 ? 'crit' : 'ok'}"><span class="n">${fmt(p.net, 2)}</span> ج</span></td>
      <td>${m ? `<span class="n">${fmt(m, 2)}</span>${o.price > m ? ' <span class="pill warn">أغلى</span>' : ''}` : '<span class="muted">—</span>'}</td></tr>`;
  });
  const t = body.length
    ? `<div class="tablebox"><table><thead><tr><th></th><th>الصنف</th><th>ليه</th><th>السعر الحالي</th><th>سعر العرض</th><th>مكسبك في العلبة</th><th>أرخص سعر برا</th></tr></thead><tbody>${body.join('')}</tbody></table></div>`
    : '<div class="tablebox"><p class="empty">مفيش أصناف محتاجة عروض دلوقتي.</p></div>';
  return `<p>الأصناف اللي قربت تنتهي أو راكدة، وجنب كل واحد سعر عرض مقترح. لو الصنف هينتهي خلال 30 يوم، العرض بيرجّعلك سعر الشراء على الأقل، لأن ده أحسن من إنه يضيع. غيّر أي سعر بإيدك، واختار الأصناف اللي تدخل في الرسالة.</p>
  <p class="note">الأدوية مش متعلّم عليها من الأول: الإعلان عن الأدوية للجمهور محتاج موافقة هيئة الدواء، فالأفضل تعرض عليها جوه الصيدلية مش في رسايل.</p>
  ${t}
  <div class="card msg"><h3>رسالة العرض (جاهزة للواتساب)</h3><textarea id="offerMsg" aria-label="رسالة العرض"></textarea>
  <div class="row"><button class="btn primary" id="copyMsg">انسخ الرسالة</button><span class="note" id="copyNote"></span></div></div>`;
}

function bindOffers(rows) {
  const name = $('phName').value.trim() || 'صيدليتنا';
  const lines = rows.filter((r) => OFFERS.get(r.code)?.on).map((r) => {
    const o = OFFERS.get(r.code);
    const pct = Math.round((1 - o.price / r.price) * 100);
    return `• ${r.name}: بدل ${fmt(r.price)} بـ ${fmt(o.price)} جنيه${pct > 0 ? ` (خصم ${pct}%)` : ''}`;
  });
  $('offerMsg').value = lines.length ? `عروض ${name} 🎁\n\n${lines.join('\n')}\n\nالعرض لحد ما الكمية تخلص. ابعتلنا هنا ونجهزلك طلبك.` : '';
  $('panel').querySelectorAll('[data-on]').forEach((el) => el.addEventListener('change', () => { OFFERS.get(el.dataset.on).on = el.checked; render(); }));
  $('panel').querySelectorAll('[data-price]').forEach((el) => el.addEventListener('change', () => { OFFERS.get(el.dataset.price).price = Math.max(0, +el.value || 0); render(); }));
  $('copyMsg').addEventListener('click', () => {
    const t = $('offerMsg');
    const fallback = () => { t.select(); $('copyNote').textContent = 'حدّدتلك الرسالة، انسخها من القائمة.'; };
    if (!navigator.clipboard) return fallback();
    navigator.clipboard.writeText(t.value).then(() => { $('copyNote').textContent = 'اتنسخت. الصقها في الواتساب.'; }, fallback);
  });
}

function renderCalc(A, s) {
  const items = [...DATA.items].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  if (!CALC_CODE || !items.some((i) => i.code === CALC_CODE)) CALC_CODE = (items.find((i) => i.category === 'تجميل') || items[0]).code;
  const it = DATA.items.find((i) => i.code === CALC_CODE);
  const isMed = it.category === 'دواء';
  const lo = Math.floor(it.cost * 0.9), hi = Math.ceil(it.price * (isMed ? 1 : 1.25));
  return `<p>اختار صنف وحرّك السعر، والمكسب الصافي يتحسب بعد الضرايب والمصاريف.</p>
  <div class="calc">
    <div class="card">
      <label>الصنف<select id="calcItem">${items.map((i) => `<option value="${esc(i.code)}" ${i.code === CALC_CODE ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select></label>
      <label><span>سعر البيع: <b id="pLbl" class="n"></b> ج</span>
        <input id="calcPrice" type="range" min="${lo}" max="${hi}" step="0.5" value="${it.price}">
      </label>
      <label>أرخص سعر شفته برا (اختياري)<input id="market" type="number" min="0" step="0.5" value="${MARKET[it.code] ?? ''}" placeholder="مثلاً ${fmt(it.price * 0.92)}"></label>
      <p class="note">السعر ده بيتحفظ على جهازك، ويظهر في العروض.</p>
      ${isMed ? '<p class="note">ده دواء ليه تسعيرة جبرية. مينفعش تبيع بأعلى من السعر المكتوب، والحاسبة دي تفيدك لو بتفكّر تعمل خصم.</p>' : '<p class="note">مستحضرات التجميل والمستلزمات أسعارها حرة، فتقدر تحرّك السعر زي ما إنت شايف.</p>'}
      <p class="note">${s.expenses > 0 ? `المصاريف ${fmt(s.expenses)} ج في الشهر، يعني ${fmt(A.overheadRate * 100, 1)}% من المبيعات.` : 'مفيش مصاريف متسجلة في الإعدادات، فالمكسب ده قبل الإيجار والكهربا والمرتبات.'}</p>
    </div>
    <div class="card" id="calcOut"></div>
  </div>`;
}

function bindCalc(A, s) {
  const it = DATA.items.find((i) => i.code === CALC_CODE);
  const update = () => {
    const price = +$('calcPrice').value;
    $('pLbl').textContent = fmt(price, 2);
    const p = profitAt(price, it, A);
    const cls = p.net < 0 ? 'crit' : p.pct < s.target ? 'warn' : 'ok';
    const msg = p.net < 0 ? 'بالسعر ده إنت خسران.' : p.pct < s.target ? `كسبان، بس أقل من الـ ${fmt(s.target)}% اللي حاطتها هدف.` : 'السعر ده كويس.';
    const floor = targetFloor(it, A, s.target);
    const m = +$('market').value;
    let marketMsg = '';
    if (m > 0 && m - 1 > price) {
      marketMsg = `<div class="verdict ok">سعرك أصلاً أرخص من أرخص سعر برا (${fmt(m)} ج). ممكن ترفعه لحد ${fmt(m - 1)} ج وتكسب ${fmt(profitAt(m - 1, it, A).net, 2)} ج في العلبة وتفضل الأرخص.</div>`;
    } else if (m > 0) {
      const pm = profitAt(m - 1, it, A);
      marketMsg = pm.net < 0 ? `<div class="verdict crit">أرخص سعر برا ${fmt(m)} ج. لو نزلت تحته هتخسر، فمتنافسش في الصنف ده واكسب في حاجة تانية.</div>`
        : pm.pct < s.target ? `<div class="verdict warn">تقدر تبيع بـ ${fmt(m - 1)} ج (أقل من أرخص سعر بجنيه) وتكسب ${fmt(pm.net, 2)} ج، بس أقل من هدفك.</div>`
        : `<div class="verdict ok">تقدر تبيع بـ ${fmt(m - 1)} ج (أقل من أرخص سعر برا) وتفضل كسبان ${fmt(pm.net, 2)} ج في العلبة.</div>`;
    }
    const scen = [it.price, it.price * 0.95, it.price * 0.9, floor].filter((x, i, a) => x && a.indexOf(x) === i);
    $('calcOut').innerHTML = `
      <h3>${esc(it.name)}</h3>
      <div class="ledger">
        <div><span>سعر البيع</span><span class="n">${fmt(price, 2)}</span></div>
        <div><span>− سعر الشراء</span><span class="n">${fmt(it.cost, 2)}</span></div>
        <div><span>− الضرايب (${fmt(A.taxRate * 100, 2)}%)</span><span class="n">${fmt(p.tax, 2)}</span></div>
        <div><span>− نصيبها من المصاريف (${fmt(A.overheadRate * 100, 1)}%)</span><span class="n">${fmt(p.over, 2)}</span></div>
        <div class="tot"><span>مكسبك الصافي</span><span class="n">${fmt(p.net, 2)} (${fmt(p.pct, 1)}%)</span></div>
      </div>
      <div class="verdict ${cls}">${msg}</div>
      ${marketMsg}
      <div class="scen">${scen.map((x) => { const q = profitAt(x, it, A); return `<div class="${Math.abs(x - price) < 0.01 ? 'cur' : ''}"><span>لو بعت بـ <span class="n">${fmt(x, 2)}</span>${x === floor ? ' (أقل سعر يحقق هدفك)' : ''}</span><span class="n">${fmt(q.net, 2)} ج</span></div>`; }).join('')}</div>`;
  };
  $('calcItem').addEventListener('change', (e) => { CALC_CODE = e.target.value; render(); });
  $('calcPrice').addEventListener('input', update);
  $('market').addEventListener('input', () => { setMarket(it.code, +$('market').value); update(); });
  update();
}

// ---------- Events ----------
$('ownerSel').addEventListener('change', (e) => { OWNER = e.target.value; render(); });
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) { TAB = b.dataset.tab; render(); } });
$('panel').addEventListener('click', (e) => { const b = e.target.closest('[data-calc]'); if (b) { CALC_CODE = b.dataset.calc; TAB = 'calc'; render(); } });
fields.forEach((f) => $(f).addEventListener('input', () => { store.set(SKEY, Object.fromEntries(fields.map((x) => [x, $(x).value]))); render(); }));
$('file').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  $('fileMsg').textContent = 'بقرا الملفات…';
  try {
    DATA = await readFiles(files);
    OFFERS.clear();
    $('srcChip').textContent = `بيانات صيدليتك: ${DATA.items.length} صنف`;
    $('srcChip').classList.add('real');
    $('resetBtn').hidden = false;
    $('fileMsg').innerHTML = DATA.sales.length ? 'اتقرت. بياناتك على جهازك بس.' : '<span class="err">اتقرت الأصناف، بس ملقتش مبيعات، فالطلبيات والراكد مش هيطلعوا صح. ارفع ملف المبيعات كمان.</span>';
  } catch (err) {
    $('fileMsg').innerHTML = `<span class="err">${esc(err.message)}</span>`;
  }
  e.target.value = '';
  render();
});
$('resetBtn').addEventListener('click', () => {
  DATA = exampleData(); OFFERS.clear();
  $('srcChip').textContent = 'بيانات مثال مصطنعة'; $('srcChip').classList.remove('real');
  $('resetBtn').hidden = true;
  $('fileMsg').textContent = 'بياناتك بتتقري على جهازك بس، ومش بتترفع على أي سيرفر.';
  render();
});

const saved = store.get(SKEY, {});
fields.forEach((f) => { if (saved[f] !== undefined) $(f).value = saved[f]; });
render();
