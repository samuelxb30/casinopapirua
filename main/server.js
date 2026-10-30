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
// Any name of 1-16 characters (no leading/trailing spaces, no control characters).
const NAME_RE = /^[^\u0000-\u001f\u007f]{1,16}$/;
const validName = n => typeof n === 'string' && n === n.trim() && NAME_RE.test(n);
const NAME_ERR = 'Username must be 1-16 characters';
const validPassword = p => typeof p === 'string' && p.length >= 1 && p.length <= 200;
const PASS_ERR = 'Password must be 1-200 characters';
const DEFAULT_ANNOUNCEMENT = 'Welcome to Royal Paper Casino — virtual points only.';
const ANNOUNCEMENT_MAX = 240;
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

// ---------- Virtual crypto market configuration ----------
// 2 Distinct classes:
// 1. 'crypto': Steady, small organic moves, rare severe flash drops / crashes.
// 2. 'memecoin': Wild roller-coaster. Huge +1200% rocket pumps (+60k on 5k) followed by instantaneous rugpulls/dumps.

const COINS = {
  BTCP: {
    name: 'Paper Bitcoin', emoji: '₿', category: 'crypto',
    anchor: 65000, vol: 0.002
  },
  ETHP: {
    name: 'Paper Ethereum', emoji: 'Ξ', category: 'crypto',
    anchor: 3400, vol: 0.003
  },
  SOLP: {
    name: 'Paper Solana', emoji: '◎', category: 'crypto',
    anchor: 160, vol: 0.0045
  },
  MOONZ: {
    name: 'MoonZ', emoji: '🚀', category: 'memecoin',
    anchor: 1.5, vol: 0.22
  },
  DOGO: {
    name: 'Dogo Coin', emoji: '🐶', category: 'memecoin',
    anchor: 0.40, vol: 0.25
  },
  WOJK: {
    name: 'Wojak Finance', emoji: '😭', category: 'memecoin',
    anchor: 0.10, vol: 0.32
  },
  PEPO: {
    name: 'Pepo the Frog', emoji: '🐸', category: 'memecoin',
    anchor: 0.004, vol: 0.40
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

// ---------- Exodus-style game wallet ----------
const WCOINS = {
  BTC:  { name: 'Bitcoin',  glyph: '₿', color: '#f7931a', anchor: 103794.44, vol: 0.0009 },
  ETH:  { name: 'Ethereum', glyph: 'Ξ', color: '#8c9eff', anchor: 2730.28,   vol: 0.0011 },
  SOL:  { name: 'Solana',   glyph: '◎', color: '#14f195', anchor: 172.34,    vol: 0.0014 },
  BNB:  { name: 'BNB',      glyph: 'B', color: '#f3ba2f', anchor: 690,       vol: 0.0010 },
  XRP:  { name: 'XRP',      glyph: '✕', color: '#9aa4b5', anchor: 2.45,      vol: 0.0016 },
  DOGE: { name: 'Dogecoin', glyph: 'Ð', color: '#c2a633', anchor: 0.21,      vol: 0.0020 },
  ADA:  { name: 'Cardano',  glyph: '₳', color: '#3b82f6', anchor: 0.75,      vol: 0.0016 },
  LTC:  { name: 'Litecoin', glyph: 'Ł', color: '#a6a9aa', anchor: 98,        vol: 0.0012 }
};

for (const c of Object.values(WCOINS)) {
  c.price = c.anchor;
  c.mu = 0;
  c.hist = [];
}

function walletTick() {
  for (const c of Object.values(WCOINS)) {
    if (rand() < 0.02) c.mu = (rand() < 0.5 ? -1 : 1) * c.vol * (0.5 + rand() * 1.5);
    c.mu *= 0.97;

    const r = c.mu + gauss() * c.vol - 0.0006 * Math.log(c.price / c.anchor);
    const next = c.price * Math.exp(Math.max(-0.05, Math.min(0.05, r)));

    c.price = Number.isFinite(next)
      ? Math.max(c.anchor * 0.2, Math.min(c.anchor * 5, next))
      : c.anchor;

    c.hist.push(c.price);
    if (c.hist.length > HIST) c.hist.shift();
  }
}

async function persistWalletPrices() {
  try {
    for (const [sym, c] of Object.entries(WCOINS)) {
      await pool.query(`
        INSERT INTO wallet_prices(symbol, price) VALUES($1, $2)
        ON CONFLICT(symbol) DO UPDATE SET price=EXCLUDED.price
      `, [sym, c.price]);
    }
  } catch (err) {
    console.error('Wallet price save error:', err);
  }
}

const WSEED_WORDS = [...new Set((`
amber anchor angel apple arrow aspen atlas aurora autumn badge bamboo banjo barrel basil beacon beaver berry bishop
blanket blossom bridge bronze brook bubble buffalo butter cabin cactus camel candle canyon captain carbon cargo carpet
castle cedar cellar cherry chimney cinder circus citrus clover cobalt comet compass copper coral cotton cougar crater
crystal curtain cypress dagger daisy dancer delta desert diamond dolphin dragon drum eagle ember emerald engine falcon
feather ferry fiddle finch flame flint forest fossil fountain fox galaxy garden garnet geyser ginger glacier globe
goblet granite gravel guitar harbor harvest hazel helmet heron hickory hill honey horizon hunter iceberg island ivory
jacket jasmine jungle kettle kingdom kitten lagoon lantern laurel lemon lighthouse lilac lizard lotus lumber magnet
mango maple marble meadow melody mirror monsoon moss mountain mustang nectar needle nickel nomad oasis ocean olive
onyx orange orchid otter oyster paddle palace panther paper parrot pebble pepper phoenix piano pilot pine planet
plume pocket pond poppy prairie pumpkin quartz quiver rabbit radar rainbow raven reef river robin rocket saddle
saffron sailor salmon sapphire scarlet shadow silver skylark slate snow sparrow spice spider spruce stable sunset
swan tangerine temple thunder tiger timber topaz tower trumpet tulip tundra turtle valley velvet violet volcano
walnut waterfall whale willow window winter wolf yarrow zebra zephyr
`).trim().split(/\s+/))];

const WSEED_SET = new Set(WSEED_WORDS);

function genSeed() {
  const bag = [...WSEED_WORDS];
  const out = [];
  for (let i = 0; i < 12; i++) out.push(bag.splice(crypto.randomInt(bag.length), 1)[0]);
  return out;
}

const normSeed = v =>
  typeof v === 'string' ? v.toLowerCase().split(/[\s,]+/).filter(Boolean) : [];

const seedHash = words =>
  crypto.createHash('sha256').update('wallet-seed:' + words.join(' ')).digest('hex');

// ---------- Luxury shop catalog ----------
const SHOP_SELL_RATE = 0.8;

const SHOP_CATEGORIES = [
  { id: 'watches',    name: 'Watches',            emoji: '⌚' },
  { id: 'cars',       name: 'Cars',               emoji: '🏎️' },
  { id: 'realestate', name: 'Real Estate',        emoji: '🏡' },
  { id: 'yachts',     name: 'Yachts & Jets',      emoji: '🛥️' },
  { id: 'jewelry',    name: 'Jewelry',            emoji: '💍' },
  { id: 'art',        name: 'Art & Collectibles', emoji: '🖼️' }
];

const SHOP_ITEMS = [
  { id: 'w01', category: 'watches', emoji: '⌚', tier: 'common',    price: 2500,      name: "Casio F-91W",                          desc: "The iconic digital classic. Alarm, stopwatch, and nearly indestructible." },
  { id: 'w02', category: 'watches', emoji: '⏱️', tier: 'common',    price: 12000,     name: "Seiko Prospex Diver",                  desc: "Serious dive watch with a rotating bezel and a reputation for toughness." },
  { id: 'w03', category: 'watches', emoji: '🌙', tier: 'uncommon',  price: 45000,     name: "Omega Speedmaster Professional",       desc: "The Moonwatch. Worn on NASA missions, loved by collectors." },
  { id: 'w04', category: 'watches', emoji: '🕰️', tier: 'rare',      price: 150000,    name: "Rolex Submariner Date",                desc: "The most recognizable dive watch on earth. Steel, ceramic bezel, instant status." },
  { id: 'w05', category: 'watches', emoji: '⚙️', tier: 'epic',      price: 600000,    name: "Audemars Piguet Royal Oak",            desc: "Octagonal bezel, integrated bracelet, and a design that changed watchmaking." },
  { id: 'w06', category: 'watches', emoji: '🌊', tier: 'epic',      price: 2400000,   name: "Patek Philippe Nautilus 5711",         desc: "Famously hard to get. Collectors queue for years." },
  { id: 'w07', category: 'watches', emoji: '💎', tier: 'legendary', price: 9500000,   name: "Richard Mille RM 056 Sapphire",        desc: "Case carved from a block of sapphire crystal. Wearable art that costs a fortune." },
  { id: 'w08', category: 'watches', emoji: '👑', tier: 'legendary', price: 40000000,  name: "Patek Philippe Henry Graves Supercomplication", desc: "The legendary 1932 pocket watch with 24 complications. Auction record holder in its day." },
  { id: 'c01', category: 'cars', emoji: '🚗', tier: 'common',    price: 18000,      name: "Honda Civic",                      desc: "Reliable, efficient and surprisingly fun to drive." },
  { id: 'c02', category: 'cars', emoji: '🐎', tier: 'common',    price: 45000,      name: "Ford Mustang GT",                  desc: "5.0L V8 muscle with an unmistakable rumble." },
  { id: 'c03', category: 'cars', emoji: '🚘', tier: 'uncommon',  price: 120000,     name: "Porsche 911 Carrera",              desc: "The everyday sports car. Rear engine, timeless shape." },
  { id: 'c04', category: 'cars', emoji: '⚡', tier: 'rare',      price: 250000,     name: "Tesla Model S Plaid",              desc: "Over 1,000 horsepower and a sub-2-second 0 to 60 mph launch." },
  { id: 'c05', category: 'cars', emoji: '🛻', tier: 'rare',      price: 400000,     name: "Mercedes-AMG G 63",                desc: "A boxy off-roader with a hand-built twin-turbo V8 and a very loud personality." },
  { id: 'c06', category: 'cars', emoji: '🐂', tier: 'epic',      price: 750000,     name: "Lamborghini Huracán",              desc: "V10 power, scissor-sharp lines, and pure Italian theatre." },
  { id: 'c07', category: 'cars', emoji: '🏁', tier: 'epic',      price: 1400000,    name: "McLaren 720S",                     desc: "Carbon-fiber tub, 710 horsepower, and a Formula 1 attitude." },
  { id: 'c08', category: 'cars', emoji: '🏎️', tier: 'epic',      price: 2800000,    name: "Ferrari 812 Superfast",            desc: "Front-engine V12 grand tourer, one of the last great naturally aspirated Ferraris." },
  { id: 'c09', category: 'cars', emoji: '🌪️', tier: 'legendary', price: 5000000,    name: "Pagani Huayra",                    desc: "Hand-built Italian hypercar where every bolt is a work of art." },
  { id: 'c10', category: 'cars', emoji: '🚀', tier: 'legendary', price: 12000000,   name: "Bugatti Chiron",                   desc: "8.0L quad-turbo W16 with 1,500 horsepower and a top speed over 260 mph." },
  { id: 'c11', category: 'cars', emoji: '🏆', tier: 'legendary', price: 30000000,   name: "1962 Ferrari 250 GTO",             desc: "Perhaps the most valuable classic car ever. Only 36 were built." },
  { id: 'c12', category: 'cars', emoji: '🛡️', tier: 'legendary', price: 60000000,   name: "Rolls-Royce Boat Tail",            desc: "A coachbuilt, one-of-three masterpiece with a hidden picnic set in the rear." },
  { id: 'r01', category: 'realestate', emoji: '🏢', tier: 'common',    price: 40000,        name: "Studio Apartment in Brooklyn, New York",    desc: "One room, exposed brick, and a subway stop on the corner." },
  { id: 'r02', category: 'realestate', emoji: '🏘️', tier: 'uncommon',  price: 180000,       name: "Townhouse in Austin, Texas",                desc: "Two floors, a garage and live music every night downtown." },
  { id: 'r03', category: 'realestate', emoji: '🛖', tier: 'uncommon',  price: 350000,       name: "Lakeside Cabin at Lake Tahoe",              desc: "Pine walls, wood stove and a private dock on the water." },
  { id: 'r04', category: 'realestate', emoji: '🏡', tier: 'rare',      price: 450000,       name: "Family Home in Portland, Oregon",           desc: "Four bedrooms, a big yard and a front porch for rainy evenings." },
  { id: 'r05', category: 'realestate', emoji: '🗼', tier: 'rare',      price: 600000,       name: "Apartment in Shibuya, Tokyo",               desc: "Compact, smart and a short walk from the famous crossing." },
  { id: 'r06', category: 'realestate', emoji: '🌆', tier: 'epic',      price: 2000000,      name: "Penthouse in Manhattan, New York",          desc: "Top floor, wraparound terrace and Central Park below you." },
  { id: 'r07', category: 'realestate', emoji: '🏖️', tier: 'epic',      price: 5500000,      name: "Beach Villa in Malibu, California",         desc: "Pacific views, a private deck and sunsets that never get old." },
  { id: 'r08', category: 'realestate', emoji: '🏔️', tier: 'epic',      price: 8000000,      name: "Ski Chalet in Aspen, Colorado",             desc: "Ski-in, ski-out, with a hot tub looking at the slopes." },
  { id: 'r09', category: 'realestate', emoji: '🌅', tier: 'epic',      price: 18000000,     name: "Lakefront Villa on Lake Como, Italy",       desc: "Terraced gardens, a boathouse and mountains reflected in the water." },
  { id: 'r10', category: 'realestate', emoji: '🌴', tier: 'legendary', price: 35000000,     name: "Mansion in Beverly Hills, California",      desc: "Gated estate with a pool, a cinema room and a very long driveway." },
  { id: 'r11', category: 'realestate', emoji: '🏬', tier: 'legendary', price: 60000000,     name: "Entire Skyscraper in Dubai",                desc: "Dozens of floors of rentable glass and a skyline all your own." },
  { id: 'r12', category: 'realestate', emoji: '🏝️', tier: 'legendary', price: 150000000,    name: "Private Island in the Maldives",            desc: "White sand, a coral lagoon and nobody else for miles." },
  { id: 'r13', category: 'realestate', emoji: '🏰', tier: 'legendary', price: 300000000,    name: "Highland Castle in Scotland",               desc: "Towers, a loch view, and a heating bill you do not want to see." },
  { id: 'r14', category: 'realestate', emoji: '🛰️', tier: 'legendary', price: 1000000000,   name: "Luxury Suite on the International Space Station", desc: "The ultimate view: sixteen sunrises every day." },
  { id: 'y01', category: 'yachts', emoji: '🛶', tier: 'common',    price: 15000,       name: "Sea-Doo GTX Jet Ski",             desc: "Fast, wet and a little bit reckless." },
  { id: 'y02', category: 'yachts', emoji: '⛵', tier: 'uncommon',  price: 80000,       name: "Beneteau Oceanis Sailboat",        desc: "Wind-powered and surprisingly cozy below deck." },
  { id: 'y03', category: 'yachts', emoji: '🚤', tier: 'rare',      price: 400000,      name: "Riva Aquariva Speedboat",          desc: "Mahogany-style elegance from the Italian lake boat legend." },
  { id: 'y04', category: 'yachts', emoji: '🚁', tier: 'epic',      price: 3000000,     name: "Airbus H145 Helicopter",           desc: "Skip traffic completely. Land on your own roof." },
  { id: 'y05', category: 'yachts', emoji: '🛥️', tier: 'epic',      price: 6000000,     name: "Sunseeker 76 Yacht",               desc: "Four cabins, a flybridge and a sun deck made for the Mediterranean." },
  { id: 'y06', category: 'yachts', emoji: '🛩️', tier: 'epic',      price: 12000000,    name: "Cessna Citation Latitude",         desc: "A comfortable midsize business jet for hopping between cities." },
  { id: 'y07', category: 'yachts', emoji: '✈️', tier: 'legendary', price: 35000000,    name: "Gulfstream G650 Private Jet",      desc: "Crosses oceans nonstop at close to the speed of sound." },
  { id: 'y08', category: 'yachts', emoji: '🚢', tier: 'legendary', price: 120000000,   name: "Lürssen 120m Superyacht",          desc: "German-built giant with a helipad, a pool and a crew of dozens." },
  { id: 'y09', category: 'yachts', emoji: '🛫', tier: 'legendary', price: 400000000,   name: "Airbus A380 Private Airliner",     desc: "The largest passenger aircraft in the world, refitted as a flying palace." },
  { id: 'j01', category: 'jewelry', emoji: '💍', tier: 'common',    price: 800,        name: "Tiffany & Co. Sterling Silver Ring",     desc: "Simple, clean and in the famous blue box." },
  { id: 'j02', category: 'jewelry', emoji: '📿', tier: 'uncommon',  price: 20000,      name: "Mikimoto Pearl Necklace",                desc: "Cultured pearls from the family that invented them." },
  { id: 'j03', category: 'jewelry', emoji: '⛓️', tier: 'rare',      price: 75000,      name: "Cartier Love Bracelet in 18K Gold",      desc: "Locks on with its own screwdriver. A Cartier icon since 1969." },
  { id: 'j04', category: 'jewelry', emoji: '💚', tier: 'epic',      price: 400000,     name: "Van Cleef & Arpels Emerald Earrings",    desc: "Deep green emeralds in the style of the Place Vendôme masters." },
  { id: 'j05', category: 'jewelry', emoji: '🌸', tier: 'epic',      price: 15000000,   name: "Graff Pink Diamond Ring",                desc: "A rare fancy-vivid pink stone from the diamond house of London." },
  { id: 'j06', category: 'jewelry', emoji: '👸', tier: 'legendary', price: 5000000,    name: "Harry Winston Diamond Necklace",         desc: "The King of Diamonds jeweler. Hundreds of carats of fire." },
  { id: 'j07', category: 'jewelry', emoji: '🔷', tier: 'legendary', price: 50000000,   name: "The Hope Diamond",                       desc: "45.52 carats of deep blue with a legend as famous as the stone." },
  { id: 'a01', category: 'art', emoji: '🎬', tier: 'common',    price: 3000,       name: "Original Star Wars (1977) Movie Poster",   desc: "An original one-sheet from opening year, folded as it came from the cinema." },
  { id: 'a02', category: 'art', emoji: '🗿', tier: 'uncommon',  price: 90000,      name: "Rodin's The Thinker Bronze Cast",       desc: "A cast of the most famous sculpture of a man deep in thought." },
  { id: 'a03', category: 'art', emoji: '⚡', tier: 'rare',      price: 250000,     name: "Pokémon 1st Edition Charizard Card",       desc: "A graded base-set holo that grown adults still dream about." },
  { id: 'a04', category: 'art', emoji: '📚', tier: 'rare',      price: 400000,     name: "Action Comics #1 (1938)",                  desc: "The first appearance of Superman. The holy grail of comics." },
  { id: 'a05', category: 'art', emoji: '🍷', tier: 'epic',      price: 1200000,    name: "Romanée-Conti Wine Cellar",                desc: "Bottles from the most prestigious vineyard in Burgundy." },
  { id: 'a06', category: 'art', emoji: '⚾', tier: 'epic',      price: 5000000,    name: "1952 Topps Mickey Mantle Baseball Card",   desc: "The most famous baseball card ever printed." },
  { id: 'a07', category: 'art', emoji: '🎨', tier: 'legendary', price: 25000000,   name: "Claude Monet Water Lilies",            desc: "Impressionist calm in oil, from the master of the garden at Giverny." },
  { id: 'a08', category: 'art', emoji: '🦖', tier: 'legendary', price: 90000000,   name: "T. rex Skeleton Stan",                 desc: "One of the most complete T. rex fossils ever found. Sold at auction in 2020." },
  { id: 'a09', category: 'art', emoji: '🖌️', tier: 'legendary', price: 450000000,  name: "Leonardo da Vinci Salvator Mundi",     desc: "The painting that holds the record for the highest price ever paid for artwork." }
];

const SHOP_BY_ID = new Map(SHOP_ITEMS.map(i => [i.id, i]));

// ---------- Database setup ----------

async function initDatabase() {
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
    CREATE TABLE IF NOT EXISTS shop_purchases (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      price_paid BIGINT NOT NULL CHECK (price_paid >= 0),
      purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, item_id)
    )
  `);

  await pool.query(`
    ALTER TABLE auto_orders ADD COLUMN IF NOT EXISTS profit_target DOUBLE PRECISION
  `);
  await pool.query(`
    ALTER TABLE auto_orders ADD COLUMN IF NOT EXISTS loss_limit DOUBLE PRECISION
  `);
  await pool.query(`
    DELETE FROM auto_orders WHERE profit_target IS NULL AND loss_limit IS NULL
  `);

  // ----- Chat -----
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_users (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS chat_users_username_lower_idx
    ON chat_users (LOWER(username))
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      token TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      sender_id BIGINT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
      recipient_id BIGINT REFERENCES chat_users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS chat_messages_public_idx
    ON chat_messages (id DESC) WHERE recipient_id IS NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS chat_messages_pair_idx
    ON chat_messages (sender_id, recipient_id, id DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS chat_messages_recipient_idx
    ON chat_messages (recipient_id, sender_id, id DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS chat_sessions_user_idx ON chat_sessions(user_id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_reads (
      user_id BIGINT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
      peer_id BIGINT NOT NULL DEFAULT 0,
      last_read_id BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, peer_id)
    )
  `);

  // ----- Exodus-style wallets -----
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      seed_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS wallets_name_lower_idx ON wallets (LOWER(name))
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_sessions (
      token TEXT PRIMARY KEY,
      wallet_id BIGINT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_holdings (
      wallet_id BIGINT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
      PRIMARY KEY (wallet_id, symbol)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_txs (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      wallet_id BIGINT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      symbol TEXT NOT NULL,
      quantity DOUBLE PRECISION NOT NULL,
      coins BIGINT NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS wallet_txs_wallet_idx ON wallet_txs (wallet_id, id DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_prices (
      symbol TEXT PRIMARY KEY,
      price DOUBLE PRECISION NOT NULL CHECK (price > 0)
    )
  `);

  // ----- Broker -----
  await pool.query(`
    CREATE TABLE IF NOT EXISTS broker_reports (
      buyer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      section TEXT NOT NULL,
      price_paid BIGINT NOT NULL CHECK (price_paid >= 0),
      data JSONB NOT NULL,
      buys INTEGER NOT NULL DEFAULT 1,
      purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (buyer_id, target_id, section)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS broker_reports_target_idx ON broker_reports(target_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    INSERT INTO site_settings(key, value)
    VALUES('announcement', $1)
    ON CONFLICT(key) DO NOTHING
  `, [DEFAULT_ANNOUNCEMENT]);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS game_history_user_id_idx ON game_history(user_id)
  `).catch(() => {});

  await pool.query(`
    CREATE INDEX IF NOT EXISTS trades_user_id_created_idx
    ON trades(user_id, created_at DESC)
  `);

  for (const [sym, c] of Object.entries(COINS)) {
    await pool.query(`
      INSERT INTO market_coins(symbol, name, category, price)
      VALUES($1, $2, $3, $4)
      ON CONFLICT(symbol) DO UPDATE SET category=EXCLUDED.category, name=EXCLUDED.name
    `, [sym, c.name, c.category, c.anchor]);
  }

  const saved = await pool.query('SELECT symbol, price FROM market_coins');

  for (const row of saved.rows) {
    if (COINS[row.symbol] && Number(row.price) > 0) {
      COINS[row.symbol].price = Number(row.price);
    }
  }

  const walletSaved = await pool.query('SELECT symbol, price FROM wallet_prices');
  for (const row of walletSaved.rows) {
    if (WCOINS[row.symbol] && Number(row.price) > 0) {
      WCOINS[row.symbol].price = Number(row.price);
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

app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'index.html'))
);

app.get(['/trade', '/trade.html'], (req, res) =>
  res.sendFile(path.join(__dirname, 'trade.html'))
);

app.get('/exodus.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'exodus.js'));
});

app.get('/health', (req, res) => res.json({ ok: true, tick: tickN }));

// ---------- Accounts ----------

app.post('/api/register', route(async (req, res) => {
  const { username, password } = req.body || {};

  if (!validName(username))
    return fail(res, NAME_ERR);

  if (!validPassword(password))
    return fail(res, PASS_ERR);

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

    if (g.type === 'higherlower') {
      game = {
        type: g.type,
        bet: Number(g.bet),
        card: s.card,
        streak: s.streak,
        multiplier: s.multiplier
      };
    } else {
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

// ---------- Announcement ticker ----------

app.get('/api/announcement', route(async (req, res) => {
  const r = await pool.query(
    "SELECT value FROM site_settings WHERE key='announcement'"
  );
  res.set('Cache-Control', 'no-store');
  res.json({ message: r.rows.length ? r.rows[0].value : DEFAULT_ANNOUNCEMENT });
}));

app.post('/api/admin/announcement', auth, admin, route(async (req, res) => {
  const raw = req.body && req.body.message;

  if (typeof raw !== 'string') return fail(res, 'Message is required');

  const message = raw.replace(/\s+/g, ' ').trim();

  if (!message) return fail(res, 'Announcement cannot be empty');
  if (message.length > ANNOUNCEMENT_MAX)
    return fail(res, `Announcement must be ${ANNOUNCEMENT_MAX} characters or fewer`);

  await pool.query(`
    INSERT INTO site_settings(key, value, updated_at)
    VALUES('announcement', $1, NOW())
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
  `, [message]);

  res.json({ success: true, message });
}));

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

app.post('/api/admin/rename', auth, admin, route(async (req, res) => {
  const { id, username } = req.body || {};

  if (!/^[1-9]\d{0,18}$/.test(String(id ?? ''))) {
    return fail(res, 'Invalid account ID');
  }

  if (!validName(username)) {
    return fail(res, NAME_ERR);
  }

  await transaction(async client => {
    const targetResult = await client.query(
      'SELECT id FROM users WHERE id=$1 FOR UPDATE',
      [String(id)]
    );

    if (!targetResult.rows.length) {
      const err = new Error('User not found');
      err.status = 404;
      throw err;
    }

    const duplicate = await client.query(
      `SELECT 1 FROM users
       WHERE LOWER(username)=LOWER($1) AND id<>$2`,
      [username, String(id)]
    );

    if (duplicate.rows.length) {
      const err = new Error('Username already taken');
      err.status = 409;
      throw err;
    }

    await client.query(
      'UPDATE users SET username=$1 WHERE id=$2',
      [username, String(id)]
    );
  });

  res.json({ success: true, username });
}));

app.post('/api/admin/delete-user', auth, admin, route(async (req, res) => {
  const { id } = req.body || {};

  if (!/^[1-9]\d{0,18}$/.test(String(id ?? ''))) {
    return fail(res, 'Invalid account ID');
  }

  if (String(id) === String(req.user.id)) {
    return fail(res, 'You cannot delete your own account');
  }

  await transaction(async client => {
    const targetResult = await client.query(
      `SELECT id, username, is_admin
       FROM users
       WHERE id=$1
       FOR UPDATE`,
      [String(id)]
    );

    const target = targetResult.rows[0];

    if (!target) {
      const err = new Error('User not found');
      err.status = 404;
      throw err;
    }

    if (target.is_admin) {
      const err = new Error('Admin accounts cannot be deleted');
      err.status = 403;
      throw err;
    }

    await client.query(
      'DELETE FROM sessions WHERE user_id=$1',
      [target.id]
    );

    await client.query(
      'DELETE FROM games WHERE user_id=$1',
      [target.id]
    );

    await client.query(
      'DELETE FROM holdings WHERE user_id=$1',
      [target.id]
    );

    await client.query(
      'DELETE FROM auto_orders WHERE user_id=$1',
      [target.id]
    );

    await client.query(
      'DELETE FROM trades WHERE user_id=$1',
      [target.id]
    );

    await client.query(
      'DELETE FROM shop_purchases WHERE user_id=$1',
      [target.id]
    );

    const historyTable = await client.query(
      `SELECT to_regclass('public.game_history') AS table_name`
    );

    if (historyTable.rows[0].table_name) {
      await client.query(
        'DELETE FROM public.game_history WHERE user_id=$1',
        [target.id]
      );
    }

    await client.query(
      'DELETE FROM users WHERE id=$1',
      [target.id]
    );
  });

  res.json({ success: true });
}));

app.post('/api/admin/balance', auth, admin, route(async (req, res) => {
  const { id, amount, mode } = req.body || {};
  const n = Number(amount);

  if (!/^[1-9]\d{0,18}$/.test(String(id ?? '')))
    return fail(res, 'Invalid account ID');

  if (!Number.isSafeInteger(n) || Math.abs(n) > 1e12)
    return fail(res, 'Invalid amount');

  const exists = await pool.query(
    'SELECT 1 FROM users WHERE id=$1',
    [String(id)]
  );

  if (!exists.rows.length) return fail(res, 'User not found', 404);

  if (mode === 'set') {
    await pool.query(
      'UPDATE users SET balance=$1 WHERE id=$2',
      [Math.max(0, n), String(id)]
    );
  } else {
    await pool.query(
      'UPDATE users SET balance=GREATEST(0,balance+$1) WHERE id=$2',
      [n, String(id)]
    );
  }

  res.json({ balance: await getBal(String(id)) });
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

// ---------- Themed Boxes ----------

const CASE_REWARDS = {
  csstyle: [
    { name: 'Worn Alloy', emoji: '🔩', rarity: 'common', multiplier: 0, weight: 20 },
    { name: 'Blue Circuit', emoji: '🔹', rarity: 'uncommon', multiplier: 0.5, weight: 30 },
    { name: 'Neon Specter', emoji: '🔷', rarity: 'rare', multiplier: 1, weight: 27 },
    { name: 'Violet Phantom', emoji: '🟣', rarity: 'epic', multiplier: 2, weight: 15 },
    { name: 'Golden Protocol', emoji: '🌟', rarity: 'legendary', multiplier: 5, weight: 7 },
    { name: 'Dragon Core', emoji: '🐉', rarity: 'legendary', multiplier: 10, weight: 1 }
  ],
  crypto: [
    { name: 'Dust Token', emoji: '🪙', rarity: 'common', multiplier: 0, weight: 20 },
    { name: 'Blue Chip', emoji: '🔹', rarity: 'uncommon', multiplier: 0.5, weight: 30 },
    { name: 'Bitcoin Relic', emoji: '₿', rarity: 'rare', multiplier: 1, weight: 27 },
    { name: 'Moon Rocket', emoji: '🚀', rarity: 'epic', multiplier: 2, weight: 15 },
    { name: 'Diamond Wallet', emoji: '💎', rarity: 'legendary', multiplier: 5, weight: 7 },
    { name: 'Golden Bitcoin', emoji: '🟡', rarity: 'legendary', multiplier: 10, weight: 1 }
  ],
  meme: [
    { name: 'Empty Bag', emoji: '🛍️', rarity: 'common', multiplier: 0, weight: 20 },
    { name: 'Sus Cat', emoji: '🐱', rarity: 'uncommon', multiplier: 0.5, weight: 30 },
    { name: 'Wojak Badge', emoji: '😭', rarity: 'rare', multiplier: 1, weight: 27 },
    { name: 'Moon Frog', emoji: '🐸', rarity: 'epic', multiplier: 2, weight: 15 },
    { name: 'Ultra Meme', emoji: '🗿', rarity: 'legendary', multiplier: 5, weight: 7 },
    { name: 'Golden Shiba', emoji: '🐕', rarity: 'legendary', multiplier: 10, weight: 1 }
  ],
  treasure: [
    { name: 'Old Pebble', emoji: '🪨', rarity: 'common', multiplier: 0, weight: 20 },
    { name: 'Silver Coin', emoji: '🥈', rarity: 'uncommon', multiplier: 0.5, weight: 30 },
    { name: 'Sapphire', emoji: '🔷', rarity: 'rare', multiplier: 1, weight: 27 },
    { name: 'Royal Ruby', emoji: '♦️', rarity: 'epic', multiplier: 2, weight: 15 },
    { name: 'Crown Jewel', emoji: '👑', rarity: 'legendary', multiplier: 5, weight: 7 },
    { name: 'Ancient Treasure', emoji: '💎', rarity: 'legendary', multiplier: 10, weight: 1 }
  ]
};

function pickCaseReward(theme) {
  const rewards = CASE_REWARDS[theme];
  const totalWeight = rewards.reduce((sum, item) => sum + item.weight, 0);
  let roll = crypto.randomInt(totalWeight);

  for (const item of rewards) {
    roll -= item.weight;
    if (roll < 0) {
      const { weight, ...publicItem } = item;
      return publicItem;
    }
  }

  const { weight, ...fallback } = rewards[0];
  return fallback;
}

app.post('/api/boxes/open', auth, route(async (req, res) => {
  const theme = typeof req.body.theme === 'string'
    ? req.body.theme
    : 'csstyle';

  if (!CASE_REWARDS[theme]) {
    return fail(res, 'Choose a valid case theme');
  }

  if (await hasGame(req.user.id)) {
    return fail(res, 'Finish your current game first');
  }

  const bet = await validBet(req, res);
  if (!bet) return;

  const reward = pickCaseReward(theme);
  const payout = Math.floor(bet * reward.multiplier);

  await transaction(async client => {
    const balanceResult = await client.query(
      'SELECT balance FROM users WHERE id=$1 FOR UPDATE',
      [req.user.id]
    );

    if (!balanceResult.rows.length ||
        Number(balanceResult.rows[0].balance) < bet) {
      const err = new Error('Not enough balance');
      err.status = 400;
      throw err;
    }

    await client.query(
      'UPDATE users SET balance=balance-$1+$2 WHERE id=$3',
      [bet, payout, req.user.id]
    );
  });

  const winnerIndex = 36;
  const items = Array.from({ length: 45 }, () => pickCaseReward(theme));
  items[winnerIndex] = reward;

  res.json({
    theme,
    items,
    winnerIndex,
    reward,
    payout,
    balance: await getBal(req.user.id)
  });
}));

// ---------- Higher or Lower ----------

const HL_MAX_MULTIPLIER = 1000;

function hlRandomCard() {
  const rank = crypto.randomInt(2, 15);
  const suits = ['♠', '♥', '♦', '♣'];
  const suit = suits[crypto.randomInt(suits.length)];

  const labels = {
    11: 'J',
    12: 'Q',
    13: 'K',
    14: 'A'
  };

  return {
    rank,
    label: labels[rank] || String(rank),
    suit
  };
}

function hlMultiplier(currentRank, guess) {
  const winningRanks = guess === 'higher'
    ? 14 - currentRank
    : currentRank - 2;

  if (winningRanks <= 0) return 0;

  return Math.min(
    HL_MAX_MULTIPLIER,
    0.94 / (winningRanks / 13)
  );
}

function hlSafePayout(bet, multiplier) {
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.floor(bet * multiplier)
  );
}

app.post('/api/higherlower/start', auth, route(async (req, res) => {
  const bet = Number(req.body.bet);

  if (!Number.isSafeInteger(bet) || bet < 1) {
    return fail(res, 'Enter a valid whole-number bet');
  }

  const uid = req.user.id;
  const card = hlRandomCard();

  await transaction(async client => {
    const userResult = await client.query(
      'SELECT balance FROM users WHERE id=$1 FOR UPDATE',
      [uid]
    );

    if (!userResult.rows.length) {
      const err = new Error('User not found');
      err.status = 404;
      throw err;
    }

    if (Number(userResult.rows[0].balance) < bet) {
      const err = new Error('Not enough balance');
      err.status = 400;
      throw err;
    }

    const existing = await client.query(
      'SELECT type FROM games WHERE user_id=$1 FOR UPDATE',
      [uid]
    );

    if (existing.rows.length) {
      const err = new Error('Finish your current game first');
      err.status = 400;
      throw err;
    }

    await client.query(
      'UPDATE users SET balance=balance-$1 WHERE id=$2',
      [bet, uid]
    );

    await client.query(`
      INSERT INTO games(user_id,type,bet,state)
      VALUES($1,'higherlower',$2,$3::jsonb)
    `, [
      uid,
      bet,
      JSON.stringify({
        card,
        streak: 0,
        multiplier: 1
      })
    ]);
  });

  res.json({
    bet,
    card,
    balance: await getBal(uid)
  });
}));

app.post('/api/higherlower/guess', auth, route(async (req, res) => {
  const uid = req.user.id;
  const guess = req.body.guess;

  if (!['higher', 'lower'].includes(guess)) {
    return fail(res, 'Choose higher or lower');
  }

  const result = await transaction(async client => {
    const gameResult = await client.query(
      'SELECT type, bet, state FROM games WHERE user_id=$1 FOR UPDATE',
      [uid]
    );

    const row = gameResult.rows[0];

    if (!row || row.type !== 'higherlower') {
      const err = new Error('No active Higher or Lower round');
      err.status = 400;
      throw err;
    }

    const state = typeof row.state === 'string'
      ? JSON.parse(row.state)
      : row.state;

    const currentCard = state.card;

    if (
      (guess === 'higher' && currentCard.rank === 14) ||
      (guess === 'lower' && currentCard.rank === 2)
    ) {
      const err = new Error('That guess is impossible for this card');
      err.status = 400;
      throw err;
    }

    const nextCard = hlRandomCard();

    const correct = guess === 'higher'
      ? nextCard.rank > currentCard.rank
      : nextCard.rank < currentCard.rank;

    const tie = nextCard.rank === currentCard.rank;

    if (!correct) {
      await client.query(
        'DELETE FROM games WHERE user_id=$1',
        [uid]
      );

      return {
        correct: false,
        tie,
        card: nextCard
      };
    }

    const stepMultiplier = hlMultiplier(currentCard.rank, guess);

    state.streak += 1;
    state.multiplier = Math.min(
      HL_MAX_MULTIPLIER,
      state.multiplier * stepMultiplier
    );
    state.card = nextCard;

    await client.query(`
      UPDATE games
      SET state=$1::jsonb
      WHERE user_id=$2 AND type='higherlower'
    `, [JSON.stringify(state), uid]);

    return {
      correct: true,
      tie: false,
      card: nextCard,
      streak: state.streak,
      multiplier: state.multiplier
    };
  });

  res.json({
    ...result,
    balance: await getBal(uid)
  });
}));

app.post('/api/higherlower/cashout', auth, route(async (req, res) => {
  const uid = req.user.id;

  const result = await transaction(async client => {
    const gameResult = await client.query(
      'SELECT type, bet, state FROM games WHERE user_id=$1 FOR UPDATE',
      [uid]
    );

    const row = gameResult.rows[0];

    if (!row || row.type !== 'higherlower') {
      const err = new Error('No active round to cash out');
      err.status = 400;
      throw err;
    }

    const state = typeof row.state === 'string'
      ? JSON.parse(row.state)
      : row.state;

    const bet = Number(row.bet);
    const multiplier = Number(state.multiplier);

    if (
      !Number.isSafeInteger(bet) ||
      bet < 1 ||
      !Number.isFinite(multiplier) ||
      multiplier < 1 ||
      multiplier > HL_MAX_MULTIPLIER
    ) {
      throw new Error('Invalid saved game state');
    }

    const payout = hlSafePayout(bet, multiplier);

    await client.query(
      'DELETE FROM games WHERE user_id=$1',
      [uid]
    );

    await client.query(
      'UPDATE users SET balance=balance+$1 WHERE id=$2',
      [payout, uid]
    );

    return {
      payout,
      multiplier,
      streak: state.streak
    };
  });

  res.json({
    ...result,
    balance: await getBal(uid)
  });
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

// ---------- Virtual crypto market engine ----------

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

const realizablePnl = (qty, cost, price) => qty * price - cost;

let autoSellRunning = false;

async function runAutoSell(order, coin) {
  const sym = order.symbol;

  const sold = await transaction(async client => {
    const orderRes = await client.query(`
      SELECT profit_target, loss_limit FROM auto_orders
      WHERE user_id=$1 AND symbol=$2 FOR UPDATE
    `, [order.user_id, sym]);
    const o = orderRes.rows[0];
    if (!o) return null;

    const holdRes = await client.query(`
      SELECT quantity, cost_basis FROM holdings
      WHERE user_id=$1 AND symbol=$2 FOR UPDATE
    `, [order.user_id, sym]);
    const h = holdRes.rows[0];

    if (!h || Number(h.quantity) <= 0) {
      await client.query(
        'DELETE FROM auto_orders WHERE user_id=$1 AND symbol=$2',
        [order.user_id, sym]
      );
      return null;
    }

    const price = coin.price;
    const qty = Number(h.quantity);
    const cost = Number(h.cost_basis);
    const pnl = realizablePnl(qty, cost, price);

    const hitProfit = o.profit_target != null && pnl >= Number(o.profit_target);
    const hitLoss = o.loss_limit != null && pnl <= -Number(o.loss_limit);
    if (!hitProfit && !hitLoss) return null;

    const proceeds = Math.max(0, Math.floor(qty * price * (1 - FEE)));

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
    `, [order.user_id, sym, qty, price]);

    const userRes = await client.query(
      'SELECT username FROM users WHERE id=$1',
      [order.user_id]
    );

    return {
      username: userRes.rows[0] ? userRes.rows[0].username : null,
      proceeds, qty, price, pnl, reason: hitProfit ? 'profit' : 'loss'
    };
  });

  if (sold && sold.username) {
    logTrade(sold.username, sym, 'sell', sold.proceeds, sold.qty, sold.price);
    console.log(
      `Auto-sell (${sold.reason}) ${sold.username} ${sym} ` +
      `P&L ${sold.pnl} -> +${sold.proceeds} coins`
    );
  }
}

async function processAutoSells() {
  if (autoSellRunning) return;
  autoSellRunning = true;

  try {
    const result = await pool.query(`
      SELECT o.user_id, o.symbol, o.profit_target, o.loss_limit,
             h.quantity, h.cost_basis
      FROM auto_orders o
      LEFT JOIN holdings h
        ON h.user_id=o.user_id AND h.symbol=o.symbol
    `);

    for (const order of result.rows) {
      const coin = COINS[order.symbol];
      if (!coin) continue;

      try {
        if (order.quantity == null || Number(order.quantity) <= 0) {
          await runAutoSell(order, coin);
          continue;
        }

        const pnl = realizablePnl(
          Number(order.quantity), Number(order.cost_basis), coin.price
        );

        const hitProfit = order.profit_target != null &&
          pnl >= Number(order.profit_target);
        const hitLoss = order.loss_limit != null &&
          pnl <= -Number(order.loss_limit);

        if (hitProfit || hitLoss) await runAutoSell(order, coin);
      } catch (err) {
        console.error('Auto-sell failed for', order.user_id, order.symbol, err);
      }
    }
  } finally {
    autoSellRunning = false;
  }
}

function tick(processOrders = true) {
  tickN++;
  walletTick();

  for (const c of Object.values(COINS)) {
    if (c.category === 'crypto') {
      // 1. CRYPTO: Steady, small gradual fluctuations, rare major flash crash / dip.
      if (rand() < 0.02) {
        c.mu = (rand() < 0.5 ? -1 : 1) * c.vol * (0.4 + rand() * 0.8);
      }
      c.mu *= 0.96;

      let r = c.mu + gauss() * c.vol - 0.0007 * Math.log(c.price / c.anchor);

      // Rare flash crash / big dump (approx 0.8% chance per tick)
      if (rand() < 0.008) {
        // Flash dip between -15% and -40%
        r -= (0.15 + rand() * 0.25);
      }

      const nextPrice = c.price * Math.exp(Math.max(-0.6, Math.min(0.2, r)));
      c.price = Number.isFinite(nextPrice)
        ? Math.max(c.anchor * 0.2, nextPrice)
        : c.anchor;

    } else {
      // 2. MEMECOINS: Extreme volatility, rocket moonshots (+60k on 5k) and total crashes / rugpulls.
      if (rand() < 0.12) {
        c.mu = (rand() < 0.45 ? -1 : 1) * c.vol * (1 + rand() * 3);
      }
      c.mu *= 0.88;

      let r = c.mu + gauss() * c.vol;

      // Random huge parabolic moonshot pump (approx 4.5% chance)
      // Multiplies coin price up to 5x - 15x in a few ticks!
      if (rand() < 0.045) {
        r += (1.2 + rand() * 2.5); // massive sudden positive log-return (+230% to +1200% in a single step)
      }

      // Random catastrophic rugpull / dump (approx 4.5% chance)
      // Can obliterate 80% to 98% of value instantly!
      if (rand() < 0.045) {
        r -= (1.6 + rand() * 2.8); // drops near zero
      }

      const nextPrice = c.price * Math.exp(Math.max(-6, Math.min(6, r)));
      // Floor at near zero (0.000001) or ceiling at 1000x anchor
      c.price = Number.isFinite(nextPrice)
        ? Math.max(c.anchor * 0.005, Math.min(c.anchor * 500, nextPrice))
        : c.anchor * 0.005;
    }

    c.hist.push(c.price);
    if (c.hist.length > HIST) c.hist.shift();
  }

  if (processOrders) {
    processAutoSells().catch(err => console.error('Auto-sell error:', err));
  }
}

async function persistMarket() {
  await persistWalletPrices();
  for (const [sym, c] of Object.entries(COINS)) {
    await pool.query(`
      UPDATE market_coins
      SET price=$1, updated_at=NOW()
      WHERE symbol=$2
    `, [c.price, sym]);
  }
}

app.get('/api/market', auth, route(async (req, res) => {
  const sel = COINS[req.query.coin] ? req.query.coin : 'BTCP';

  const holdingsResult = await pool.query(`
    SELECT symbol AS sym, quantity AS qty, cost_basis AS cost
    FROM holdings WHERE user_id=$1
  `, [req.user.id]);

  const ordersResult = await pool.query(`
    SELECT symbol AS sym, profit_target AS target, loss_limit AS stop
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
    autoOrders: ordersResult.rows.map(o => {
      const hold = holdingsResult.rows.find(h => h.sym === o.sym);
      const pnl = hold && COINS[o.sym]
        ? realizablePnl(Number(hold.qty), Number(hold.cost), COINS[o.sym].price)
        : 0;
      return {
        ...o,
        target: o.target == null ? null : Number(o.target),
        stop: o.stop == null ? null : Number(o.stop),
        pnl
      };
    })
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
    const pct = Number(req.body.percent);
    if (!(pct > 0 && pct <= 100))
      return fail(res, 'Percent must be 1-100');

    let got = 0;

    await transaction(async client => {
      // Lock the holding row so concurrent sells cannot both pay out.
      const hr = await client.query(`
        SELECT quantity AS qty, cost_basis AS cost
        FROM holdings WHERE user_id=$1 AND symbol=$2 FOR UPDATE
      `, [uid, sym]);

      const hold = hr.rows[0];
      if (!hold || Number(hold.qty) <= 0)
        throw shopFail('You do not own this coin');

      const oldQty = Number(hold.qty);
      const oldCost = Number(hold.cost);
      const q = pct === 100 ? oldQty : oldQty * pct / 100;
      got = Math.max(0, Math.floor(q * price * (1 - FEE)));

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

  const parseCoins = value => {
    if (value === '' || value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 && n <= 1e15 ? n : NaN;
  };

  const target = parseCoins(req.body.target ?? req.body.profit);
  const stop = parseCoins(req.body.stop ?? req.body.loss);

  if (Number.isNaN(target) || Number.isNaN(stop))
    return fail(res, 'Profit and loss limits must be positive numbers');

  if (target == null && stop == null)
    return fail(res, 'Enter a profit target or a loss limit');

  const holding = await pool.query(`
    SELECT quantity, cost_basis FROM holdings
    WHERE user_id=$1 AND symbol=$2
  `, [req.user.id, sym]);

  if (!holding.rows.length || Number(holding.rows[0].quantity) <= 0)
    return fail(res, 'Buy this coin before setting auto-sell');

  await pool.query(`
    INSERT INTO auto_orders(user_id,symbol,profit_target,loss_limit)
    VALUES($1,$2,$3,$4)
    ON CONFLICT(user_id,symbol) DO UPDATE SET
      profit_target=EXCLUDED.profit_target,
      loss_limit=EXCLUDED.loss_limit
  `, [req.user.id, sym, target, stop]);

  const parts = [];
  if (target != null) parts.push(`profit reaches ${Math.floor(target).toLocaleString()}`);
  if (stop != null) parts.push(`loss reaches ${Math.floor(stop).toLocaleString()}`);

  res.json({ msg: `Auto-sell on for ${sym}: sells when ${parts.join(' or ')}` });
}));

// ---------- Luxury shop ----------

const shopFail = (msg, status = 400) => {
  const err = new Error(msg);
  err.status = status;
  return err;
};

app.get('/api/shop', auth, route(async (req, res) => {
  const owned = await pool.query(
    'SELECT item_id, price_paid FROM shop_purchases WHERE user_id=$1',
    [req.user.id]
  );

  res.json({
    balance: await getBal(req.user.id),
    sellRate: SHOP_SELL_RATE,
    categories: SHOP_CATEGORIES,
    items: SHOP_ITEMS,
    owned: owned.rows
      .filter(r => SHOP_BY_ID.has(r.item_id))
      .map(r => ({ id: r.item_id, paid: Number(r.price_paid) }))
  });
}));

app.post('/api/shop/buy', auth, route(async (req, res) => {
  const item = SHOP_BY_ID.get(String((req.body || {}).id || ''));
  if (!item) return fail(res, 'Unknown item');

  const uid = req.user.id;

  await transaction(async client => {
    const userResult = await client.query(
      'SELECT balance FROM users WHERE id=$1 FOR UPDATE',
      [uid]
    );

    if (!userResult.rows.length) throw shopFail('User not found', 404);
    if (Number(userResult.rows[0].balance) < item.price)
      throw shopFail('Not enough balance');

    const inserted = await client.query(`
      INSERT INTO shop_purchases(user_id,item_id,price_paid)
      VALUES($1,$2,$3)
      ON CONFLICT(user_id,item_id) DO NOTHING
      RETURNING item_id
    `, [uid, item.id, item.price]);

    if (!inserted.rows.length) throw shopFail('You already own this item');

    await client.query(
      'UPDATE users SET balance=balance-$1 WHERE id=$2',
      [item.price, uid]
    );
  });

  res.json({
    balance: await getBal(uid),
    msg: `Purchased ${item.name}`,
    paid: item.price
  });
}));

app.post('/api/shop/sell', auth, route(async (req, res) => {
  const item = SHOP_BY_ID.get(String((req.body || {}).id || ''));
  if (!item) return fail(res, 'Unknown item');

  const uid = req.user.id;
  let refund = 0;

  await transaction(async client => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [uid]);

    const removed = await client.query(`
      DELETE FROM shop_purchases
      WHERE user_id=$1 AND item_id=$2
      RETURNING price_paid
    `, [uid, item.id]);

    if (!removed.rows.length) throw shopFail('You do not own this item');

    refund = Math.floor(Number(removed.rows[0].price_paid) * SHOP_SELL_RATE);

    await client.query(
      'UPDATE users SET balance=balance+$1 WHERE id=$2',
      [refund, uid]
    );
  });

  res.json({
    balance: await getBal(uid),
    msg: `Sold ${item.name}`,
    refund
  });
}));

// ---------- Chat ----------

const CHAT_MAX_LEN = 1000;
const CHAT_RESERVED = new Set(['public']);

const chatClients = new Map();
const chatOfflineTimers = new Map();
const chatRate = new Map();

const chatOnline = id => {
  const set = chatClients.get(String(id));
  return !!(set && set.size);
};

function chatPush(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (err) { }
}

function chatDeliver(userIds, event, data) {
  for (const id of new Set(userIds.map(String))) {
    const set = chatClients.get(id);
    if (set) for (const res of set) chatPush(res, event, data);
  }
}

function chatBroadcast(event, data) {
  for (const set of chatClients.values())
    for (const res of set) chatPush(res, event, data);
}

function chatRateOk(uid) {
  const now = Date.now();
  const recent = (chatRate.get(uid) || []).filter(t => now - t < 10000);
  if (recent.length >= 15) {
    chatRate.set(uid, recent);
    return false;
  }
  recent.push(now);
  chatRate.set(uid, recent);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [uid, list] of chatRate) {
    if (!list.some(t => now - t < 10000)) chatRate.delete(uid);
  }
}, 60000).unref();

const CHAT_SELECT = `
  SELECT m.id, m.body, m.created_at,
         s.username AS sender_name, r.username AS recipient_name
  FROM chat_messages m
  JOIN chat_users s ON s.id = m.sender_id
  LEFT JOIN chat_users r ON r.id = m.recipient_id
`;

const chatMsg = r => ({
  id: Number(r.id),
  from: r.sender_name,
  to: r.recipient_name || 'public',
  text: r.body,
  ts: new Date(r.created_at).toISOString()
});

async function chatFindUser(name) {
  if (!validName(name)) return null;
  const r = await pool.query(
    'SELECT id, username, last_seen FROM chat_users WHERE LOWER(username)=LOWER($1)',
    [name]
  );
  return r.rows[0] || null;
}

const chatAuth = route(async (req, res, next) => {
  const token = req.headers.authorization || '';
  if (!token || token.length > 200) return fail(res, 'Please log in to chat', 401);

  const r = await pool.query(`
    SELECT u.id, u.username
    FROM chat_sessions s
    JOIN chat_users u ON u.id = s.user_id
    WHERE s.token = $1
  `, [token]);

  if (!r.rows.length) return fail(res, 'Please log in to chat', 401);

  req.chatUser = r.rows[0];
  next();
});

async function chatNewSession(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    'INSERT INTO chat_sessions(token,user_id) VALUES($1,$2)',
    [token, uid]
  );
  return token;
}

app.post('/api/chat/register', route(async (req, res) => {
  const { username, password } = req.body || {};

  if (!validName(username))
    return fail(res, NAME_ERR);

  if (CHAT_RESERVED.has(username.toLowerCase()))
    return fail(res, 'That username is reserved');

  if (!validPassword(password))
    return fail(res, PASS_ERR);

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = `${salt}:${hashPw(password, salt)}`;

  let uid;
  try {
    const r = await pool.query(
      'INSERT INTO chat_users(username,password_hash) VALUES($1,$2) RETURNING id',
      [username, passwordHash]
    );
    uid = r.rows[0].id;
  } catch (err) {
    if (err.code === '23505') return fail(res, 'Username already taken');
    throw err;
  }

  await pool.query(`
    INSERT INTO chat_reads(user_id,peer_id,last_read_id)
    SELECT $1::bigint, 0, COALESCE(MAX(id), 0)
    FROM chat_messages WHERE recipient_id IS NULL
  `, [uid]);

  res.json({ token: await chatNewSession(uid) });
}));

app.post('/api/chat/login', route(async (req, res) => {
  const { username, password } = req.body || {};

  const r = await pool.query(
    'SELECT * FROM chat_users WHERE LOWER(username)=LOWER($1)',
    [typeof username === 'string' ? username : '']
  );
  const u = r.rows[0];

  if (!u || typeof password !== 'string')
    return fail(res, 'Wrong username or password', 401);

  const stored = String(u.password_hash || '');
  const sep = stored.indexOf(':');
  if (sep < 1) return fail(res, 'Wrong username or password', 401);

  const a = Buffer.from(stored.slice(sep + 1), 'hex');
  const b = Buffer.from(hashPw(password, stored.slice(0, sep)), 'hex');

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return fail(res, 'Wrong username or password', 401);

  res.json({ token: await chatNewSession(u.id) });
}));

app.post('/api/chat/logout', chatAuth, route(async (req, res) => {
  await pool.query(
    'DELETE FROM chat_sessions WHERE token=$1',
    [req.headers.authorization]
  );
  res.json({});
}));

app.get('/api/chat/me', chatAuth, route(async (req, res) => {
  res.json({ id: Number(req.chatUser.id), username: req.chatUser.username });
}));

app.get('/api/chat/stream', chatAuth, (req, res) => {
  const uid = String(req.chatUser.id);
  const name = req.chatUser.username;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');

  clearTimeout(chatOfflineTimers.get(uid));
  chatOfflineTimers.delete(uid);

  let set = chatClients.get(uid);
  if (!set) {
    set = new Set();
    chatClients.set(uid, set);
  }
  const wasOffline = set.size === 0;
  set.add(res);

  if (wasOffline) chatBroadcast('presence', { username: name, online: true });

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (err) { }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    set.delete(res);

    if (set.size === 0) {
      chatOfflineTimers.set(uid, setTimeout(async () => {
        const current = chatClients.get(uid);
        if (current && current.size) return;
        chatClients.delete(uid);
        chatOfflineTimers.delete(uid);

        let lastSeen = new Date().toISOString();
        try {
          const r = await pool.query(
            'UPDATE chat_users SET last_seen=NOW() WHERE id=$1 RETURNING last_seen',
            [uid]
          );
          if (r.rows[0]) lastSeen = new Date(r.rows[0].last_seen).toISOString();
        } catch (err) { }

        chatBroadcast('presence', { username: name, online: false, lastSeen });
      }, 5000));
    }
  });
});

app.get('/api/chat/dialogs', chatAuth, route(async (req, res) => {
  const me = req.chatUser;

  const pubLast = await pool.query(
    `${CHAT_SELECT} WHERE m.recipient_id IS NULL ORDER BY m.id DESC LIMIT 1`
  );
  const pubUnread = await pool.query(`
    SELECT COUNT(*) AS n FROM chat_messages
    WHERE recipient_id IS NULL AND sender_id <> $1::bigint
      AND id > COALESCE(
        (SELECT last_read_id FROM chat_reads
         WHERE user_id=$1::bigint AND peer_id=0), 0)
  `, [me.id]);

  const priv = await pool.query(`
    SELECT c.peer_id, u.username, u.last_seen,
           m.id AS last_id, m.body, m.created_at,
           (m.sender_id = $1::bigint) AS mine,
           (SELECT COUNT(*) FROM chat_messages x
             WHERE x.sender_id = c.peer_id AND x.recipient_id = $1::bigint
               AND x.id > COALESCE(
                 (SELECT r.last_read_id FROM chat_reads r
                  WHERE r.user_id = $1::bigint AND r.peer_id = c.peer_id), 0)
           ) AS unread
    FROM (
      SELECT CASE WHEN sender_id = $1::bigint THEN recipient_id ELSE sender_id END AS peer_id,
             MAX(id) AS last_id
      FROM chat_messages
      WHERE recipient_id IS NOT NULL
        AND (sender_id = $1::bigint OR recipient_id = $1::bigint)
      GROUP BY 1
    ) c
    JOIN chat_users u ON u.id = c.peer_id
    JOIN chat_messages m ON m.id = c.last_id
    ORDER BY c.last_id DESC
    LIMIT 100
  `, [me.id]);

  const pl = pubLast.rows[0];

  res.json({
    public: {
      last: pl ? {
        id: Number(pl.id),
        from: pl.sender_name,
        text: pl.body,
        ts: new Date(pl.created_at).toISOString(),
        mine: pl.sender_name === me.username
      } : null,
      unread: Number(pubUnread.rows[0].n)
    },
    chats: priv.rows.map(r => ({
      name: r.username,
      online: chatOnline(r.peer_id),
      lastSeen: new Date(r.last_seen).toISOString(),
      unread: Number(r.unread),
      last: {
        id: Number(r.last_id),
        from: r.mine ? me.username : r.username,
        text: r.body,
        ts: new Date(r.created_at).toISOString(),
        mine: !!r.mine
      }
    }))
  });
}));

app.get('/api/chat/history', chatAuth, route(async (req, res) => {
  const me = req.chatUser;
  const peer = String(req.query.peer || '');
  const before = Number(req.query.before) || 0;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);

  const params = [];
  let where;
  let peerInfo = null;

  if (peer === 'public') {
    where = 'm.recipient_id IS NULL';
  } else {
    const p = await chatFindUser(peer);
    if (!p) return fail(res, 'User not found', 404);
    params.push(me.id, p.id);
    where = `((m.sender_id=$1::bigint AND m.recipient_id=$2::bigint)
           OR (m.sender_id=$2::bigint AND m.recipient_id=$1::bigint))`;
    peerInfo = {
      name: p.username,
      online: chatOnline(p.id),
      lastSeen: new Date(p.last_seen).toISOString()
    };
  }

  if (before > 0) {
    params.push(before);
    where += ` AND m.id < $${params.length}::bigint`;
  }

  params.push(limit + 1);

  const r = await pool.query(
    `${CHAT_SELECT} WHERE ${where} ORDER BY m.id DESC LIMIT $${params.length}`,
    params
  );

  const more = r.rows.length > limit;
  const rows = r.rows.slice(0, limit).reverse();

  res.json({ peer: peerInfo, more, messages: rows.map(chatMsg) });
}));

app.post('/api/chat/send', chatAuth, route(async (req, res) => {
  const me = req.chatUser;
  const { to } = req.body || {};
  let text = (req.body || {}).text;

  if (typeof text !== 'string') return fail(res, 'Message is empty');
  text = text.replace(/\r\n?/g, '\n').trim();

  if (!text) return fail(res, 'Message is empty');
  if (text.length > CHAT_MAX_LEN)
    return fail(res, `Message is too long (max ${CHAT_MAX_LEN} characters)`);

  if (!chatRateOk(String(me.id)))
    return fail(res, 'Slow down, you are sending too fast', 429);

  let recipient = null;

  if (to !== 'public') {
    recipient = await chatFindUser(to);
    if (!recipient) return fail(res, 'User not found', 404);
    if (String(recipient.id) === String(me.id))
      return fail(res, "You can't message yourself");
  }

  const ins = await pool.query(`
    INSERT INTO chat_messages(sender_id,recipient_id,body)
    VALUES($1,$2,$3)
    RETURNING id, created_at
  `, [me.id, recipient ? recipient.id : null, text]);

  const message = {
    id: Number(ins.rows[0].id),
    from: me.username,
    to: recipient ? recipient.username : 'public',
    text,
    ts: new Date(ins.rows[0].created_at).toISOString()
  };

  if (recipient) chatDeliver([me.id, recipient.id], 'message', message);
  else chatBroadcast('message', message);

  res.json({ message });
}));

app.post('/api/chat/read', chatAuth, route(async (req, res) => {
  const me = req.chatUser;
  const peer = String((req.body || {}).peer || '');

  let peerId;
  let maxRes;

  if (peer === 'public') {
    peerId = 0;
    maxRes = await pool.query(
      'SELECT COALESCE(MAX(id),0) AS m FROM chat_messages WHERE recipient_id IS NULL'
    );
  } else {
    const p = await chatFindUser(peer);
    if (!p) return fail(res, 'User not found', 404);
    peerId = p.id;
    maxRes = await pool.query(
      `SELECT COALESCE(MAX(id),0) AS m FROM chat_messages
       WHERE sender_id=$1 AND recipient_id=$2`,
      [p.id, me.id]
    );
  }

  await pool.query(`
    INSERT INTO chat_reads(user_id,peer_id,last_read_id)
    VALUES($1,$2,$3)
    ON CONFLICT(user_id,peer_id) DO UPDATE SET
      last_read_id = GREATEST(chat_reads.last_read_id, EXCLUDED.last_read_id)
  `, [me.id, peerId, maxRes.rows[0].m]);

  res.json({ ok: true });
}));

app.get('/api/chat/users/search', chatAuth, route(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 16);
  if (q.length < 1) return res.json({ users: [] });

  const escaped = q.replace(/[\\%_]/g, '\\$&');

  const r = await pool.query(`
    SELECT id, username FROM chat_users
    WHERE LOWER(username) LIKE LOWER($1) AND id <> $2
    ORDER BY username LIMIT 8
  `, [escaped + '%', req.chatUser.id]);

  res.json({
    users: r.rows.map(u => ({ name: u.username, online: chatOnline(u.id) }))
  });
}));

app.get('/api/chat/user', chatAuth, route(async (req, res) => {
  const p = await chatFindUser(String(req.query.name || ''));
  if (!p) return fail(res, 'User not found', 404);

  res.json({
    name: p.username,
    online: chatOnline(p.id),
    lastSeen: new Date(p.last_seen).toISOString()
  });
}));

// ---------- Exodus-style wallet API ----------

const walletTries = new Map();

function walletRateOk(uid) {
  const now = Date.now();
  const recent = (walletTries.get(uid) || []).filter(t => now - t < 60000);
  if (recent.length >= 10) {
    walletTries.set(uid, recent);
    return false;
  }
  recent.push(now);
  walletTries.set(uid, recent);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [uid, list] of walletTries) {
    if (!list.some(t => now - t < 60000)) walletTries.delete(uid);
  }
}, 60000).unref();

async function walletNewSession(walletId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    'INSERT INTO wallet_sessions(token,wallet_id) VALUES($1,$2)',
    [token, walletId]
  );
  return token;
}

const walletAuth = route(async (req, res, next) => {
  const token = req.headers['x-wallet-token'] || '';

  if (!token || token.length > 200)
    return res.status(401).json({ error: 'Open your wallet first', wallet: true });

  const r = await pool.query(`
    SELECT w.id, w.name
    FROM wallet_sessions s
    JOIN wallets w ON w.id = s.wallet_id
    WHERE s.token = $1
  `, [token]);

  if (!r.rows.length)
    return res.status(401).json({ error: 'Wallet session expired', wallet: true });

  req.wallet = r.rows[0];
  next();
});

function walletAssets(holdings) {
  return Object.entries(WCOINS).map(([sym, c]) => {
    const qty = holdings.get(sym) || 0;
    return {
      sym,
      name: c.name,
      glyph: c.glyph,
      color: c.color,
      price: c.price,
      change: c.hist.length > 1
        ? c.price / c.hist[Math.max(0, c.hist.length - 300)] - 1
        : 0,
      qty,
      value: qty * c.price
    };
  });
}

async function walletHoldings(client, walletId) {
  const r = await client.query(
    'SELECT symbol, quantity FROM wallet_holdings WHERE wallet_id=$1',
    [walletId]
  );
  return new Map(r.rows.map(x => [x.symbol, Number(x.quantity)]));
}

app.post('/api/wallet/create', auth, route(async (req, res) => {
  const { name, password } = req.body || {};

  if (!validName(name)) return fail(res, NAME_ERR);
  if (!validPassword(password)) return fail(res, PASS_ERR);

  if (!walletRateOk(String(req.user.id)))
    return fail(res, 'Too many attempts, wait a minute', 429);

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = `${salt}:${hashPw(password, salt)}`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const seed = genSeed();

    try {
      const r = await pool.query(
        'INSERT INTO wallets(name,password_hash,seed_hash) VALUES($1,$2,$3) RETURNING id',
        [name, passwordHash, seedHash(seed)]
      );
      const token = await walletNewSession(r.rows[0].id);
      return res.json({ token, name, seed });
    } catch (err) {
      if (err.code !== '23505') throw err;

      const dup = await pool.query(
        'SELECT 1 FROM wallets WHERE LOWER(name)=LOWER($1)',
        [name]
      );
      if (dup.rows.length) return fail(res, 'Wallet name already taken');
    }
  }

  fail(res, 'Could not create the wallet, please try again', 500);
}));

app.post('/api/wallet/login', auth, route(async (req, res) => {
  if (!walletRateOk(String(req.user.id)))
    return fail(res, 'Too many attempts, wait a minute', 429);

  const { name, password } = req.body || {};

  const r = await pool.query(
    'SELECT * FROM wallets WHERE LOWER(name)=LOWER($1)',
    [typeof name === 'string' ? name : '']
  );
  const w = r.rows[0];

  if (!w || typeof password !== 'string')
    return fail(res, 'Wrong wallet name or password', 401);

  const stored = String(w.password_hash || '');
  const sep = stored.indexOf(':');
  if (sep < 1) return fail(res, 'Wrong wallet name or password', 401);

  const a = Buffer.from(stored.slice(sep + 1), 'hex');
  const b = Buffer.from(hashPw(password, stored.slice(0, sep)), 'hex');

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return fail(res, 'Wrong wallet name or password', 401);

  res.json({ token: await walletNewSession(w.id), name: w.name });
}));

app.post('/api/wallet/login-seed', auth, route(async (req, res) => {
  if (!walletRateOk(String(req.user.id)))
    return fail(res, 'Too many attempts, wait a minute', 429);

  const words = normSeed(req.body && req.body.seed);

  if (words.length !== 12 || !words.every(w => WSEED_SET.has(w)))
    return fail(res, 'Invalid seed phrase', 401);

  const r = await pool.query(
    'SELECT id, name FROM wallets WHERE seed_hash=$1',
    [seedHash(words)]
  );

  if (!r.rows.length) return fail(res, 'Invalid seed phrase', 401);

  res.json({ token: await walletNewSession(r.rows[0].id), name: r.rows[0].name });
}));

app.post('/api/wallet/logout', auth, route(async (req, res) => {
  await pool.query(
    'DELETE FROM wallet_sessions WHERE token=$1',
    [String(req.headers['x-wallet-token'] || '')]
  );
  res.json({});
}));

app.get('/api/wallet/me', auth, walletAuth, route(async (req, res) => {
  const assets = walletAssets(await walletHoldings(pool, req.wallet.id));

  res.json({
    name: req.wallet.name,
    balance: await getBal(req.user.id),
    fee: FEE,
    assets,
    total: assets.reduce((sum, a) => sum + a.value, 0)
  });
}));

app.post('/api/wallet/buy', auth, walletAuth, route(async (req, res) => {
  const sym = String((req.body || {}).sym || '');
  const c = WCOINS[sym];
  if (!c) return fail(res, 'Unknown asset');

  const coins = Number(req.body.coins);
  if (!Number.isSafeInteger(coins) || coins < 1)
    return fail(res, 'Enter a valid amount');

  const price = c.price;
  const qty = coins * (1 - FEE) / price;

  await transaction(async client => {
    const u = await client.query(
      'SELECT balance FROM users WHERE id=$1 FOR UPDATE',
      [req.user.id]
    );

    if (!u.rows.length || Number(u.rows[0].balance) < coins)
      throw shopFail('Not enough balance');

    await client.query(
      'UPDATE users SET balance=balance-$1 WHERE id=$2',
      [coins, req.user.id]
    );

    await client.query(`
      INSERT INTO wallet_holdings(wallet_id,symbol,quantity)
      VALUES($1,$2,$3)
      ON CONFLICT(wallet_id,symbol) DO UPDATE SET
        quantity=wallet_holdings.quantity+EXCLUDED.quantity
    `, [req.wallet.id, sym, qty]);

    await client.query(`
      INSERT INTO wallet_txs(wallet_id,kind,symbol,quantity,coins,note)
      VALUES($1,'buy',$2,$3,$4,$5)
    `, [req.wallet.id, sym, qty, coins, req.user.username]);
  });

  res.json({
    balance: await getBal(req.user.id),
    msg: `Bought ${qty.toPrecision(5)} ${sym}`
  });
}));

app.post('/api/wallet/sell', auth, walletAuth, route(async (req, res) => {
  const sym = String((req.body || {}).sym || '');
  const c = WCOINS[sym];
  if (!c) return fail(res, 'Unknown asset');

  const pct = Number(req.body.percent);
  if (!(pct > 0 && pct <= 100)) return fail(res, 'Percent must be 1-100');

  const price = c.price;
  let got = 0;
  let q = 0;

  await transaction(async client => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);

    const h = await client.query(`
      SELECT quantity FROM wallet_holdings
      WHERE wallet_id=$1 AND symbol=$2 FOR UPDATE
    `, [req.wallet.id, sym]);

    const have = h.rows[0] ? Number(h.rows[0].quantity) : 0;
    if (have <= 0) throw shopFail('This wallet holds none of that asset');

    q = pct === 100 ? have : have * pct / 100;
    got = Math.max(0, Math.floor(q * price * (1 - FEE)));

    if (pct === 100) {
      await client.query(
        'DELETE FROM wallet_holdings WHERE wallet_id=$1 AND symbol=$2',
        [req.wallet.id, sym]
      );
    } else {
      await client.query(`
        UPDATE wallet_holdings SET quantity=quantity-$1
        WHERE wallet_id=$2 AND symbol=$3
      `, [q, req.wallet.id, sym]);
    }

    await client.query(
      'UPDATE users SET balance=balance+$1 WHERE id=$2',
      [got, req.user.id]
    );

    await client.query(`
      INSERT INTO wallet_txs(wallet_id,kind,symbol,quantity,coins,note)
      VALUES($1,'sell',$2,$3,$4,$5)
    `, [req.wallet.id, sym, q, got, req.user.username]);
  });

  res.json({
    balance: await getBal(req.user.id),
    msg: `Sold ${q.toPrecision(5)} ${sym} for ${got.toLocaleString()} coins`
  });
}));

