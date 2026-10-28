
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is missing. Add your Neon connection string in Render Environment.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5
});

pool.on('error', err => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

const app = express();
app.use(express.json({ limit: '20kb' }));

const START_BALANCE = 1000;
const CHICKEN_MAX = 12;
const P = { easy: 0.08, medium: 0.15, hard: 0.25 };
const FEE = 0.005;
const HIST = 600;

const fail = (res, msg, code = 400) =>
  res.status(code).json({ error: msg });

const route = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const rand = () => crypto.randomInt(0, 1e9) / 1e9;
const hashPw = (password, salt) =>
  crypto.scryptSync(password, salt, 64).toString('hex');

const mm = (c, k) => {
  let m = 0.97;
  for (let i = 0; i < k; i++) m *= (25 - i) / (25 - c - i);
  return m;
};

const cm = (p, n) => 0.97 / Math.pow(1 - p, n);
const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

// ---------- Database setup ----------

async function initDatabase() {
  // Compatible with the tables created in the Neon SQL Editor.
  // Existing users, balances and holdings are not dropped.

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS games (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      bet BIGINT NOT NULL,
      state JSONB NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS holdings (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
      cost_basis DOUBLE PRECISION NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, symbol)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_coins (
      symbol TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('crypto', 'memecoin')),
      price DOUBLE PRECISION NOT NULL CHECK (price > 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL REFERENCES market_coins(symbol),
      side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
      quantity DOUBLE PRECISION NOT NULL CHECK (quantity > 0),
      price DOUBLE PRECISION NOT NULL CHECK (price > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS auto_orders (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL REFERENCES market_coins(symbol),
      take_profit DOUBLE PRECISION,
      stop_loss DOUBLE PRECISION,
      PRIMARY KEY (user_id, symbol)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS game_history_user_id_idx ON game_history(user_id)
  `).catch(() => {
    // game_history is optional if the starter schema differs.
  });

  await pool.query(`
    CREATE INDEX IF NOT EXISTS trades_user_id_created_idx
    ON trades(user_id, created_at DESC)
  `);

  // Seed the market without overwriting prices already saved in Neon.
  for (const [sym, c] of Object.entries(COINS)) {
    await pool.query(`
      INSERT INTO market_coins(symbol, name, category, price)
      VALUES($1, $2, $3, $4)
      ON CONFLICT(symbol) DO NOTHING
    `, [sym, c.name, c.category, c.anchor]);
  }

  // Load the latest persisted market prices.
  const saved = await pool.query('SELECT symbol, price FROM market_coins');

  for (const row of saved.rows) {
    if (COINS[row.symbol] && Number(row.price) > 0) {
      COINS[row.symbol].price = Number(row.price);
    }
  }

  console.log('Neon PostgreSQL database ready.');
}

async function getBal(id) {
  const r = await pool.query(
    'SELECT balance FROM users WHERE id=$1',
    [id]
  );
  if (!r.rows.length) throw new Error('User not found');
  return Number(r.rows[0].balance);
}

async function addBal(id, amount) {
  await pool.query(
    'UPDATE users SET balance=balance+$1 WHERE id=$2',
    [amount, id]
  );
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function newSession(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    'INSERT INTO sessions(token,user_id) VALUES($1,$2)',
    [token, uid]
  );
  return token;
}

const auth = route(async (req, res, next) => {
  const token = req.headers.authorization || '';
  if (!token || token.length > 200) return fail(res, 'Please log in', 401);

  const result = await pool.query(`
    SELECT u.*
    FROM sessions s
    JOIN users u ON u.id=s.user_id
    WHERE s.token=$1
  `, [token]);

  if (!result.rows.length) return fail(res, 'Please log in', 401);

  req.user = result.rows[0];
  next();
});

const admin = (req, res, next) =>
  req.user.is_admin ? next() : fail(res, 'Admins only', 403);

async function validBet(req, res) {
  const bet = Number(req.body.bet);

  if (!Number.isSafeInteger(bet) || bet < 1) {
    fail(res, 'Invalid bet');
    return null;
  }

  if (bet > await getBal(req.user.id)) {
    fail(res, 'Not enough balance');
    return null;
  }

  return bet;
}

async function getGame(uid, type) {
  const result = await pool.query(
    'SELECT * FROM games WHERE user_id=$1',
    [uid]
  );
  const g = result.rows[0];

  if (!g || g.type !== type) return null;

  return {
    ...g,
    bet: Number(g.bet),
    s: typeof g.state === 'string' ? JSON.parse(g.state) : g.state
  };
}

async function saveGame(uid, type, bet, state) {
  await pool.query(`
    INSERT INTO games(user_id,type,bet,state)
    VALUES($1,$2,$3,$4::jsonb)
    ON CONFLICT(user_id) DO UPDATE SET
      type=EXCLUDED.type,
      bet=EXCLUDED.bet,
      state=EXCLUDED.state
  `, [uid, type, bet, JSON.stringify(state)]);
}

async function endGame(uid) {
  await pool.query('DELETE FROM games WHERE user_id=$1', [uid]);
}

async function hasGame(uid) {
  const r = await pool.query(
    'SELECT 1 FROM games WHERE user_id=$1',
    [uid]
  );
  return r.rows.length > 0;
}

// ---------- Pages ----------

// Keep server.js and secrets out of the public web directory.
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'index.html'))
);

app.get(['/trade', '/trade.html'], (req, res) =>
  res.sendFile(path.join(__dirname, 'trade.html'))
);

// ---------- Accounts ----------

app.post('/api/register', route(async (req, res) => {
  const { username, password } = req.body || {};

  if (!/^[a-zA-Z0-9_]{3,16}$/.test(username || ''))
    return fail(res, 'Username: 3-16 letters, numbers or _');

  if (typeof password !== 'string' || password.length < 6 || password.length > 200)
    return fail(res, 'Password must be 6-200 characters');

  const existing = await pool.query(
    'SELECT 1 FROM users WHERE LOWER(username)=LOWER($1)',
    [username]
  );

  if (existing.rows.length)
    return fail(res, 'Username already taken');

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = `${salt}:${hashPw(password, salt)}`;

  const count = await pool.query('SELECT COUNT(*) AS n FROM users');
  const isFirst = Number(count.rows[0].n) === 0;

  const result = await pool.query(`
    INSERT INTO users(username,password_hash,balance,is_admin)
    VALUES($1,$2,$3,$4)
    RETURNING id
  `, [username, passwordHash, START_BALANCE, isFirst]);

  const token = await newSession(result.rows[0].id);
  res.json({ token });
}));

app.post('/api/login', route(async (req, res) => {
  const { username, password } = req.body || {};

  const result = await pool.query(
    'SELECT * FROM users WHERE LOWER(username)=LOWER($1)',
    [typeof username === 'string' ? username : '']
  );

  const u = result.rows[0];

  if (!u || typeof password !== 'string')
    return fail(res, 'Wrong username or password', 401);

  const stored = String(u.password_hash || '');
  const separator = stored.indexOf(':');

  if (separator < 1)
    return fail(res, 'Account password format needs migration', 401);

  const salt = stored.slice(0, separator);
  const savedHash = stored.slice(separator + 1);
  const submittedHash = hashPw(password, salt);

  const a = Buffer.from(savedHash, 'hex');
  const b = Buffer.from(submittedHash, 'hex');

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return fail(res, 'Wrong username or password', 401);

  res.json({ token: await newSession(u.id) });
}));

app.get('/api/me', auth, route(async (req, res) => {
  const u = req.user;
  const result = await pool.query(
    'SELECT * FROM games WHERE user_id=$1',
    [u.id]
  );

  let game = null;

  if (result.rows.length) {
    const g = result.rows[0];
    const s = typeof g.state === 'string' ? JSON.parse(g.state) : g.state;

    game = {
      type: g.type,
      bet: Number(g.bet),
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
    balance: await getBal(u.id),
    isAdmin: !!u.is_admin,
    game
  });
}));

app.post('/api/logout', auth, route(async (req, res) => {
  await pool.query(
    'DELETE FROM sessions WHERE token=$1',
    [req.headers.authorization]
  );
  res.json({});
}));

// ---------- Admin ----------

app.get('/api/admin/users', auth, admin, route(async (req, res) => {
  const r = await pool.query(`
    SELECT id,username,balance,is_admin,created_at
    FROM users ORDER BY id
  `);

  res.json(r.rows.map(u => ({
    ...u,
    balance: Number(u.balance),
    is_admin: !!u.is_admin,
    created: u.created_at
  })));
}));

app.post('/api/admin/balance', auth, admin, route(async (req, res) => {
  const { id, amount, mode } = req.body || {};
  const n = Number(amount);

  if (!Number.isSafeInteger(n) || Math.abs(n) > 1e12)
    return fail(res, 'Invalid amount');

  const exists = await pool.query('SELECT 1 FROM users WHERE id=$1', [id]);
  if (!exists.rows.length) return fail(res, 'User not found');

  if (mode === 'set') {
    await pool.query(
      'UPDATE users SET balance=$1 WHERE id=$2',
      [Math.max(0, n), id]
    );
  } else {
    await pool.query(
      'UPDATE users SET balance=GREATEST(0,balance+$1) WHERE id=$2',
      [n, id]
    );
  }

  res.json({ balance: await getBal(id) });
}));

// ---------- Mines ----------

app.post('/api/mines/start', auth, route(async (req, res) => {
  const c = Number(req.body.mines);

  if (!Number.isInteger(c) || c < 1 || c > 24)
    return fail(res, 'Mines must be 1-24');

  if (await hasGame(req.user.id))
    return fail(res, 'Finish your current game first');

  const bet = await validBet(req, res);
  if (!bet) return;

  const cells = [...Array(25).keys()];
  for (let i = 24; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }

  await transaction(async client => {
    await client.query(
      'UPDATE users SET balance=balance-$1 WHERE id=$2',
      [bet, req.user.id]
    );
    await client.query(`
      INSERT INTO games(user_id,type,bet,state)
      VALUES($1,'mines',$2,$3::jsonb)
    `, [req.user.id, bet, JSON.stringify({
      mines: cells.slice(0, c), count: c, revealed: []
    })]);
  });

  res.json({ balance: await getBal(req.user.id), next: mm(c, 1) });
}));

app.post('/api/mines/reveal', auth, route(async (req, res) => {
  const g = await getGame(req.user.id, 'mines');
  if (!g) return fail(res, 'No active game');

  const i = Number(req.body.index);
  if (!Number.isInteger(i) || i < 0 || i > 24 || g.s.revealed.includes(i))
    return fail(res, 'Invalid tile');

  if (g.s.mines.includes(i)) {
    await endGame(req.user.id);
    return res.json({
      boom: true, mines: g.s.mines, balance: await getBal(req.user.id)
    });
  }

  g.s.revealed.push(i);
  const k = g.s.revealed.length;
  const mult = mm(g.s.count, k);

  if (k === 25 - g.s.count) {
    const payout = Math.floor(g.bet * mult);
    await transaction(async client => {
      await client.query(
        'UPDATE users SET balance=balance+$1 WHERE id=$2',
        [payout, req.user.id]
      );
      await client.query('DELETE FROM games WHERE user_id=$1', [req.user.id]);
    });

    return res.json({
      done: true, mult, payout, mines: g.s.mines,
      balance: await getBal(req.user.id)
    });
  }

  await saveGame(req.user.id, 'mines', g.bet, g.s);
  res.json({ mult, next: mm(g.s.count, k + 1) });
}));

app.post('/api/mines/cashout', auth, route(async (req, res) => {
  const g = await getGame(req.user.id, 'mines');
  if (!g || !g.s.revealed.length)
    return fail(res, 'Reveal at least one tile first');

  const mult = mm(g.s.count, g.s.revealed.length);
  const payout = Math.floor(g.bet * mult);

  await transaction(async client => {
    await client.query(
      'UPDATE users SET balance=balance+$1 WHERE id=$2',
      [payout, req.user.id]
    );
    await client.query('DELETE FROM games WHERE user_id=$1', [req.user.id]);
  });

  res.json({
    payout, mult, mines: g.s.mines, balance: await getBal(req.user.id)
  });
}));

// ---------- Chicken Road ----------

app.post('/api/chicken/start', auth, route(async (req, res) => {
  const diff = req.body.diff;
  if (!P[diff]) return fail(res, 'Invalid difficulty');
  if (await hasGame(req.user.id))
    return fail(res, 'Finish your current game first');

  const bet = await validBet(req, res);
  if (!bet) return;

  await transaction(async client => {
    await client.query(
      'UPDATE users SET balance=balance-$1 WHERE id=$2',
      [bet, req.user.id]
    );
    await client.query(`
      INSERT INTO games(user_id,type,bet,state)
      VALUES($1,'chicken',$2,$3::jsonb)
    `, [req.user.id, bet, JSON.stringify({ diff, steps: 0 })]);
  });

  res.json({ balance: await getBal(req.user.id) });
}));

app.post('/api/chicken/step', auth, route(async (req, res) => {
  const g = await getGame(req.user.id, 'chicken');
  if (!g) return fail(res, 'No active game');

  if (rand() < P[g.s.diff]) {
    await endGame(req.user.id);
    return res.json({
      dead: true, steps: g.s.steps + 1,
      balance: await getBal(req.user.id)
    });
  }

  g.s.steps++;
  const mult = cm(P[g.s.diff], g.s.steps);

  if (g.s.steps >= CHICKEN_MAX) {
    const payout = Math.floor(g.bet * mult);
    await transaction(async client => {
      await client.query(
        'UPDATE users SET balance=balance+$1 WHERE id=$2',
        [payout, req.user.id]
      );
      await client.query('DELETE FROM games WHERE user_id=$1', [req.user.id]);
    });

    return res.json({
      done: true, steps: g.s.steps, mult, payout,
      balance: await getBal(req.user.id)
    });
  }

  await saveGame(req.user.id, 'chicken', g.bet, g.s);
  res.json({ steps: g.s.steps, mult });
}));

app.post('/api/chicken/cashout', auth, route(async (req, res) => {
  const g = await getGame(req.user.id, 'chicken');
  if (!g || !g.s.steps)
    return fail(res, 'Take at least one step first');

  const mult = cm(P[g.s.diff], g.s.steps);
  const payout = Math.floor(g.bet * mult);

  await transaction(async client => {
    await client.query(
      'UPDATE users SET balance=balance+$1 WHERE id=$2',
      [payout, req.user.id]
    );
    await client.query('DELETE FROM games WHERE user_id=$1', [req.user.id]);
  });

  res.json({ payout, mult, balance: await getBal(req.user.id) });
}));

// ---------- Boxes ----------

const BOX = [[0, 45], [0.5, 20], [1.5, 22], [3, 11], [10, 2]];

const pickBox = () => {
  let r = rand() * 100;
  for (const [m, w] of BOX) {
    if ((r -= w) < 0) return m;
  }
  return 0;
};

app.post('/api/boxes/open', auth, route(async (req, res) => {
  const pick = Number(req.body.pick);

  if (![0, 1, 2].includes(pick)) return fail(res, 'Pick a box');
  if (await hasGame(req.user.id))
    return fail(res, 'Finish your current game first');

  const bet = await validBet(req, res);
  if (!bet) return;

  const boxes = [pickBox(), pickBox(), pickBox()];
  const payout = Math.floor(bet * boxes[pick]);

  await addBal(req.user.id, payout - bet);
  res.json({ boxes, payout, balance: await getBal(req.user.id) });
}));

// ---------- Roulette ----------

app.post('/api/roulette/spin', auth, route(async (req, res) => {
  const bets = Array.isArray(req.body.bets) ? req.body.bets.slice(0, 20) : [];
  if (!bets.length) return fail(res, 'Place a bet first');
  if (await hasGame(req.user.id))
    return fail(res, 'Finish your current game first');

  let total = 0;

  for (const b of bets) {
    if (!Number.isSafeInteger(b.amount) || b.amount < 1)
      return fail(res, 'Invalid bet');

    if (b.type === 'number'
      ? !(Number.isInteger(b.value) && b.value >= 0 && b.value <= 36)
      : !['red','black','even','odd','low','high'].includes(b.type)
    ) return fail(res, 'Invalid bet');

    total += b.amount;
    if (!Number.isSafeInteger(total)) return fail(res, 'Bet too large');
  }

  if (total > await getBal(req.user.id))
    return fail(res, 'Not enough balance');

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

  await addBal(req.user.id, payout - total);
  res.json({ number: n, payout, total, balance: await getBal(req.user.id) });
}));

// ---------- Virtual crypto market ----------

const COINS = {
  BTCP: {
    name: 'Paper Bitcoin', emoji: '₿', category: 'crypto',
    anchor: 50000, vol: 0.025
  },
  MOONZ: {
    name: 'MoonZ', emoji: '🚀', category: 'memecoin',
    anchor: 1.8, vol: 0.075
  },
  DOGO: {
    name: 'Dogo Coin', emoji: '🐶', category: 'memecoin',
    anchor: 0.42, vol: 0.060
  },
  WOJK: {
    name: 'Wojak Finance', emoji: '😭', category: 'memecoin',
    anchor: 0.12, vol: 0.095
  },
  PEPO: {
    name: 'Pepo the Frog', emoji: '🐸', category: 'memecoin',
    anchor: 0.0035, vol: 0.120
  }
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

function logTrade(user, sym, side, coins, qty, price) {
  TRADES.push({
    id: ++tradeId, user, sym, side, coins, qty, price, tick: tickN
  });
  if (TRADES.length > 500) TRADES.shift();
}

async function saveTrade(userId, sym, side, qty, price) {
  await pool.query(`
    INSERT INTO trades(user_id,symbol,side,quantity,price)
    VALUES($1,$2,$3,$4,$5)
  `, [userId, sym, side, qty, price]);
}

async function processAutoSells() {
  const result = await pool.query('SELECT * FROM auto_orders');

  for (const order of result.rows) {
    const sym = order.symbol;
    const c = COINS[sym];
    if (!c) continue;

    const target = order.take_profit == null ? null : Number(order.take_profit);
    const stop = order.stop_loss == null ? null : Number(order.stop_loss);

    const targetHit = target != null && c.price >= target;
    const stopHit = stop != null && c.price <= stop;
    if (!targetHit && !stopHit) continue;

    await transaction(async client => {
      const holdingResult = await client.query(`
        SELECT quantity FROM holdings
        WHERE user_id=$1 AND symbol=$2
        FOR UPDATE
      `, [order.user_id, sym]);

      const h = holdingResult.rows[0];

      if (!h || Number(h.quantity) <= 0) {
        await client.query(
          'DELETE FROM auto_orders WHERE user_id=$1 AND symbol=$2',
          [order.user_id, sym]
        );
        return;
      }

      const qty = Number(h.quantity);
      const proceeds = Math.max(0, Math.floor(qty * c.price * (1 - FEE)));

      await client.query(
        'UPDATE users SET balance=balance+$1 WHERE id=$2',
        [proceeds, order.user_id]
      );
      await client.query(
        'DELETE FROM holdings WHERE user_id=$1 AND symbol=$2',
        [order.user_id, sym]
      );
      await client.query(
        'DELETE FROM auto_orders WHERE user_id=$1 AND symbol=$2',
        [order.user_id, sym]
      );
      await client.query(`
        INSERT INTO trades(user_id,symbol,side,quantity,price)
        VALUES($1,$2,'sell',$3,$4)
      `, [order.user_id, sym, qty, c.price]);

      const userResult = await client.query(
        'SELECT username FROM users WHERE id=$1',
        [order.user_id]
      );

      if (userResult.rows[0]) {
        logTrade(userResult.rows[0].username, sym, 'sell', proceeds, qty, c.price);
      }
    });
  }
}

function tick() {
  tickN++;

  for (const c of Object.values(COINS)) {
    if (rand() < 0.035) {
      c.mu = (rand() < 0.5 ? -1 : 1) * c.vol * (0.5 + rand() * 2);
    }

    c.mu *= 0.985;

    let r = c.mu + gauss() * c.vol
      - 0.0008 * Math.log(c.price / c.anchor);

    if (rand() < 0.012) {
      r += (rand() < 0.5 ? -1 : 1) * (0.12 + rand() * 0.65);
    }

    const nextPrice = c.price * Math.exp(Math.max(-5, Math.min(5, r)));

    c.price = Number.isFinite(nextPrice)
      ? Math.max(c.anchor * 0.001, nextPrice)
      : c.anchor * 0.001;

    c.hist.push(c.price);
    if (c.hist.length > HIST) c.hist.shift();
  }

  processAutoSells().catch(err => console.error('Auto-sell error:', err));
}

async function persistMarket() {
  for (const [sym, c] of Object.entries(COINS)) {
    await pool.query(`
      UPDATE market_coins
      SET price=$1, updated_at=NOW()
      WHERE symbol=$2
    `, [c.price, sym]);
  }
}

app.get('/api/market', auth, route(async (req, res) => {
  const sel = COINS[req.query.coin] ? req.query.coin : 'DOGO';

  const holdingsResult = await pool.query(`
    SELECT symbol AS sym, quantity AS qty, cost_basis AS cost
    FROM holdings WHERE user_id=$1
  `, [req.user.id]);

  const ordersResult = await pool.query(`
    SELECT symbol AS sym, take_profit AS target, stop_loss AS stop
    FROM auto_orders WHERE user_id=$1
  `, [req.user.id]);

  const feedResult = await pool.query(`
    SELECT t.id, u.username AS "user", t.symbol AS sym,
           t.side, t.quantity AS qty, t.price, t.created_at
    FROM trades t
    JOIN users u ON u.id=t.user_id
    ORDER BY t.id DESC LIMIT 30
  `);

  const feed = feedResult.rows.map(t => ({
    ...t,
    coins: Math.floor(Number(t.quantity) * Number(t.price)),
    qty: Number(t.qty),
    price: Number(t.price)
  }));

  res.json({
    balance: await getBal(req.user.id),
    selected: sel,
    history: COINS[sel].hist,
    fee: FEE,
    tick: tickN,
    feed,
    marks: TRADES.filter(t => t.sym === sel && t.tick > tickN - HIST),
    coins: Object.entries(COINS).map(([sym, c]) => ({
      sym,
      name: c.name,
      emoji: c.emoji,
      category: c.category,
      price: c.price,
      change: c.hist.length > 1
        ? c.price / c.hist[Math.max(0, c.hist.length - 300)] - 1
        : 0
    })),
    holdings: holdingsResult.rows.map(h => ({
      ...h,
      qty: Number(h.qty),
      cost: Number(h.cost)
    })),
    autoOrders: ordersResult.rows.map(o => ({
      ...o,
      target: o.target == null ? null : Number(o.target),
      stop: o.stop == null ? null : Number(o.stop)
    }))
  });
}));

app.post('/api/trade', auth, route(async (req, res) => {
  const { sym, side } = req.body || {};
  const c = COINS[sym];
  const uid = req.user.id;

  if (!c) return fail(res, 'Unknown coin');

  const price = c.price;

  const holdingResult = await pool.query(`
    SELECT quantity AS qty, cost_basis AS cost
    FROM holdings WHERE user_id=$1 AND symbol=$2
  `, [uid, sym]);

  const h = holdingResult.rows[0];

  if (side === 'buy') {
    const amt = Number(req.body.amount);

    if (!Number.isSafeInteger(amt) || amt < 1)
      return fail(res, 'Enter a valid amount');

    await transaction(async client => {
      const userResult = await client.query(
        'SELECT balance FROM users WHERE id=$1 FOR UPDATE',
        [uid]
      );

      if (!userResult.rows.length || Number(userResult.rows[0].balance) < amt) {
        const err = new Error('Not enough balance');
        err.status = 400;
        throw err;
      }

      const qty = amt * (1 - FEE) / price;

      await client.query(
        'UPDATE users SET balance=balance-$1 WHERE id=$2',
        [amt, uid]
      );

      await client.query(`
        INSERT INTO holdings(user_id,symbol,quantity,cost_basis)
        VALUES($1,$2,$3,$4)
        ON CONFLICT(user_id,symbol) DO UPDATE SET
          quantity=holdings.quantity+EXCLUDED.quantity,
          cost_basis=holdings.cost_basis+EXCLUDED.cost_basis
      `, [uid, sym, qty, amt]);

      await client.query(`
        INSERT INTO trades(user_id,symbol,side,quantity,price)
        VALUES($1,$2,'buy',$3,$4)
      `, [uid, sym, qty, price]);

      logTrade(req.user.username, sym, 'buy', amt, qty, price);
    });

    return res.json({
      balance: await getBal(uid),
      msg: `Bought ${((amt * (1 - FEE)) / price).toPrecision(5)} ${sym}`
    });
  }

  if (side === 'sell') {
    if (!h || Number(h.qty) <= 0)
      return fail(res, 'You do not own this coin');

    const pct = Number(req.body.percent);
    if (!(pct > 0 && pct <= 100))
      return fail(res, 'Percent must be 1-100');

    const oldQty = Number(h.qty);
    const oldCost = Number(h.cost);
    const q = pct === 100 ? oldQty : oldQty * pct / 100;
    const got = Math.max(0, Math.floor(q * price * (1 - FEE)));

    await transaction(async client => {
      await client.query(
        'UPDATE users SET balance=balance+$1 WHERE id=$2',
        [got, uid]
      );

      if (pct === 100) {
        await client.query(
          'DELETE FROM holdings WHERE user_id=$1 AND symbol=$2',
          [uid, sym]
        );
        await client.query(
          'DELETE FROM auto_orders WHERE user_id=$1 AND symbol=$2',
          [uid, sym]
        );
      } else {
        await client.query(`
          UPDATE holdings SET quantity=quantity-$1,cost_basis=cost_basis-$2
          WHERE user_id=$3 AND symbol=$4
        `, [q, oldCost * q / oldQty, uid, sym]);
      }

      await client.query(`
        INSERT INTO trades(user_id,symbol,side,quantity,price)
        VALUES($1,$2,'sell',$3,$4)
      `, [uid, sym, q, price]);

      logTrade(req.user.username, sym, 'sell', got, q, price);
    });

    return res.json({
      balance: await getBal(uid),
      msg: `Sold for ${got.toLocaleString()} coins`
    });
  }

  return fail(res, 'Invalid side');
}));

// ---------- Auto-sell settings ----------

app.post('/api/auto-sell', auth, route(async (req, res) => {
  const { sym } = req.body || {};
  if (!COINS[sym]) return fail(res, 'Unknown coin');

  if (req.body.clear === true) {
    await pool.query(
      'DELETE FROM auto_orders WHERE user_id=$1 AND symbol=$2',
      [req.user.id, sym]
    );
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

  const holding = await pool.query(`
    SELECT quantity FROM holdings
    WHERE user_id=$1 AND symbol=$2
  `, [req.user.id, sym]);

  if (!holding.rows.length || Number(holding.rows[0].quantity) <= 0)
    return fail(res, 'Buy this coin before setting auto-sell');

  await pool.query(`
    INSERT INTO auto_orders(user_id,symbol,take_profit,stop_loss)
    VALUES($1,$2,$3,$4)
    ON CONFLICT(user_id,symbol) DO UPDATE SET
      take_profit=EXCLUDED.take_profit,
      stop_loss=EXCLUDED.stop_loss
  `, [req.user.id, sym, target, stop]);

  res.json({ msg: `Auto-sell saved for ${sym}` });
}));

// ---------- Errors and startup ----------

app.use((err, req, res, next) => {
  console.error(err);

  if (res.headersSent) return next(err);

  if (err.status) return fail(res, err.message, err.status);

  res.status(500).json({ error: 'Server error. Check Render logs.' });
});

async function start() {
  await initDatabase();

  // Fill the initial chart history.
  for (let i = 0; i < HIST; i++) tick();

  // The simulated market continues running while the server is online.
  setInterval(tick, 1000);

  // Save the latest prices so they can be restored after a redeploy.
  setInterval(() => {
    persistMarket().catch(err => console.error('Market save error:', err));
  }, 5000);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Casino running on port ${PORT}`));
}

start().catch(err => {
  console.error('Could not start casino:', err);
  process.exit(1);
});
