/* Algo Members · single-file vanilla JS
   ────────────────────────────────────────
   Auth: cookie-based session (HttpOnly, signed). The server's
   `requireMember` middleware reads the cookie; we never touch
   the cookie value from JS.
   On boot: probe /api/me. 200 → app shell. 401 → auth screen.
   ───────────────────────────────────────── */

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

const fmt = {
  date: ts => {
    if (!ts) return '—';
    const d = new Date(typeof ts === 'string' ? ts : Number(ts));
    if (isNaN(d.getTime())) return '—';
    const sameDay = d.toDateString() === new Date().toDateString();
    if (sameDay) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' · ' +
           d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  },
  ago: ts => {
    if (!ts) return '—';
    const diff = Date.now() - Number(ts);
    const mins = Math.floor(diff / 60000);
    if (mins < 1)   return 'just now';
    if (mins < 60)  return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs  < 24)  return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    if (days < 30)  return days + 'd ago';
    const months = Math.floor(days / 30);
    return months + 'mo ago';
  },
  money: (cents, currency) => {
    if (typeof cents !== 'number') return '—';
    const cur = (currency || 'gbp').toLowerCase();
    const sym = cur === 'gbp' ? '£' : cur === 'usd' ? '$' : cur === 'eur' ? '€' : '';
    const v = (cents / 100).toFixed(2);
    return sym + v.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  },
  esc: str => String(str == null ? '' : str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c])),
};

function setHTML(el, html) { if (el) el.innerHTML = html; }

let currentMember = null;

// ──────────────────────────────────────────────────────────────
// API helper — sends/receives session cookie automatically
// ──────────────────────────────────────────────────────────────
async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign(
    { 'Accept': 'application/json' },
    opts.body ? { 'Content-Type': 'application/json' } : {},
    opts.headers || {}
  );
  const res = await fetch(path, Object.assign({}, opts, { headers, credentials: 'same-origin' }));
  if (res.status === 401 && !opts.allowUnauth) {
    showAuth('Session expired — please sign in again.');
    throw new Error('401 unauthorised');
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
    throw new Error(res.status + ' ' + msg);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.indexOf('application/json') >= 0 ? res.json() : res.text();
}

// ──────────────────────────────────────────────────────────────
// Toast
// ──────────────────────────────────────────────────────────────
let toastTimer;
function toast(message, kind) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.className = 'toast show ' + (kind || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// ──────────────────────────────────────────────────────────────
// Auth screen
// ──────────────────────────────────────────────────────────────
let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  const isLogin = mode === 'login';
  $('#loginForm').hidden = !isLogin;
  $('#signupForm').hidden = isLogin;
  $('#authSubtitle').textContent = isLogin ? 'Member sign-in' : 'Create your account';
  $('#toggleText').textContent = isLogin ? 'No account yet?' : 'Already have an account?';
  $('#toggleAuthBtn').textContent = isLogin ? 'Create one →' : 'Sign in →';
  $('#loginError').textContent = '';
  $('#signupError').textContent = '';
  setTimeout(() => {
    const focusEl = isLogin ? $('#loginEmail') : $('#signupName');
    if (focusEl) focusEl.focus();
  }, 30);
}

function showAuth(errorText) {
  $('#authScreen').setAttribute('aria-hidden', 'false');
  document.body.classList.add('locked');
  if (errorText) {
    if (authMode === 'login') $('#loginError').textContent = errorText;
    else $('#signupError').textContent = errorText;
  }
}
function hideAuth() {
  $('#authScreen').setAttribute('aria-hidden', 'true');
  document.body.classList.remove('locked');
}

// ──────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────
async function boot() {
  try {
    const me = await api('/api/me', { allowUnauth: true });
    onAuthSuccess(me);
  } catch (e) {
    showAuth('');
  }
}

function onAuthSuccess(member) {
  currentMember = member;
  hideAuth();
  // Profile chip
  const initial = (member.name || member.email || '?').trim()[0].toUpperCase();
  $('#profileAvatar').textContent = initial;
  $('#profileName').textContent = member.name || member.email;
  // Boot dashboard
  const initialTab = (location.hash || '#dashboard').replace('#', '');
  const valid = ['dashboard', 'news', 'announcements', 'discord', 'setup', 'account'];
  setTab(valid.indexOf(initialTab) >= 0 ? initialTab : 'dashboard');
}