app.post('/api/wallet/send', auth, walletAuth, route(async (req, res) => {
  const sym = String((req.body || {}).sym || '');
  if (!WCOINS[sym]) return fail(res, 'Unknown asset');

  const pct = Number(req.body.percent);
  if (!(pct > 0 && pct <= 100)) return fail(res, 'Percent must be 1-100');

  const toName = String(req.body.to || '').trim();
  if (!validName(toName)) return fail(res, 'Enter the recipient wallet name');

  const target = await pool.query(
    'SELECT id, name FROM wallets WHERE LOWER(name)=LOWER($1)',
    [toName]
  );
  const dest = target.rows[0];

  if (!dest) return fail(res, 'No wallet with that name', 404);
  if (String(dest.id) === String(req.wallet.id))
    return fail(res, "You can't send to the same wallet");

  let q = 0;

  await transaction(async client => {
    await client.query(`
      SELECT wallet_id FROM wallet_holdings
      WHERE symbol=$1 AND wallet_id IN ($2,$3)
      ORDER BY wallet_id FOR UPDATE
    `, [sym, req.wallet.id, dest.id]);

    const h = await client.query(
      'SELECT quantity FROM wallet_holdings WHERE wallet_id=$1 AND symbol=$2',
      [req.wallet.id, sym]
    );

    const have = h.rows[0] ? Number(h.rows[0].quantity) : 0;
    if (have <= 0) throw shopFail('This wallet holds none of that asset');

    q = pct === 100 ? have : have * pct / 100;

    if (pct === 100) {
      await client.query(
        'DELETE FROM wallet_holdings WHERE wallet_id=$1 AND symbol=$2',
        [req.wallet.id, sym]
      );
    } else {
      await client.query(`
        UPDATE wallet_holdings SET quantity=quantity-$1
        WHERE wallet_id=$2 AND symbol=$3
      `, [q, req.wallet.id, sym]);
    }

    await client.query(`
      INSERT INTO wallet_holdings(wallet_id,symbol,quantity)
      VALUES($1,$2,$3)
      ON CONFLICT(wallet_id,symbol) DO UPDATE SET
        quantity=wallet_holdings.quantity+EXCLUDED.quantity
    `, [dest.id, sym, q]);

    await client.query(`
      INSERT INTO wallet_txs(wallet_id,kind,symbol,quantity,coins,note)
      VALUES($1,'send',$2,$3,0,$4), ($5,'receive',$2,$3,0,$6)
    `, [req.wallet.id, sym, q, dest.name, dest.id, req.wallet.name]);
  });

  res.json({ msg: `Sent ${q.toPrecision(5)} ${sym} to ${dest.name}` });
}));

