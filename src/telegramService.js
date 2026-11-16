'use strict';

const crypto = require('crypto');
const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { Api } = require('teleproto/tl');
const { sanitizeFileName } = require('./mediaBuilder');

const ALLOWED_TELEGRAM_HOSTS = new Set([
  't.me',
  'www.t.me',
  'telegram.me',
  'www.telegram.me',
  'telegram.dog',
  'www.telegram.dog'
]);

const RESERVED_PATH_SEGMENTS = new Set([
  'c',
  's',
  'joinchat',
  'addstickers',
  'addlist',
  'addtheme',
  'proxy',
  'socks',
  'share',
  'iv',
  'login',
  'boost'
]);

const VIDEO_ID_REGEX = /^vid_([a-zA-Z0-9_]{1,64})_(\d{1,20})_(\d{1,2})$/;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

// Bounded in-memory cache of resolved videos (max 1000 items)
const resolvedVideosCache = new Map();
const MAX_CACHE_SIZE = 1000;
const privateChannelCache = new Map();

function cacheVideo(video) {
  if (resolvedVideosCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = resolvedVideosCache.keys().next().value;
    if (oldestKey) resolvedVideosCache.delete(oldestKey);
  }
  resolvedVideosCache.set(video.id, video);
}

function normalizeCdnUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith('//')) {
    return `https:${trimmed}`;
  }
  return trimmed;
}

/**
 * Validates that a scraped CDN video URL belongs strictly to official Telegram CDN domains.
 * Prevents SSRF if upstream HTML ever contained unexpected URLs.
 */
function isAllowedTelegramCdnUrl(rawUrl) {
  const normalized = normalizeCdnUrl(rawUrl);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password || parsed.port) return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'telegram-cdn.org' ||
      host.endsWith('.telegram-cdn.org') ||
      host === 'telesco.pe' ||
      host.endsWith('.telesco.pe') ||
      host === 'cdn-telegram.org' ||
      host.endsWith('.cdn-telegram.org') ||
      host === 'telegram.org' ||
      host.endsWith('.telegram.org') ||
      host === 't.me' ||
      host.endsWith('.t.me')
    );
  } catch {
    return false;
  }
}

// Clients are cached per encrypted browser session, never shared between visitors.
const telegramClientCache = new Map();
const MAX_TELEGRAM_CLIENTS = 20;

function makeTelegramClient(sessionString, apiId, apiHash) {
  const numericApiId = Number(apiId);
  if (!Number.isSafeInteger(numericApiId) || numericApiId <= 0 || !apiHash) {
    const err = new Error('Set a valid Telegram API ID and API Hash in the sign-in form or server environment.');
    err.statusCode = 400;
    throw err;
  }
  return new TelegramClient(new StringSession(sessionString || ''), numericApiId, apiHash, {
    connectionRetries: 3,
    autoReconnect: true
  });
}

function rememberTelegramClient(sessionContext, client) {
  const cacheKey = crypto.createHash('sha256').update(sessionContext.sessionString).digest('hex');
  if (telegramClientCache.size >= MAX_TELEGRAM_CLIENTS && !telegramClientCache.has(cacheKey)) {
    const oldestKey = telegramClientCache.keys().next().value;
    const oldestClient = telegramClientCache.get(oldestKey);
    telegramClientCache.delete(oldestKey);
    oldestClient.disconnect().catch(() => {});
  }
  telegramClientCache.set(cacheKey, client);
}

async function getAuthorizedTelegramClient(sessionContext) {
  if (!sessionContext?.sessionString || !sessionContext?.apiId || !sessionContext?.apiHash) {
    const err = new Error('This browser has no active Telegram session. Sign in to access private videos.');
    err.statusCode = 401;
    throw err;
  }

  const cacheKey = crypto.createHash('sha256').update(sessionContext.sessionString).digest('hex');
  const cached = telegramClientCache.get(cacheKey);
  if (cached && await cached.checkAuthorization()) return cached;
  if (cached) {
    telegramClientCache.delete(cacheKey);
    await cached.disconnect().catch(() => {});
  }

  const client = makeTelegramClient(sessionContext.sessionString, sessionContext.apiId, sessionContext.apiHash);
  await client.connect();
  if (!await client.checkAuthorization()) {
    await client.disconnect();
    const err = new Error('The saved Telegram session is no longer authorized. Connect again.');
    err.statusCode = 401;
    throw err;
  }
  privateChannelCache.clear();
  rememberTelegramClient(sessionContext, client);
  return client;
}

function maskPhone(phone) {
  const clean = String(phone || '').replace(/[^\d+]/g, '');
  if (clean.length <= 4) return '****';
  return `${clean.slice(0, 3)}****${clean.slice(-2)}`;
}

/**
 * Returns current MTProto authentication status without exposing secrets.
 */
async function getAuthStatus(sessionContext) {
  if (!sessionContext) {
    return {
      authenticated: false,
      mode: 'public',
      message: 'Public video links are available. Connect your Telegram account to access private channels you belong to.'
    };
  }
  try {
    const client = await getAuthorizedTelegramClient(sessionContext);
    const user = await client.getMe();
    return {
      authenticated: true,
      mode: 'mtproto',
      user: { username: user.username || 'Telegram account' },
      message: `Connected to Telegram as ${user.username || 'your account'}. Private channels you can access are available.`
    };
  } catch {
    return {
      authenticated: false,
      mode: 'public',
      message: 'Public video links are available. Connect your Telegram account to access private channels you belong to.'
    };
  }
}

/**
 * Handles real MTProto login, session restoration, and disconnect.
 */
