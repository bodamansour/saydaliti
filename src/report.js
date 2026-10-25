// "Money at risk" morning report — plain text, ready for WhatsApp. Pure function over analyze() output.
const fmt = (n) => Math.round(Number.isFinite(n) ? n : 0).toLocaleString('en-US');

export function morningReport(A, { pharmacyName = 'الصيدلية', date = new Date(), top = 5 } = {}) {
  const riskVal = A.expiring.reduce((a, r) => a + r.atRisk * r.cost, 0);
  const deadVal = A.deadStock.reduce((a, r) => a + r.qty * r.cost, 0);
  const orderVal = A.reorder.reduce((a, r) => a + r.order * r.cost, 0);
  const d = date.toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' });
  const lines = [`صباح الخير، تقرير ${pharmacyName} — ${d}`, ''];

  lines.push(`💰 فلوس في خطر: ${fmt(riskVal + deadVal)} جنيه`);
  lines.push(`   • هتنتهي قبل ما تتباع: ${fmt(riskVal)} ج (${A.expiring.length} صنف)`);
  lines.push(`   • راكد من غير بيع: ${fmt(deadVal)} ج (${A.deadStock.length} صنف)`);

  if (A.expiring.length) {
    lines.push('', '⏳ قرب ينتهي (اعمل عرض أو رجّعه للمخزن):');
    for (const r of A.expiring.slice(0, top)) {
      lines.push(`   • ${r.name}: ${r.atRisk} قطعة، ${r.expDays <= 0 ? 'منتهي' : `بعد ${r.expDays} يوم`} (${fmt(r.atRisk * r.cost)} ج)`);
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

  if (A.deadStock.length) {
    lines.push('', '🧊 أكبر رواكد (متطلبش منها تاني):');
    for (const r of A.deadStock.slice(0, Math.min(3, top))) {
      lines.push(`   • ${r.name}: ${r.qty} قطعة (${fmt(r.qty * r.cost)} ج)${r.lastSale === null ? ' — متباعتش خالص' : ` — آخر بيع من ${r.lastSale} يوم`}`);
    }
  }

  if (!A.expiring.length && !A.reorder.length && !A.deadStock.length) lines.push('', '✅ مفيش حاجة محتاجة تتعمل النهارده.');
  return lines.join('\n');
}