app.post('/api/wallet/swap', auth, walletAuth, route(async (req, res) => {
  const from = String((req.body || {}).from || '');
  const to = String((req.body || {}).to || '');
  const cf = WCOINS[from];
  const ct = WCOINS[to];

  if (!cf || !ct) return fail(res, 'Unknown asset');
  if (from === to) return fail(res, 'Pick two different assets');

  const pct = Number(req.body.percent);
  if (!(pct > 0 && pct <= 100)) return fail(res, 'Percent must be 1-100');

  const priceFrom = cf.price;
  const priceTo = ct.price;
  let q = 0;
  let got = 0;

  await transaction(async client => {
    await client.query(`
      SELECT symbol FROM wallet_holdings
      WHERE wallet_id=$1 AND symbol IN ($2,$3)
      ORDER BY symbol FOR UPDATE
    `, [req.wallet.id, from, to]);

    const h = await client.query(
      'SELECT quantity FROM wallet_holdings WHERE wallet_id=$1 AND symbol=$2',
      [req.wallet.id, from]
    );

    const have = h.rows[0] ? Number(h.rows[0].quantity) : 0;
    if (have <= 0) throw shopFail('This wallet holds none of that asset');

    q = pct === 100 ? have : have * pct / 100;
    got = q * priceFrom * (1 - FEE) / priceTo;

    if (!(got > 0) || !Number.isFinite(got)) throw shopFail('Amount too small to exchange');

    if (pct === 100) {
      await client.query(
        'DELETE FROM wallet_holdings WHERE wallet_id=$1 AND symbol=$2',
        [req.wallet.id, from]
      );
    } else {
      await client.query(`
        UPDATE wallet_holdings SET quantity=quantity-$1
        WHERE wallet_id=$2 AND symbol=$3
      `, [q, req.wallet.id, from]);
    }

    await client.query(`
      INSERT INTO wallet_holdings(wallet_id,symbol,quantity)
      VALUES($1,$2,$3)
      ON CONFLICT(wallet_id,symbol) DO UPDATE SET
        quantity=wallet_holdings.quantity+EXCLUDED.quantity
    `, [req.wallet.id, to, got]);

    await client.query(`
      INSERT INTO wallet_txs(wallet_id,kind,symbol,quantity,coins,note)
      VALUES($1,'swap',$2,$3,0,$4)
    `, [req.wallet.id, from, q, `${to}:${got}`]);
  });

  res.json({
    msg: `Exchanged ${q.toPrecision(5)} ${from} for ${got.toPrecision(5)} ${to}`
  });
}));