async function handleAuthLogin(body = {}, currentSessionContext = null) {
  if (!body || typeof body !== 'object') {
    const err = new Error('Invalid request payload.');
    err.statusCode = 400;
    throw err;
  }

  // 1. Disconnect / Logout
  if (body.disconnect === true || body.action === 'disconnect' || body.action === 'logout') {
    if (currentSessionContext?.sessionString) {
      const cacheKey = crypto.createHash('sha256').update(currentSessionContext.sessionString).digest('hex');
      const client = telegramClientCache.get(cacheKey) || await getAuthorizedTelegramClient(currentSessionContext);
      try { await client.logOut(); } catch { await client.disconnect().catch(() => {}); }
      telegramClientCache.delete(cacheKey);
    }
    privateChannelCache.clear();
    return {
      status: 'disconnected',
      authenticated: false,
      mode: 'public',
      message: 'Telegram MTProto session disconnected.'
    };
  }

  // 2. Validate a saved StringSession.
  const sessionString = typeof body.sessionString === 'string' ? body.sessionString.trim() : '';
  if (sessionString) {
    if (sessionString.length < 8 || sessionString.length > 2048 || /[\r\n<>]/.test(sessionString)) {
      const err = new Error('Invalid sessionString format.');
      err.statusCode = 400;
      throw err;
    }
    const apiId = String(body.apiId || '').trim();
    const apiHash = String(body.apiHash || '').trim();
    const client = makeTelegramClient(sessionString, apiId, apiHash);
    await client.connect();
    if (!await client.checkAuthorization()) {
      await client.disconnect();
      const err = new Error('That Telegram session string is not authorized.');
      err.statusCode = 401;
      throw err;
    }
    const me = await client.getMe();
    privateChannelCache.clear();
    const sessionContext = { sessionString, apiId, apiHash, username: me.username || 'Telegram account' };
    rememberTelegramClient(sessionContext, client);
    return {
      status: 'authenticated',
      authenticated: true,
      mode: 'mtproto',
      user: { username: sessionContext.username },
      sessionContext,
      message: 'Authenticated with Telegram MTProto session string.'
    };
  }

  // 3. Interactive API ID + API Hash + Phone Number flow
  const apiId = String(body.apiId || '').trim();
  const apiHash = String(body.apiHash || '').trim();
  const phoneNumber = String(body.phoneNumber || body.phone || '').trim();
  const phoneCode = String(body.phoneCode || body.code || '').trim();
  const password = String(body.password || '').trim();

  if (!apiId || !/^\d{4,12}$/.test(apiId)) {
    const err = new Error('Valid numeric Telegram apiId (4-12 digits) is required.');
    err.statusCode = 400;
    throw err;
  }

  if (!apiHash || !/^[a-fA-F0-9]{32}$/.test(apiHash)) {
    const err = new Error('A valid 32-character Telegram API Hash is required.');
    err.statusCode = 400;
    throw err;
  }

  if (!phoneNumber || !/^\+?[\d\s()-]{7,20}$/.test(phoneNumber)) {
    const err = new Error('Valid phoneNumber (e.g., +1234567890) is required.');
    err.statusCode = 400;
    throw err;
  }

  const authContext = body.authContext && typeof body.authContext === 'object' ? body.authContext : null;
  if (!phoneCode && !authContext) {
    const client = makeTelegramClient('', apiId, apiHash);
    await client.connect();
    try {
      const { phoneCodeHash, isCodeViaApp } = await client.sendCode({ apiId: Number(apiId), apiHash }, phoneNumber);
      const context = {
        sessionString: client.session.save(),
        phoneCodeHash,
        phoneNumber
      };
      await client.disconnect();
      return {
        status: 'code_required',
        authenticated: false,
        mode: 'public',
        authContext: context,
        message: `Telegram sent a login code to ${maskPhone(phoneNumber)}${isCodeViaApp ? ' in your Telegram app' : ''}. Enter it to continue.`
      };
    } catch (err) {
      await client.disconnect().catch(() => {});
      throw err;
    }
  }

  if (!authContext?.sessionString || !authContext?.phoneCodeHash || authContext.phoneNumber !== phoneNumber) {
    const err = new Error('Login step expired. Start Telegram sign-in again to request a new code.');
    err.statusCode = 400;
    throw err;
  }

  if (phoneCode && !/^\d{4,10}$/.test(phoneCode)) {
    const err = new Error('Enter the verification code shown in Telegram.');
    err.statusCode = 400;
    throw err;
  }

  const client = makeTelegramClient(authContext.sessionString, apiId, apiHash);
  await client.connect();
  try {
    let me;
    if (phoneCode) {
      try {
        const result = await client.invoke(new Api.auth.SignIn({
          phoneNumber,
          phoneCodeHash: authContext.phoneCodeHash,
          phoneCode
        }));
        if (result instanceof Api.auth.AuthorizationSignUpRequired) {
          const err = new Error('This Telegram account needs to finish account registration in an official Telegram app first.');
          err.statusCode = 400;
          throw err;
        }
        me = result.user;
      } catch (err) {
        if (err.errorMessage !== 'SESSION_PASSWORD_NEEDED') throw err;
        if (!password) {
          const savedContext = { ...authContext, sessionString: client.session.save() };
          await client.disconnect();
          return {
            status: 'password_required',
            authenticated: false,
            mode: 'public',
            authContext: savedContext,
            message: 'Enter your Telegram two-step verification password.'
          };
        }
        me = await client.signInWithPassword({ apiId: Number(apiId), apiHash }, {
          password: async () => password
        });
      }
    } else if (password) {
      me = await client.signInWithPassword({ apiId: Number(apiId), apiHash }, {
        password: async () => password
      });
    } else {
      const err = new Error('Enter the Telegram login code or your two-step verification password.');
      err.statusCode = 400;
      throw err;
    }

    privateChannelCache.clear();
    const sessionContext = {
      sessionString: client.session.save(),
      apiId,
      apiHash,
      username: me.username || 'Telegram account'
    };
    rememberTelegramClient(sessionContext, client);
    return {
      status: 'authenticated',
      authenticated: true,
      mode: 'mtproto',
      user: { username: sessionContext.username, phone: maskPhone(phoneNumber) },
      sessionContext,
      message: `Authenticated as ${sessionContext.username} (${maskPhone(phoneNumber)}).`
    };
  } catch (err) {
    await client.disconnect().catch(() => {});
    throw err;
  }
}

