'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'telegram_session';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const developmentSecret = process.env.NODE_ENV === 'production' ? '' : crypto.randomBytes(32).toString('hex');

function getCookieKey() {
  const secret = process.env.TELEGRAM_COOKIE_SECRET || developmentSecret;
  if (!secret || secret.length < 32) {
    const err = new Error('Set TELEGRAM_COOKIE_SECRET to at least 32 characters before signing in.');
    err.statusCode = 503;
    throw err;
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function isTelegramCookieSecretConfigured() {
  return process.env.NODE_ENV !== 'production' ||
    (typeof process.env.TELEGRAM_COOKIE_SECRET === 'string' && process.env.TELEGRAM_COOKIE_SECRET.length >= 32);
}

function encodeTelegramSession(session) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getCookieKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(session), 'utf8'),
    cipher.final()
  ]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

function decodeTelegramSession(value) {
  if (typeof value !== 'string' || value.length > 6000) return null;
  const [ivPart, tagPart, encryptedPart] = value.split('.');
  if (!ivPart || !tagPart || !encryptedPart) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', getCookieKey(), Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(encryptedPart, 'base64url')),
      decipher.final()
    ]).toString('utf8');
    const session = JSON.parse(plain);
    if (typeof session.sessionString !== 'string' || typeof session.apiId !== 'string' || typeof session.apiHash !== 'string') return null;
    return session;
  } catch {
    return null;
  }
}

function getTelegramSessionCookie(req) {
  const cookieHeader = req.headers.cookie || '';
  const rawCookie = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!rawCookie) return null;
  return decodeTelegramSession(rawCookie.slice(COOKIE_NAME.length + 1));
}

function setTelegramSessionCookie(res, session) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const value = encodeTelegramSession(session);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Strict${secure}`);
}

function clearTelegramSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`);
}

module.exports = {
  getTelegramSessionCookie,
  setTelegramSessionCookie,
  clearTelegramSessionCookie,
  isTelegramCookieSecretConfigured
};