app.get('/api/wallet/history', auth, walletAuth, route(async (req, res) => {
  const r = await pool.query(`
    SELECT id, kind, symbol, quantity, coins, note, created_at
    FROM wallet_txs WHERE wallet_id=$1
    ORDER BY id DESC LIMIT 40
  `, [req.wallet.id]);

  res.json({
    txs: r.rows.map(t => ({
      id: Number(t.id),
      kind: t.kind,
      sym: t.symbol,
      qty: Number(t.quantity),
      coins: Number(t.coins),
      note: t.note,
      ts: new Date(t.created_at).toISOString()
    }))
  });
}));

// ---------- Public Data Broker ----------

const BROKER_SECTIONS = {
  profile: { name: 'Identity & Chat',     emoji: '🪪', price: 250,
    desc: 'Royal Chat (Telegram-style) username, online status, last seen, account age.' },
  casino:  { name: 'Casino Balance',      emoji: '🎰', price: 1000,
    desc: 'Current casino balance, leaderboard rank and whether they are mid-game.' },
  trading: { name: 'Trading Portfolio',   emoji: '📈', price: 2500,
    desc: 'Crypto trading positions, total portfolio value and trading activity.' },
  luxury:  { name: 'Luxury Collection',   emoji: '💎', price: 5000,
    desc: 'Every watch, car, mansion and artwork they own in the shop.' },
  wallet:  { name: 'Exodus Wallet',       emoji: '👛', price: 10000,
    desc: 'Linked Exodus wallet balance and holdings per asset (matched by identical name).' }
};
const BROKER_IDS = Object.keys(BROKER_SECTIONS);
const BROKER_BUNDLE_DISCOUNT = 0.25;
const brokerBundleParts = () =>
  BROKER_IDS.map(id => ({ id, price: Math.floor(BROKER_SECTIONS[id].price * (1 - BROKER_BUNDLE_DISCOUNT)) }));