/**
 * Strictly validates and parses a Telegram video/post URL.
 * Prevents SSRF, open redirects, path traversal, and non-Telegram URLs.
 */
function parseTelegramUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    const err = new Error('Please provide a Telegram link URL.');
    err.statusCode = 400;
    throw err;
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || trimmed.length > 512) {
    const err = new Error('URL must be between 1 and 512 characters.');
    err.statusCode = 400;
    throw err;
  }

  if (/[\r\n\t<>]/.test(trimmed)) {
    const err = new Error('Invalid characters in Telegram URL.');
    err.statusCode = 400;
    throw err;
  }

  if (trimmed.toLowerCase().startsWith('tg://')) {
    let parsedTg;
    try {
      parsedTg = new URL(trimmed);
    } catch {
      const err = new Error('Malformed tg:// link.');
      err.statusCode = 400;
      throw err;
    }

    const hostAction = (parsedTg.hostname || parsedTg.pathname.replace(/^\/+/, '')).toLowerCase();
    const singleParam = parsedTg.searchParams.get('single') !== null;
    const countParam = Number(parsedTg.searchParams.get('videos') || parsedTg.searchParams.get('count') || 0);

    if (hostAction === 'privatepost') {
      const chatId = parsedTg.searchParams.get('channel') || '';
      const postId = parsedTg.searchParams.get('post') || '';
      if (!/^\d{1,20}$/.test(chatId) || !/^\d{1,20}$/.test(postId) || Number(postId) <= 0) {
        const err = new Error('Invalid tg://privatepost link: numeric channel and post parameters required.');
        err.statusCode = 400;
        throw err;
      }
      return {
        normalizedUrl: `https://t.me/c/${chatId}/${postId}`,
        isPrivate: true,
        chatKey: chatId,
        chatTitle: `Private Channel #${chatId}`,
        messageId: postId,
        forceSingle: singleParam,
        requestedCount: countParam
      };
    }

    if (hostAction === 'resolve') {
      const domain = parsedTg.searchParams.get('domain') || '';
      const postId = parsedTg.searchParams.get('post') || '';
      if (!/^[a-zA-Z0-9_]{3,64}$/.test(domain) || RESERVED_PATH_SEGMENTS.has(domain.toLowerCase())) {
        const err = new Error('Invalid tg://resolve link: valid channel domain required.');
        err.statusCode = 400;
        throw err;
      }
      if (!/^\d{1,20}$/.test(postId) || Number(postId) <= 0) {
        const err = new Error('Invalid tg://resolve link: positive numeric post ID required.');
        err.statusCode = 400;
        throw err;
      }
      return {
        normalizedUrl: `https://t.me/${domain}/${postId}`,
        isPrivate: false,
        chatKey: domain,
        chatTitle: `@${domain}`,
        messageId: postId,
        forceSingle: singleParam,
        requestedCount: countParam
      };
    }

    const err = new Error('Unsupported tg:// link type. Use tg://resolve or tg://privatepost.');
    err.statusCode = 400;
    throw err;
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    const err = new Error('Invalid URL format. Expected https://t.me/<channel>/<msgId> or https://t.me/c/<chatId>/<msgId>.');
    err.statusCode = 400;
    throw err;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    const err = new Error('Only https://t.me, http://t.me, or tg:// protocols are allowed.');
    err.statusCode = 400;
    throw err;
  }

  if (parsed.username || parsed.password || parsed.port) {
    const err = new Error('Telegram URLs must not contain credentials or custom ports.');
    err.statusCode = 400;
    throw err;
  }

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_TELEGRAM_HOSTS.has(host)) {
    const err = new Error('Invalid domain. Only official Telegram links (t.me / telegram.me) are allowed.');
    err.statusCode = 400;
    throw err;
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  const forceSingle = parsed.searchParams.has('single') && parsed.searchParams.get('single') !== '0' && parsed.searchParams.get('single') !== 'false';
  const requestedCount = Number(parsed.searchParams.get('videos') || parsed.searchParams.get('count') || 0);

  if (segments[0] === 'c') {
    if (segments.length !== 3 && segments.length !== 4) {
      const err = new Error('Invalid private Telegram link format. Expected https://t.me/c/<chatId>/<msgId>.');
      err.statusCode = 400;
      throw err;
    }
    const chatId = segments[1];
    const msgId = segments[segments.length - 1];
    if (!/^\d{1,20}$/.test(chatId) || !/^\d{1,20}$/.test(msgId) || Number(msgId) <= 0) {
      const err = new Error('Private link chatId and messageId must be positive numbers.');
      err.statusCode = 400;
      throw err;
    }
    if (segments.length === 4 && !/^\d{1,20}$/.test(segments[2])) {
      const err = new Error('Private link topic/thread ID must be numeric.');
      err.statusCode = 400;
      throw err;
    }
    return {
      normalizedUrl: `https://t.me/c/${chatId}/${msgId}`,
      isPrivate: true,
      chatKey: chatId,
      chatTitle: `Private Channel #${chatId}`,
      messageId: msgId,
      forceSingle,
      requestedCount
    };
  }

  let channelSegment = segments[0];
  let msgSegment = segments[1];
  if (segments[0] === 's' && segments.length === 3) {
    channelSegment = segments[1];
    msgSegment = segments[2];
  } else if (segments.length === 3 && /^\d{1,20}$/.test(segments[1]) && /^\d{1,20}$/.test(segments[2])) {
    channelSegment = segments[0];
    msgSegment = segments[2];
  } else if (segments.length !== 2) {
    const err = new Error('Invalid Telegram post link. Expected https://t.me/<channel>/<msgId> or https://t.me/c/<chatId>/<msgId>.');
    err.statusCode = 400;
    throw err;
  }

  if (!channelSegment || !/^[a-zA-Z0-9_]{3,64}$/.test(channelSegment) || RESERVED_PATH_SEGMENTS.has(channelSegment.toLowerCase())) {
    const err = new Error('Invalid Telegram channel username in URL.');
    err.statusCode = 400;
    throw err;
  }

  if (!msgSegment || !/^\d{1,20}$/.test(msgSegment) || Number(msgSegment) <= 0) {
    const err = new Error('Telegram message ID must be a positive integer.');
    err.statusCode = 400;
    throw err;
  }

  return {
    normalizedUrl: `https://t.me/${channelSegment}/${msgSegment}`,
    isPrivate: false,
    chatKey: channelSegment,
    chatTitle: `@${channelSegment}`,
    messageId: msgSegment,
    forceSingle,
    requestedCount
  };
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseDurationToSeconds(rawDuration) {
  if (!rawDuration || typeof rawDuration !== 'string') return 0;
  const parts = rawDuration.trim().split(':').map((n) => Number(n));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0] || 0;
}

