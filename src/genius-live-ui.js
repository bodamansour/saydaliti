// «مزامنة مع المتحدة»: only inside the Windows program, online, for the pharmacy's owner. The program
// reads the United (Genius) database on this computer every few minutes and uploads what changed.
const day8 = (n) => (n ? `${String(n).slice(6, 8)}/${String(n).slice(4, 6)}/${String(n).slice(0, 4)}` : '');

export function setupGeniusLive({ $, esc, desk, makeToken }) {
  const g = desk?.genius;
  if (!g) return;
  $('geniusLiveBox').hidden = false;
  const when = (iso) => (iso ? new Date(iso).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const creds = () => ({ user: $('glUser').value.trim(), password: $('glPass').value });
  let found = [];

  async function refresh() {
    const s = await g.status();
    if (!s) return;
    $('glSetup').hidden = !!s.enabled;
    $('glRunning').hidden = !s.enabled;
    if (!s.enabled) { $('glStatus').textContent = 'المزامنة مقفولة على الجهاز ده.'; return; }
    const lines = [`شغالة من «${esc(s.database)}» على «${esc(s.server)}»، كل ${esc(s.minutes)} دقايق، ومن غير ما الشباك يبقى مفتوح.`];
    if (s.busy) lines.push('بيقرا من المتحدة دلوقتي…');
    if (s.lastCheck) lines.push(`آخر قراية: ${when(s.lastCheck)} — ${esc(s.items)} صنف${s.stockDay ? `، رصيد المتحدة بتاريخ ${day8(s.stockDay)}` : ''}.`);
    if (s.lastUpload) lines.push(`آخر رفع: ${when(s.lastUpload)}. دوس F5 عشان تشوف الأرقام الجديدة.`);
    if (s.lastError) lines.push(`<span class="err">${esc(s.lastError)}</span>`);
    else if (s.nextAt) lines.push(`<span class="note">القراية الجاية: ${when(s.nextAt)}</span>`);
    $('glStatus').innerHTML = lines.join('<br>');
  }

  $('glFind').addEventListener('click', async () => {
    $('glFindMsg').textContent = 'بيدوّر…';
    $('glFound').hidden = true;
    const r = await g.find(creds());
    found = r?.databases || [];
    if (found.length) {
      $('glDb').innerHTML = found.map((d, i) => `<option value="${i}">${esc(d.database)} على ${esc(d.server)} (${esc(d.items)} صنف)</option>`).join('');
      $('glFound').hidden = false;
      $('glFindMsg').textContent = found.length > 1 ? 'لقيت أكتر من قاعدة بيانات، اختار اللي فيها أصناف أكتر.' : 'لقيت المتحدة.';
    } else {
      const errs = (r?.errors || []).map((e) => e.message);
      $('glFindMsg').innerHTML = `<span class="err">${esc(errs[0] || (r?.servers?.length ? 'لقيت SQL Server بس مفيش فيه قاعدة بيانات المتحدة.' : 'مفيش SQL Server على الجهاز ده. افتح صيدليتي على الجهاز اللي عليه المتحدة.'))}</span>`;
    }
  });

  $('glOn').addEventListener('click', async () => {
    const d = found[+$('glDb').value];
    if (!d) return;
    $('glFindMsg').textContent = 'بيشغّل المزامنة ويقرا أول مرة (ممكن ياخد كام دقيقة)…';
    $('glOn').disabled = true;
    try {
      const token = await makeToken();
      await g.enable({ server: d.server, database: d.database, ...creds(), token, minutes: +$('glMin').value });
      $('glFindMsg').textContent = '';
    } catch (e) {
      $('glFindMsg').innerHTML = `<span class="err">${esc(e.message)}</span>`;
    } finally { $('glOn').disabled = false; refresh(); }
  });
  $('glNow').addEventListener('click', async () => { const p = g.now(); setTimeout(refresh, 300); await p; refresh(); });
  $('glOff').addEventListener('click', async () => { await g.disable(); refresh(); });

  let timer = null;
  $('geniusLiveBox').addEventListener('toggle', () => {
    clearInterval(timer);
    if ($('geniusLiveBox').open) { refresh(); timer = setInterval(refresh, 4000); }
  });
  refresh();
}