const brokerBundlePrice = () => brokerBundleParts().reduce((s, p) => s + p.price, 0);

const brokerIso = d => (d ? new Date(d).toISOString() : null);

const BROKER_BUILDERS = {
  async profile(c, t) {
    const chat = await c.query(
      'SELECT id, username, last_seen, created_at FROM chat_users WHERE LOWER(username)=LOWER($1)',
      [t.username]
    );
    const u = chat.rows[0];
    return {
      casinoUsername: t.username,
      memberSince: brokerIso(t.created_at),
      chat: u ? {
        username: u.username,
        online: chatOnline(u.id),
        lastSeen: brokerIso(u.last_seen),
        joined: brokerIso(u.created_at)
      } : null
    };
  },

  async casino(c, t) {
    const bal = Number((await c.query('SELECT balance FROM users WHERE id=$1', [t.id])).rows[0].balance);
    const rank = await c.query(
      'SELECT COUNT(*) FILTER (WHERE balance > $1) AS ahead, COUNT(*) AS total FROM users',
      [bal]
    );
    const game = await c.query('SELECT type FROM games WHERE user_id=$1', [t.id]);
    return {
      balance: bal,
      rank: Number(rank.rows[0].ahead) + 1,
      players: Number(rank.rows[0].total),
      activeGame: game.rows[0] ? game.rows[0].type : null
    };
  },

  async trading(c, t) {
    const h = await c.query(
      'SELECT symbol, quantity, cost_basis FROM holdings WHERE user_id=$1 AND quantity > 0',
      [t.id]
    );
    const positions = h.rows
      .filter(r => COINS[r.symbol])
      .map(r => {
        const coin = COINS[r.symbol];
        const qty = Number(r.quantity);
        return {
          sym: r.symbol, name: coin.name, emoji: coin.emoji,
          qty, value: qty * coin.price, cost: Number(r.cost_basis)
        };
      })
      .sort((a, b) => b.value - a.value);
    const tr = await c.query(
      'SELECT COUNT(*) AS n, MAX(created_at) AS last FROM trades WHERE user_id=$1',
      [t.id]
    );
    const orders = await c.query('SELECT COUNT(*) AS n FROM auto_orders WHERE user_id=$1', [t.id]);
    return {
      positions,
      totalValue: positions.reduce((s, p) => s + p.value, 0),
      trades: Number(tr.rows[0].n),
      lastTrade: brokerIso(tr.rows[0].last),
      autoOrders: Number(orders.rows[0].n)
    };
  },

  async luxury(c, t) {
    const r = await c.query('SELECT item_id, price_paid FROM shop_purchases WHERE user_id=$1', [t.id]);
    const items = r.rows
      .filter(x => SHOP_BY_ID.has(x.item_id))
      .map(x => {
        const it = SHOP_BY_ID.get(x.item_id);
        return { name: it.name, emoji: it.emoji, tier: it.tier, paid: Number(x.price_paid) };
      })
      .sort((a, b) => b.paid - a.paid);
    return {
      count: items.length,
      totalPaid: items.reduce((s, i) => s + i.paid, 0),
      items: items.slice(0, 12)
    };
  },

  async wallet(c, t) {
    const w = await c.query('SELECT id, name, created_at FROM wallets WHERE LOWER(name)=LOWER($1)', [t.username]);
    if (!w.rows.length) return { found: false };
    const wallet = w.rows[0];
    const assets = walletAssets(await walletHoldings(c, wallet.id))
      .filter(a => a.qty > 0)
      .map(a => ({ sym: a.sym, name: a.name, glyph: a.glyph, qty: a.qty, value: a.value }))
      .sort((a, b) => b.value - a.value);
    const txs = await c.query('SELECT COUNT(*) AS n FROM wallet_txs WHERE wallet_id=$1', [wallet.id]);
    return {
      found: true,
      walletName: wallet.name,
      created: brokerIso(wallet.created_at),
      total: assets.reduce((s, a) => s + a.value, 0),
      assets,
      transactions: Number(txs.rows[0].n)
    };
  }
};