/**
 * Fetches an embed HTML page from https://t.me safely.
 */
async function fetchTelegramHtml(pathnameAndQuery, timeoutMs = 6000) {
  const url = `https://t.me/${pathnameAndQuery.replace(/^\/+/, '')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://t.me/'
      }
    });
    if (!res.ok) return null;
    // Ensure final URL did not redirect outside Telegram
    if (res.url) {
      const finalHost = new URL(res.url).hostname.toLowerCase();
      if (!ALLOWED_TELEGRAM_HOSTS.has(finalHost)) return null;
    }
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extracts video URLs, duration, thumbnail, caption, and grouped album message IDs from Telegram widget HTML.
 */
function parseEmbedWidgetHtml(html, channel, defaultMsgId) {
  if (!html) return null;

  const authorMatch = html.match(/class="tgme_widget_message_owner_name"[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/i);
  const textMatch = html.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const cleanAuthor = authorMatch ? decodeHtmlEntities(authorMatch[1]).trim() : null;
  const cleanCaption = textMatch
    ? decodeHtmlEntities(textMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim().slice(0, 110)
    : null;

  // Extract all <video src="..."> or <source src="...">
  const videoUrls = [];
  const seenUrls = new Set();
  const videoTagRegex = /<(?:video|source)[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let vMatch;
  while ((vMatch = videoTagRegex.exec(html)) !== null) {
    const candidate = normalizeCdnUrl(decodeHtmlEntities(vMatch[1].trim()));
    if (isAllowedTelegramCdnUrl(candidate) && !seenUrls.has(candidate)) {
      seenUrls.add(candidate);
      videoUrls.push(candidate);
    }
  }

  // Extract video duration if present
  const durMatch = html.match(/class="[^"]*tgme_widget_message_video_duration[^"]*"[^>]*>([^<]+)<\/time>/i)
    || html.match(/<time[^>]*class="[^"]*message_video_duration[^"]*"[^>]*>([^<]+)<\/time>/i);
  const durationSec = durMatch ? parseDurationToSeconds(durMatch[1]) : 0;

  // Extract video thumbnail if present
  const thumbMatch = html.match(/tgme_widget_message_video_thumb[^>]+background-image:\s*url\(['"]?([^'")]+)['"]?\)/i);
  const thumbnailUrl = thumbMatch ? normalizeCdnUrl(decodeHtmlEntities(thumbMatch[1].trim())) : null;

  // Extract grouped album message IDs linked inside the message media wrapper
  const groupedMsgIds = new Set();
  const escapedChannel = channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const groupLinkRegex = new RegExp(
    `(?:href=["']https?:\\/\\/t\\.me\\/${escapedChannel}\\/(\\d+)(?:\\?[^"']*)?["']|data-post=["']${escapedChannel}\\/(\\d+)["'])`,
    'gi'
  );
  const baseNum = Number(defaultMsgId);
  const hasGroupedWrap = /tgme_widget_message_grouped/i.test(html);

  let gMatch;
  while ((gMatch = groupLinkRegex.exec(html)) !== null) {
    const idStr = gMatch[1] || gMatch[2];
    const idNum = Number(idStr);
    if (idStr && Number.isFinite(idNum) && Math.abs(idNum - baseNum) <= 12) {
      groupedMsgIds.add(idStr);
    }
  }

  return {
    chatTitle: cleanAuthor || `@${channel}`,
    caption: cleanCaption,
    videoUrls,
    durationSec,
    thumbnailUrl,
    hasGroupedWrap,
    groupedMsgIds: Array.from(groupedMsgIds).sort((a, b) => Number(a) - Number(b))
  };
}

/**
 * Probes the real byte size of a Telegram CDN video URL via HEAD or Range bytes=0-0.
 */
async function probeCdnVideoSize(cdnUrl, timeoutMs = 2500) {
  if (!isAllowedTelegramCdnUrl(cdnUrl)) return 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(cdnUrl, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        'Referer': 'https://t.me/'
      }
    });
    const len = Number(res.headers.get('content-length') || 0);
    if (len > 0) return len;
    return 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Inspects a public Telegram post and extracts all real video CDN URLs
 * (supporting both single-video posts and multi-video media group albums).
 */
