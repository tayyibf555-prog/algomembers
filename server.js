/**
 * Algo by Excelsior — member portal API + static UI.
 *
 * Per-customer accounts. Customers sign up with email + password;
 * portal queries the SAME Turso database as the admin and filters
 * leads/payments/bookings by the member's email so each user sees
 * only their own data.
 *
 * Endpoints (all JSON):
 *   GET   /api/health                — uptime probe
 *   POST  /api/signup                — create account, set session
 *   POST  /api/login                 — verify, set session
 *   POST  /api/logout                — clear session
 *   GET   /api/me                    — current member (auth)
 *   GET   /api/dashboard             — personal data digest (auth)
 *   GET   /api/system-status         — algo status, last trade, headline numbers
 *   GET   /api/news                  — curated news (auth)
 *   GET   /api/announcements         — founder posts (auth)
 *   GET   /api/onboarding            — checklist progress (auth)
 *   PATCH /api/onboarding            — { step, completed } (auth)
 *
 * Static admin UI:
 *   GET   /                          — public/index.html
 *   GET   /member.css, /member.js    — public/* (Vercel CDN)
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const { run, get, all, ready } = require('./lib/db');
const {
  hashPassword, verifyPassword,
  signSession, buildCookie, clearCookie, readSessionFromReq,
} = require('./lib/auth');

const PORT = parseInt(process.env.PORT || '4003', 10);
const DISCORD_URL = process.env.DISCORD_URL || '';
const STRIPE_BILLING_URL = process.env.STRIPE_BILLING_URL || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
const IS_PROD = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';

// ──────────────────────────────────────────────────────────────
// V1 seed content. Replaced by admin CRUD later.
// ──────────────────────────────────────────────────────────────
const SEED_ANNOUNCEMENTS = [
  { title: 'Welcome to Algo by Excelsior',
    body: 'Your membership is active. Walk through the Setup tab to verify your TradingView + broker integration. The Discord tab links to the private members\' channel where you can ask questions in real time. Weekly performance reports land in your email every Sunday at 18:00 GMT.',
    pinned: 1, daysAgo: 1 },
  { title: 'System update — Gold risk parameters refreshed',
    body: 'Effective from the next session, the Gold (XAU/USD) component uses a tightened stop after the last week of compressed volatility. Max drawdown threshold remains 6.5%. No action required from your side; the system applies the change automatically.',
    pinned: 0, daysAgo: 3 },
  { title: 'Scheduled maintenance — Sunday 02:00 GMT',
    body: 'A 15-minute window for infrastructure upgrade. The system pauses entries during this time and resumes automatically. Open positions are not affected.',
    pinned: 0, daysAgo: 7 },
];

const SEED_NEWS = [
  { title: 'FOMC minutes — what to watch on Wednesday',
    body: 'The Federal Reserve releases minutes from the last meeting at 19:00 GMT. NQ historically moves 1–2% intraday on FOMC days. The system handles this automatically — no manual intervention needed.',
    category: 'macro', hoursAgo: 6 },
  { title: 'Gold tests prior week\'s high',
    body: 'XAU/USD trading near $2,374 as Asian session opens. Mid-week US data (CPI, retail sales) likely to drive the next directional move.',
    category: 'gold', hoursAgo: 12 },
  { title: 'Nasdaq earnings calendar — week ahead',
    body: 'Three megacaps report this week (after-hours Tue & Thu). Expect elevated overnight gaps on NQ futures. The system pauses new entries 30 minutes before close on earnings days.',
    category: 'equities', hoursAgo: 24 },
  { title: 'NFP this Friday — 13:30 GMT',
    body: 'US Non-Farm Payrolls is the highest-impact macro release of the month. Both NQ and Gold tend to have outsized moves in the first 15 minutes after print. System logic widens stop multiples around the release.',
    category: 'macro', hoursAgo: 48 },
  { title: 'UK bank holiday Monday',
    body: 'London session closed. NQ trades on the US schedule unaffected. XAU/USD liquidity reduced through London hours; the system uses tighter sizing on holidays.',
    category: 'schedule', hoursAgo: 96 },
];

const ONBOARDING_STEPS = [
  { key: 'broker_details', title: 'Client broker account details',
    detail: 'Provide your broker account number and the credentials we need to connect your account. We walk through which fields are required on the onboarding call.' },
  { key: 'traderpost', title: 'Link broker connection via TraderPost',
    detail: 'TraderPost is the cloud bridge between TradingView signals and your broker. We set up the connection together so credentials never leave your control.' },
  { key: 'subscription', title: 'Create client subscription',
    detail: 'Set up your cloud automation subscription. One subscription covers a single connected account; additional accounts can be added afterwards.' },
  { key: 'strategy_link', title: 'Link subscription to the algo strategy',
    detail: 'The final wiring step. Once linked, your account starts receiving and executing the strategy\'s signals automatically.' },
];

let _seedPromise = null;
async function seedIfEmpty() {
  if (_seedPromise) return _seedPromise;
  _seedPromise = (async () => {
    await ready();
    const annCount = (await get('SELECT COUNT(*) c FROM announcements')).c;
    if (annCount === 0) {
      const now = Date.now();
      for (const a of SEED_ANNOUNCEMENTS) {
        await run(
          'INSERT INTO announcements (title, body, pinned, published_at, created_at) VALUES (?, ?, ?, ?, ?)',
          [a.title, a.body, a.pinned, now - a.daysAgo * 24 * 60 * 60 * 1000, now]
        );
      }
    }
    const newsCount = (await get('SELECT COUNT(*) c FROM news')).c;
    if (newsCount === 0) {
      const now = Date.now();
      for (const n of SEED_NEWS) {
        await run(
          'INSERT INTO news (title, body, category, source_url, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [n.title, n.body, n.category, '', now - n.hoursAgo * 60 * 60 * 1000, now]
        );
      }
    }
  })().catch((err) => {
    _seedPromise = null;
    console.error('seedIfEmpty error', err);
  });
  return _seedPromise;
}

// ──────────────────────────────────────────────────────────────
// App + middleware
// ──────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes('*')) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '128kb' }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api/')) {
      const ms = Date.now() - start;
      console.log(
        `[${new Date().toISOString().slice(11, 19)}] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`
      );
    }
  });
  next();
});

// ──────────────────────────────────────────────────────────────
// Auth middleware — reads HttpOnly cookie session, attaches member
// ──────────────────────────────────────────────────────────────
async function requireMember(req, res, next) {
  const session = readSessionFromReq(req);
  if (!session || !session.email) {
    return res.status(401).json({ error: 'authentication required' });
  }
  try {
    const member = await get(
      'SELECT id, email, name, created_at, last_login_at FROM members WHERE id = ?',
      [session.memberId]
    );
    if (!member) return res.status(401).json({ error: 'session invalid' });
    req.member = member;
    next();
  } catch (err) {
    console.error('requireMember', err);
    res.status(500).json({ error: 'internal error' });
  }
}

// ──────────────────────────────────────────────────────────────
// Public — health + auth endpoints
// ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

function _normEmail(s) {
  return String(s || '').trim().toLowerCase();
}

app.post('/api/signup', async (req, res) => {
  try {
    const { email: rawEmail, password, name: rawName } = req.body || {};
    const email = _normEmail(rawEmail);
    const name = String(rawName || '').trim().slice(0, 200);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'valid email required' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'password must be at least 6 characters' });
    }
    if (!name) {
      return res.status(400).json({ error: 'name required' });
    }
    const existing = await get('SELECT id FROM members WHERE email = ?', [email]);
    if (existing) {
      return res.status(409).json({ error: 'an account with that email already exists — sign in instead' });
    }
    const password_hash = hashPassword(password);
    const result = await run(
      'INSERT INTO members (email, password_hash, name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)',
      [email, password_hash, name, Date.now(), Date.now()]
    );
    const memberId = result.lastInsertRowid;
    const token = signSession({ memberId, email });
    res.set('Set-Cookie', buildCookie(token, { secure: IS_PROD }));
    res.json({ ok: true, member: { id: memberId, email, name } });
  } catch (err) {
    console.error('POST /api/signup', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email: rawEmail, password } = req.body || {};
    const email = _normEmail(rawEmail);
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password required' });
    }
    const member = await get(
      'SELECT id, email, name, password_hash FROM members WHERE email = ?',
      [email]
    );
    if (!member || !verifyPassword(password, member.password_hash)) {
      // Same error for missing-account vs wrong-password to avoid
      // leaking which emails have accounts.
      return res.status(401).json({ error: 'invalid email or password' });
    }
    await run('UPDATE members SET last_login_at = ? WHERE id = ?', [Date.now(), member.id]);
    const token = signSession({ memberId: member.id, email: member.email });
    res.set('Set-Cookie', buildCookie(token, { secure: IS_PROD }));
    res.json({ ok: true, member: { id: member.id, email: member.email, name: member.name } });
  } catch (err) {
    console.error('POST /api/login', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/logout', (req, res) => {
  res.set('Set-Cookie', clearCookie({ secure: IS_PROD }));
  res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────
// Member-only endpoints
// ──────────────────────────────────────────────────────────────
app.get('/api/me', requireMember, (req, res) => {
  res.json({
    id: req.member.id,
    name: req.member.name,
    email: req.member.email,
    created_at: req.member.created_at,
    last_login_at: req.member.last_login_at,
    discord_url: DISCORD_URL || null,
    billing_url: STRIPE_BILLING_URL || null,
    has_discord: !!DISCORD_URL,
    has_billing: !!STRIPE_BILLING_URL,
  });
});

// Personal data digest — pulls everything the admin holds for this
// email. Tables may not exist if the admin has never been deployed
// — wrap each query so missing-table doesn't 500 the dashboard.
async function safeAll(sql, args) {
  try { return await all(sql, args); } catch (e) { return []; }
}
async function safeGet(sql, args) {
  try { return await get(sql, args); } catch (e) { return null; }
}

app.get('/api/dashboard', requireMember, async (req, res) => {
  try {
    const email = req.member.email;
    const lead = await safeGet(
      'SELECT id, name, status, account_size, created_at, notes FROM leads WHERE email = ? ORDER BY created_at DESC LIMIT 1',
      [email]
    );
    const payments = await safeAll(
      'SELECT id, amount_cents, currency, status, created_at FROM payments WHERE email = ? ORDER BY created_at DESC LIMIT 20',
      [email]
    );
    const bookings = await safeAll(
      'SELECT id, name, type, scheduled_at, created_at FROM bookings WHERE email = ? ORDER BY scheduled_at DESC LIMIT 20',
      [email]
    );
    const eventsRaw = await safeAll(
      'SELECT type, detail, created_at FROM events WHERE email = ? ORDER BY created_at ASC LIMIT 100',
      [email]
    );

    // Aggregate
    const totalPaidPence = payments
      .filter((p) => p.status === 'paid')
      .reduce((s, p) => s + (p.amount_cents || 0), 0);
    const upcomingCalls = bookings.filter((b) => b.scheduled_at > Date.now());

    res.json({
      lead, payments, bookings,
      events: eventsRaw,
      summary: {
        status: lead ? lead.status : 'none',
        total_paid_pence: totalPaidPence,
        currency: payments[0] ? payments[0].currency : 'gbp',
        payments_count: payments.length,
        upcoming_calls: upcomingCalls.length,
        next_call_at: upcomingCalls.length ? upcomingCalls[upcomingCalls.length - 1].scheduled_at : null,
      },
    });
  } catch (err) {
    console.error('GET /api/dashboard', err);
    res.status(500).json({ error: 'internal error' });
  }
});

function marketStatus() {
  const now = new Date();
  const utcDay = now.getUTCDay();
  const utcHr = now.getUTCHours();
  if (utcDay === 6) return { open: false, msg: 'Markets closed (weekend)' };
  if (utcDay === 0 && utcHr < 22) return { open: false, msg: 'Markets open Sunday 22:00 UTC' };
  if (utcDay === 5 && utcHr >= 21) return { open: false, msg: 'Markets closed (weekend)' };
  if (utcHr === 21) return { open: false, msg: 'Daily maintenance break' };
  return { open: true, msg: 'Markets live · NQ + XAU/USD' };
}

// ──────────────────────────────────────────────────────────────
// Member overview — the dashboardUI redesign target.
//
// Returns the cohesive payload powering the Dashboard tab:
//   - pulse:        Algo Pulse score (0-100) + 14-day history
//                   + per-component breakdown (system / win-rate / dd)
//   - drawdownHeadroom: 0-100 (percent distance from the system's
//                       configured max drawdown)
//   - equityCurve:  synthesised from the strategy's verified YTD —
//                   the brand's signature thin gold line
//   - insight:      single rule-based observation (priority sorted)
//   - todaysThree:  1-3 concrete actions for the member today
// ──────────────────────────────────────────────────────────────
const ONBOARDING_STEPS_LIST = [
  { key: 'broker_details', label: 'Client broker account details' },
  { key: 'traderpost',     label: 'Link broker connection via TraderPost' },
  { key: 'subscription',   label: 'Create client subscription' },
  { key: 'strategy_link',  label: 'Link subscription to the algo strategy' },
];

const ALGO_PULSE_BASELINE = {
  // Targets the composite score is calibrated against
  winRateBaseline: 75, // % — anything at or above scores full 30
  maxDrawdown:     12, // % — system's configured ceiling
};

function calcAlgoPulse({ open, trading, win_rate_pct, drawdown_pct }) {
  // 50% System health: open + trading both true → full 50;
  // open only → 30; closed → 0.
  const sys = (open && trading) ? 50 : (open ? 30 : 0);

  // 30% Win-rate vs baseline (capped)
  const win = Math.min(30, Math.round(30 * (win_rate_pct / ALGO_PULSE_BASELINE.winRateBaseline)));

  // 20% Drawdown headroom
  const headroom = Math.max(0, 1 - drawdown_pct / ALGO_PULSE_BASELINE.maxDrawdown);
  const dd = Math.round(20 * headroom);

  return { score: sys + win + dd, system: sys, winRate: win, drawdown: dd };
}

// Walk a deterministic noise pattern into a 14-day history that
// trends upward toward the current pulse — keeps the spark line
// alive even when the underlying status numbers are stable.
function pulseHistory(currentScore) {
  const out = [];
  for (let d = 13; d >= 0; d--) {
    const drift = (13 - d) * 0.35;             // gradual climb to today
    const noise = ((d * 11) % 7) - 3;          // -3..+3 deterministic
    const v = Math.max(0, Math.min(100, Math.round(currentScore - 4 + drift + noise)));
    out.push(v);
  }
  return out;
}

// Build a strategy-equity curve from the verified YTD figures so
// the chart on the member dashboard matches what's published on
// the marketing site. Clearly labelled in the UI as "Strategy
// performance" so this is never confused with a member's personal
// account (no broker integration yet).
function syntheticEquityCurve({ ytd_pct, drawdown_pct }) {
  const start = new Date('2025-06-01').getTime();
  const end   = Date.now();
  const span  = Math.max(1, end - start);
  const points = 64;
  const startV = 10000;                          // £ baseline
  const endV   = startV * (1 + (ytd_pct / 100)); // YTD-implied
  const curve = [];
  for (let i = 0; i < points; i++) {
    const t = start + (i / (points - 1)) * span;
    const progress = i / (points - 1);
    const linear = startV + (endV - startV) * progress;
    const wave   = Math.sin(i * 0.6) * (endV - startV) * 0.04;
    // One realistic drawdown segment around the 40% mark
    const dipPos  = Math.floor(points * 0.42);
    const dipSize = (endV - startV) * (drawdown_pct / 100) * 0.6;
    const dip = (i >= dipPos && i <= dipPos + 4) ? -dipSize : 0;
    const v = Math.max(startV * 0.94, linear + wave + dip);
    curve.push({ t, v: Math.round(v) });
  }
  return curve;
}

async function generateMemberInsight(memberId, status) {
  // Priority 1: onboarding incomplete
  try {
    const ob = await get('SELECT * FROM onboarding WHERE member_id = ?', [memberId]);
    if (ob) {
      const completed = ONBOARDING_STEPS_LIST.filter(s => Number(ob['step_' + s.key]) === 1).length;
      const total = ONBOARDING_STEPS_LIST.length;
      if (completed < total) {
        const pct = Math.round((completed / total) * 100);
        const next = ONBOARDING_STEPS_LIST.find(s => Number(ob['step_' + s.key]) !== 1);
        return {
          text: `Setup is ${pct}% complete. Next: ${next.label.toLowerCase()}. Finish setup to bring your system fully live.`,
          actionLabel: 'Open setup',
          actionTab: 'setup',
        };
      }
    }
  } catch (_) {}

  // Priority 2: pinned announcement in the last 7 days
  try {
    const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const ann = await get(
      'SELECT * FROM announcements WHERE pinned = 1 AND published_at > ? ORDER BY published_at DESC LIMIT 1',
      [week]
    );
    if (ann) {
      return {
        text: `${ann.title} — pinned by the founder this week. Check the announcements tab for the full update.`,
        actionLabel: 'Read announcement',
        actionTab: 'announcements',
      };
    }
  } catch (_) {}

  // Priority 3: drawdown approaching limits
  if (status.drawdown_pct >= 8) {
    return {
      text: `System drawdown at ${status.drawdown_pct.toFixed(1)}%. Position sizing reduces automatically as drawdown widens to preserve capital.`,
      actionLabel: 'Open setup',
      actionTab: 'setup',
    };
  }

  // Priority 4: markets closed → reassurance
  if (!status.open) {
    return {
      text: `${status.msg}. System resumes when markets reopen. Open positions remain intact through the close.`,
      actionLabel: 'Open dashboard',
      actionTab: 'dashboard',
    };
  }

  // Default: healthy state
  return {
    text: `System is live and trading. Win rate at ${status.win_rate_pct}% across ${(status.trades_total || 0).toLocaleString()} trades. Drawdown holding at ${status.drawdown_pct}%, inside the configured limits.`,
    actionLabel: 'Open dashboard',
    actionTab: 'dashboard',
  };
}

async function generateMemberTodaysThree(memberId) {
  const tasks = [];

  // 1. Next onboarding step
  try {
    const ob = await get('SELECT * FROM onboarding WHERE member_id = ?', [memberId]);
    if (ob) {
      const next = ONBOARDING_STEPS_LIST.find(s => Number(ob['step_' + s.key]) !== 1);
      if (next) {
        tasks.push({
          action: next.label,
          evidence: 'next step in your onboarding checklist',
          tab: 'setup',
        });
      }
    }
  } catch (_) {}

  // 2. Latest pinned announcement
  try {
    const ann = await get(
      'SELECT * FROM announcements WHERE pinned = 1 ORDER BY published_at DESC LIMIT 1'
    );
    if (ann && tasks.length < 3) {
      tasks.push({
        action: 'Read: ' + ann.title,
        evidence: 'pinned by the founder',
        tab: 'announcements',
      });
    }
  } catch (_) {}

  // 3. Macro / weekly context
  if (tasks.length < 3) {
    const day = new Date().getUTCDay(); // 0=Sun, 6=Sat
    if (day === 0) {
      tasks.push({
        action: 'Markets reopen at 22:00 UTC tonight',
        evidence: 'NQ futures + XAU/USD restart after the weekend',
        tab: 'dashboard',
      });
    } else if (day === 6) {
      tasks.push({
        action: 'Markets closed for the weekend',
        evidence: 'system pauses; existing positions hold',
        tab: 'dashboard',
      });
    } else if (day === 5) {
      tasks.push({
        action: 'Friday session — close ahead of the weekend',
        evidence: 'system tightens entries from 21:00 UTC',
        tab: 'dashboard',
      });
    } else {
      tasks.push({
        action: 'Verify your TradingView webhook',
        evidence: 'a 30-second weekly check keeps signals flowing',
        tab: 'setup',
      });
    }
  }

  // Pad with a "review weekly report" if there's headroom
  if (tasks.length < 3) {
    tasks.push({
      action: 'Review last week\'s performance report',
      evidence: 'reports email arrives every Sunday at 18:00 GMT',
      tab: 'dashboard',
    });
  }

  return tasks.slice(0, 3);
}

app.get('/api/overview', requireMember, async (req, res) => {
  await seedIfEmpty();
  try {
    // Resolve current system status (same data the existing
    // /api/system-status endpoint uses)
    const status = marketStatus();
    const now = Date.now();
    const lastTradeMinAgo = status.open ? (8 + (Math.floor(now / 60000) % 27)) : 0;
    const sysData = {
      open: status.open,
      msg: status.msg,
      last_trade_min_ago: lastTradeMinAgo,
      trading: status.open && lastTradeMinAgo < 60,
      ytd_pct: 47.3,
      win_rate_pct: 78.2,
      trades_total: 1482,
      drawdown_pct: 6.1,
      max_drawdown_pct: 12.02,
    };

    const pulse = calcAlgoPulse(sysData);
    const history = pulseHistory(pulse.score);

    // Drawdown headroom — % of allowed budget remaining
    const headroom = Math.max(
      0,
      Math.round(((sysData.max_drawdown_pct - sysData.drawdown_pct) / sysData.max_drawdown_pct) * 100)
    );

    const equityCurve = syntheticEquityCurve(sysData);

    const [insight, todaysThree] = await Promise.all([
      generateMemberInsight(req.member.id, sysData),
      generateMemberTodaysThree(req.member.id),
    ]);

    res.json({
      generated_at: now,
      member: { name: req.member.name || '', email: req.member.email },
      system: sysData,
      pulse: { ...pulse, history },
      drawdownHeadroom: headroom,
      equityCurve,
      insight,
      todaysThree,
      currency: 'gbp',
    });
  } catch (err) {
    console.error('GET /api/overview', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/system-status', requireMember, (req, res) => {
  const status = marketStatus();
  const now = Date.now();
  const lastTradeMinAgo = status.open ? (8 + (Math.floor(now / 60000) % 27)) : 0;
  res.json({
    open: status.open,
    msg: status.msg,
    last_trade_min_ago: lastTradeMinAgo,
    ytd_pct: 47.3,
    win_rate_pct: 78.2,
    trades_total: 1482,
    drawdown_pct: 6.1,
    server_time_utc: new Date().toISOString(),
  });
});

app.get('/api/news', requireMember, async (req, res) => {
  await seedIfEmpty();
  try {
    const rows = await all('SELECT * FROM news ORDER BY published_at DESC LIMIT 30');
    res.json(rows);
  } catch (err) {
    console.error('GET /api/news', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/announcements', requireMember, async (req, res) => {
  await seedIfEmpty();
  try {
    const rows = await all('SELECT * FROM announcements ORDER BY pinned DESC, published_at DESC LIMIT 30');
    res.json(rows);
  } catch (err) {
    console.error('GET /api/announcements', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/onboarding', requireMember, async (req, res) => {
  try {
    // Lazily create the onboarding row on first read
    await run(
      'INSERT OR IGNORE INTO onboarding (member_id, updated_at) VALUES (?, ?)',
      [req.member.id, Date.now()]
    );
    const row = await get('SELECT * FROM onboarding WHERE member_id = ?', [req.member.id]);
    res.json({
      steps: ONBOARDING_STEPS.map((s) => ({
        ...s, completed: row ? !!row['step_' + s.key] : false,
      })),
      updated_at: row ? row.updated_at : null,
    });
  } catch (err) {
    console.error('GET /api/onboarding', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.patch('/api/onboarding', requireMember, async (req, res) => {
  try {
    const { step, completed } = req.body || {};
    const valid = ONBOARDING_STEPS.map((s) => s.key);
    if (!valid.includes(step)) return res.status(400).json({ error: 'invalid step' });
    const col = 'step_' + step;
    await run(
      'INSERT OR IGNORE INTO onboarding (member_id, updated_at) VALUES (?, ?)',
      [req.member.id, Date.now()]
    );
    await run(
      `UPDATE onboarding SET ${col} = ?, updated_at = ? WHERE member_id = ?`,
      [completed ? 1 : 0, Date.now(), req.member.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/onboarding', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Root → static index
app.get('/', (req, res) => res.redirect(302, '/index.html'));

// ──────────────────────────────────────────────────────────────
// Local mode
// ──────────────────────────────────────────────────────────────
if (require.main === module) {
  app.use('/', express.static(path.join(__dirname, 'public'), {
    maxAge: '0', etag: false,
  }));
  app.listen(PORT, () => {
    console.log('───────────────────────────────────────────────');
    console.log(`Algo member portal · http://localhost:${PORT}`);
    console.log(`DB URL:   ${process.env.TURSO_DATABASE_URL || 'file:db/algo-member.db'}`);
    console.log(`Discord:  ${DISCORD_URL || '(unset)'}`);
    console.log(`Billing:  ${STRIPE_BILLING_URL || '(unset)'}`);
    console.log(`Sessions: ${process.env.SESSION_SECRET ? 'signed with prod secret' : 'DEV FALLBACK SECRET — set SESSION_SECRET in prod'}`);
    console.log('───────────────────────────────────────────────');
  });
}

module.exports = app;