document.addEventListener('DOMContentLoaded', () => {
  // Toggle login/signup
  $('#toggleAuthBtn').addEventListener('click', () => {
    setAuthMode(authMode === 'login' ? 'signup' : 'login');
  });

  // Login
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#loginError').textContent = '';
    const submit = e.target.querySelector('button[type=submit]');
    submit.disabled = true; submit.textContent = 'Signing in…';
    try {
      const email = $('#loginEmail').value.trim();
      const password = $('#loginPass').value;
      const res = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
        allowUnauth: true,
      });
      onAuthSuccess(res.member);
    } catch (err) {
      $('#loginError').textContent = err.message.replace(/^4\d\d /, '') || 'Sign-in failed.';
    } finally {
      submit.disabled = false; submit.textContent = 'Sign in →';
    }
  });

  // Signup
  $('#signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#signupError').textContent = '';
    const submit = e.target.querySelector('button[type=submit]');
    submit.disabled = true; submit.textContent = 'Creating account…';
    try {
      const name = $('#signupName').value.trim();
      const email = $('#signupEmail').value.trim();
      const password = $('#signupPass').value;
      const res = await api('/api/signup', {
        method: 'POST',
        body: JSON.stringify({ name, email, password }),
        allowUnauth: true,
      });
      onAuthSuccess(res.member);
      toast('Welcome, ' + (res.member.name || 'member') + '!');
    } catch (err) {
      $('#signupError').textContent = err.message.replace(/^4\d\d /, '') || 'Signup failed.';
    } finally {
      submit.disabled = false; submit.textContent = 'Create account →';
    }
  });

  // Sign out
  $('#signOutBtn').addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST', allowUnauth: true });
    } catch (e) {}
    location.reload();
  });

  // "Go to tab" buttons in dashboard cards
  $$('[data-go]').forEach(b => b.addEventListener('click', () => {
    setTab(b.dataset.go);
  }));

  // Tabs
  $$('#tabs .tab').forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));

  boot();
});

// ──────────────────────────────────────────────────────────────
// Tabs
// ──────────────────────────────────────────────────────────────
function setTab(name) {
  $$('#tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  loadPanel(name);
}

async function loadPanel(name) {
  if (name === 'dashboard')     await loadDashboard();
  if (name === 'news')          await loadNews();
  if (name === 'announcements') await loadAnnouncements();
  if (name === 'discord')       loadDiscord();
  if (name === 'setup')         await loadSetup();
  if (name === 'account')       await loadAccount();
}

// ──────────────────────────────────────────────────────────────
// DASHBOARD
// ──────────────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const data = await api('/api/overview');
    paintGreeting(data);
    paintLive(data.system);
    paintInsight(data.insight);
    paintPulse(data.pulse);
    paintDrawdownHeadroom(data.drawdownHeadroom, data.system);
    paintEquityCurve(data.equityCurve);
    paintTodaysThree(data.todaysThree);
  } catch (err) {
    console.error('loadDashboard', err);
    if (typeof toast === 'function') toast('Failed to load dashboard', 'error');
  }
}

function paintGreeting(data) {
  const firstName = ((data.member && data.member.name) || (currentMember && currentMember.name) || '').split(' ')[0];
  const h = new Date().getHours();
  const time =
    h < 5  ? 'Up early' :
    h < 12 ? 'Good morning' :
    h < 17 ? 'Good afternoon' :
    h < 22 ? 'Good evening' : 'Late night';
  const el = $('#ovGreeting');
  if (el) el.textContent = firstName ? (time + ', ' + firstName + '.') : (time + '.');
  const ctx = $('#ovContext');
  if (ctx) {
    const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    ctx.textContent = today + ' · everything you need from one screen.';
  }
}

function paintLive(sys) {
  if (!sys) return;
  const live = $('#ovLive');
  const txt = $('#ovLiveText');
  if (live) live.classList.toggle('closed', !sys.open);
  if (txt) txt.textContent = sys.open ? 'Live' : 'Closed';
}

function paintInsight(insight) {
  if (!insight) return;
  const text = $('#insightText');
  const action = $('#insightAction');
  if (text) text.textContent = insight.text;
  if (action) {
    action.textContent = insight.actionLabel || 'Open';
    action.dataset.targetTab = insight.actionTab || 'dashboard';
    action.onclick = () => {
      if (typeof setTab === 'function') setTab(insight.actionTab || 'dashboard');
    };
  }
}