async function tryInspectPublicPost(channel, messageId, { forceSingle = false } = {}) {
  if (!/^[a-zA-Z0-9_]{3,64}$/.test(channel) || !/^\d{1,20}$/.test(messageId)) {
    return null;
  }
  if (process.env.DISABLE_LIVE_EMBED_FETCH === '1') {
    return null;
  }

  // 1. Fetch primary embed HTML (without single=1 so we can detect media groups/albums)
  const mainHtml = await fetchTelegramHtml(`${encodeURIComponent(channel)}/${encodeURIComponent(messageId)}?embed=1&mode=tme`);
  const mainParsed = parseEmbedWidgetHtml(mainHtml, channel, messageId);
  if (!mainParsed) return null;

  const discoveredClips = [];
  const seenCdnUrls = new Set();

  // Check if this post is a multi-video media group (album)
  const albumIds = (!forceSingle && mainParsed.groupedMsgIds.length > 1)
    ? mainParsed.groupedMsgIds.slice(0, 10)
    : [String(messageId)];

  if (albumIds.length > 1) {
    // Fetch each album item with ?embed=1&mode=tme&single=1 in parallel to get its dedicated <video src>
    const singleResults = await Promise.all(
      albumIds.map(async (subMsgId) => {
        const subHtml = await fetchTelegramHtml(
          `${encodeURIComponent(channel)}/${encodeURIComponent(subMsgId)}?embed=1&mode=tme&single=1`
        );
        return {
          subMsgId,
          parsed: parseEmbedWidgetHtml(subHtml, channel, subMsgId)
        };
      })
    );

    for (const item of singleResults) {
      if (item.parsed && item.parsed.videoUrls.length > 0) {
        for (const url of item.parsed.videoUrls) {
          if (!seenCdnUrls.has(url)) {
            seenCdnUrls.add(url);
            discoveredClips.push({
              itemMsgId: item.subMsgId,
              cdnUrl: url,
              durationSec: item.parsed.durationSec || mainParsed.durationSec || 30,
              thumbnailUrl: item.parsed.thumbnailUrl || mainParsed.thumbnailUrl || null,
              caption: item.parsed.caption || mainParsed.caption || null
            });
          }
        }
      }
    }
  }

  // If no album clips or if single post, use videoUrls from mainParsed (or try &single=1 fallback)
  if (discoveredClips.length === 0) {
    for (const url of mainParsed.videoUrls) {
      if (!seenCdnUrls.has(url)) {
        seenCdnUrls.add(url);
        discoveredClips.push({
          itemMsgId: String(messageId),
          cdnUrl: url,
          durationSec: mainParsed.durationSec || 30,
          thumbnailUrl: mainParsed.thumbnailUrl || null,
          caption: mainParsed.caption || null
        });
      }
    }
  }

  if (discoveredClips.length === 0) {
    const singleHtml = await fetchTelegramHtml(
      `${encodeURIComponent(channel)}/${encodeURIComponent(messageId)}?embed=1&mode=tme&single=1`
    ) || await fetchTelegramHtml(
      `${encodeURIComponent(channel)}/${encodeURIComponent(messageId)}?embed=1`
    );
    const singleParsed = parseEmbedWidgetHtml(singleHtml, channel, messageId);
    if (singleParsed && singleParsed.videoUrls.length > 0) {
      for (const url of singleParsed.videoUrls) {
        if (!seenCdnUrls.has(url)) {
          seenCdnUrls.add(url);
          discoveredClips.push({
            itemMsgId: String(messageId),
            cdnUrl: url,
            durationSec: singleParsed.durationSec || mainParsed.durationSec || 30,
            thumbnailUrl: singleParsed.thumbnailUrl || mainParsed.thumbnailUrl || null,
            caption: singleParsed.caption || mainParsed.caption || null
          });
        }
      }
    }
  }

  // Fallback: check public channel preview /s/<channel>/<messageId> scoped to target data-post block
  if (discoveredClips.length === 0) {
    const sHtml = await fetchTelegramHtml(`s/${encodeURIComponent(channel)}/${encodeURIComponent(messageId)}`);
    if (sHtml) {
      const escapedPost = `${channel}/${messageId}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const blockRegex = new RegExp(`data-post=["']${escapedPost}["'][\\s\\S]*?(?=data-post=["']|$)`, 'i');
      const blockMatch = sHtml.match(blockRegex);
      if (blockMatch) {
        const sParsed = parseEmbedWidgetHtml(blockMatch[0], channel, messageId);
        if (sParsed && sParsed.videoUrls.length > 0) {
          for (const url of sParsed.videoUrls) {
            if (!seenCdnUrls.has(url)) {
              seenCdnUrls.add(url);
              discoveredClips.push({
                itemMsgId: String(messageId),
                cdnUrl: url,
                durationSec: sParsed.durationSec || mainParsed.durationSec || 30,
                thumbnailUrl: sParsed.thumbnailUrl || mainParsed.thumbnailUrl || null,
                caption: sParsed.caption || mainParsed.caption || null
              });
            }
          }
        }
      }
    }
  }

  // Probe real file sizes in parallel (up to 2.5s timeout)
  if (discoveredClips.length > 0) {
    await Promise.all(
      discoveredClips.map(async (clip) => {
        const bytes = await probeCdnVideoSize(clip.cdnUrl);
        clip.sizeBytes = bytes;
      })
    );
  }

  return {
    chatTitle: mainParsed.chatTitle,
    caption: mainParsed.caption,
    clips: discoveredClips
  };
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  const num = Number(bytes) || 0;
  if (num < 1024 * 1024) {
    return `${Math.max(1, Math.round(num / 1024))} KB`;
  }
  return `${(num / (1024 * 1024)).toFixed(2)} MB`;
}

function toSafeNumber(value) {
  const number = Number(value?.toString?.() ?? value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function getVideoDocument(message) {
  const media = message?.media;
  if (media?.className !== 'MessageMediaDocument' || media.document?.className !== 'Document') return null;
  const document = media.document;
  const videoAttribute = (document.attributes || []).find((attr) => attr.className === 'DocumentAttributeVideo');
  const filenameAttribute = (document.attributes || []).find((attr) => attr.className === 'DocumentAttributeFilename');
  const fileName = filenameAttribute?.fileName || '';
  if (!videoAttribute || !(document.mimeType === 'video/mp4' || /\.mp4$/i.test(fileName))) return null;
  return {
    document,
    fileName,
    duration: Number(videoAttribute.duration) || 0,
    width: Number(videoAttribute.w) || 0,
    height: Number(videoAttribute.h) || 0
  };
}

function getPrivateChannelCacheKey(sessionContext, chatKey) {
  const sessionHash = crypto.createHash('sha256').update(sessionContext.sessionString).digest('hex');
  return `${sessionHash}:${chatKey}`;
}

async function getTelegramChannelEntity(client, chatKey, sessionContext, isPrivate) {
  const cacheKey = getPrivateChannelCacheKey(sessionContext, `${isPrivate ? 'private' : 'public'}:${chatKey}`);
  if (privateChannelCache.has(cacheKey)) return privateChannelCache.get(cacheKey);
  if (isPrivate) {
    const markedId = `-100${chatKey}`;
    // StringSession persists the auth key, not Telegram's access-hash entity cache.
    // Load dialogs so private channel IDs from t.me/c links can be matched safely.
    for await (const dialog of client.iterDialogs({ limit: 5000 })) {
      if (dialog.isChannel && dialog.entity && String(dialog.id) === markedId) {
        if (privateChannelCache.size >= 250) privateChannelCache.delete(privateChannelCache.keys().next().value);
        privateChannelCache.set(cacheKey, dialog.entity);
        return dialog.entity;
      }
    }
    const err = new Error('That private channel was not found in your Telegram dialogs. Confirm that your account has joined it.');
    err.statusCode = 403;
    throw err;
  }

  const entity = await client.getEntity(chatKey);
  if (entity?.className !== 'Channel') {
    const err = new Error('This Telegram link does not point to a channel or supergroup.');
    err.statusCode = 400;
    throw err;
  }
  if (privateChannelCache.size >= 250) privateChannelCache.delete(privateChannelCache.keys().next().value);
  privateChannelCache.set(cacheKey, entity);
  return entity;
}

async function getTelegramPostVideos(chatKey, messageId, sessionContext, isPrivate) {
  const client = await getAuthorizedTelegramClient(sessionContext);
  const messageNumber = Number(messageId);
  if (!Number.isSafeInteger(messageNumber) || messageNumber <= 0) {
    const err = new Error('This Telegram message ID is outside the supported range.');
    err.statusCode = 400;
    throw err;
  }

  const channel = await getTelegramChannelEntity(client, chatKey, sessionContext, isPrivate);
  const result = await client.getMessages(channel, { ids: messageNumber });
  const target = result?.[0];
  if (!target || target.className !== 'Message') {
    const err = new Error('That Telegram post was not found or your account cannot access it.');
    err.statusCode = 404;
    throw err;
  }

  let messages = [target];
  if (target.groupedId) {
    const nearby = await client.getMessages(channel, {
      minId: Math.max(0, messageNumber - 10),
      maxId: messageNumber + 10,
      limit: 20
    });
    const groupId = target.groupedId.toString();
    messages = nearby.filter((message) => message.groupedId?.toString() === groupId);
  }
  messages.sort((a, b) => a.id - b.id);

  const videos = messages.flatMap((message, index) => {
    const info = getVideoDocument(message);
    if (!info) return [];
    const item = buildVideoItem({
      chatKey,
      chatTitle: channel.title || `Private Channel #${chatKey}`,
      messageId: String(message.id),
      index: index + 1,
      isPrivate,
      useMtproto: true,
      caption: message.message || undefined,
      fileName: info.fileName,
      durationSec: info.duration,
      sizeBytes: toSafeNumber(info.document.size),
      resolution: info.width && info.height ? `${info.width}x${info.height}` : 'Unknown'
    });
    cacheVideo(item);
    return [item];
  });

  if (!videos.length) {
    const err = new Error('This Telegram post does not contain an MP4 video.');
    err.statusCode = 415;
    throw err;
  }
  return { channel, target, videos };
}

