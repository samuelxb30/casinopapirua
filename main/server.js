const express = require('express'), Database = require('better-sqlite3'), crypto = require('crypto'), path = require('path');
const db = new Database(path.join(__dirname, 'casino.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, salt TEXT, hash TEXT,
  balance INTEGER NOT NULL DEFAULT 1000, is_admin INTEGER NOT NULL DEFAULT 0, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER);
CREATE TABLE IF NOT EXISTS games(user_id INTEGER PRIMARY KEY, type TEXT, bet INTEGER, state TEXT);`);

const START_BALANCE = 1000, CHICKEN_MAX = 12;
const P = { easy: 0.08, medium: 0.15, hard: 0.25 };            // chance to get hit per lane
const mm = (c, k) => { let m = 0.97; for (let i = 0; i < k; i++) m *= (25 - i) / (25 - c - i); return m; };
const cm = (p, n) => 0.97 / Math.pow(1 - p, n);
const rand = () => crypto.randomInt(0, 1e9) / 1e9;
const hashPw = (p, s) => crypto.scryptSync(p, s, 64).toString('hex');
const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });
const getBal = id => db.prepare('SELECT balance FROM users WHERE id=?').get(id).balance;
const addBal = (id, d) => db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(d, id);
const newSession = uid => { const t = crypto.randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions VALUES(?,?)').run(t, uid); return t; };

function auth(req, res, next) {
  const u = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(req.headers.authorization || '');
  if (!u) return fail(res, 'Please log in', 401);
  req.user = u; next();
}
const admin = (req, res, next) => req.user.is_admin ? next() : fail(res, 'Admins only', 403);
const validBet = (req, res) => {
  const bet = Number(req.body.bet);
  if (!Number.isInteger(bet) || bet < 1) { fail(res, 'Invalid bet'); return null; }
  if (bet > getBal(req.user.id)) { fail(res, 'Not enough balance'); return null; }
  return bet;
};
const getGame = (uid, type) => { const g = db.prepare('SELECT * FROM games WHERE user_id=?').get(uid); return g && g.type === type ? { ...g, s: JSON.parse(g.state) } : null; };
const saveGame = (uid, type, bet, s) => db.prepare('INSERT OR REPLACE INTO games VALUES(?,?,?,?)').run(uid, type, bet, JSON.stringify(s));
const endGame = uid => db.prepare('DELETE FROM games WHERE user_id=?').run(uid);
const hasGame = uid => !!db.prepare('SELECT 1 FROM games WHERE user_id=?').get(uid);

// ---------- Accounts ----------
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!/^[a-zA-Z0-9_]{3,16}$/.test(username || '')) return fail(res, 'Username: 3-16 letters, numbers or _');
  if (!password || password.length < 6) return fail(res, 'Password must be at least 6 characters');
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return fail(res, 'Username already taken');
  const salt = crypto.randomBytes(16).toString('hex');
  const first = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;   // first account = admin
  const r = db.prepare('INSERT INTO users(username,salt,hash,balance,is_admin) VALUES(?,?,?,?,?)').run(username, salt, hashPw(password, salt), START_BALANCE, first ? 1 : 0);
  res.json({ token: newSession(r.lastInsertRowid) });
});
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username || '');
  if (!u || !crypto.timingSafeEqual(Buffer.from(hashPw(password || '', u.salt)), Buffer.from(u.hash))) return fail(res, 'Wrong username or password', 401);
  res.json({ token: newSession(u.id) });
});
app.get('/api/me', auth, (req, res) => {
  const u = req.user, g = db.prepare('SELECT * FROM games WHERE user_id=?').get(u.id);
  let game = null;
  if (g) {
    const s = JSON.parse(g.state);
    game = { type: g.type, bet: g.bet, revealed: s.revealed, count: s.count, steps: s.steps, diff: s.diff,
             mult: g.type === 'mines' ? mm(s.count, s.revealed.length) : cm(P[s.diff], s.steps) };
  }
  res.json({ username: u.username, balance: u.balance, isAdmin: !!u.is_admin, game });
});
app.post('/api/logout', auth, (req, res) => { db.prepare('DELETE FROM sessions WHERE token=?').run(req.headers.authorization); res.json({}); });

// ---------- Admin ----------
app.get('/api/admin/users', auth, admin, (req, res) =>
  res.json(db.prepare('SELECT id,username,balance,is_admin,created FROM users ORDER BY id').all()));
app.post('/api/admin/balance', auth, admin, (req, res) => {
  const { id, amount, mode } = req.body, n = Number(amount);
  if (!Number.isInteger(n) || Math.abs(n) > 1e12) return fail(res, 'Invalid amount');
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) return fail(res, 'User not found');
  if (mode === 'set') db.prepare('UPDATE users SET balance=? WHERE id=?').run(Math.max(0, n), id);
  else db.prepare('UPDATE users SET balance=MAX(0,balance+?) WHERE id=?').run(n, id);
  res.json({ balance: getBal(id) });
});

// ---------- Mines ----------
app.post('/api/mines/start', auth, (req, res) => {
  const c = Number(req.body.mines);
  if (!Number.isInteger(c) || c < 1 || c > 24) return fail(res, 'Mines must be 1-24');
  if (hasGame(req.user.id)) return fail(res, 'Finish your current game first');
  const bet = validBet(req, res); if (!bet) return;
  const cells = [...Array(25).keys()];
  for (let i = 24; i > 0; i--) { const j = crypto.randomInt(i + 1); [cells[i], cells[j]] = [cells[j], cells[i]]; }
  addBal(req.user.id, -bet);
  saveGame(req.user.id, 'mines', bet, { mines: cells.slice(0, c), count: c, revealed: [] });
  res.json({ balance: getBal(req.user.id), next: mm(c, 1) });
});
app.post('/api/mines/reveal', auth, (req, res) => {
  const g = getGame(req.user.id, 'mines'); if (!g) return fail(res, 'No active game');
  const i = Number(req.body.index);
  if (!Number.isInteger(i) || i < 0 || i > 24 || g.s.revealed.includes(i)) return fail(res, 'Invalid tile');
  if (g.s.mines.includes(i)) { endGame(req.user.id); return res.json({ boom: true, mines: g.s.mines, balance: getBal(req.user.id) }); }
  g.s.revealed.push(i);
  const k = g.s.revealed.length, mult = mm(g.s.count, k);
  if (k === 25 - g.s.count) {
    const payout = Math.floor(g.bet * mult); addBal(req.user.id, payout); endGame(req.user.id);
    return res.json({ done: true, mult, payout, mines: g.s.mines, balance: getBal(req.user.id) });
  }
  saveGame(req.user.id, 'mines', g.bet, g.s);
  res.json({ mult, next: mm(g.s.count, k + 1) });
});
app.post('/api/mines/cashout', auth, (req, res) => {
  const g = getGame(req.user.id, 'mines'); if (!g || !g.s.revealed.length) return fail(res, 'Reveal at least one tile first');
  const mult = mm(g.s.count, g.s.revealed.length), payout = Math.floor(g.bet * mult);
  addBal(req.user.id, payout); endGame(req.user.id);
  res.json({ payout, mult, mines: g.s.mines, balance: getBal(req.user.id) });
});

// ---------- Chicken Road ----------
app.post('/api/chicken/start', auth, (req, res) => {
  const diff = req.body.diff;
  if (!P[diff]) return fail(res, 'Invalid difficulty');
  if (hasGame(req.user.id)) return fail(res, 'Finish your current game first');
  const bet = validBet(req, res); if (!bet) return;
  addBal(req.user.id, -bet); saveGame(req.user.id, 'chicken', bet, { diff, steps: 0 });
  res.json({ balance: getBal(req.user.id) });
});
app.post('/api/chicken/step', auth, (req, res) => {
  const g = getGame(req.user.id, 'chicken'); if (!g) return fail(res, 'No active game');
  if (rand() < P[g.s.diff]) { endGame(req.user.id); return res.json({ dead: true, steps: g.s.steps + 1, balance: getBal(req.user.id) }); }
  g.s.steps++;
  const mult = cm(P[g.s.diff], g.s.steps);
  if (g.s.steps >= CHICKEN_MAX) {
    const payout = Math.floor(g.bet * mult); addBal(req.user.id, payout); endGame(req.user.id);
    return res.json({ done: true, steps: g.s.steps, mult, payout, balance: getBal(req.user.id) });
  }
  saveGame(req.user.id, 'chicken', g.bet, g.s);
  res.json({ steps: g.s.steps, mult });
});
app.post('/api/chicken/cashout', auth, (req, res) => {
  const g = getGame(req.user.id, 'chicken'); if (!g || !g.s.steps) return fail(res, 'Take at least one step first');
  const mult = cm(P[g.s.diff], g.s.steps), payout = Math.floor(g.bet * mult);
  addBal(req.user.id, payout); endGame(req.user.id);
  res.json({ payout, mult, balance: getBal(req.user.id) });
});

// ---------- Boxes ----------
const BOX = [[0, 45], [0.5, 20], [1.5, 22], [3, 11], [10, 2]];     // [multiplier, weight] ~96% RTP
const pickBox = () => { let r = rand() * 100; for (const [m, w] of BOX) { if ((r -= w) < 0) return m; } return 0; };
app.post('/api/boxes/open', auth, (req, res) => {
  const pick = Number(req.body.pick);
  if (![0, 1, 2].includes(pick)) return fail(res, 'Pick a box');
  if (hasGame(req.user.id)) return fail(res, 'Finish your current game first');
  const bet = validBet(req, res); if (!bet) return;
  const boxes = [pickBox(), pickBox(), pickBox()], payout = Math.floor(bet * boxes[pick]);
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
    if (!Number.isInteger(b.amount) || b.amount < 1) return fail(res, 'Invalid bet');
    if (b.type === 'number' ? !(Number.isInteger(b.value) && b.value >= 0 && b.value <= 36) : !['red','black','even','odd','low','high'].includes(b.type)) return fail(res, 'Invalid bet');
    total += b.amount;
  }
  if (total > getBal(req.user.id)) return fail(res, 'Not enough balance');
  const n = crypto.randomInt(37); let payout = 0;
  for (const b of bets) {
    const win = { number: n === b.value, red: RED.has(n), black: n > 0 && !RED.has(n), even: n > 0 && n % 2 === 0,
                  odd: n % 2 === 1, low: n >= 1 && n <= 18, high: n >= 19 }[b.type];
    if (win) payout += b.amount * (b.type === 'number' ? 36 : 2);
  }
  addBal(req.user.id, payout - total);
  res.json({ number: n, payout, total, balance: getBal(req.user.id) });
});

// ---------- Crypto / memecoin market ----------
db.exec(`CREATE TABLE IF NOT EXISTS holdings(user_id INTEGER, sym TEXT, qty REAL, cost REAL, PRIMARY KEY(user_id,sym))`);
const FEE = 0.005, HIST = 600;                                   // 0.5% trading fee, 10 min of 1s ticks
const COINS = {
  BTCP:  { name: 'Paper Bitcoin',  emoji: '₿',  anchor: 50000,  vol: 0.0018 },
  MOONZ: { name: 'MoonZ',          emoji: '🚀', anchor: 1.8,    vol: 0.008 },
  DOGO:  { name: 'Dogo Coin',      emoji: '🐶', anchor: 0.42,   vol: 0.005 },
  WOJK:  { name: 'Wojak Finance',  emoji: '😭', anchor: 0.12,   vol: 0.012 },
  PEPO:  { name: 'Pepo the Frog',  emoji: '🐸', anchor: 0.0035, vol: 0.016 },
};
const gauss = () => { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
for (const c of Object.values(COINS)) { c.price = c.anchor; c.mu = 0; c.hist = []; }
let tickN = 0, tradeId = 0; const TRADES = [];
const logTrade = (user, sym, side, coins, qty, price) => { TRADES.push({ id: ++tradeId, user, sym, side, coins, qty, price, tick: tickN }); if (TRADES.length > 500) TRADES.shift(); };
function tick() {
  tickN++;
  for (const c of Object.values(COINS)) {
    if (rand() < 0.02) c.mu = (rand() - 0.5) * c.vol * 1.2;      // new trend regime (pump / dump phases)
    let r = c.mu + gauss() * c.vol - 0.0004 * Math.log(c.price / c.anchor);
    if (rand() < 0.003) r += (rand() < 0.5 ? -1 : 1) * (0.04 + rand() * 0.08) * (c.vol > 0.004 ? 1 : 0.3);  // sudden pump/dump
    c.price = Math.max(c.anchor * 0.02, c.price * Math.exp(r));
    c.hist.push(c.price); if (c.hist.length > HIST) c.hist.shift();
  }
}
for (let i = 0; i < HIST; i++) tick();
setInterval(tick, 1000);

app.get('/api/market', auth, (req, res) => {
  const sel = COINS[req.query.coin] ? req.query.coin : 'DOGO';
  res.json({
    balance: getBal(req.user.id), selected: sel, history: COINS[sel].hist, fee: FEE, tick: tickN,
    feed: TRADES.slice(-30).reverse(),                                   // latest trades from all users
    marks: TRADES.filter(t => t.sym === sel && t.tick > tickN - HIST),   // trades to pin on the chart
    coins: Object.entries(COINS).map(([sym, c]) => ({ sym, name: c.name, emoji: c.emoji, price: c.price, change: c.price / c.hist[Math.max(0, c.hist.length - 300)] - 1 })),
    holdings: db.prepare('SELECT sym,qty,cost FROM holdings WHERE user_id=?').all(req.user.id),
  });
});
app.post('/api/trade', auth, (req, res) => {
  const { sym, side } = req.body, c = COINS[sym], uid = req.user.id;
  if (!c) return fail(res, 'Unknown coin');
  const price = c.price, h = db.prepare('SELECT * FROM holdings WHERE user_id=? AND sym=?').get(uid, sym);
  if (side === 'buy') {
    const amt = Number(req.body.amount);
    if (!Number.isInteger(amt) || amt < 1) return fail(res, 'Enter a valid amount');
    if (amt > getBal(uid)) return fail(res, 'Not enough balance');
    const qty = amt * (1 - FEE) / price;
    addBal(uid, -amt);
    db.prepare('INSERT INTO holdings VALUES(?,?,?,?) ON CONFLICT(user_id,sym) DO UPDATE SET qty=qty+excluded.qty, cost=cost+excluded.cost').run(uid, sym, qty, amt);
    logTrade(req.user.username, sym, 'buy', amt, qty, price);
    return res.json({ balance: getBal(uid), msg: `Bought ${qty.toPrecision(5)} ${sym}` });
  }
  if (side === 'sell') {
    if (!h || h.qty <= 0) return fail(res, 'You do not own this coin');
    const pct = Number(req.body.percent);
    if (!(pct > 0 && pct <= 100)) return fail(res, 'Percent must be 1-100');
    const q = pct === 100 ? h.qty : h.qty * pct / 100, got = Math.floor(q * price * (1 - FEE));
    addBal(uid, got);
    if (pct === 100) db.prepare('DELETE FROM holdings WHERE user_id=? AND sym=?').run(uid, sym);
    else db.prepare('UPDATE holdings SET qty=qty-?, cost=cost-? WHERE user_id=? AND sym=?').run(q, h.cost * q / h.qty, uid, sym);
    logTrade(req.user.username, sym, 'sell', got, q, price);
    return res.json({ balance: getBal(uid), msg: `Sold for ${got.toLocaleString()} coins` });
  }
  fail(res, 'Invalid side');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Casino running on http://localhost:${PORT}`));
