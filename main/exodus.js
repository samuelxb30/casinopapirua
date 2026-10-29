/* Exodus-style game wallet. Virtual coins only.
   Self-contained: injects its own styles and markup, so it works on any page
   that has a casino login (localStorage.token). */
(function () {
  'use strict';
  if (window.__exoWallet) return;
  window.__exoWallet = true;

  const CSS = `
.exo-hide{display:none!important}
.exo-launcher{position:fixed;left:88px;bottom:18px;z-index:25;width:58px;height:58px;border-radius:50%;border:0;background:linear-gradient(150deg,#7c5cff,#4a2fd1);color:#fff;cursor:pointer;box-shadow:0 6px 20px #0009;display:flex;align-items:center;justify-content:center;padding:0;transition:transform .15s}
.exo-launcher:hover{transform:scale(1.07)}
.exo-launcher svg{width:32px;height:32px}
.exo-launcher:focus-visible,.exo-panel button:focus-visible{outline:2px solid #b8a8ff;outline-offset:2px}
.exo-panel{position:fixed;left:18px;bottom:88px;z-index:26;width:min(390px,calc(100vw - 36px));height:min(700px,calc(100vh - 110px));background:linear-gradient(180deg,#3a2d94 0,#231d58 38%,#161a2e 70%);border:1px solid #0b0e17;border-radius:26px;overflow:hidden;box-shadow:0 14px 50px #000c;color:#f2f1ff;font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column}
.exo-panel *{box-sizing:border-box}
.exo-panel button,.exo-panel input,.exo-panel textarea,.exo-panel select{font-family:inherit}
.exo-iconbtn{background:#ffffff14;border:0;color:#dcd7ff;width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;font-size:16px;flex:none}
.exo-iconbtn:hover{background:#ffffff26}
.exo-hex{width:46px;height:46px;flex:none;background:var(--c,#7c5cff);clip-path:polygon(50% 0,93% 25%,93% 75%,50% 100%,7% 75%,7% 25%);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:21px;color:#fff;text-shadow:0 1px 3px #0006}
.exo-hex.sm{width:34px;height:34px;font-size:15px;background:#6a4cf0}
.exo-hex.sm svg{width:20px;height:20px}
.up{color:#2ecc71}.dn{color:#ff6b81}

.exo-loading{flex:1;display:flex;align-items:center;justify-content:center;color:#b9b3e8}

/* auth */
.exo-auth{flex:1;overflow-y:auto;padding:26px 24px 20px;display:flex;flex-direction:column;align-items:center;text-align:center;position:relative}
.exo-auth .exo-x{position:absolute;top:12px;right:12px}
.exo-logo{width:84px;height:84px;background:linear-gradient(150deg,#8d70ff,#4a2fd1);clip-path:polygon(50% 0,93% 25%,93% 75%,50% 100%,7% 75%,7% 25%);display:flex;align-items:center;justify-content:center;margin:6px 0 12px;color:#fff}
.exo-logo svg{width:44px;height:44px}
.exo-auth h3{margin:0 0 4px;font-size:24px}
.exo-sub{margin:0 0 16px;color:#b9b3e8;font-size:13px}
.exo-tabs{display:flex;gap:4px;background:#0d0f1f88;border-radius:12px;padding:3px;width:100%;margin-bottom:14px}
.exo-tabs button{flex:1;background:transparent;border:0;color:#b9b3e8;padding:9px 4px;border-radius:9px;font-weight:600;font-size:13px;cursor:pointer}
.exo-tabs button.on{background:#6a4cf0;color:#fff}
.exo-f{width:100%;margin-bottom:10px;text-align:left}
.exo-f input,.exo-f textarea,.exo-f select{width:100%;background:#0d0f1fa0;border:1px solid #3b3f6b;color:#f2f1ff;padding:12px 14px;border-radius:12px;font-size:15px;outline:0}
.exo-f textarea{resize:none}
.exo-f input:focus,.exo-f textarea:focus,.exo-f select:focus{border-color:#8d70ff}
.exo-f input::placeholder,.exo-f textarea::placeholder{color:#7b7fb0}
.exo-f select option{background:#1b1d36}
.exo-primary{width:100%;background:#6a4cf0;color:#fff;border:0;border-radius:12px;padding:13px;font-size:15px;font-weight:700;cursor:pointer}
.exo-primary:hover{background:#7a5eff}
.exo-primary:disabled{opacity:.45;cursor:not-allowed}
.exo-primary.green{background:#1fae5e}.exo-primary.red{background:#e04560}
.exo-warn{margin-top:14px;padding:10px 12px;border-radius:10px;background:#f5c54214;border:1px solid #f5c54255;color:#f3dca0;font-size:12px;text-align:left}
.exo-info{margin-top:10px;color:#8f93c4;font-size:11px;text-align:center}

/* seed */
.exo-seed{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:100%;margin:6px 0 12px}
.exo-seed span{background:#0d0f1fa0;border:1px solid #3b3f6b;border-radius:10px;padding:8px 4px;font-weight:600;font-size:13px;text-align:center}
.exo-seed i{color:#8d70ff;font-style:normal;font-size:10px;margin-right:4px}
.exo-check{display:flex;gap:8px;align-items:flex-start;text-align:left;width:100%;margin:6px 0 12px;font-size:13px;color:#d6d2ff}
.exo-check input{margin-top:2px;accent-color:#6a4cf0}

/* main */
.exo-main{flex:1;display:flex;flex-direction:column;min-height:0}
.exo-top{display:flex;align-items:center;gap:8px;padding:14px 14px 6px}
.exo-wname{font-weight:700;font-size:15px;min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.exo-wname small{display:block;font-weight:500;font-size:11px;color:#b9b3e8}
.exo-balpill{background:#0d0f1f88;border:1px solid #f5c54277;color:#f5c542;border-radius:99px;padding:5px 11px;font-weight:700;font-size:12px;white-space:nowrap}
.exo-body{flex:1;min-height:0;overflow-y:auto;padding:4px 14px 12px;scrollbar-width:thin;scrollbar-color:#4b4f86 transparent}
.exo-ringwrap{position:relative;width:min(220px,62vw);aspect-ratio:1;margin:6px auto 12px}
.exo-ringwrap svg{width:100%;height:100%;display:block}
.exo-ringc{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.exo-ringc small{color:#b9b3e8;font-size:11px;text-transform:uppercase;letter-spacing:1px}
.exo-ringc b{font-size:26px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;padding:0 24px}
.exo-card{display:flex;align-items:center;gap:12px;background:#24264aa8;border:1px solid #ffffff12;border-radius:16px;padding:11px 12px;margin-bottom:8px;cursor:pointer}
.exo-card:hover{background:#2d2f5cc0}
.exo-cm{flex:1;min-width:0}
.exo-cm b{display:block;font-size:15px}
.exo-cm span{font-size:12px;color:#b9b3e8;font-variant-numeric:tabular-nums}
.exo-cv{text-align:right;font-variant-numeric:tabular-nums;min-width:0}
.exo-cv b{display:block;font-size:14px;overflow-wrap:anywhere}
.exo-cv span{font-size:12px;color:#e8e6ff}
.exo-seg{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;background:#0d0f1f88;border-radius:12px;padding:3px;margin-bottom:12px}
.exo-seg button{background:transparent;border:0;color:#b9b3e8;padding:9px 4px;border-radius:9px;font-weight:700;font-size:13px;cursor:pointer}
.exo-seg button.on{background:#6a4cf0;color:#fff}
.exo-quick{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:-2px 0 10px}
.exo-quick button{background:#ffffff14;border:0;color:#e8e6ff;padding:8px 0;border-radius:9px;font-size:12px;font-weight:600;cursor:pointer}
.exo-quick button:hover{background:#ffffff26}
.exo-flip{display:block;margin:-2px auto 8px;background:#ffffff14;border:0;color:#e8e6ff;width:38px;height:38px;border-radius:50%;font-size:18px;cursor:pointer}
.exo-flip:hover{background:#ffffff26}
.exo-rate{color:#9a9ed0;font-size:12px;margin-top:2px}
.exo-lbl{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#9a9ed0;margin:0 0 4px}
.exo-est{color:#c9c6f5;font-size:13px;margin:4px 0 12px;min-height:38px}
.exo-est b{color:#fff}
.exo-tx{display:flex;gap:10px;align-items:center;padding:10px 4px;border-bottom:1px solid #ffffff12}
.exo-tx .ic{width:34px;height:34px;border-radius:50%;background:#ffffff14;display:flex;align-items:center;justify-content:center;flex:none;font-size:15px}
.exo-tx .t{flex:1;min-width:0}
.exo-tx .t b{display:block;font-size:14px}
.exo-tx .t span{font-size:12px;color:#9a9ed0}
.exo-empty{padding:30px 10px;text-align:center;color:#9a9ed0}
.exo-nav{flex:none;margin:6px 12px 14px;background:#20224bd0;border:1px solid #ffffff14;border-radius:99px;padding:6px;display:grid;grid-template-columns:repeat(4,1fr);gap:2px}
.exo-nav button{background:transparent;border:0;color:#b9b3e8;border-radius:99px;padding:9px 0;cursor:pointer;font-size:12px;font-weight:600;display:flex;flex-direction:column;align-items:center;gap:1px}
.exo-nav button span{font-size:19px;line-height:1}
.exo-nav button.on{background:#ffffff1f;color:#fff}
.exo-toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:40;background:#222a46;border:1px solid #8d70ff;color:#fff;padding:11px 20px;border-radius:10px;opacity:0;transition:.3s;pointer-events:none;max-width:90vw;font:14px system-ui,sans-serif;text-align:center}
.exo-toast.show{opacity:1}
@media(max-width:520px){
  .exo-panel{inset:0;left:0;bottom:0;width:100%;height:100%;border:0;border-radius:0}
  .exo-launcher{left:80px;bottom:12px;width:52px;height:52px}
}
`;

  const LOGO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" opacity=".3" d="M12 1.5 21 6.75v10.5L12 22.5 3 17.25V6.75z"/><path fill="currentColor" d="M8.2 7.6h7.6v1.9h-5.5v1.6h4.6V13h-4.6v1.5h5.6v1.9H8.2z"/></svg>';

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const holder = document.createElement('div');
  holder.innerHTML =
    '<button class="exo-launcher" id="exoLauncher" aria-label="Open Exodus wallet">' + LOGO + '</button>' +
    '<div class="exo-panel exo-hide" id="exoPanel" role="dialog" aria-label="Exodus wallet"></div>' +
    '<div class="exo-toast" id="exoToast"></div>';
  Array.from(holder.children).forEach(el => document.body.appendChild(el));

  const $ = id => document.getElementById(id);
  const panel = $('exoPanel');

  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = n => Math.floor(Number(n) || 0).toLocaleString();
  const fp = p => p >= 1000
    ? p.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : p >= 1 ? p.toFixed(3) : p.toFixed(4);
  const fq = q => !q ? '0' : q >= 1 ? q.toFixed(4) : q.toPrecision(4);
  const pc = c => (c >= 0 ? '+' : '') + (c * 100).toFixed(2) + '%';

  const S = {
    open: false,
    token: localStorage.exoToken || null,
    tab: 'password',
    view: 'portfolio',
    side: 'buy',
    sym: 'BTC',
    me: null,
    pending: null,
    busy: false,
    hist: null,
    from: 'BTC',
    to: 'ETH'
  };

  let toastTimer = null;
  function toast(t) {
    const e = $('exoToast');
    e.textContent = t;
    e.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => e.classList.remove('show'), 2600);
  }

  async function api(path, body) {
    try {
      const r = await fetch('/api/wallet/' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: localStorage.token || '',
          'X-Wallet-Token': S.token || ''
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const d = await r.json().catch(() => ({}));

      if (!r.ok) {
        if (r.status === 401 && d.wallet) signOut(true);
        toast(d.error || 'Wallet error');
        return null;
      }
      return d;
    } catch (e) {
      toast('Cannot reach server');
      return null;
    }
  }

  async function act(path, body) {
    if (S.busy) return null;
    S.busy = true;
    try { return await api(path, body); }
    finally { S.busy = false; }
  }

  function syncCasino(balance) {
    if (typeof balance !== 'number') return;
    try { if (typeof setBal === 'function') setBal(balance); } catch (e) { /* page has no setBal */ }
    const el = document.getElementById('bal');
    if (el) el.textContent = fmt(balance);
  }

  // ---------- open / close ----------
  function open(force) {
    S.open = force === undefined ? !S.open : force;

    if (S.open && !localStorage.token) {
      S.open = false;
      toast('Log in to the casino first');
      return;
    }

    panel.classList.toggle('exo-hide', !S.open);
    if (!S.open) return;

    // Only one floating window at a time: close the chat if it is open.
    const tg = document.getElementById('tgPanel');
    if (tg && !tg.classList.contains('hide') && typeof window.tgToggle === 'function') window.tgToggle(false);

    render();
    if (S.token) refresh();
  }

  $('exoLauncher').onclick = () => open();

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && S.open) open(false);
  });

  // Opening the chat closes the wallet.
  document.addEventListener('click', e => {
    if (S.open && e.target.closest && e.target.closest('#tgLauncher')) open(false);
  }, true);

  // ---------- rendering ----------
  function render() {
    if (S.pending) return renderSeed();

    if (!S.token) return renderAuth();

    if (!S.me) {
      panel.innerHTML = '<div class="exo-loading">Opening wallet…</div>';
      return;
    }
    renderMain();
  }

  function renderAuth() {
    const t = S.tab;
    let form;

    if (t === 'password') {
      form =
        '<div class="exo-f"><input id="exoName" placeholder="Wallet name" maxlength="16" autocomplete="off" spellcheck="false"></div>' +
        '<div class="exo-f"><input id="exoPass" type="password" placeholder="Password" maxlength="200" autocomplete="off" data-enter="login"></div>' +
        '<button class="exo-primary" data-act="login">Open wallet</button>';
    } else if (t === 'seed') {
      form =
        '<div class="exo-f"><textarea id="exoSeed" rows="4" placeholder="Enter your 12-word seed phrase, separated by spaces" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea></div>' +
        '<button class="exo-primary" data-act="loginSeed">Restore wallet</button>';
    } else {
      form =
        '<div class="exo-f"><input id="exoCName" placeholder="Choose a wallet name (1-16 characters)" maxlength="16" autocomplete="off" spellcheck="false"></div>' +
        '<div class="exo-f"><input id="exoCPass" type="password" placeholder="Choose a password" maxlength="200" autocomplete="off" data-enter="create"></div>' +
        '<button class="exo-primary" data-act="create">Create new wallet</button>';
    }

    const tab = (id, label) =>
      '<button data-act="tab" data-tab="' + id + '" class="' + (t === id ? 'on' : '') + '">' + label + '</button>';

    panel.innerHTML =
      '<div class="exo-auth">' +
        '<button class="exo-iconbtn exo-x" data-act="close" aria-label="Close wallet">✕</button>' +
        '<div class="exo-logo">' + LOGO + '</div>' +
        '<h3>Exodus Wallet</h3>' +
        '<p class="exo-sub">Game wallet · virtual coins only</p>' +
        '<div class="exo-tabs">' + tab('password', 'Password') + tab('seed', 'Seed phrase') + tab('create', 'New wallet') + '</div>' +
        form +
        '<div class="exo-warn">⚠️ Anyone who knows a wallet\'s password <b>or</b> its seed phrase can open it and take the funds. This is a game: never type a real wallet password or seed phrase here.</div>' +
        '<div class="exo-info">Simulation for entertainment. Not affiliated with or endorsed by Exodus Movement, Inc. No real-world value.</div>' +
      '</div>';

    const first = panel.querySelector('input,textarea');
    if (first) setTimeout(() => first.focus(), 30);
  }

  function renderSeed() {
    const p = S.pending;
    panel.innerHTML =
      '<div class="exo-auth">' +
        '<div class="exo-logo">' + LOGO + '</div>' +
        '<h3>Your seed phrase</h3>' +
        '<p class="exo-sub">Wallet “' + esc(p.name) + '” was created. Write these 12 words down.</p>' +
        '<div class="exo-seed">' +
          p.seed.map((w, i) => '<span><i>' + (i + 1) + '</i>' + esc(w) + '</span>').join('') +
        '</div>' +
        '<button class="exo-iconbtn" style="width:auto;border-radius:10px;padding:0 14px;height:34px;font-size:13px;margin-bottom:10px" data-act="copySeed">Copy words</button>' +
        '<div class="exo-warn" style="margin-top:0;margin-bottom:12px">This is the only time the phrase is shown. Anyone who has it — or your password — can open this wallet and spend or cash out everything in it.</div>' +
        '<label class="exo-check"><input type="checkbox" id="exoSaved" data-change="saved"> I saved my seed phrase</label>' +
        '<button class="exo-primary" id="exoContinue" data-act="continue" disabled>Continue</button>' +
      '</div>';
  }

  function ringSvg(assets, total) {
    const R = 96, C = 2 * Math.PI * R;
    let out = '';

    if (total <= 0) {
      out = '<circle cx="110" cy="110" r="' + R + '" fill="none" stroke="#ffffff26" stroke-width="7"/>';
    } else {
      let off = 0;
      for (const a of assets) {
        if (a.value <= 0) continue;
        const len = a.value / total * C;
        const dash = Math.max(0.1, len - Math.min(4, len * 0.2));
        out += '<circle cx="110" cy="110" r="' + R + '" fill="none" stroke="' + a.color +
          '" stroke-width="7" stroke-linecap="round" stroke-dasharray="' + dash + ' ' + (C - dash) +
          '" stroke-dashoffset="' + (-off) + '" transform="rotate(-90 110 110)"/>';
        off += len;
      }
    }
    return '<svg viewBox="0 0 220 220" aria-hidden="true">' + out + '</svg>';
  }

  function renderMain() {
    const nav = (id, icon, label) =>
      '<button data-act="nav" data-view="' + id + '" class="' + (S.view === id ? 'on' : '') + '"><span>' + icon + '</span>' + label + '</button>';

    panel.innerHTML =
      '<div class="exo-main">' +
        '<div class="exo-top">' +
          '<div class="exo-hex sm">' + LOGO + '</div>' +
          '<div class="exo-wname" id="exoWName"></div>' +
          '<div class="exo-balpill" id="exoBal" title="Your casino balance"></div>' +
          '<button class="exo-iconbtn" data-act="logout" title="Lock wallet" aria-label="Lock wallet">🔒</button>' +
          '<button class="exo-iconbtn" data-act="close" aria-label="Close wallet">✕</button>' +
        '</div>' +
        '<div class="exo-body" id="exoBody"></div>' +
        '<div class="exo-nav">' + nav('portfolio', '👛', 'Wallet') + nav('trade', '$', 'Trade') + nav('exchange', '⇄', 'Exchange') + nav('history', '🕘', 'History') + '</div>' +
      '</div>';

    $('exoWName').innerHTML = esc(S.me.name) + '<small>Game wallet</small>';
    renderView();
    paint();
  }

  function renderView() {
    const body = $('exoBody');
    if (!body) return;
    if (S.view === 'portfolio') {
      body.innerHTML =
        '<div class="exo-ringwrap"><div id="exoRing"></div><div class="exo-ringc"><small>Wallet value</small><b id="exoTotal">0</b></div></div>' +
        '<div id="exoList"></div>';
    } else if (S.view === 'trade') {
      renderTrade();
    } else if (S.view === 'exchange') {
      renderExchange();
    } else {
      renderHistory();
    }
    paint();
  }

  const asset = sym => (S.me ? S.me.assets : []).find(a => a.sym === sym);

  // Patch only the dynamic parts so inputs keep focus while prices update.
  function paint() {
    if (!S.me || !$('exoBody')) return;

    $('exoBal').textContent = '🪙 ' + fmt(S.me.balance);

    document.querySelectorAll('#exoPanel .exo-nav button').forEach(b =>
      b.classList.toggle('on', b.dataset.view === S.view));

    if (S.view === 'portfolio' && $('exoList')) {
      $('exoRing').innerHTML = ringSvg(S.me.assets, S.me.total);
      $('exoTotal').textContent = fmt(S.me.total);

      const sorted = [...S.me.assets].sort((a, b) => b.value - a.value);
      $('exoList').innerHTML = sorted.map(a =>
        '<div class="exo-card" data-act="pick" data-sym="' + a.sym + '">' +
          '<div class="exo-hex" style="--c:' + a.color + '">' + esc(a.glyph) + '</div>' +
          '<div class="exo-cm"><b>' + esc(a.name) + '</b>' +
            '<span>🪙 ' + fp(a.price) + ' <i class="' + (a.change >= 0 ? 'up' : 'dn') + '" style="font-style:normal">' + pc(a.change) + '</i></span></div>' +
          '<div class="exo-cv"><b style="color:' + a.color + '">' + fq(a.qty) + ' ' + a.sym + '</b>' +
            '<span>🪙 ' + fmt(a.value) + '</span></div>' +
        '</div>').join('');
    }

    if (S.view === 'trade') estimate();
    if (S.view === 'exchange') estimateX();
  }

  function renderTrade() {
    const body = $('exoBody');
    const side = S.side;
    const sideBtn = (id, label) =>
      '<button data-act="side" data-side="' + id + '" class="' + (side === id ? 'on' : '') + '">' + label + '</button>';

    const quick = side === 'buy'
      ? [['25%', .25], ['50%', .5], ['75%', .75], ['Max', 1]]
      : [['25%', 25], ['50%', 50], ['75%', 75], ['100%', 100]];

    const btnClass = side === 'buy' ? 'green' : side === 'sell' ? 'red' : '';
    const label = side === 'buy' ? 'Buy' : side === 'sell' ? 'Cash out' : 'Send';

    body.innerHTML =
      '<div class="exo-seg">' + sideBtn('buy', 'Buy') + sideBtn('sell', 'Cash out') + sideBtn('send', 'Send') + '</div>' +
      '<div class="exo-lbl">Asset</div>' +
      '<div class="exo-f"><select id="exoSym" data-change="sym">' +
        S.me.assets.map(a => '<option value="' + a.sym + '"' + (a.sym === S.sym ? ' selected' : '') + '>' + esc(a.name) + ' (' + a.sym + ')</option>').join('') +
      '</select></div>' +
      (side === 'send'
        ? '<div class="exo-lbl">Recipient wallet name</div><div class="exo-f"><input id="exoTo" placeholder="Wallet name" maxlength="16" autocomplete="off" spellcheck="false"></div>'
        : '') +
      '<div class="exo-lbl">' + (side === 'buy' ? 'Spend (casino coins)' : 'Percent of holding') + '</div>' +
      '<div class="exo-f"><input id="exoAmt" type="number" min="1" step="1" value="' + (side === 'buy' ? 100 : 100) + '" data-input="amt" data-enter="go"></div>' +
      '<div class="exo-quick">' +
        quick.map(q => '<button data-act="quick" data-v="' + q[1] + '">' + q[0] + '</button>').join('') +
      '</div>' +
      '<div class="exo-est" id="exoEst"></div>' +
      '<button class="exo-primary ' + btnClass + '" id="exoGo" data-act="go">' + label + '</button>' +
      '<div class="exo-info">' +
        (side === 'buy' ? 'Fee 0.5% · coins come out of your casino balance'
          : side === 'sell' ? 'Fee 0.5% · coins go to the casino account you are logged in with'
          : 'Moves funds to another wallet · no fee') +
      '</div>';

    estimate();
  }

  function estimate() {
    const el = $('exoEst');
    if (!el || !S.me) return;

    const a = asset(S.sym);
    if (!a) return;

    const v = parseFloat($('exoAmt') ? $('exoAmt').value : '') || 0;
    const go = $('exoGo');
    if (go) go.textContent = (S.side === 'buy' ? 'Buy ' : S.side === 'sell' ? 'Cash out ' : 'Send ') + a.sym;

    if (S.side === 'buy') {
      el.innerHTML = 'You get ≈ <b>' + fq(v * (1 - S.me.fee) / a.price) + ' ' + a.sym + '</b><br>' +
        'Price 🪙 ' + fp(a.price) + ' · Casino balance 🪙 ' + fmt(S.me.balance);
    } else if (a.qty <= 0) {
      el.textContent = 'This wallet holds no ' + a.name + '.';
    } else {
      const q = a.qty * Math.min(v, 100) / 100;
      el.innerHTML = (S.side === 'sell' ? 'Cash out' : 'Send') + ' <b>' + fq(q) + ' ' + a.sym + '</b>' +
        (S.side === 'sell' ? ' for ≈ <b>🪙 ' + fmt(q * a.price * (1 - S.me.fee)) + '</b>' : '') +
        '<br>Wallet holds ' + fq(a.qty) + ' ' + a.sym;
    }
  }


  // ---------- exchange (asset <-> asset) ----------
  function renderExchange() {
    const body = $('exoBody');
    const opts = sel => S.me.assets.map(a =>
      '<option value="' + a.sym + '"' + (a.sym === sel ? ' selected' : '') + '>' + esc(a.name) + ' (' + a.sym + ')</option>').join('');

    body.innerHTML =
      '<div class="exo-lbl">From</div>' +
      '<div class="exo-f"><select id="exoXFrom" data-change="xfrom">' + opts(S.from) + '</select></div>' +
      '<button class="exo-flip" data-act="flip" aria-label="Swap direction" title="Swap direction">⇅</button>' +
      '<div class="exo-lbl">To</div>' +
      '<div class="exo-f"><select id="exoXTo" data-change="xto">' + opts(S.to) + '</select></div>' +
      '<div class="exo-lbl">Percent of your holding to exchange</div>' +
      '<div class="exo-f"><input id="exoXAmt" type="number" min="1" max="100" step="1" value="100" data-input="xamt" data-enter="xgo"></div>' +
      '<div class="exo-quick">' +
        [25, 50, 75, 100].map(v => '<button data-act="xquick" data-v="' + v + '">' + v + '%</button>').join('') +
      '</div>' +
      '<div class="exo-est" id="exoXEst"></div>' +
      '<button class="exo-primary" id="exoXGo" data-act="xgo">Exchange</button>' +
      '<div class="exo-info">Fee 0.5% · swaps happen inside this wallet at the live price</div>';

    estimateX();
  }

  function estimateX() {
    const el = $('exoXEst');
    if (!el || !S.me) return;

    const a = asset(S.from);
    const b = asset(S.to);
    if (!a || !b) return;

    const v = parseFloat($('exoXAmt') ? $('exoXAmt').value : '') || 0;
    const go = $('exoXGo');
    if (go) go.textContent = 'Exchange ' + a.sym + ' → ' + b.sym;

    const rate = a.price * (1 - S.me.fee) / b.price;
    let html = '<span class="exo-rate">1 ' + a.sym + ' ≈ ' + fq(rate) + ' ' + b.sym + '</span><br>';

    if (S.from === S.to) {
      html = 'Pick two different assets.';
    } else if (a.qty <= 0) {
      html += 'This wallet holds no ' + a.name + '.';
    } else {
      const q = a.qty * Math.min(v, 100) / 100;
      html += 'Exchange <b>' + fq(q) + ' ' + a.sym + '</b> for ≈ <b>' + fq(q * rate) + ' ' + b.sym + '</b>' +
        '<br>You hold ' + fq(a.qty) + ' ' + a.sym;
    }
    el.innerHTML = html;
  }

  async function loadHistory() {
    const d = await api('history');
    if (!d) return;
    S.hist = d.txs;
    if (S.view === 'history') renderHistory();
  }

  function renderHistory() {
    const body = $('exoBody');
    if (!body) return;

    if (!S.hist) {
      body.innerHTML = '<div class="exo-empty">Loading…</div>';
      loadHistory();
      return;
    }
    if (!S.hist.length) {
      body.innerHTML = '<div class="exo-empty">No activity yet. Buy something to get started.</div>';
      return;
    }

    const when = ts => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    body.innerHTML = S.hist.map(t => {
      let icon, title, sub;
      if (t.kind === 'buy') {
        icon = '⬇️'; title = 'Bought ' + fq(t.qty) + ' ' + t.sym;
        sub = 'for 🪙 ' + fmt(t.coins) + ' · by ' + esc(t.note);
      } else if (t.kind === 'sell') {
        icon = '💸'; title = 'Cashed out ' + fq(t.qty) + ' ' + t.sym;
        sub = '+🪙 ' + fmt(t.coins) + ' to ' + esc(t.note);
      } else if (t.kind === 'swap') {
        const parts = String(t.note).split(':');
        icon = '🔄'; title = 'Exchanged ' + fq(t.qty) + ' ' + t.sym;
        sub = 'for ' + fq(Number(parts[1]) || 0) + ' ' + esc(parts[0]);
      } else if (t.kind === 'send') {
        icon = '📤'; title = 'Sent ' + fq(t.qty) + ' ' + t.sym;
        sub = 'to wallet ' + esc(t.note);
      } else {
        icon = '📥'; title = 'Received ' + fq(t.qty) + ' ' + t.sym;
        sub = 'from wallet ' + esc(t.note);
      }
      return '<div class="exo-tx"><div class="ic">' + icon + '</div><div class="t"><b>' + title + '</b><span>' + sub + '</span></div>' +
        '<span style="font-size:11px;color:#9a9ed0;white-space:nowrap">' + when(t.ts) + '</span></div>';
    }).join('');
  }

  // ---------- data ----------
  async function refresh() {
    if (!S.token) return;
    const d = await api('me');
    if (!d) return;

    const first = !S.me;
    S.me = d;
    if (!asset(S.sym)) S.sym = d.assets[0].sym;

    if (first && !S.pending) render();
    else paint();
  }

  function enter(token) {
    S.token = token;
    localStorage.exoToken = token;
    S.me = null;
    S.pending = null;
    S.view = 'portfolio';
    S.hist = null;
    render();
    refresh();
  }

  function signOut(silent) {
    const t = S.token;
    if (!silent && t) {
      fetch('/api/wallet/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: localStorage.token || '', 'X-Wallet-Token': t },
        body: '{}'
      }).catch(() => {});
    }
    S.token = null;
    S.me = null;
    S.pending = null;
    S.hist = null;
    S.tab = 'password';
    localStorage.removeItem('exoToken');
    if (S.open) render();
  }

  // ---------- actions ----------
  const actions = {
    close() { open(false); },

    tab(el) { S.tab = el.dataset.tab; renderAuth(); },

    async login() {
      const name = ($('exoName').value || '').trim();
      const password = $('exoPass').value;
      if (!name || !password) return toast('Enter the wallet name and password');
      const d = await act('login', { name, password });
      if (d) enter(d.token);
    },

    async loginSeed() {
      const seed = $('exoSeed').value;
      if (!seed.trim()) return toast('Enter your 12-word seed phrase');
      const d = await act('login-seed', { seed });
      if (d) enter(d.token);
    },

    async create() {
      const name = ($('exoCName').value || '').trim();
      const password = $('exoCPass').value;
      if (!name || !password) return toast('Choose a wallet name and a password');
      const d = await act('create', { name, password });
      if (!d) return;
      S.pending = { token: d.token, name: d.name, seed: d.seed };
      renderSeed();
    },

    async copySeed() {
      try {
        await navigator.clipboard.writeText(S.pending.seed.join(' '));
        toast('Seed phrase copied');
      } catch (e) {
        toast('Could not copy: write the words down instead');
      }
    },

    continue() {
      if (!S.pending) return;
      enter(S.pending.token);
    },

    logout() { signOut(false); },

    nav(el) {
      S.view = el.dataset.view;
      renderView();
    },

    pick(el) {
      S.sym = el.dataset.sym;
      S.view = 'trade';
      renderView();
    },

    side(el) {
      S.side = el.dataset.side;
      renderTrade();
    },

    quick(el) {
      const v = Number(el.dataset.v);
      $('exoAmt').value = S.side === 'buy'
        ? Math.max(1, Math.floor((S.me.balance || 0) * v))
        : v;
      estimate();
    },

    flip() {
      const f = S.from; S.from = S.to; S.to = f;
      renderExchange();
    },

    xquick(el) {
      $('exoXAmt').value = Number(el.dataset.v);
      estimateX();
    },

    async xgo() {
      if (S.from === S.to) return toast('Pick two different assets');
      const v = parseFloat($('exoXAmt').value);
      if (!(v > 0 && v <= 100)) return toast('Enter a percent from 1 to 100');

      const d = await act('swap', { from: S.from, to: S.to, percent: v });
      if (!d) return;

      toast(d.msg);
      S.hist = null;
      await refresh();
    },

    async go() {
      const v = parseFloat($('exoAmt').value);
      if (!(v > 0)) return toast('Enter an amount');

      let path, body;
      if (S.side === 'buy') {
        path = 'buy'; body = { sym: S.sym, coins: Math.floor(v) };
      } else if (S.side === 'sell') {
        path = 'sell'; body = { sym: S.sym, percent: v };
      } else {
        const to = ($('exoTo').value || '').trim();
        if (!to) return toast('Enter the recipient wallet name');
        path = 'send'; body = { sym: S.sym, percent: v, to };
      }

      const d = await act(path, body);
      if (!d) return;

      toast(d.msg);
      syncCasino(d.balance);
      S.hist = null;
      await refresh();
    }
  };

  panel.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || !panel.contains(el)) return;
    const fn = actions[el.dataset.act];
    if (fn) fn(el);
  });

  panel.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const el = e.target.closest('[data-enter]');
    if (el && actions[el.dataset.enter]) {
      e.preventDefault();
      actions[el.dataset.enter](el);
    }
  });

  panel.addEventListener('input', e => {
    if (e.target.dataset && e.target.dataset.input === 'amt') estimate();
    if (e.target.dataset && e.target.dataset.input === 'xamt') estimateX();
  });

  panel.addEventListener('change', e => {
    const t = e.target;
    if (!t.dataset) return;
    if (t.dataset.change === 'sym') { S.sym = t.value; estimate(); }
    if (t.dataset.change === 'xfrom') { S.from = t.value; estimateX(); }
    if (t.dataset.change === 'xto') { S.to = t.value; estimateX(); }
    if (t.dataset.change === 'saved') $('exoContinue').disabled = !t.checked;
  });

  // Keep prices and balances fresh while the wallet is open.
  setInterval(() => {
    if (S.open && S.token && !S.busy && !S.pending) refresh();
  }, 2000);

  // Resume a saved wallet session quietly (validated on first open).
})();