async function getMtprotoVideoMessage(video, sessionContext) {
  const client = await getAuthorizedTelegramClient(sessionContext);
  const channel = await getTelegramChannelEntity(client, video.chatId, sessionContext, video.isPrivate);
  const result = await client.getMessages(channel, { ids: Number(video.messageId) });
  const message = result?.[0];
  if (!message || !getVideoDocument(message)) {
    const err = new Error('The Telegram video is no longer available to this account.');
    err.statusCode = 404;
    throw err;
  }
  return { client, message, document: getVideoDocument(message).document };
}

async function downloadMtprotoVideo(video, sessionContext) {
  const { client, message } = await getMtprotoVideoMessage(video, sessionContext);
  const buffer = await client.downloadMedia(message, {});
  if (!Buffer.isBuffer(buffer) || !isMp4Buffer(buffer)) {
    const err = new Error('Telegram did not return a valid MP4 video file.');
    err.statusCode = 502;
    throw err;
  }
  return buffer;
}

async function prepareMtprotoVideoStream(rawId, rangeHeader = '', sessionContext) {
  const video = await ensureVideoResolved(rawId, sessionContext);
  if (video.streamSource !== 'telegram_mtproto') {
    const err = new Error('This video is not being served from a Telegram MTProto session.');
    err.statusCode = 400;
    throw err;
  }
  const { client, message, document } = await getMtprotoVideoMessage(video, sessionContext);
  const total = toSafeNumber(document.size);
  if (!total) {
    const err = new Error('Telegram did not provide the video file size.');
    err.statusCode = 502;
    throw err;
  }

  let start = 0;
  let end = total - 1;
  let partial = false;
  if (rangeHeader) {
    const match = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/i);
    if (!match || (!match[1] && !match[2])) {
      const err = new Error('Invalid byte range.');
      err.statusCode = 416;
      throw err;
    }
    if (!match[1]) {
      const suffix = Number(match[2]);
      start = Math.max(0, total - suffix);
    } else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(total - 1, Number(match[2]));
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= total) {
      const err = new Error('Requested byte range is outside this video.');
      err.statusCode = 416;
      throw err;
    }
    partial = true;
  }

  const bytesExpected = end - start + 1;
  const iterator = client.iterDownload(message, {
    offset: start,
    limit: bytesExpected,
    requestSize: 512 * 1024
  });
  const first = await iterator.next();
  if (!first.value || (start === 0 && !isMp4Buffer(first.value))) {
    await iterator.return?.();
    const err = new Error('Telegram did not return a valid MP4 video stream.');
    err.statusCode = 502;
    throw err;
  }

  async function* chunks() {
    let remaining = bytesExpected;
    let chunk = first.value;
    while (chunk && remaining > 0) {
      const output = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      yield output;
      remaining -= output.length;
      if (!remaining) break;
      const next = await iterator.next();
      chunk = next.done ? null : next.value;
    }
    await iterator.return?.();
  }

  return {
    video,
    fileName: sanitizeFileName(video.fileName),
    total,
    start,
    end,
    partial,
    bytesExpected,
    stream: chunks()
  };
}

