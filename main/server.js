
const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const db = new Database(path.join(__dirname, 'casino.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE COLLATE NOCASE,
  salt TEXT,
  hash TEXT,
  balance INTEGER NOT NULL DEFAULT 1000,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER);
CREATE TABLE IF NOT EXISTS games(user_id INTEGER PRIMARY KEY, type TEXT, bet INTEGER, state TEXT);
CREATE TABLE IF NOT EXISTS holdings(
  user_id INTEGER,
  sym TEXT,
  qty REAL,
  cost REAL,
  PRIMARY KEY(user_id,sym)
);
CREATE TABLE IF NOT EXISTS auto_orders(
  user_id INTEGER,
  sym TEXT,
  target REAL,
  stop REAL,
  PRIMARY KEY(user_id,sym)
);
`);

const START_BALANCE = 1000;
const CHICKEN_MAX = 12;
const P = { easy: 0.08, medium: 0.15, hard: 0.25 };

const mm = (c, k) => {
  let m = 0.97;
  for (let i = 0; i < k; i++) m *= (25 - i) / (25 - c - i);
  return m;
};
const cm = (p, n) => 0.97 / Math.pow(1 - p, n);
const rand = () => crypto.randomInt(0, 1e9) / 1e9;
const hashPw = (p, s) => crypto.scryptSync(p, s, 64).toString('hex');
const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

const app = express();
app.use(express.json({ limit: '20kb' }));

// Keep server.js and casino.db outside the public directory.
// Put index.html and trade.html in ./public.
app.use(express.static(__dirname, {
  index: 'index.html',
  dotfiles: 'ignore'
}));

const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });
const getBal = id => db.prepare('SELECT balance FROM users WHERE id=?').get(id).balance;
const addBal = (id, d) => db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(d, id);
const newSession = uid => {
  const t = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?)').run(t, uid);
  return t;
};

function auth(req, res, next) {
  const token = req.headers.authorization || '';
  const u = db.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?'
  ).get(token);
  if (!u) return fail(res, 'Please log in', 401);
  req.user = u;
  next();
}

const admin = (req, res, next) =>
  req.user.is_admin ? next() : fail(res, 'Admins only', 403);

const validBet = (req, res) => {
  const bet = Number(req.body.bet);
  if (!Number.isInteger(bet) || bet < 1) {
    fail(res, 'Invalid bet');
    return null;
  }
  if (bet > getBal(req.user.id)) {
    fail(res, 'Not enough balance');
    return null;
  }
  return bet;
};

const getGame = (uid, type) => {
  const g = db.prepare('SELECT * FROM games WHERE user_id=?').get(uid);
  return g && g.type === type
    ? { ...g, s: JSON.parse(g.state) }
    : null;
};
const saveGame = (uid, type, bet, s) =>
  db.prepare('INSERT OR REPLACE INTO games VALUES(?,?,?,?)')
    .run(uid, type, bet, JSON.stringify(s));
const endGame = uid => db.prepare('DELETE FROM games WHERE user_id=?').run(uid);
const hasGame = uid => !!db.prepare('SELECT 1 FROM games WHERE user_id=?').get(uid);

// ---------- Accounts ----------
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};

  if (!/^[a-zA-Z0-9_]{3,16}$/.test(username || ''))
    return fail(res, 'Username: 3-16 letters, numbers or _');

  if (typeof password !== 'string' || password.length < 6 || password.length > 200)
    return fail(res, 'Password must be 6-200 characters');

  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username))
    return fail(res, 'Username already taken');

  const salt = crypto.randomBytes(16).toString('hex');
  const first = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;

  const r = db.prepare(
    'INSERT INTO users(username,salt,hash,balance,is_admin) VALUES(?,?,?,?,?)'
  ).run(username, salt, hashPw(password, salt), START_BALANCE, first ? 1 : 0);

  res.json({ token: newSession(r.lastInsertRowid) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username || '');

  if (
    !u ||
    typeof password !== 'string' ||
    !crypto.timingSafeEqual(
      Buffer.from(hashPw(password, u.salt)),
      Buffer.from(u.hash)
    )
  ) return fail(res, 'Wrong username or password', 401);

  res.json({ token: newSession(u.id) });
});

app.get('/api/me', auth, (req, res) => {
  const u = req.user;
  const g = db.prepare('SELECT * FROM games WHERE user_id=?').get(u.id);
  let game = null;

  if (g) {
    const s = JSON.parse(g.state);
    game = {
      type: g.type,
      bet: g.bet,
      revealed: s.revealed,
      count: s.count,
      steps: s.steps,
      diff: s.diff,
      mult: g.type === 'mines'
        ? mm(s.count, s.revealed.length)
        : cm(P[s.diff], s.steps)
    };
  }

  res.json({
    username: u.username,
    balance: u.balance,
    isAdmin: !!u.is_admin,
    game
  });
});

app.post('/api/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token=?')
    .run(req.headers.authorization);
  res.json({});
});

// ---------- Admin ----------
app.get('/api/admin/users', auth, admin, (req, res) =>
  res.json(
    db.prepare(
      'SELECT id,username,balance,is_admin,created FROM users ORDER BY id'
    ).all()
  )
);

app.post('/api/admin/balance', auth, admin, (req, res) => {
  const { id, amount, mode } = req.body || {};
  const n = Number(amount);

  if (!Number.isSafeInteger(n) || Math.abs(n) > 1e12)
    return fail(res, 'Invalid amount');

  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id))
    return fail(res, 'User not found');

  if (mode === 'set') {
    db.prepare('UPDATE users SET balance=? WHERE id=?')
      .run(Math.max(0, n), id);
  } else {
    db.prepare('UPDATE users SET balance=MAX(0,balance+?) WHERE id=?')
      .run(n, id);
  }

  res.json({ balance: getBal(id) });
});

// ---------- Mines ----------
app.post('/api/mines/start', auth, (req, res) => {
  const c = Number(req.body.mines);

  if (!Number.isInteger(c) || c < 1 || c > 24)
    return fail(res, 'Mines must be 1-24');

  if (hasGame(req.user.id))
    return fail(res, 'Finish your current game first');

  const bet = validBet(req, res);
  if (!bet) return;

  const cells = [...Array(25).keys()];
  for (let i = 24; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }

  addBal(req.user.id, -bet);
  saveGame(req.user.id, 'mines', bet, {
    mines: cells.slice(0, c),
    count: c,
    revealed: []
  });

  res.json({ balance: getBal(req.user.id), next: mm(c, 1) });
});

app.post('/api/mines/reveal', auth, (req, res) => {
  const g = getGame(req.user.id, 'mines');
  if (!g) return fail(res, 'No active game');

  const i = Number(req.body.index);
  if (!Number.isInteger(i) || i < 0 || i > 24 || g.s.revealed.includes(i))
    return fail(res, 'Invalid tile');

  if (g.s.mines.includes(i)) {
    endGame(req.user.id);
    return res.json({
      boom: true,
      mines: g.s.mines,
      balance: getBal(req.user.id)
    });
  }

  g.s.revealed.push(i);
  const k = g.s.revealed.length;
  const mult = mm(g.s.count, k);

  if (k === 25 - g.s.count) {
    const payout = Math.floor(g.bet * mult);
    addBal(req.user.id, payout);
    endGame(req.user.id);
    return res.json({
      done: true, mult, payout, mines: g.s.mines,
      balance: getBal(req.user.id)
    });
  }

  saveGame(req.user.id, 'mines', g.bet, g.s);
  res.json({ mult, next: mm(g.s.count, k + 1) });
});

app.post('/api/mines/cashout', auth, (req, res) => {
  const g = getGame(req.user.id, 'mines');
  if (!g || !g.s.revealed.length)
    return fail(res, 'Reveal at least one tile first');

  const mult = mm(g.s.count, g.s.revealed.length);
  const payout = Math.floor(g.bet * mult);

  addBal(req.user.id, payout);
  endGame(req.user.id);
  res.json({ payout, mult, mines: g.s.mines, balance: getBal(req.user.id) });
});

// ---------- Chicken Road ----------
app.post('/api/chicken/start', auth, (req, res) => {
  const diff = req.body.diff;
  if (!P[diff]) return fail(res, 'Invalid difficulty');
  if (hasGame(req.user.id)) return fail(res, 'Finish your current game first');

  const bet = validBet(req, res);
  if (!bet) return;

  addBal(req.user.id, -bet);
  saveGame(req.user.id, 'chicken', bet, { diff, steps: 0 });
  res.json({ balance: getBal(req.user.id) });
});

app.post('/api/chicken/step', auth, (req, res) => {
  const g = getGame(req.user.id, 'chicken');
  if (!g) return fail(res, 'No active game');

  if (rand() < P[g.s.diff]) {
    endGame(req.user.id);
    return res.json({
      dead: true,
      steps: g.s.steps + 1,
      balance: getBal(req.user.id)
    });
  }

  g.s.steps++;
  const mult = cm(P[g.s.diff], g.s.steps);

  if (g.s.steps >= CHICKEN_MAX) {
    const payout = Math.floor(g.bet * mult);
    addBal(req.user.id, payout);
    endGame(req.user.id);
    return res.json({
      done: true, steps: g.s.steps, mult, payout,
      balance: getBal(req.user.id)
    });
  }

  saveGame(req.user.id, 'chicken', g.bet, g.s);
  res.json({ steps: g.s.steps, mult });
});

app.post('/api/chicken/cashout', auth, (req, res) => {
  const g = getGame(req.user.id, 'chicken');
  if (!g || !g.s.steps)
    return fail(res, 'Take at least one step first');

  const mult = cm(P[g.s.diff], g.s.steps);
  const payout = Math.floor(g.bet * mult);

  addBal(req.user.id, payout);
  endGame(req.user.id);
  res.json({ payout, mult, balance: getBal(req.user.id) });
});

// ---------- Boxes ----------
const BOX = [[0, 45], [0.5, 20], [1.5, 22], [3, 11], [10, 2]];
const pickBox = () => {
  let r = rand() * 100;
  for (const [m, w] of BOX) {
    if ((r -= w) < 0) return m;
  }
  return 0;
};

app.post('/api/boxes/open', auth, (req, res) => {
  const pick = Number(req.body.pick);

  if (![0, 1, 2].includes(pick)) return fail(res, 'Pick a box');
  if (hasGame(req.user.id)) return fail(res, 'Finish your current game first');

  const bet = validBet(req, res);
  if (!bet) return;

  const boxes = [pickBox(), pickBox(), pickBox()];
  const payout = Math.floor(bet * boxes[pick]);

  addBal(req.user.id, payout - bet);
  res.json({ boxes, payout, balance: getBal(req.user.id) });
});

// ---------- Roulette ----------
app.post('/api/roulette/spin', auth, (req, res) => {
  const bets = Array.isArray(req.body.bets) ? req.body.bets.slice(0, 20) : [];
  if (!bets.length) return fail(res, 'Place a bet first');
  if (hasGame(req.user.id)) return fail(res, 'Finish your current game first');

  let total = 0;
  for (const b of bets) {
    if (!Number.isInteger(b.amount) || b.amount < 1)
      return fail(res, 'Invalid bet');

    if (
      b.type === 'number'
        ? !(Number.isInteger(b.value) && b.value >= 0 && b.value <= 36)
        : !['red','black','even','odd','low','high'].includes(b.type)
    ) return fail(res, 'Invalid bet');

    total += b.amount;
    if (!Number.isSafeInteger(total)) return fail(res, 'Bet too large');
  }

  if (total > getBal(req.user.id)) return fail(res, 'Not enough balance');

  const n = crypto.randomInt(37);
  let payout = 0;

  for (const b of bets) {
    const win = {
      number: n === b.value,
      red: RED.has(n),
      black: n > 0 && !RED.has(n),
      even: n > 0 && n % 2 === 0,
      odd: n % 2 === 1,
      low: n >= 1 && n <= 18,
      high: n >= 19
    }[b.type];

    if (win) payout += b.amount * (b.type === 'number' ? 36 : 2);
  }

  addBal(req.user.id, payout - total);
  res.json({ number: n, payout, total, balance: getBal(req.user.id) });
});

// ---------- Virtual crypto market ----------
const FEE = 0.005;
const HIST = 600;

const COINS = {
  BTCP:  { name: 'Paper Bitcoin',  emoji: '₿',  anchor: 50000,  vol: 0.025 },
  MOONZ: { name: 'MoonZ',          emoji: '🚀', anchor: 1.8,    vol: 0.075 },
  DOGO:  { name: 'Dogo Coin',      emoji: '🐶', anchor: 0.42,   vol: 0.060 },
  WOJK:  { name: 'Wojak Finance',  emoji: '😭', anchor: 0.12,   vol: 0.095 },
  PEPO:  { name: 'Pepo the Frog',  emoji: '🐸', anchor: 0.0035, vol: 0.120 }
};

const gauss = () => {
  let u = 0, v = 0;
  while (!u) u = rand();
  while (!v) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

for (const c of Object.values(COINS)) {
  c.price = c.anchor;
  c.mu = 0;
  c.hist = [];
}

let tickN = 0;
let tradeId = 0;
const TRADES = [];

const logTrade = (user, sym, side, coins, qty, price) => {
  TRADES.push({
    id: ++tradeId,
    user,
    sym,
    side,
    coins,
    qty,
    price,
    tick: tickN
  });
  if (TRADES.length > 500) TRADES.shift();
};

// Automatically sell the user's full holding when either threshold is crossed.
// Each order is deleted after triggering, preventing repeated execution.
function processAutoSells() {
  const orders = db.prepare('SELECT * FROM auto_orders').all();

  for (const order of orders) {
    const c = COINS[order.sym];
    if (!c) continue;

    const targetHit = order.target != null && c.price >= order.target;
    const stopHit = order.stop != null && c.price <= order.stop;
    if (!targetHit && !stopHit) continue;

    const h = db.prepare(
      'SELECT * FROM holdings WHERE user_id=? AND sym=?'
    ).get(order.user_id, order.sym);

    if (!h || h.qty <= 0) {
      db.prepare('DELETE FROM auto_orders WHERE user_id=? AND sym=?')
        .run(order.user_id, order.sym);
      continue;
    }

    const qty = h.qty;
    const proceeds = Math.max(0, Math.floor(qty * c.price * (1 - FEE)));
    const user = db.prepare('SELECT username FROM users WHERE id=?')
      .get(order.user_id);

    const execute = db.transaction(() => {
      addBal(order.user_id, proceeds);
      db.prepare('DELETE FROM holdings WHERE user_id=? AND sym=?')
        .run(order.user_id, order.sym);
      db.prepare('DELETE FROM auto_orders WHERE user_id=? AND sym=?')
        .run(order.user_id, order.sym);
    });

    execute();

    if (user) {
      logTrade(user.username, order.sym, 'sell', proceeds, qty, c.price);
    }
  }
}

function tick() {
  tickN++;

  for (const c of Object.values(COINS)) {
    // Periodically start a strong upward or downward trend.
    if (rand() < 0.035) {
      c.mu = (rand() < 0.5 ? -1 : 1) * c.vol * (0.5 + rand() * 2);
    }

    // Trends fade gradually, but random movement can overpower them.
    c.mu *= 0.985;

    let r = c.mu + gauss() * c.vol
      - 0.0008 * Math.log(c.price / c.anchor);

    // Occasional sudden pumps or crashes.
    if (rand() < 0.012) {
      r += (rand() < 0.5 ? -1 : 1) * (0.12 + rand() * 0.65);
    }

    // Prevent zero, negative, infinite, or invalid prices.
    const nextPrice = c.price * Math.exp(Math.max(-5, Math.min(5, r)));
    c.price = Number.isFinite(nextPrice)
      ? Math.max(c.anchor * 0.001, nextPrice)
      : c.anchor * 0.001;

    c.hist.push(c.price);
    if (c.hist.length > HIST) c.hist.shift();
  }

  processAutoSells();
}

for (let i = 0; i < HIST; i++) tick();
setInterval(tick, 1000);

app.get('/api/market', auth, (req, res) => {
  const sel = COINS[req.query.coin] ? req.query.coin : 'DOGO';

  res.json({
    balance: getBal(req.user.id),
    selected: sel,
    history: COINS[sel].hist,
    fee: FEE,
    tick: tickN,

    // Shared trade feed and chart markers for all logged-in users.
    feed: TRADES.slice(-30).reverse(),
    marks: TRADES.filter(t => t.sym === sel && t.tick > tickN - HIST),

    coins: Object.entries(COINS).map(([sym, c]) => ({
      sym,
      name: c.name,
      emoji: c.emoji,
      price: c.price,
      change: c.hist.length > 1
        ? c.price / c.hist[Math.max(0, c.hist.length - 300)] - 1
        : 0
    })),

    holdings: db.prepare(
      'SELECT sym,qty,cost FROM holdings WHERE user_id=?'
    ).all(req.user.id),

    autoOrders: db.prepare(
      'SELECT sym,target,stop FROM auto_orders WHERE user_id=?'
    ).all(req.user.id)
  });
});

app.post('/api/trade', auth, (req, res) => {
  const { sym, side } = req.body || {};
  const c = COINS[sym];
  const uid = req.user.id;

  if (!c) return fail(res, 'Unknown coin');

  const price = c.price;
  const h = db.prepare(
    'SELECT * FROM holdings WHERE user_id=? AND sym=?'
  ).get(uid, sym);

  if (side === 'buy') {
    const amt = Number(req.body.amount);

    if (!Number.isSafeInteger(amt) || amt < 1)
      return fail(res, 'Enter a valid amount');

    if (amt > getBal(uid)) return fail(res, 'Not enough balance');

    const qty = amt * (1 - FEE) / price;

    const execute = db.transaction(() => {
      addBal(uid, -amt);
      db.prepare(`
        INSERT INTO holdings VALUES(?,?,?,?)
        ON CONFLICT(user_id,sym)
        DO UPDATE SET qty=qty+excluded.qty,cost=cost+excluded.cost
      `).run(uid, sym, qty, amt);
    });

    execute();
    logTrade(req.user.username, sym, 'buy', amt, qty, price);

    return res.json({
      balance: getBal(uid),
      msg: `Bought ${qty.toPrecision(5)} ${sym}`
    });
  }

  if (side === 'sell') {
    if (!h || h.qty <= 0) return fail(res, 'You do not own this coin');

    const pct = Number(req.body.percent);
    if (!(pct > 0 && pct <= 100))
      return fail(res, 'Percent must be 1-100');

    const q = pct === 100 ? h.qty : h.qty * pct / 100;
    const got = Math.max(0, Math.floor(q * price * (1 - FEE)));

    const execute = db.transaction(() => {
      addBal(uid, got);

      if (pct === 100) {
        db.prepare('DELETE FROM holdings WHERE user_id=? AND sym=?')
          .run(uid, sym);
        db.prepare('DELETE FROM auto_orders WHERE user_id=? AND sym=?')
          .run(uid, sym);
      } else {
        db.prepare(`
          UPDATE holdings SET qty=qty-?,cost=cost-?
          WHERE user_id=? AND sym=?
        `).run(q, h.cost * q / h.qty, uid, sym);
      }
    });

    execute();
    logTrade(req.user.username, sym, 'sell', got, q, price);

    return res.json({
      balance: getBal(uid),
      msg: `Sold for ${got.toLocaleString()} coins`
    });
  }

  return fail(res, 'Invalid side');
});

// ---------- Auto-sell settings ----------
app.post('/api/auto-sell', auth, (req, res) => {
  const { sym } = req.body || {};

  if (!COINS[sym]) return fail(res, 'Unknown coin');

  if (req.body.clear === true) {
    db.prepare('DELETE FROM auto_orders WHERE user_id=? AND sym=?')
      .run(req.user.id, sym);
    return res.json({ msg: `Auto-sell cancelled for ${sym}` });
  }

  const parsePrice = value => {
    if (value === '' || value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : NaN;
  };

  const target = parsePrice(req.body.target);
  const stop = parsePrice(req.body.stop);

  if (Number.isNaN(target) || Number.isNaN(stop))
    return fail(res, 'Prices must be positive numbers');

  if (target == null && stop == null)
    return fail(res, 'Enter a target price or stop-loss price');

  if (target != null && stop != null && target <= stop)
    return fail(res, 'Target price must be higher than stop-loss');

  const holding = db.prepare(
    'SELECT qty FROM holdings WHERE user_id=? AND sym=?'
  ).get(req.user.id, sym);

  if (!holding || holding.qty <= 0)
    return fail(res, 'Buy this coin before setting auto-sell');

  db.prepare(`
    INSERT INTO auto_orders(user_id,sym,target,stop)
    VALUES(?,?,?,?)
    ON CONFLICT(user_id,sym) DO UPDATE SET
      target=excluded.target,
      stop=excluded.stop
  `).run(req.user.id, sym, target, stop);

  res.json({ msg: `Auto-sell saved for ${sym}` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Casino running on port ${PORT}`));