async function brokerTarget(client, name) {
  if (!validName(name)) return null;
  const r = await client.query(
    'SELECT id, username, created_at FROM users WHERE LOWER(username)=LOWER($1)',
    [name]
  );
  return r.rows[0] || null;
}

const brokerOwned = async (buyerId, targetId) => {
  const r = await pool.query(
    'SELECT section, data, price_paid, purchased_at FROM broker_reports WHERE buyer_id=$1 AND target_id=$2',
    [buyerId, targetId]
  );
  return new Map(r.rows.map(x => [x.section, x]));
};

async function brokerView(buyerId, t) {
  const owned = await brokerOwned(buyerId, t.id);
  return {
    name: t.username,
    sections: BROKER_IDS.map(id => {
      const s = BROKER_SECTIONS[id];
      const o = owned.get(id);
      return {
        id, name: s.name, emoji: s.emoji, desc: s.desc, price: s.price,
        owned: !!o,
        paid: o ? Number(o.price_paid) : null,
        purchasedAt: o ? brokerIso(o.purchased_at) : null,
        data: o ? o.data : null
      };
    })
  };
}

app.get('/api/broker', auth, route(async (req, res) => {
  const uid = req.user.id;
  const mine = await pool.query(`
    SELECT u.username, COUNT(*) AS sections, MAX(r.purchased_at) AS last
    FROM broker_reports r JOIN users u ON u.id = r.target_id
    WHERE r.buyer_id = $1
    GROUP BY u.username ORDER BY MAX(r.purchased_at) DESC LIMIT 50
  `, [uid]);
  const exp = await pool.query(
    'SELECT COALESCE(SUM(buys),0) AS n FROM broker_reports WHERE target_id=$1',
    [uid]
  );

  res.json({
    balance: await getBal(uid),
    sections: BROKER_IDS.map(id => ({ id, ...BROKER_SECTIONS[id] })),
    bundlePrice: brokerBundlePrice(),
    bundleDiscount: BROKER_BUNDLE_DISCOUNT,
    exposure: Number(exp.rows[0].n),
    purchased: mine.rows.map(r => ({
      name: r.username,
      sections: Number(r.sections),
      last: brokerIso(r.last)
    }))
  });
}));