/**
 * Builds deterministic or live-CDN video item metadata.
 */
function buildVideoItem({
  chatKey,
  chatTitle,
  messageId,
  index,
  isPrivate,
  caption,
  cdnUrl = null,
  durationSec = 0,
  sizeBytes = 0,
  thumbnailUrl = null,
  fileName: sourceFileName = '',
  resolution = 'Unknown',
  useMtproto = false
}) {
  const safeIndex = Math.max(1, Math.min(10, Number(index) || 1));
  const duration = Math.max(0, Number(durationSec) || 0);
  const size = Math.max(0, Number(sizeBytes) || 0);
  const id = `vid_${chatKey}_${messageId}_${safeIndex}`;
  const fileName = sanitizeFileName(sourceFileName || `tg_${chatKey}_${messageId}_${safeIndex}.mp4`);
  const baseTitle = caption
    ? caption
    : `Telegram video ${safeIndex}`;

  return {
    id,
    index: safeIndex,
    title: baseTitle,
    fileName,
    duration,
    durationFormatted: duration > 0 ? formatDuration(duration) : 'Unknown',
    size,
    sizeFormatted: size > 0 ? formatBytes(size) : 'Unknown',
    resolution,
    quality: 'Unknown',
    mimeType: 'video/mp4',
    isPrivate: Boolean(isPrivate),
    chatId: String(chatKey),
    chatTitle: chatTitle || (isPrivate ? `Private Channel #${chatKey}` : `@${chatKey}`),
    messageId: String(messageId),
    sourceUrl: isPrivate ? `https://t.me/c/${chatKey}/${messageId}` : `https://t.me/${chatKey}/${messageId}`,
    downloadUrl: `/api/download?id=${encodeURIComponent(id)}`,
    previewUrl: `/api/download?id=${encodeURIComponent(id)}&inline=1`,
    thumbnailUrl: thumbnailUrl || undefined,
    streamSource: cdnUrl ? 'telegram_cdn' : (isPrivate || useMtproto ? 'telegram_mtproto' : 'demo'),
    isLiveStream: Boolean(cdnUrl),
    cdnUrl: cdnUrl || null
  };
}

/**
 * Resolves a Telegram URL into 1 or more selectable video items.
 * - For real public Telegram posts with embedded videos, returns the exact real Telegram CDN video(s)
 *   (1 video for a single-video post, or N videos for a multi-video media group album).
 * - Links that cannot be resolved to real public video media return a clear error.
 */
async function resolveTelegramUrl(rawUrl, sessionContext) {
  const parsed = parseTelegramUrl(rawUrl);

  if (parsed.isPrivate) {
    const { channel, videos } = await getTelegramPostVideos(parsed.chatKey, parsed.messageId, sessionContext, true);
    return {
      ok: true,
      url: parsed.normalizedUrl,
      isPrivate: true,
      chatId: parsed.chatKey,
      chatTitle: channel.title || `Private Channel #${parsed.chatKey}`,
      messageId: parsed.messageId,
      videoCount: videos.length,
      isAlbum: videos.length > 1,
      streamSource: 'mtproto',
      authMode: 'mtproto',
      authenticated: true,
      videos
    };
  }

  let chatTitle = parsed.chatTitle;
  let caption = null;

  if (!parsed.isPrivate) {
    const livePost = await tryInspectPublicPost(parsed.chatKey, parsed.messageId, {
      forceSingle: parsed.forceSingle
    });

    if (livePost) {
      if (livePost.chatTitle) chatTitle = livePost.chatTitle;
      if (livePost.caption) caption = livePost.caption;

      if (Array.isArray(livePost.clips) && livePost.clips.length > 0) {
        const realVideos = livePost.clips.map((clip, idx) => {
          const video = buildVideoItem({
            chatKey: parsed.chatKey,
            chatTitle,
            messageId: clip.itemMsgId || parsed.messageId,
            index: idx + 1,
            isPrivate: false,
            caption: clip.caption || caption,
            cdnUrl: clip.cdnUrl,
            durationSec: clip.durationSec,
            sizeBytes: clip.sizeBytes,
            thumbnailUrl: clip.thumbnailUrl
          });
          cacheVideo(video);
          return video;
        });

        // Also cache alias under original requested messageId if clip was from a grouped messageId
        if (realVideos[0] && realVideos[0].id !== `vid_${parsed.chatKey}_${parsed.messageId}_1`) {
          resolvedVideosCache.set(`vid_${parsed.chatKey}_${parsed.messageId}_1`, realVideos[0]);
        }

        return {
          ok: true,
          url: parsed.normalizedUrl,
          isPrivate: false,
          chatId: parsed.chatKey,
          chatTitle,
          messageId: parsed.messageId,
          videoCount: realVideos.length,
          isAlbum: realVideos.length > 1,
          streamSource: 'telegram_cdn',
          authMode: 'public',
          authenticated: false,
          videos: realVideos
        };
      }
    }
  }

  if (sessionContext) {
    const { channel, videos } = await getTelegramPostVideos(parsed.chatKey, parsed.messageId, sessionContext, false);
    return {
      ok: true,
      url: parsed.normalizedUrl,
      isPrivate: false,
      chatId: parsed.chatKey,
      chatTitle: channel.title || `@${parsed.chatKey}`,
      messageId: parsed.messageId,
      videoCount: videos.length,
      isAlbum: videos.length > 1,
      streamSource: 'telegram_mtproto',
      authMode: 'mtproto',
      authenticated: true,
      videos
    };
  }

  const err = new Error('No downloadable video was found. Telegram may be blocking this post, or the link may not contain a public video.');
  err.statusCode = 404;
  throw err;
}

