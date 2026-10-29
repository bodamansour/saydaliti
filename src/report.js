
// "Money at risk" morning report — plain text, ready for WhatsApp. Pure function over analyze() output.
// At what each batch cost when known (from analyze), else at the item's buying price.
const riskOf = (r) => r.riskValue ?? r.atRisk * r.cost;
const valueOf = (r) => r.value ?? r.qty * r.cost;
const NF0 = new Intl.NumberFormat('en-US');
const fmt = (n) => NF0.format(Math.round(Number.isFinite(n) ? n : 0));

export function morningReport(A, { pharmacyName = 'الصيدلية', date = new Date(), top = 5, shortages = [], priceChanged = 0 } = {}) {
  const riskVal = A.expiring.reduce((a, r) => a + riskOf(r), 0);
  const deadVal = A.deadStock.reduce((a, r) => a + valueOf(r), 0);
  const orderVal = A.reorder.reduce((a, r) => a + r.order * r.cost, 0);
  const d = date.toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' });
  const lines = [`صباح الخير، تقرير ${pharmacyName} — ${d}`, ''];

  lines.push(`💰 فلوس في خطر: ${fmt(riskVal + deadVal)} جنيه`);
  lines.push(`   • هتنتهي قبل ما تتباع: ${fmt(riskVal)} ج (${A.expiring.length} صنف)`);
  lines.push(`   • راكد من غير بيع: ${fmt(deadVal)} ج (${A.deadStock.length} صنف)`);

  if (A.expiring.length) {
    lines.push('', '⏳ قرب ينتهي (اعمل عرض أو رجّعه للمخزن):');
    for (const r of A.expiring.slice(0, top)) {
      lines.push(`   • ${r.name}: ${r.atRisk} قطعة، ${r.expDays <= 0 ? 'منتهي' : `بعد ${r.expDays} يوم`} (${fmt(riskOf(r))} ج)`);
    }
    if (A.expiring.length > top) lines.push(`   و${A.expiring.length - top} صنف تاني في اللوحة.`);
  }

  if (A.reorder.length) {
    lines.push('', `🛒 اطلب النهارده (حوالي ${fmt(orderVal)} ج):`);
    for (const r of A.reorder.slice(0, top)) {
      lines.push(`   • ${r.name}: ${r.order} — ${r.daysCover < 1 ? 'خلص تقريباً' : `هيخلص بعد ${Math.round(r.daysCover)} يوم`}`);
    }
    if (A.reorder.length > top) lines.push(`   و${A.reorder.length - top} صنف تاني في اللوحة.`);
  }

  if (shortages.length) {
    lines.push('', '🚫 ناقص في السوق (اطلب أول ما يتوفر):');
    for (const x of shortages.slice(0, top)) {
      const left = x.daysCover === Infinity ? 'مبيتسحبش' : x.daysCover < 1 ? 'خلص تقريباً' : `يكفي ${Math.round(x.daysCover)} يوم`;
      lines.push(`   • ${x.row.name}: معاك ${x.qty} (${left})${x.stockUp ? ` — اطلب ${x.stockUp}` : ''}`);
    }
  }

  if (A.deadStock.length) {
    lines.push('', '🧊 أكبر رواكد (متطلبش منها تاني):');
    for (const r of A.deadStock.slice(0, Math.min(3, top))) {
      lines.push(`   • ${r.name}: ${r.qty} قطعة (${fmt(valueOf(r))} ج)${r.lastSale === null ? ' — متباعتش خالص' : ` — آخر بيع من ${r.lastSale} يوم`}`);
    }
  }

  if (priceChanged) lines.push('', `💲 ${priceChanged} صنف سعره اتغير في آخر تحديث للبيانات (التفاصيل في «أسعار اتغيرت»).`);

  if (!A.expiring.length && !A.reorder.length && !A.deadStock.length && !shortages.length && !priceChanged) lines.push('', '✅ مفيش حاجة محتاجة تتعمل النهارده.');
  return lines.join('\n');
}

// ---------- WhatsApp template (business-initiated messages must use an approved template) ----------
// Template body to submit in Meta (Arabic), 6 variables:
//   صباح الخير {{1}}
//   فلوس في خطر النهارده: {{2}} جنيه.
//   {{3}} صنف هينتهي قبل ما يتباع، و{{4}} صنف راكد، و{{5}} صنف محتاج يتطلب.
//   التفاصيل والعروض الجاهزة: {{6}}
// Parameter values may not contain new lines, tabs or more than 4 spaces in a row.
const oneLine = (s) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim() || '-';

export function morningTemplateParams(A, { pharmacyName = 'الصيدلية', link = '' } = {}) {
  const riskVal = A.expiring.reduce((a, r) => a + riskOf(r), 0);
  const deadVal = A.deadStock.reduce((a, r) => a + valueOf(r), 0);
  return [pharmacyName, fmt(riskVal + deadVal), String(A.expiring.length), String(A.deadStock.length), String(A.reorder.length), link].map(oneLine);
}

// Egyptian mobile numbers → WhatsApp format (country code, no +). Returns null for anything else.
export function normalizeEgPhone(raw) {
  const ar = '٠١٢٣٤٥٦٧٨٩';
  let d = String(raw ?? '').replace(/[٠-٩]/g, (c) => ar.indexOf(c)).replace(/\D/g, '');
  if (d.startsWith('0020')) d = d.slice(2);
  if (d.startsWith('01') && d.length === 11) d = '2' + d;
  return /^201[0125]\d{8}$/.test(d) ? d : null;
}

export function parsePhones(text) {
  return [...new Set(String(text ?? '').split(/[,،;\n]+/).map(normalizeEgPhone).filter(Boolean))];
}
