// The public pages (about, privacy, terms): fills in the current prices and the support number from
// the database (app_config is readable by anyone, it holds nothing private).
const $$ = (sel) => document.querySelectorAll(sel);
const fmt = (n) => (+n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

async function load() {
  try {
    const cfg = await (await fetch('./api/config')).json();
    if (!cfg?.url || cfg.local) return null;
    const res = await fetch(`${cfg.url}/rest/v1/app_config?select=trial_days,price_month,price_branch,support_phone&limit=1`, { headers: { apikey: cfg.key } });
    if (!res.ok) return null;
    return (await res.json())[0] || null;
  } catch { return null; }
}

load().then((c) => {
  if (!c) return;
  const wa = String(c.support_phone || '').replace(/\D/g, '').replace(/^0/, '20');
  for (const el of $$('[data-cfg="trial"]')) el.textContent = fmt(c.trial_days);
  for (const el of $$('[data-cfg="price"]')) el.textContent = fmt(c.price_month);
  for (const el of $$('[data-cfg="branch"]')) el.textContent = fmt(c.price_branch);
  for (const el of $$('[data-cfg="phone"]')) el.textContent = c.support_phone || '';
  for (const el of $$('a[data-cfg="whatsapp"]')) { if (wa) { el.href = `https://wa.me/${wa}`; el.hidden = false; } }
  for (const el of $$('[data-when="priced"]')) el.hidden = !(+c.price_month > 0);
  for (const el of $$('[data-when="branch"]')) el.hidden = !(+c.price_branch > 0);
  for (const el of $$('[data-when="phone"]')) el.hidden = !wa;
});