/**
 * Synchronously validates a `videoId` and returns cached metadata or minimal metadata for re-resolution.
 */
function getVideoById(rawId) {
  if (!rawId || typeof rawId !== 'string') {
    const err = new Error('Missing video id parameter.');
    err.statusCode = 400;
    throw err;
  }

  const id = rawId.trim();
  const match = id.match(VIDEO_ID_REGEX);
  if (!match) {
    const err = new Error('Invalid video id format.');
    err.statusCode = 400;
    throw err;
  }

  if (resolvedVideosCache.has(id)) {
    return resolvedVideosCache.get(id);
  }

  const [, chatKey, messageId, indexStr] = match;
  const isPrivate = /^\d+$/.test(chatKey);
  const reconstructed = buildVideoItem({
    chatKey,
    chatTitle: isPrivate ? `Private Channel #${chatKey}` : `@${chatKey}`,
    messageId,
    index: Number(indexStr),
    isPrivate
  });
  cacheVideo(reconstructed);
  return reconstructed;
}

/**
 * Ensures that even on a stateless serverless cold start (e.g. Vercel),
 * a public channel `videoId` re-resolves its live Telegram CDN URL before streaming/downloading.
 */
async function ensureVideoResolved(rawId, sessionContext) {
  const baseVideo = getVideoById(rawId);
  if (baseVideo.isPrivate) {
    const { videos } = await getTelegramPostVideos(baseVideo.chatId, baseVideo.messageId, sessionContext, true);
    const exactVideo = videos.find((video) => video.messageId === baseVideo.messageId);
    if (exactVideo) return exactVideo;
    const err = new Error('The requested private Telegram video was not found in that post.');
    err.statusCode = 404;
    throw err;
  }
  if (baseVideo.cdnUrl) {
    return baseVideo;
  }

  if (process.env.DISABLE_LIVE_EMBED_FETCH === '1') {
    const err = new Error('Telegram video lookup is disabled on this server.');
    err.statusCode = 503;
    throw err;
  }

  const match = baseVideo.id.match(VIDEO_ID_REGEX);
  if (!match) return baseVideo;
  const [, chatKey, messageId, indexStr] = match;
  const targetIdx = Math.max(1, Number(indexStr) || 1);

  const livePost = await tryInspectPublicPost(chatKey, messageId);
  if (livePost && Array.isArray(livePost.clips) && livePost.clips.length > 0) {
    const selectedClip = livePost.clips[targetIdx - 1];
    if (!selectedClip) {
      const err = new Error('The requested Telegram video could not be found in this post. Please inspect the link again.');
      err.statusCode = 404;
      throw err;
    }
    const updated = buildVideoItem({
      chatKey,
      chatTitle: livePost.chatTitle,
      messageId,
      index: targetIdx,
      isPrivate: false,
      caption: selectedClip.caption || livePost.caption,
      cdnUrl: selectedClip.cdnUrl,
      durationSec: selectedClip.durationSec,
      sizeBytes: selectedClip.sizeBytes,
      thumbnailUrl: selectedClip.thumbnailUrl
    });
    cacheVideo(updated);
    return updated;
  }

  if (sessionContext) {
    const { videos } = await getTelegramPostVideos(baseVideo.chatId, baseVideo.messageId, sessionContext, false);
    const exactVideo = videos.find((video) => video.messageId === baseVideo.messageId);
    if (exactVideo) return exactVideo;
  }

  const err = new Error('Telegram did not provide a downloadable video for this post. Check that the post is public and still available.');
  err.statusCode = 404;
  throw err;
}

function isMp4Buffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 16 &&
    buffer.toString('ascii', 4, 8) === 'ftyp' &&
    buffer.includes(Buffer.from('mdat', 'ascii'));
}

/**
 * Fetches the full MP4 binary buffer for a videoId from a real Telegram CDN URL.
 */
async function getVideoBinaryByIdAsync(rawId, sessionContext) {
  const video = await ensureVideoResolved(rawId, sessionContext);

  if (video.cdnUrl && isAllowedTelegramCdnUrl(video.cdnUrl)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const cdnRes = await fetch(video.cdnUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': BROWSER_USER_AGENT,
          'Referer': 'https://t.me/'
        }
      });
      if (cdnRes.ok) {
        const arrBuf = await cdnRes.arrayBuffer();
        const buffer = Buffer.from(arrBuf);
        if (isMp4Buffer(buffer)) {
          return {
            video,
            fileName: sanitizeFileName(video.fileName),
            buffer,
            isLiveStream: true
          };
        }
        const err = new Error('Telegram returned data that is not a playable MP4 video. Please try inspecting the link again.');
        err.statusCode = 502;
        throw err;
      }
      const err = new Error(`Telegram video download failed (HTTP ${cdnRes.status}). Please inspect the link again.`);
      err.statusCode = 502;
      throw err;
    } catch {
      const err = new Error('Could not retrieve the real video from Telegram. Please try again later.');
      err.statusCode = 502;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  if (video.streamSource === 'telegram_mtproto') {
    const buffer = await downloadMtprotoVideo(video, sessionContext);
    return {
      video,
      fileName: sanitizeFileName(video.fileName),
      buffer,
      isLiveStream: true
    };
  }

  const err = new Error('No real Telegram video file is available for this link. Inspect a public video post before downloading.');
  err.statusCode = 404;
  throw err;
}

module.exports = {
  parseTelegramUrl,
  parseEmbedWidgetHtml,
  tryInspectPublicPost,
  resolveTelegramUrl,
  getAuthStatus,
  handleAuthLogin,
  getVideoById,
  ensureVideoResolved,
  getVideoBinaryByIdAsync,
  prepareMtprotoVideoStream,
  isAllowedTelegramCdnUrl,
  BROWSER_USER_AGENT,
  VIDEO_ID_REGEX
};
