// Barcode labels (Code 128) and the receipt's QR code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { code128, barcodeSvg, qrSvg, whatsappLink, labelHtml } from '../src/labels.js';

test('Code 128: start, data, checksum and stop', () => {
  // "12345678" in set C: start C (105), 12, 34, 56, 78, checksum, stop.
  const v = code128('12345678');
  assert.deepEqual(v.slice(0, 5), [105, 12, 34, 56, 78]);
  assert.equal(v[5], (105 + 12 * 1 + 34 * 2 + 56 * 3 + 78 * 4) % 103);
  assert.equal(v.at(-1), 106);
  assert.equal(code128('A1')[0], 104, 'set B for text');
  assert.match(barcodeSvg('6224008097136'), /^<svg[^>]*>.*<rect x=/);
  assert.throws(() => code128('بانادول'));
});

test('WhatsApp link and QR for the receipt', () => {
  assert.equal(whatsappLink('01001234567'), 'https://wa.me/201001234567');
  assert.equal(whatsappLink('٠١٠٠١٢٣٤٥٦٧'), 'https://wa.me/201001234567');
  assert.equal(whatsappLink('0502233445'), null);
  assert.match(qrSvg('https://wa.me/201001234567'), /<path d="M/);
});

test('a label has the name, the price and the barcode number', () => {
  const h = labelHtml({ pharmacy: 'صيدلية أحمد منصور', name: 'بانادول <إكسترا>', price: '51.00', barcode: '6224008097136' });
  assert.match(h, /بانادول &lt;إكسترا&gt;/);
  assert.match(h, /51\.00 ج/);
  assert.match(h, /6224008097136/);
});
