// Barcode labels for the shelf and the box (Code 128, which every scanner reads), and the QR code on
// the receipt. Pure functions that return SVG text; the pages print them.
import qrcode from './qrcode.js';

// Code 128 bar widths for values 0–106 (each: bar, space, bar, space, bar, space; 106 = stop + bar).
const PATTERNS = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 '
  + '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 '
  + '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 '
  + '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 '
  + '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 '
  + '114131 311141 411131 211412 211214 211232 2331112').split(' ');

// The symbol values for a text: set C (two digits per symbol) for an even run of digits, else set B.
export function code128(text) {
  const s = String(text);
  if (!/^[\x20-\x7e]+$/.test(s)) throw new Error('barcode text must be plain ASCII');
  const allDigits = /^\d+$/.test(s) && s.length % 2 === 0 && s.length >= 4;
  const vals = allDigits ? [105] : [104];
  if (allDigits) for (let i = 0; i < s.length; i += 2) vals.push(+s.slice(i, i + 2));
  else for (const ch of s) vals.push(ch.charCodeAt(0) - 32);
  let sum = vals[0];
  for (let i = 1; i < vals.length; i++) sum += vals[i] * i;
  vals.push(sum % 103, 106);
  return vals;
}

// The barcode as SVG bars (module = one narrow bar), with a quiet zone on both sides.
export function barcodeSvg(text, { height = 40, module = 1.6 } = {}) {
  const widths = code128(text).map((v) => PATTERNS[v]).join('');
  let x = 10 * module, bars = '';
  for (let i = 0; i < widths.length; i++) {
    const w = +widths[i] * module;
    if (i % 2 === 0) bars += `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${height}"/>`;
    x += w;
  }
  const width = x + 10 * module;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(2)} ${height}" width="${width.toFixed(2)}" height="${height}" preserveAspectRatio="none" role="img" aria-label="${text}"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${bars}</g></svg>`;
}

// A QR code (for the receipt: the pharmacy's WhatsApp, say) as SVG.
export function qrSvg(text, size = 96) {
  const q = qrcode(0, 'M');
  q.addData(unescape(encodeURIComponent(String(text)))); // UTF-8 bytes
  q.make();
  const n = q.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 4} ${n + 4}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// An Egyptian mobile number → a WhatsApp link (01xxxxxxxxx → https://wa.me/201xxxxxxxxx).
export function whatsappLink(phone) {
  const d = String(phone || '').replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 0x660).replace(/\D/g, '');
  if (/^01\d{9}$/.test(d)) return `https://wa.me/2${d}`;
  if (/^201\d{9}$/.test(d)) return `https://wa.me/${d}`;
  return null;
}

// One label: the pharmacy's name, the item, its price, and its barcode with the number under it.
export function labelHtml({ pharmacy, name, price, barcode }) {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<div class="label">${pharmacy ? `<div class="lb-ph">${esc(pharmacy)}</div>` : ''}<div class="lb-name">${esc(name)}</div>
    <div class="lb-bc">${barcodeSvg(barcode)}</div><div class="lb-row"><span class="n">${esc(barcode)}</span>${price ? `<b class="n">${esc(price)} ج</b>` : ''}</div></div>`;
}
