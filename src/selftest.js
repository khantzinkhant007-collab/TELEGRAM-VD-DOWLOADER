'use strict';

const assert = require('assert');
const http = require('http');

process.env.DISABLE_LIVE_EMBED_FETCH = '1';
const app = require('../server');
const { parseEmbedWidgetHtml, isAllowedTelegramCdnUrl } = require('./telegramService');

function request(baseUrl, path, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(url, { method, headers: reqHeaders }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(buffer.toString('utf8'));
        } catch {
          // binary response
        }
        resolve({ status: res.statusCode, headers: res.headers, buffer, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runTests() {
  // 0. Unit-test Telegram Embed Widget HTML Parser & CDN URL Validator
  assert.strictEqual(isAllowedTelegramCdnUrl('https://cdn4.telesco.pe/file/abc123.mp4?token=xyz'), true);
  assert.strictEqual(isAllowedTelegramCdnUrl('https://cdn4.telegram-cdn.org/file/abc123.mp4?token=xyz'), true);
  assert.strictEqual(isAllowedTelegramCdnUrl('//cdn4.telegram-cdn.org/file/abc123.mp4?token=xyz'), true);
  assert.strictEqual(isAllowedTelegramCdnUrl('https://evil.com/file/abc.mp4'), false);

  const sampleEmbedHtml = `
    <div class="tgme_widget_message_owner_name"><span dir="auto">Sample Channel</span></div>
    <div class="tgme_widget_message_grouped_wrap">
      <a class="tgme_widget_message_video_player" href="https://t.me/v131312/7402">
        <i class="tgme_widget_message_video_thumb" style="background-image:url('https://cdn4.telesco.pe/file/thumb1.jpg')"></i>
        <video src="https://cdn4.telesco.pe/file/real_video_7402.mp4?token=1&amp;exp=2"></video>
        <time class="tgme_widget_message_video_duration">01:15</time>
      </a>
      <a class="tgme_widget_message_video_player" href="https://t.me/v131312/7403"></a>
    </div>
    <div class="tgme_widget_message_text">Real Telegram Video Post</div>
  `;
  const parsedEmbed = parseEmbedWidgetHtml(sampleEmbedHtml, 'v131312', '7402');
  assert.strictEqual(parsedEmbed.chatTitle, 'Sample Channel');
  assert.strictEqual(parsedEmbed.caption, 'Real Telegram Video Post');
  assert.strictEqual(parsedEmbed.durationSec, 75);
  assert.strictEqual(parsedEmbed.videoUrls[0], 'https://cdn4.telesco.pe/file/real_video_7402.mp4?token=1&exp=2');
  assert.deepStrictEqual(parsedEmbed.groupedMsgIds, ['7402', '7403']);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Health endpoint
    const health = await request(baseUrl, '/api/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.json.ok, true);
    assert.strictEqual(health.headers['x-content-type-options'], 'nosniff');

    // 2. Auth status & login flow
    const authStatus1 = await request(baseUrl, '/api/auth/status');
    assert.strictEqual(authStatus1.status, 200);
    assert.strictEqual(typeof authStatus1.json.authenticated, 'boolean');

    const authCodeStep = await request(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { apiId: '123456', apiHash: 'abcdef1234567890abcdef', phoneNumber: '+15551234567' }
    });
    assert.strictEqual(authCodeStep.status, 200);
    assert.strictEqual(authCodeStep.json.status, 'code_required');

    const authComplete = await request(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: {
        apiId: '123456',
        apiHash: 'abcdef1234567890abcdef',
        phoneNumber: '+15551234567',
        phoneCode: '54321'
      }
    });
    assert.strictEqual(authComplete.status, 200);
    assert.strictEqual(authComplete.json.status, 'authenticated');
    assert.strictEqual(authComplete.json.authenticated, true);

    // 3. Reject invalid/SSRF URLs on /api/resolve
    for (const badUrl of [
      'https://evil.com/t.me/channel/10',
      'http://127.0.0.1:8080/secret',
      'http://169.254.169.254/latest/meta-data/',
      'javascript:alert(1)',
      'https://t.me/c/notanumber/104'
    ]) {
      const badRes = await request(baseUrl, '/api/resolve', {
        method: 'POST',
        body: { url: badUrl }
      });
      assert.strictEqual(badRes.status, 400, `Expected 400 for bad URL: ${badUrl}`);
    }

    // 4. Resolve Private Channel Link (multi-video album)
    const privRes = await request(baseUrl, '/api/resolve', {
      method: 'POST',
      body: { url: 'https://t.me/c/192837465/104' }
    });
    assert.strictEqual(privRes.status, 200);
    assert.strictEqual(privRes.json.isPrivate, true);
    assert.ok(privRes.json.videoCount > 1, 'Expected multiple videos in media group');
    assert.strictEqual(privRes.json.videos.length, privRes.json.videoCount);

    // 5. Resolve Public Channel Link
    const pubRes = await request(baseUrl, '/api/resolve', {
      method: 'POST',
      body: { url: 'https://t.me/telegram/205' }
    });
    assert.strictEqual(pubRes.status, 200);
    assert.strictEqual(pubRes.json.isPrivate, false);
    assert.ok(pubRes.json.videos.length >= 2);

    // 6. Single video MP4 download + avcC & stco validation + iOS Range 206 support
    const firstVideo = privRes.json.videos[0];
    const dlRes = await request(baseUrl, firstVideo.downloadUrl);
    assert.strictEqual(dlRes.status, 200);
    assert.strictEqual(dlRes.headers['content-type'], 'video/mp4');
    assert.strictEqual(dlRes.buffer.subarray(4, 8).toString('ascii'), 'ftyp');
    assert.ok(dlRes.buffer.includes(Buffer.from('avcC', 'ascii')), 'MP4 must contain avcC box for iOS Safari');
    const stcoIdx = dlRes.buffer.indexOf(Buffer.from('stco', 'ascii'));
    const mdatIdx = dlRes.buffer.indexOf(Buffer.from('mdat', 'ascii'));
    assert.ok(stcoIdx > 0 && mdatIdx > 0, 'MP4 must contain stco and mdat boxes');
    const recordedChunkOffset = dlRes.buffer.readUInt32BE(stcoIdx + 12);
    assert.strictEqual(recordedChunkOffset, mdatIdx + 4, 'stco chunk_offset must point to exact start of mdat payload');

    const rangeRes = await request(baseUrl, `${firstVideo.downloadUrl}&inline=1`, {
      headers: { Range: 'bytes=0-63' }
    });
    assert.strictEqual(rangeRes.status, 206);
    assert.strictEqual(rangeRes.buffer.length, 64);
    assert.ok(rangeRes.headers['content-disposition'].startsWith('inline;'));

    // 7. Batch ZIP download combining videos from both links
    const combinedIds = [
      ...privRes.json.videos.map((v) => v.id),
      ...pubRes.json.videos.map((v) => v.id)
    ];
    const batchRes = await request(baseUrl, '/api/download-batch', {
      method: 'POST',
      body: { videoIds: combinedIds }
    });
    assert.strictEqual(batchRes.status, 200);
    assert.strictEqual(batchRes.headers['content-type'], 'application/zip');
    assert.strictEqual(batchRes.buffer.readUInt32LE(0), 0x04034B50);

    console.log(`All backend self-tests passed (${combinedIds.length} batch videos verified, avcC + stco + Range 206 verified).`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

if (require.main === module) {
  runTests().catch((err) => {
    console.error('Self-test failed:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