function paintPulse(pulse) {
  if (!pulse) return;
  const v = $('#pulseValue');
  if (v) v.textContent = String(pulse.score);
  const tk = $('#pulseTakeaway');
  if (tk) {
    if (pulse.score >= 80)      tk.textContent = 'System running clean. All three components are at or near full strength.';
    else if (pulse.score >= 60) tk.textContent = 'Solid. The system is healthy with room to climb on one component below.';
    else if (pulse.score >= 40) tk.textContent = 'Mixed. Worth checking which component is dragging the score down.';
    else                        tk.textContent = 'Pulse is low. Likely markets are closed or the system is paused.';
  }
  const sEl = $('#pulseSystem');
  const wEl = $('#pulseWin');
  const dEl = $('#pulseDd');
  if (sEl) sEl.textContent = (pulse.system   || 0) + ' / 50';
  if (wEl) wEl.textContent = (pulse.winRate  || 0) + ' / 30';
  if (dEl) dEl.textContent = (pulse.drawdown || 0) + ' / 20';

  const hist = (pulse.history || []).slice(-14);
  if (!hist.length) return;
  const W = 200, H = 36, pad = 1;
  const max = 100;
  const stepX = hist.length > 1 ? (W - pad * 2) / (hist.length - 1) : 0;
  const pts = hist.map((y, i) => {
    const x = pad + i * stepX;
    const yy = pad + (1 - y / max) * (H - pad * 2);
    return [x, yy];
  });
  const line = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const fill = line + ' L' + (W - pad).toFixed(1) + ',' + (H - pad).toFixed(1) +
               ' L' + pad.toFixed(1) + ',' + (H - pad).toFixed(1) + ' Z';
  const lineEl = $('#pulseSparkLine');
  const fillEl = $('#pulseSparkFill');
  if (lineEl) lineEl.setAttribute('d', line);
  if (fillEl) fillEl.setAttribute('d', fill);
}

function paintDrawdownHeadroom(headroom, sys) {
  const v = $('#ddhValue');
  const tk = $('#ddhTakeaway');
  if (headroom === null || headroom === undefined) {
    if (v) v.textContent = '—';
    if (tk) tk.textContent = 'No drawdown data available.';
    return;
  }
  if (v) v.textContent = String(headroom);
  if (tk) {
    if (headroom >= 70) {
      tk.textContent = 'Plenty of room. Current drawdown is well inside the configured limits.';
    } else if (headroom >= 40) {
      tk.textContent = 'Moderate room. The system is operating normally with sizing held steady.';
    } else if (headroom >= 20) {
      tk.textContent = 'Tightening. Sizing reduces automatically as drawdown widens to preserve capital.';
    } else {
      tk.textContent = 'Near limits. The system is in capital-preservation mode.';
    }
  }
}

function paintEquityCurve(curve) {
  const lineEl = $('#equityLine');
  const fillEl = $('#equityFill');
  const meta = $('#ecMeta');
  const tk = $('#ecTakeaway');
  if (!lineEl) return;

  if (!curve || !curve.length) {
    if (lineEl) lineEl.setAttribute('d', '');
    if (fillEl) fillEl.setAttribute('d', '');
    if (tk) tk.textContent = 'Waiting on system data.';
    return;
  }

  const startV = curve[0].v;
  const endV   = curve[curve.length - 1].v;
  const pct = startV > 0 ? ((endV - startV) / startV) * 100 : 0;
  if (meta) meta.textContent = 'Verified · since ' +
    new Date(curve[0].t).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  if (tk) {
    tk.textContent = '£' + startV.toLocaleString('en-GB') + ' → £' +
      endV.toLocaleString('en-GB') + ' (+' + pct.toFixed(1) +
      '%) on the published strategy. Your personal account curve will appear once broker integration is connected.';
  }

  // Map points into the SVG's 800×220 canvas
  const W = 800, H = 220, padX = 8, padY = 14;
  const tMin = curve[0].t;
  const tMax = curve[curve.length - 1].t;
  const tSpan = Math.max(1, tMax - tMin);
  const vMin = Math.min.apply(null, curve.map(p => p.v));
  const vMax = Math.max.apply(null, curve.map(p => p.v));
  const vSpan = Math.max(1, vMax - vMin);
  const pts = curve.map(p => {
    const x = padX + ((p.t - tMin) / tSpan) * (W - padX * 2);
    const y = padY + (1 - ((p.v - vMin) / vSpan)) * (H - padY * 2);
    return [x, y];
  });
  let dLine = 'M' + pts[0][0].toFixed(1) + ',' + pts[0][1].toFixed(1);
  for (let i = 1; i < pts.length; i++) {
    dLine += ' L' + pts[i][0].toFixed(1) + ',' + pts[i][1].toFixed(1);
  }
  const dFill = dLine + ' L' + pts[pts.length - 1][0].toFixed(1) + ',' + (H - padY).toFixed(1) +
                ' L' + pts[0][0].toFixed(1) + ',' + (H - padY).toFixed(1) + ' Z';

  lineEl.setAttribute('d', dLine);
  if (fillEl) fillEl.setAttribute('d', dFill);
}

