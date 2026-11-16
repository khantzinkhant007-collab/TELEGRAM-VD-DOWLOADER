'use strict';

const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const express = require('express');
const {
  resolveTelegramUrl,
  getAuthStatus,
  handleAuthLogin,
  ensureVideoResolved,
  getVideoBinaryByIdAsync,
  prepareMtprotoVideoStream
} = require('./src/telegramService');
const { sanitizeFileName } = require('./src/mediaBuilder');
const {
  getTelegramSessionCookie,
  setTelegramSessionCookie,
  clearTelegramSessionCookie,
  isTelegramCookieSecretConfigured
} = require('./src/sessionCookies');

const app = express();
app.disable('x-powered-by');

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

// Lightweight in-memory rate limiter for /api/* routes (DoS protection)
const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000;
const maxRequestsPerWindow = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 120;
const clientHits = new Map();

app.use('/api', (req, res, next) => {
  const now = Date.now();
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  let record = clientHits.get(ip);

  if (!record || now - record.start > rateLimitWindowMs) {
    record = { start: now, count: 0 };
    clientHits.set(ip, record);
  }

  record.count += 1;
  const remaining = Math.max(0, maxRequestsPerWindow - record.count);
  res.setHeader('X-RateLimit-Limit', String(maxRequestsPerWindow));
  res.setHeader('X-RateLimit-Remaining', String(remaining));

  if (record.count > maxRequestsPerWindow) {
    return res.status(429).json({
      ok: false,
      error: 'Too many requests. Please wait a moment and try again.'
    });
  }

  if (clientHits.size > 2000) {
    for (const [k, v] of clientHits.entries()) {
      if (now - v.start > rateLimitWindowMs) clientHits.delete(k);
    }
  }

  next();
});

app.use('/api', (req, _res, next) => {
  req.telegramSession = getTelegramSessionCookie(req);
  next();
});

// Strict payload size limits
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

// Serve static frontend assets from public/
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// Optional server-side batch list store (complements frontend localStorage queue)
const serverBatchStore = new Map();
const MAX_BATCH_VIDEOS = Number(process.env.MAX_BATCH_SIZE) || 50;

function getServerBatchStore(sessionContext) {
  const ownerKey = sessionContext?.sessionString
    ? crypto.createHash('sha256').update(sessionContext.sessionString).digest('hex')
    : 'public';
  if (!serverBatchStore.has(ownerKey)) serverBatchStore.set(ownerKey, new Map());
  return serverBatchStore.get(ownerKey);
}

/**
 * 1. Health Check
 */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

/**
 * 2. Telegram Auth Status
 */
app.get('/api/auth/status', async (req, res) => {
  try {
    res.json(await getAuthStatus(req.telegramSession));
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message || 'Failed to read Telegram auth status.' });
  }
});

/**
 * 3. Telegram MTProto Login / Session Management
 */
app.post('/api/auth/login', async (req, res) => {
  try {
    if (req.body?.disconnect !== true && !isTelegramCookieSecretConfigured()) {
      return res.status(503).json({
        ok: false,
        error: 'Set TELEGRAM_COOKIE_SECRET to at least 32 random characters in production before signing in.'
      });
    }
    const result = await handleAuthLogin(req.body || {}, req.telegramSession);
    if (result.sessionContext) {
      setTelegramSessionCookie(res, result.sessionContext);
      const { sessionContext: _sessionContext, ...safeResult } = result;
      return res.json(safeResult);
    }
    if (result.status === 'disconnected') clearTelegramSessionCookie(res);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 400).json({
      ok: false,
      error: err.message || 'Authentication failed.'
    });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const result = await handleAuthLogin({ disconnect: true }, req.telegramSession);
    clearTelegramSessionCookie(res);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 400).json({ ok: false, error: err.message || 'Failed to disconnect Telegram.' });
  }
});

/**
 * 4. Resolve Telegram Video Link (Single Video or Multi-Video Album / Private Link)
 */
