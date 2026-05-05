/**
 * lib/auth.js — password hashing + session signing.
 *
 * Uses Node's built-in crypto (scrypt for passwords, HMAC-SHA256
 * for session tokens). No extra dependencies.
 */

const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST   = 16384;  // 2^14, balanced for serverless cold starts
const SCRYPT_BLOCK  = 8;
const SCRYPT_PAR    = 1;

const SESSION_TTL_DAYS = 30;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

// ────────── Passwords ──────────

function hashPassword(password) {
  if (!password || typeof password !== 'string' || password.length < 6) {
    throw new Error('password must be at least 6 characters');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    cost: SCRYPT_COST, blockSize: SCRYPT_BLOCK, parallelization: SCRYPT_PAR,
  });
  return `s1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(input, stored) {
  try {
    if (!stored || !stored.startsWith('s1$')) return false;
    const [, saltHex, hashHex] = stored.split('$');
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const candidate = crypto.scryptSync(input, salt, SCRYPT_KEYLEN, {
      cost: SCRYPT_COST, blockSize: SCRYPT_BLOCK, parallelization: SCRYPT_PAR,
    });
    return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
  } catch (_) {
    return false;
  }
}

// ────────── Session tokens ──────────

function _secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    // Dev fallback so local boots don't crash. Production MUST set
    // SESSION_SECRET to a long random value.
    return 'dev-only-fallback-secret-set-SESSION_SECRET-in-prod';
  }
  return s;
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify({
    ...payload,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', _secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySession(token) {
  try {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', _secret()).update(body).digest('base64url');
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

// ────────── Cookie helpers ──────────

const COOKIE_NAME = 'algo_member_session';

function buildCookie(token, { secure }) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function clearCookie({ secure }) {
  const attrs = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function readSessionFromReq(req) {
  const raw = req.get('cookie') || '';
  const match = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE_NAME + '='));
  if (!match) return null;
  const token = match.slice(COOKIE_NAME.length + 1);
  return verifySession(token);
}

module.exports = {
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  buildCookie,
  clearCookie,
  readSessionFromReq,
  COOKIE_NAME,
};