function paintTodaysThree(tasks) {
  const list = $('#todoList');
  if (!list) return;
  if (!tasks || !tasks.length) {
    setHTML(list, '<li class="todo-empty">No items detected.</li>');
    return;
  }
  setHTML(list, tasks.map((t, i) => (
    '<li data-target-tab="' + fmt.esc(t.tab || 'dashboard') + '">' +
      '<span class="todo-num">' + String(i + 1).padStart(2, '0') + '</span>' +
      '<div class="todo-text">' +
        '<div class="todo-action">' + fmt.esc(t.action) + '</div>' +
        '<div class="todo-evidence">' + fmt.esc(t.evidence) + '</div>' +
      '</div>' +
      '<svg class="todo-arrow" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
        '<path d="M5 3 L11 8 L5 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>' +
    '</li>'
  )).join(''));
  list.querySelectorAll('li[data-target-tab]').forEach(li => {
    li.addEventListener('click', () => {
      const t = li.getAttribute('data-target-tab');
      if (t && typeof setTab === 'function') setTab(t);
    });
  });
}

async function loadDashboardSummary() {
  try {
    const data = await api('/api/dashboard');
    const summary = data.summary || {};
    const hasAnyData = !!(data.lead || (data.payments && data.payments.length) || (data.bookings && data.bookings.length));

    if (!hasAnyData) {
      $('#dashboardEmpty').classList.remove('hidden');
      $('#emptyEmail').textContent = currentMember.email || '';
      $$('#dashboardSummary .v').forEach(v => v.textContent = '—');
      $('#kvStatus').textContent = 'New member';
    } else {
      $('#dashboardEmpty').classList.add('hidden');
      $('#kvStatus').innerHTML = renderStatusPill(summary.status);
      $('#kvPaid').textContent = fmt.money(summary.total_paid_pence, summary.currency || 'gbp');
      $('#kvPayments').textContent = String(summary.payments_count || 0);
      $('#kvCalls').textContent = String(summary.upcoming_calls || 0);
      $('#kvNextCall').textContent = summary.next_call_at ? fmt.date(summary.next_call_at) : '—';
    }

    // Activity timeline
    const events = data.events || [];
    if (!events.length) {
      setHTML($('#activityTimeline'), '<div class="muted small">No activity yet. Once your form submission, payment, or booking lands, it shows up here.</div>');
    } else {
      const sorted = events.slice().sort((a, b) => b.created_at - a.created_at).slice(0, 12);
      setHTML($('#activityTimeline'),
        sorted.map(ev => (
          '<div class="timeline-item">' +
            '<div class="when">' + fmt.esc(fmt.date(ev.created_at)) + '</div>' +
            '<div class="what"><span class="type">' + fmt.esc(prettifyEvent(ev.type)) + '</span></div>' +
            (ev.detail ? '<div class="detail">' + fmt.esc(ev.detail) + '</div>' : '') +
          '</div>'
        )).join('')
      );
    }
  } catch (err) {
    console.error('dashboard summary', err);
  }
}

function prettifyEvent(t) {
  switch (t) {
    case 'form_submitted':    return 'Form submitted';
    case 'payment_completed': return 'Payment';
    case 'call_booked':       return 'Call booked';
    case 'status_changed':    return 'Status update';
    case 'lead_deleted':      return 'Record removed';
    default:                  return t || 'event';
  }
}

function renderStatusPill(status) {
  const labels = { new: 'New lead', contacted: 'Contacted', booked: 'Call booked', paid: 'Active member', lost: 'Closed', none: 'No record yet' };
  return fmt.esc(labels[status] || status || 'unknown');
}