app.post('/api/resolve', async (req, res) => {
  try {
    const rawUrl = req.body?.url || req.body?.link;
    const resolved = await resolveTelegramUrl(rawUrl, req.telegramSession);
    res.json(resolved);
  } catch (err) {
    res.status(err.statusCode || 400).json({
      ok: false,
      error: err.message || 'Failed to resolve Telegram video link.'
    });
  }
});

/**
 * Helper to serve a Buffer with full HTTP Range (206 Partial Content) support for iOS Safari / QuickTime.
 */
function sendBufferWithRange(req, res, buffer, safeFileName, isInline) {
  const total = buffer.length;
  const dispositionType = isInline ? 'inline' : 'attachment';

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `${dispositionType}; filename="${safeFileName}"`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');

  const range = req.headers.range;
  if (range && /^bytes=/i.test(range)) {
    const parts = range.replace(/^bytes=/i, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;

    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && end < total) {
      const chunk = buffer.subarray(start, end + 1);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', String(chunk.length));
      return res.status(206).send(chunk);
    }
  }

  res.setHeader('Content-Length', String(total));
  return res.status(200).send(buffer);
}

/**
 * 5. Download or Stream Single Video as Real MP4 Binary
 */
async function handleSingleDownload(req, res) {
  try {
    const rawId = req.query.id || req.params.id;
    const isInline = req.query.inline === '1' || req.query.inline === 'true';
    const resolvedVideo = await ensureVideoResolved(rawId, req.telegramSession);
    if (resolvedVideo.streamSource === 'telegram_mtproto') {
      const download = await prepareMtprotoVideoStream(rawId, req.headers.range || '', req.telegramSession);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `${isInline ? 'inline' : 'attachment'}; filename="${download.fileName}"`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Length', String(download.bytesExpected));
      if (download.partial) {
        res.setHeader('Content-Range', `bytes ${download.start}-${download.end}/${download.total}`);
      }
      const stream = Readable.from(download.stream);
      stream.on('error', (err) => res.destroy(err));
      res.status(download.partial ? 206 : 200);
      return stream.pipe(res);
    }
    const download = await getVideoBinaryByIdAsync(rawId, req.telegramSession);
    return sendBufferWithRange(req, res, download.buffer, sanitizeFileName(download.fileName || download.video.fileName), isInline);
  } catch (err) {
    if (!res.headersSent) {
      res.status(err.statusCode || 400).json({
        ok: false,
        error: err.message || 'Invalid video download request.'
      });
    }
  }
}

app.get('/api/download', handleSingleDownload);
app.get('/api/download/:id', handleSingleDownload);

/**
 * 6. Batch Download All Saved Videos as a Single ZIP Archive
 */
function extractBatchIds(input) {
  const rawList = Array.isArray(input?.videoIds)
    ? input.videoIds
    : Array.isArray(input?.items)
      ? input.items
      : Array.isArray(input?.ids)
        ? input.ids
        : Array.isArray(input?.videos)
          ? input.videos
          : null;

  if (!rawList || rawList.length === 0) {
    const err = new Error('Please provide a non-empty array of videoIds or items to download.');
    err.statusCode = 400;
    throw err;
  }

  if (rawList.length > MAX_BATCH_VIDEOS) {
    const err = new Error(`Batch download is limited to a maximum of ${MAX_BATCH_VIDEOS} videos per archive.`);
    err.statusCode = 400;
    throw err;
  }

  const normalizedIds = [];
  const seen = new Set();

  for (const item of rawList) {
    const id = typeof item === 'string'
      ? item.trim()
      : (item && typeof item === 'object' ? String(item.id || item.videoId || '').trim() : '');
    if (!id) {
      const err = new Error('Each batch item must contain a valid video id.');
      err.statusCode = 400;
      throw err;
    }
    if (!seen.has(id)) {
      seen.add(id);
      normalizedIds.push(id);
    }
  }

  return normalizedIds;
}

