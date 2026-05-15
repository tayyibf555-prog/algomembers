/**
 * lib/db.js — Turso (libSQL) for the member portal.
 * Same client pattern as the admin. Schema initialises lazily on
 * first request (idempotent CREATE IF NOT EXISTS).
 */

const { createClient } = require('@libsql/client');

const SCHEMA = [
  // Member accounts. Email is the link to the admin's existing
  // leads/payments/bookings tables — when a member signs up,
  // anything tied to that email automatically appears in their
  // dashboard.
  `CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_members_email ON members(email)`,

  // Curated trading news (admin posts these; member portal reads).
  `CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    category TEXT DEFAULT 'market',
    source_url TEXT DEFAULT '',
    published_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_news_published ON news(published_at)`,

  // Founder announcements (system updates, parameter changes).
  `CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    pinned INTEGER DEFAULT 0,
    published_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_announcements_published ON announcements(published_at)`,

  // Broker account details submitted by the member during onboarding.
  // One row per member, keyed by member_id (UNIQUE). The admin
  // portal reads this table to surface the data in its Members tab.
  // Account numbers are stored in plaintext because the team needs
  // them to set up the TraderPost connection; keep this surface
  // limited to authenticated members + authenticated admin reads.
  `CREATE TABLE IF NOT EXISTS member_broker_details (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER UNIQUE NOT NULL,
    broker_name TEXT DEFAULT '',
    account_number TEXT DEFAULT '',
    account_type TEXT DEFAULT '',
    account_size TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    submitted_at INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_broker_details_member ON member_broker_details(member_id)`,

  // Per-member onboarding progress, keyed by the members.id PK.
  // Auto-created on first member access via INSERT OR IGNORE.
  //
  // The four "active" step columns reflect the current onboarding
  // flow (see ONBOARDING_STEPS in server.js). The six legacy columns
  // above them remain for backward compatibility with rows written
  // by earlier versions of the portal; no read/write path touches
  // them any more.
  `CREATE TABLE IF NOT EXISTS onboarding (
    member_id INTEGER PRIMARY KEY,
    step_tradingview INTEGER DEFAULT 0,
    step_broker INTEGER DEFAULT 0,
    step_risk INTEGER DEFAULT 0,
    step_paper INTEGER DEFAULT 0,
    step_live INTEGER DEFAULT 0,
    step_reports INTEGER DEFAULT 0,
    step_broker_details INTEGER DEFAULT 0,
    step_traderpost INTEGER DEFAULT 0,
    step_subscription INTEGER DEFAULT 0,
    step_strategy_link INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
];

// Idempotent migrations for existing onboarding tables. CREATE TABLE
// IF NOT EXISTS above won't add columns to a table that already
// exists, so we run ALTER TABLE ADD COLUMN for each new column and
// swallow the "duplicate column name" error if it already exists.
const POST_INIT_MIGRATIONS = [
  'ALTER TABLE onboarding ADD COLUMN step_broker_details INTEGER DEFAULT 0',
  'ALTER TABLE onboarding ADD COLUMN step_traderpost     INTEGER DEFAULT 0',
  'ALTER TABLE onboarding ADD COLUMN step_subscription   INTEGER DEFAULT 0',
  'ALTER TABLE onboarding ADD COLUMN step_strategy_link  INTEGER DEFAULT 0',
];

let _client = null;
let _initPromise = null;

function getClient() {
  if (_client) return _client;
  const url = process.env.TURSO_DATABASE_URL || 'file:db/algo-member.db';
  const authToken = process.env.TURSO_AUTH_TOKEN || undefined;
  _client = createClient({ url, authToken, intMode: 'number' });
  return _client;
}

async function ready() {
  if (_initPromise) return _initPromise;
  const client = getClient();
  _initPromise = (async () => {
    for (const stmt of SCHEMA) await client.execute(stmt);
    // Apply column additions idempotently. Each ALTER throws
    // "duplicate column" if the column already exists; we swallow
    // that and rethrow anything else.
    for (const stmt of POST_INIT_MIGRATIONS) {
      try {
        await client.execute(stmt);
      } catch (err) {
        const msg = String(err && err.message).toLowerCase();
        if (!/duplicate column/i.test(msg)) throw err;
      }
    }
  })().catch((err) => {
    _initPromise = null;
    throw err;
  });
  return _initPromise;
}

function _rowToObject(row, columns) {
  const out = {};
  for (let i = 0; i < columns.length; i++) out[columns[i]] = row[i];
  return out;
}

async function run(sql, args = []) {
  await ready();
  const result = await getClient().execute({ sql, args });
  return {
    lastInsertRowid:
      result.lastInsertRowid != null ? Number(result.lastInsertRowid) : null,
    changes: result.rowsAffected,
  };
}
async function get(sql, args = []) {
  await ready();
  const result = await getClient().execute({ sql, args });
  return result.rows.length ? _rowToObject(result.rows[0], result.columns) : null;
}
async function all(sql, args = []) {
  await ready();
  const result = await getClient().execute({ sql, args });
  return result.rows.map((r) => _rowToObject(r, result.columns));
}

module.exports = { ready, run, get, all, getClient };