async function loadLatestAnnouncement() {
  try {
    const items = await api('/api/announcements');
    const top = items[0];
    if (!top) {
      setHTML($('#latestAnnouncement'), '<div class="muted small">No announcements yet.</div>');
      return;
    }
    setHTML($('#latestAnnouncement'),
      '<div class="ann-meta">' +
        (top.pinned ? '<span class="pinned-tag">Pinned</span>' : '') +
        '<span class="muted">' + fmt.esc(fmt.date(top.published_at)) + '</span>' +
      '</div>' +
      '<h3 style="font-family:var(--font-display);font-weight:600;font-size:1.0625rem;margin-bottom:0.5rem;">' + fmt.esc(top.title) + '</h3>' +
      '<p style="color:var(--ink-soft);font-size:0.9375rem;line-height:1.6;">' + fmt.esc(top.body) + '</p>'
    );
  } catch (err) {
    console.error('latest announcement', err);
  }
}

async function loadDashboardOnboardingMini() {
  try {
    const data = await api('/api/onboarding');
    const total = data.steps.length;
    const done = data.steps.filter(s => s.completed).length;
    const remaining = data.steps.filter(s => !s.completed).slice(0, 3);
    setHTML($('#onboardingMini'),
      '<div class="setup-progress" style="margin-bottom:1rem;">' +
        '<div class="setup-progress-track"><div class="setup-progress-fill" style="width:' + Math.round(done/total*100) + '%"></div></div>' +
        '<span class="setup-progress-label">' + done + ' of ' + total + ' complete</span>' +
      '</div>' +
      (remaining.length === 0
        ? '<div class="muted small">All setup steps complete. The system is configured for your account.</div>'
        : '<ul style="display:flex;flex-direction:column;gap:0.5rem;">' +
          remaining.map(s => '<li style="font-size:0.875rem;color:var(--ink-soft);">→ ' + fmt.esc(s.title) + '</li>').join('') +
          '</ul>'
      )
    );
  } catch (err) {
    console.error('onboarding mini', err);
  }
}

// ──────────────────────────────────────────────────────────────
// NEWS
// ──────────────────────────────────────────────────────────────
async function loadNews() {
  const wrap = $('#newsList');
  setHTML(wrap, '<div class="muted">Loading…</div>');
  try {
    const items = await api('/api/news');
    if (!items.length) { setHTML(wrap, '<div class="muted">No news yet.</div>'); return; }
    setHTML(wrap, items.map(n => (
      '<article class="news-item">' +
        '<div class="news-meta">' +
          '<span class="cat-pill">' + fmt.esc(n.category || 'market') + '</span>' +
          '<span class="muted">' + fmt.esc(fmt.ago(n.published_at)) + '</span>' +
        '</div>' +
        '<h3>' + fmt.esc(n.title) + '</h3>' +
        '<p>' + fmt.esc(n.body) + '</p>' +
      '</article>'
    )).join(''));
  } catch (err) {
    setHTML(wrap, '<div class="muted">Error: ' + fmt.esc(err.message) + '</div>');
  }
}

// ──────────────────────────────────────────────────────────────
// ANNOUNCEMENTS
// ──────────────────────────────────────────────────────────────
async function loadAnnouncements() {
  const wrap = $('#announcementList');
  setHTML(wrap, '<div class="muted">Loading…</div>');
  try {
    const items = await api('/api/announcements');
    if (!items.length) { setHTML(wrap, '<div class="muted">No announcements yet.</div>'); return; }
    setHTML(wrap, items.map(a => (
      '<article class="announcement-item' + (a.pinned ? ' pinned' : '') + '">' +
        '<div class="ann-meta">' +
          (a.pinned ? '<span class="pinned-tag">Pinned</span>' : '') +
          '<span class="muted">' + fmt.esc(fmt.date(a.published_at)) + '</span>' +
        '</div>' +
        '<h3>' + fmt.esc(a.title) + '</h3>' +
        '<p>' + fmt.esc(a.body) + '</p>' +
      '</article>'
    )).join(''));
  } catch (err) {
    setHTML(wrap, '<div class="muted">Error: ' + fmt.esc(err.message) + '</div>');
  }
}