app.get('/api/broker/search', auth, route(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q || q.length > 16) return res.json({ users: [] });
  const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
  const r = await pool.query(`
    SELECT username FROM users
    WHERE id <> $1 AND username ILIKE $2 ESCAPE '\\'
    ORDER BY (LOWER(username) = LOWER($3)) DESC, LOWER(username)
    LIMIT 8
  `, [req.user.id, like, q]);
  res.json({ users: r.rows.map(x => x.username) });
}));

app.get('/api/broker/profile', auth, route(async (req, res) => {
  const t = await brokerTarget(pool, String(req.query.name || ''));
  if (!t) return fail(res, 'Player not found', 404);
  if (t.id === req.user.id) return fail(res, 'You cannot buy a report on yourself');
  res.json({ balance: await getBal(req.user.id), ...(await brokerView(req.user.id, t)) });
}));

app.post('/api/broker/buy', auth, route(async (req, res) => {
  const body = req.body || {};
  const uid = req.user.id;
  const bundle = body.sections === 'all';

  let parts;
  if (bundle) {
    parts = brokerBundleParts();
  } else {
    const ids = Array.isArray(body.sections) ? [...new Set(body.sections.map(String))] : [];
    if (!ids.length || ids.length > BROKER_IDS.length || ids.some(id => !BROKER_SECTIONS[id]))
      return fail(res, 'Choose what to buy');
    parts = ids.map(id => ({ id, price: BROKER_SECTIONS[id].price }));
  }
  const total = parts.reduce((s, p) => s + p.price, 0);

  let target;
  await transaction(async client => {
    target = await brokerTarget(client, String(body.name || ''));
    if (!target) throw shopFail('Player not found', 404);
    if (target.id === uid) throw shopFail('You cannot buy a report on yourself');

    const b = await client.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE', [uid]);
    if (!b.rows.length) throw shopFail('User not found', 404);
    if (Number(b.rows[0].balance) < total) throw shopFail('Not enough balance');

    for (const p of parts) {
      const data = await BROKER_BUILDERS[p.id](client, target);
      await client.query(`
        INSERT INTO broker_reports(buyer_id, target_id, section, price_paid, data)
        VALUES($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT(buyer_id, target_id, section) DO UPDATE SET
          price_paid = EXCLUDED.price_paid,
          data = EXCLUDED.data,
          purchased_at = NOW(),
          buys = broker_reports.buys + 1
      `, [uid, target.id, p.id, p.price, JSON.stringify(data)]);
    }

    await client.query('UPDATE users SET balance=balance-$1 WHERE id=$2', [total, uid]);
  });

  res.json({
    balance: await getBal(uid),
    paid: total,
    msg: `Report on ${target.username} purchased`,
    ...(await brokerView(uid, target))
  });
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

  for (let i = 0; i < HIST; i++) tick(false);

  setInterval(() => tick(), 1000);

  setInterval(() => {
    persistMarket().catch(err => console.error('Market save error:', err));
  }, 5000);

  const selfUrl = process.env.RENDER_EXTERNAL_URL;
  if (selfUrl && typeof fetch === 'function') {
    setInterval(() => {
      fetch(`${selfUrl}/health`).catch(() => {});
    }, 10 * 60 * 1000);
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Casino running on port ${PORT}`));
}

start().catch(err => {
  console.error('Could not start casino:', err);
  process.exit(1);
});