async function handleBatchDownload(req, res, idsInput, sessionContext) {
  try {
    const ids = extractBatchIds(idsInput);
    const videos = [];
    for (const id of ids) {
      videos.push(await ensureVideoResolved(id, sessionContext));
    }

    const { ZipArchive } = await import('archiver');
    const archive = new ZipArchive({ store: true, forceZip64: true });
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') archive.emit('error', err);
    });
    archive.on('error', (err) => {
      if (res.headersSent) res.destroy(err);
      else res.status(err.statusCode || 502).json({ ok: false, error: err.message || 'Failed to build batch ZIP archive.' });
    });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="telegram_videos_batch.zip"');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200);
    archive.pipe(res);

    const usedNames = new Set();
    for (const video of videos) {
      let fileName = sanitizeFileName(video.fileName || `telegram_video_${video.id}.mp4`);
      const baseName = fileName.replace(/\.mp4$/i, '');
      let suffix = 2;
      while (usedNames.has(fileName.toLowerCase())) {
        fileName = `${baseName}_${suffix++}.mp4`;
      }
      usedNames.add(fileName.toLowerCase());

      if (video.streamSource === 'telegram_mtproto') {
        const download = await prepareMtprotoVideoStream(video.id, '', sessionContext);
        archive.append(Readable.from(download.stream), { name: fileName });
      } else {
        const download = await getVideoBinaryByIdAsync(video.id, sessionContext);
        archive.append(download.buffer, { name: fileName });
      }
    }
    await archive.finalize();
  } catch (err) {
    if (res.headersSent) res.destroy(err);
    else res.status(err.statusCode || 400).json({
        ok: false,
        error: err.message || 'Failed to build batch ZIP archive.'
      });
  }
}

app.post('/api/download-batch', (req, res) => {
  handleBatchDownload(req, res, req.body || {}, req.telegramSession);
});

app.get('/api/download-batch', (req, res) => {
  const rawIds = typeof req.query.ids === 'string'
    ? req.query.ids.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  handleBatchDownload(req, res, { videoIds: rawIds }, req.telegramSession);
});

/**
 * Optional Server-Side Batch Queue Endpoints (/api/batch)
 */
app.get('/api/batch', (req, res) => {
  const items = Array.from(getServerBatchStore(req.telegramSession).values());
  res.json({
    ok: true,
    count: items.length,
    items
  });
});

app.post('/api/batch', async (req, res) => {
  try {
    const userBatch = getServerBatchStore(req.telegramSession);
    const ids = extractBatchIds(req.body || {});
    for (const id of ids) {
      if (userBatch.size >= MAX_BATCH_VIDEOS && !userBatch.has(id)) {
        break;
      }
      const video = await ensureVideoResolved(id, req.telegramSession);
      userBatch.set(video.id, video);
    }
    const items = Array.from(userBatch.values());
    res.json({
      ok: true,
      count: items.length,
      items
    });
  } catch (err) {
    res.status(err.statusCode || 400).json({
      ok: false,
      error: err.message || 'Failed to save videos to batch queue.'
    });
  }
});

app.delete('/api/batch/:id', (req, res) => {
  const userBatch = getServerBatchStore(req.telegramSession);
  userBatch.delete(req.params.id);
  const items = Array.from(userBatch.values());
  res.json({ ok: true, count: items.length, items });
});

app.delete('/api/batch', (req, res) => {
  getServerBatchStore(req.telegramSession).clear();
  res.json({ ok: true, count: 0, items: [] });
});

// Unknown /api/* route handler
app.use('/api', (req, res) => {
  res.status(404).json({
    ok: false,
    error: `API route not found: ${req.method} ${req.originalUrl}`
  });
});

// SPA fallback for frontend routes
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'), (err) => {
    if (err && !res.headersSent) {
      res.status(404).send('Frontend index.html not found.');
    }
  });
});

// Global error handler (suppresses internal stack traces in responses)
app.use((err, req, res, _next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      ok: false,
      error: 'Request payload too large.'
    });
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      ok: false,
      error: 'Malformed JSON in request body.'
    });
  }
  res.status(500).json({
    ok: false,
    error: 'Internal server error.'
  });
});

// Only start HTTP server when executed directly (compatible with Vercel serverless imports)
if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, () => {
    console.log(`Telegram Video Batch Downloader server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