// ──────────────────────────────────────────────────────────────
// DISCORD
// ──────────────────────────────────────────────────────────────
function loadDiscord() {
  const url = currentMember && currentMember.discord_url;
  const btn = $('#discordJoinBtn');
  const note = $('#discordNote');
  if (url) {
    btn.href = url;
    btn.classList.remove('disabled');
    note.classList.add('hidden');
  } else {
    btn.href = '#';
    btn.classList.add('disabled');
    btn.addEventListener('click', e => e.preventDefault(), { once: true });
    note.classList.remove('hidden');
    note.textContent = 'Discord URL not yet configured. The founder will share the invite in your onboarding email.';
  }
}

// ──────────────────────────────────────────────────────────────
// SETUP
// ──────────────────────────────────────────────────────────────
async function loadSetup() {
  const wrap = $('#setupList');
  setHTML(wrap, '<div class="muted">Loading…</div>');
  try {
    const data = await api('/api/onboarding');
    renderSetup(data.steps);
  } catch (err) {
    setHTML(wrap, '<div class="muted">Error: ' + fmt.esc(err.message) + '</div>');
  }
}

function renderSetup(steps) {
  const total = steps.length;
  const done = steps.filter(s => s.completed).length;
  $('#setupProgressFill').style.width = Math.round(done / total * 100) + '%';
  $('#setupProgressLabel').textContent = done + ' of ' + total + ' complete';

  setHTML($('#setupList'), steps.map((s, i) => (
    '<div class="setup-item' + (s.completed ? ' done' : '') + '" data-step="' + s.key + '">' +
      '<span class="step-num">' + String(i + 1).padStart(2, '0') + '</span>' +
      '<div class="step-content">' +
        '<h3>' + fmt.esc(s.title) + '</h3>' +
        '<p>' + fmt.esc(s.detail) + '</p>' +
      '</div>' +
      '<button class="step-toggle" aria-label="Toggle ' + fmt.esc(s.title) + '" type="button">' +
        '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8 L7 12 L13 4"/></svg>' +
      '</button>' +
    '</div>'
  )).join(''));

  $$('#setupList .setup-item').forEach(item => {
    const toggle = item.querySelector('.step-toggle');
    if (!toggle) return;
    const stepKey = item.dataset.step;
    item.addEventListener('click', async (e) => {
      e.preventDefault();
      const isDone = item.classList.contains('done');
      try {
        await api('/api/onboarding', {
          method: 'PATCH',
          body: JSON.stringify({ step: stepKey, completed: !isDone }),
        });
        item.classList.toggle('done');
        const newDone = $$('#setupList .setup-item.done').length;
        $('#setupProgressFill').style.width = Math.round(newDone / total * 100) + '%';
        $('#setupProgressLabel').textContent = newDone + ' of ' + total + ' complete';
      } catch (err) {
        toast('Update failed: ' + err.message, 'error');
      }
    });
  });
}

// ──────────────────────────────────────────────────────────────
// ACCOUNT
// ──────────────────────────────────────────────────────────────
async function loadAccount() {
  $('#acctName').textContent  = currentMember.name || '—';
  $('#acctEmail').textContent = currentMember.email || '—';
  $('#acctSince').textContent = currentMember.created_at ? fmt.date(currentMember.created_at) : '—';
  $('#acctLast').textContent  = currentMember.last_login_at ? fmt.date(currentMember.last_login_at) : '—';

  // Subscription block — pull live from /api/dashboard so it's accurate.
  try {
    const data = await api('/api/dashboard');
    const summary = data.summary || {};
    $('#acctPlan').textContent       = summary.status === 'paid' ? 'Subscription · £1,000/month' : 'No active subscription';
    $('#acctStatus').innerHTML       = renderStatusPill(summary.status);
    $('#acctTotalPaid').textContent  = fmt.money(summary.total_paid_pence || 0, summary.currency || 'gbp');
  } catch (err) {
    /* ignore */
  }

  const billingBtn = $('#billingBtn');
  if (currentMember.billing_url) {
    billingBtn.href = currentMember.billing_url;
    billingBtn.classList.remove('disabled');
    billingBtn.style.opacity = '';
    billingBtn.style.pointerEvents = '';
    billingBtn.title = '';
  } else {
    billingBtn.href = '#';
    billingBtn.style.opacity = '0.5';
    billingBtn.style.pointerEvents = 'none';
    billingBtn.title = 'Billing portal not yet configured';
  }
}
