(() => {
  'use strict';

  const STORAGE_KEY = 'telebatch_saved_videos_v1';

  // Application State
  const state = {
    auth: {
      authenticated: false,
      mode: 'demo_fallback',
      user: null,
      message: '',
      authContext: null
    },
    currentResolved: null,
    selectedVideoIds: new Set(),
    batchQueue: [],
    isResolving: false,
    isDownloadingBatch: false,
    sequentialDownloadItems: null,
    sequentialDownloadIndex: 0
  };

  // DOM Elements
  const els = {
    healthBadge: document.getElementById('healthBadge'),
    healthText: document.getElementById('healthText'),
    authToggleBtn: document.getElementById('authToggleBtn'),
    authModeIndicator: document.getElementById('authModeIndicator'),
    authBtnLabel: document.getElementById('authBtnLabel'),
    authPanel: document.getElementById('authPanel'),
    closeAuthPanelBtn: document.getElementById('closeAuthPanelBtn'),
    authStatusMessage: document.getElementById('authStatusMessage'),
    authForm: document.getElementById('authForm'),
    apiIdInput: document.getElementById('apiIdInput'),
    apiHashInput: document.getElementById('apiHashInput'),
    phoneInput: document.getElementById('phoneInput'),
    sessionStringInput: document.getElementById('sessionStringInput'),
    authVerificationFields: document.getElementById('authVerificationFields'),
    phoneCodeInput: document.getElementById('phoneCodeInput'),
    passwordInput: document.getElementById('passwordInput'),
    authSubmitBtn: document.getElementById('authSubmitBtn'),
    authDisconnectBtn: document.getElementById('authDisconnectBtn'),
    authFeedbackText: document.getElementById('authFeedbackText'),

    stepIndicator1: document.getElementById('stepIndicator1'),
    stepIndicator2: document.getElementById('stepIndicator2'),
    stepIndicator3: document.getElementById('stepIndicator3'),

    resolveForm: document.getElementById('resolveForm'),
    telegramUrlInput: document.getElementById('telegramUrlInput'),
    clearUrlBtn: document.getElementById('clearUrlBtn'),
    inspectBtn: document.getElementById('inspectBtn'),
    inspectBtnText: document.getElementById('inspectBtnText'),
    resolveErrorBox: document.getElementById('resolveErrorBox'),
    sampleLinkBtns: document.querySelectorAll('.sample-link-btn'),

    inspectorSubtitle: document.getElementById('inspectorSubtitle'),
    resolvedMetaBadges: document.getElementById('resolvedMetaBadges'),
    resolvedPrivacyBadge: document.getElementById('resolvedPrivacyBadge'),
    resolvedSourceBadge: document.getElementById('resolvedSourceBadge'),
    resolvedCountBadge: document.getElementById('resolvedCountBadge'),
    inspectorEmptyState: document.getElementById('inspectorEmptyState'),
    inspectorContent: document.getElementById('inspectorContent'),
    selectAllCheckbox: document.getElementById('selectAllCheckbox'),
    selectAllLabelText: document.getElementById('selectAllLabelText'),
    selectAllBtn: document.getElementById('selectAllBtn'),
    selectionSummaryText: document.getElementById('selectionSummaryText'),
    saveSelectedBtn: document.getElementById('saveSelectedBtn'),
    selectAllAndSaveBtn: document.getElementById('selectAllAndSaveBtn'),
    multiVideoNotice: document.getElementById('multiVideoNotice'),
    multiVideoCountSpan: document.getElementById('multiVideoCountSpan'),
    resolvedVideosList: document.getElementById('resolvedVideosList'),

    batchCountPill: document.getElementById('batchCountPill'),
    addAnotherLinkBtn: document.getElementById('addAnotherLinkBtn'),
    clearBatchBtn: document.getElementById('clearBatchBtn'),
    batchStatsBar: document.getElementById('batchStatsBar'),
    statTotalVideos: document.getElementById('statTotalVideos'),
    statTotalLinks: document.getElementById('statTotalLinks'),
    statTotalSize: document.getElementById('statTotalSize'),
    statTotalDuration: document.getElementById('statTotalDuration'),
    downloadAllZipBtn: document.getElementById('downloadAllZipBtn'),
    downloadAllZipText: document.getElementById('downloadAllZipText'),
    downloadAllSequentialBtn: document.getElementById('downloadAllSequentialBtn'),
    downloadAllSeqText: document.getElementById('downloadAllSeqText'),
    batchProgressBox: document.getElementById('batchProgressBox'),
    batchProgressBar: document.getElementById('batchProgressBar'),
    batchProgressText: document.getElementById('batchProgressText'),
    batchNextDownloadBtn: document.getElementById('batchNextDownloadBtn'),
    batchEmptyState: document.getElementById('batchEmptyState'),
    batchItemsList: document.getElementById('batchItemsList'),

    toastContainer: document.getElementById('toastContainer')
  };

  // --- Utility & Security Helpers ---

  function isValidTelegramUrl(rawUrl) {
    if (typeof rawUrl !== 'string') return false;
    const trimmed = rawUrl.trim();
    if (!trimmed || trimmed.length > 512) return false;

    if (/^tg:\/\/(resolve|privatepost)\?/i.test(trimmed)) {
      return true;
    }

    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return false;
      }
      const host = parsed.hostname.toLowerCase();
      const allowedHosts = ['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me', 'telegram.dog'];
      if (!allowedHosts.includes(host)) {
        return false;
      }
      // Match /c/<chatId>/<msgId>, /s/<channel>/<msgId>, or /<channel>/<msgId> (with optional thread id)
      const pathPattern = /^\/(?:c\/[0-9]+\/[0-9]+(?:\/[0-9]+)?|(?:s\/)?[a-zA-Z0-9_]{3,64}\/[0-9]+(?:\/[0-9]+)?)\/?$/;
      return pathPattern.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function sanitizeFileName(name, fallback = 'telegram_video.mp4') {
    if (typeof name !== 'string' || !name.trim()) return fallback;
    const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.mp4$/i, '').slice(0, 110);
    return `${cleaned || 'telegram_video'}.mp4`;
  }

  function getSafeDownloadUrl(video, inline = false) {
    const id = typeof video?.id === 'string' ? video.id.trim() : '';
    let base = `/api/download?id=${encodeURIComponent(id)}`;
    if (typeof video?.downloadUrl === 'string' && video.downloadUrl.startsWith('/api/download')) {
      base = video.downloadUrl;
    }
    if (inline) {
      return base.includes('?') ? `${base}&inline=1` : `${base}?inline=1`;
    }
    return base;
  }

  async function downloadMp4(video) {
    const fileName = sanitizeFileName(video.fileName, `${video.id}.mp4`);
    const response = await fetch(getSafeDownloadUrl(video, false));
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!response.ok || contentType !== 'video/mp4') {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody?.error || `Could not download ${fileName} (HTTP ${response.status}).`);
    }

    const blobUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
  }

  function getSafeThumbnailUrl(video) {
    const raw = video?.thumbnailUrl || video?.thumbUrl || video?.thumbnail || '';
    if (typeof raw !== 'string' || !raw.trim()) return '';
    try {
      const parsed = new URL(raw.trim());
      if (parsed.protocol === 'https:') {
        return parsed.href;
      }
    } catch {
      // Ignore invalid URLs
    }
    return '';
  }

  function getVideoStreamSource(video) {
    if (video?.streamSource === 'telegram_cdn' || video?.streamSource === 'telegram_mtproto' || video?.streamSource === 'mtproto' || video?.streamSource === 'demo') {
      return video.streamSource;
    }
    if (video?.cdnUrl || video?.isLive) {
      return 'telegram_cdn';
    }
    return 'demo';
  }

  function isLiveStreamVideo(video) {
    const src = getVideoStreamSource(video);
    return src === 'telegram_cdn' || src === 'telegram_mtproto' || src === 'mtproto';
  }

  function formatBytes(bytes, isLive = false) {
    const num = Number(bytes);
    if (!Number.isFinite(num) || num <= 0) {
      return 'Unknown size';
    }
    if (num < 1024 * 1024) {
      return `${(num / 1024).toFixed(0)} KB`;
    }
    return `${(num / (1024 * 1024)).toFixed(num < 10 * 1024 * 1024 ? 2 : 1)} MB`;
  }

  function formatDuration(seconds, isLive = false) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    if (total === 0 && isLive) {
      return 'Unknown duration';
    }
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  function showToast(message, type = 'info') {
    if (!els.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = String(message);
    els.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 4200);
  }

  function updateWorkflowStepIndicator() {
    els.stepIndicator1.classList.add('active');
    if (state.currentResolved && Array.isArray(state.currentResolved.videos) && state.currentResolved.videos.length > 0) {
      els.stepIndicator2.classList.add('active');
    } else {
      els.stepIndicator2.classList.remove('active');
    }

    if (state.batchQueue.length > 0) {
      els.stepIndicator3.classList.add('active');
    } else {
      els.stepIndicator3.classList.remove('active');
    }
  }

  // --- Inline Video Preview Builder ---

  function createInlinePreviewControl(video, durSpan, resSpan) {
    const previewContainer = document.createElement('div');
    previewContainer.className = 'inline-preview-box hidden';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn btn-secondary btn-sm';
    toggleBtn.textContent = '▶ Preview';
    toggleBtn.title = 'Play & verify this video right in the page';

    let playerEl = null;

    toggleBtn.addEventListener('click', () => {
      const isHidden = previewContainer.classList.contains('hidden');
      if (isHidden) {
        previewContainer.classList.remove('hidden');
        toggleBtn.textContent = '✕ Close Preview';
        if (!playerEl) {
          playerEl = document.createElement('video');
          playerEl.className = 'inline-video-player';
          playerEl.controls = true;
          playerEl.playsInline = true;
          playerEl.setAttribute('playsinline', '');
          playerEl.setAttribute('webkit-playsinline', '');
          playerEl.preload = 'metadata';
          const poster = getSafeThumbnailUrl(video);
          if (poster) {
            playerEl.poster = poster;
          }
          playerEl.src = getSafeDownloadUrl(video, true);

          playerEl.addEventListener('loadedmetadata', () => {
            if (Number.isFinite(playerEl.duration) && playerEl.duration > 0) {
              video.duration = Math.round(playerEl.duration);
              if (durSpan) {
                durSpan.textContent = `⏱ ${formatDuration(video.duration, isLiveStreamVideo(video))}`;
              }
            }
            if (playerEl.videoWidth > 0 && playerEl.videoHeight > 0) {
              video.resolution = `${playerEl.videoWidth}x${playerEl.videoHeight}`;
              if (resSpan) {
                resSpan.textContent = `🎞 ${video.resolution}`;
              }
            }
          });

          previewContainer.appendChild(playerEl);
        }
        playerEl.play().catch(() => {
          // User can tap play inside native controls if autoplay is blocked
        });
      } else {
        if (playerEl) {
          playerEl.pause();
        }
        previewContainer.classList.add('hidden');
        toggleBtn.textContent = '▶ Preview';
      }
    });

    return { toggleBtn, previewContainer };
  }

  // --- Persistent Batch Storage ---

  function loadBatchFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;

      const validItems = [];
      const seenIds = new Set();
      for (const item of parsed) {
        if (!item || typeof item.id !== 'string' || !item.id.trim()) continue;
        if (!['telegram_cdn', 'telegram_mtproto'].includes(getVideoStreamSource(item))) continue;
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        const savedTitle = String(item.title || 'Telegram Video');
        const isGeneratedTitle = /^Clip \d+ - (Main Recording|Part \d+ -|Bonus Clip)/i.test(savedTitle);
        validItems.push({
          id: String(item.id).slice(0, 120),
          index: Number(item.index) || 1,
          title: (isGeneratedTitle ? `Telegram video ${Number(item.index) || 1}` : savedTitle).slice(0, 200),
          fileName: sanitizeFileName(item.fileName, `${item.id}.mp4`),
          duration: Number(item.duration) || 0,
          size: Number(item.size) || 0,
          resolution: String(item.resolution || 'Unknown').slice(0, 32),
          isPrivate: Boolean(item.isPrivate),
          streamSource: getVideoStreamSource(item),
          thumbnailUrl: getSafeThumbnailUrl(item),
          downloadUrl: getSafeDownloadUrl(item),
          sourceUrl: String(item.sourceUrl || '').slice(0, 300),
          chatTitle: String(item.chatTitle || 'Telegram Chat').slice(0, 140),
          messageId: String(item.messageId || '').slice(0, 40)
        });
      }
      state.batchQueue = validItems;
    } catch {
      state.batchQueue = [];
    }
  }

  function saveBatchToStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.batchQueue));
    } catch {
      // Ignore storage quota errors
    }
  }

  function isVideoInBatch(videoId) {
    return state.batchQueue.some((item) => item.id === videoId);
  }

  // --- API Calls: Health & Auth ---

  async function checkApiHealth() {
    try {
      const res = await fetch('/api/health', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('Health check failed');
      const data = await res.json();
      if (data && data.ok) {
        els.healthBadge.className = 'status-pill status-online';
        els.healthText.textContent = 'Server Online';
      }
    } catch {
      els.healthBadge.className = 'status-pill status-offline';
      els.healthText.textContent = 'API Offline';
    }
  }

  async function fetchAuthStatus() {
    try {
      const res = await fetch('/api/auth/status', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      applyAuthState(data);
    } catch {
      // Keep default status if server is still starting
    }
  }

  function applyAuthState(data) {
    state.auth.authenticated = Boolean(data?.authenticated);
    state.auth.mode = data?.mode || 'demo_fallback';
    state.auth.user = data?.user || null;
    state.auth.message = data?.message || '';

    if (state.auth.authenticated && state.auth.mode === 'mtproto') {
      els.authModeIndicator.className = 'auth-dot auth-live';
      const userLabel = state.auth.user?.username || state.auth.user?.phone || 'Connected';
      els.authBtnLabel.textContent = `MTProto Live (${userLabel})`;
      els.authDisconnectBtn.classList.remove('hidden');
    } else {
      els.authModeIndicator.className = 'auth-dot auth-demo';
      els.authBtnLabel.textContent = 'Connect Telegram for Private Videos';
      els.authDisconnectBtn.classList.add('hidden');
    }

    if (state.auth.message) {
      els.authStatusMessage.textContent = state.auth.message;
    }
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    els.authFeedbackText.textContent = 'Connecting to Telegram...';
    els.authSubmitBtn.disabled = true;

    const payload = {
      apiId: els.apiIdInput.value.trim(),
      apiHash: els.apiHashInput.value.trim(),
      phoneNumber: els.phoneInput.value.trim(),
      phoneCode: els.phoneCodeInput.value.trim(),
      password: els.passwordInput.value,
      sessionString: els.sessionStringInput.value.trim(),
      authContext: state.auth.authContext
    };

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (!res.ok) {
        els.authFeedbackText.textContent = data?.error || data?.message || 'Authentication failed.';
        showToast(els.authFeedbackText.textContent, 'error');
        return;
      }

      els.authFeedbackText.textContent = data?.message || `Status: ${data?.status}`;

      if (data.status === 'code_required' || data.status === 'password_required') {
        state.auth.authContext = data.authContext || state.auth.authContext;
        els.authVerificationFields.classList.remove('hidden');
        showToast(data.message || 'Verification code or 2FA password required.', 'info');
      } else if (data.status === 'authenticated') {
        state.auth.authContext = null;
        els.apiHashInput.value = '';
        els.passwordInput.value = '';
        els.sessionStringInput.value = '';
        els.phoneCodeInput.value = '';
        els.authVerificationFields.classList.add('hidden');
        els.authFeedbackText.textContent = `${data.message} This browser is signed in with a protected session cookie.`;
        showToast('Telegram MTProto session connected!', 'success');
        applyAuthState(data);
      }
    } catch {
      els.authFeedbackText.textContent = 'Network error while connecting session.';
    } finally {
      els.authSubmitBtn.disabled = false;
    }
  }

  async function handleAuthDisconnect() {
    els.authDisconnectBtn.disabled = true;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ disconnect: true })
      });
      const data = await res.json();
      els.authFeedbackText.textContent = data?.message || 'Session disconnected.';
      state.auth.authContext = null;
      els.sessionStringInput.value = '';
      showToast('Disconnected Telegram MTProto session.', 'info');
      await fetchAuthStatus();
    } catch {
      showToast('Failed to disconnect session.', 'error');
    } finally {
      els.authDisconnectBtn.disabled = false;
    }
  }

  // --- Step 1 & Step 2: Resolve Link & Multi-Video Selection ---

  function showResolveError(msg) {
    if (!msg) {
      els.resolveErrorBox.textContent = '';
      els.resolveErrorBox.classList.add('hidden');
      return;
    }
    els.resolveErrorBox.textContent = String(msg);
    els.resolveErrorBox.classList.remove('hidden');
  }

  async function resolveTelegramUrl(rawUrl) {
    const url = rawUrl.trim();
    showResolveError('');

    if (!url) {
      showResolveError('Please paste a Telegram video link (e.g. https://t.me/v131312/7402 or https://t.me/c/192837465/104).');
      els.telegramUrlInput.focus();
      return;
    }

    if (!isValidTelegramUrl(url)) {
      showResolveError('Invalid Telegram link format. Supported formats: https://t.me/<channel>/<msgId> or https://t.me/c/<chatId>/<msgId>.');
      return;
    }

    state.isResolving = true;
    els.inspectBtn.disabled = true;
    els.inspectBtnText.textContent = 'Inspecting...';

    try {
      const res = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const errMessage = data?.error || data?.message || `Failed to inspect link (HTTP ${res.status}).`;
        showResolveError(errMessage);
        showToast(errMessage, 'error');
        return;
      }

      const videos = Array.isArray(data.videos) ? data.videos : [];
      state.currentResolved = {
        url: data.url || url,
        isPrivate: Boolean(data.isPrivate),
        chatTitle: data.chatTitle || (data.isPrivate ? 'Private Telegram Chat' : 'Public Telegram Channel'),
        messageId: String(data.messageId || ''),
        videoCount: Number(data.videoCount) || videos.length,
        streamSource: data.streamSource || (videos[0] ? getVideoStreamSource(videos[0]) : 'demo'),
        videos
      };

      // Select all videos by default when resolved so user can immediately save or customize
      state.selectedVideoIds.clear();
      for (const vid of videos) {
        if (vid && vid.id) {
          state.selectedVideoIds.add(vid.id);
        }
      }

      renderInspector();
      updateWorkflowStepIndicator();

      if (videos.length > 1) {
        showToast(`Found ${videos.length} videos in this link! All ${videos.length} selected — click "Save Selected to Batch List".`, 'info');
      } else if (videos.length === 1) {
        showToast('Found 1 video in this link! Preview it or click "Save Selected to Batch List".', 'info');
      }
    } catch {
      showResolveError('Could not reach the backend server. Please verify the server is running.');
    } finally {
      state.isResolving = false;
      els.inspectBtn.disabled = false;
      els.inspectBtnText.textContent = 'Inspect Link';
    }
  }

  function createThumbnailElement(video, fallbackNumberText, fallbackSubText) {
    const thumb = document.createElement('div');
    thumb.className = 'video-thumb-box';
    thumb.setAttribute('aria-hidden', 'true');

    const safeThumbUrl = getSafeThumbnailUrl(video);
    if (safeThumbUrl) {
      const img = document.createElement('img');
      img.className = 'video-thumb-img';
      img.src = safeThumbUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        img.remove();
        const s1 = document.createElement('span');
        s1.textContent = fallbackNumberText;
        const s2 = document.createElement('span');
        s2.textContent = fallbackSubText;
        thumb.append(s1, s2);
      });
      thumb.appendChild(img);
    } else {
      const s1 = document.createElement('span');
      s1.textContent = fallbackNumberText;
      const s2 = document.createElement('span');
      s2.textContent = fallbackSubText;
      thumb.append(s1, s2);
    }
    return thumb;
  }

  function createStreamSourceBadge(video) {
    const source = getVideoStreamSource(video);
    const badge = document.createElement('span');
    if (source === 'telegram_cdn') {
      badge.className = 'stream-tag stream-tag-live';
      badge.textContent = '● Live Telegram Stream';
    } else if (source === 'telegram_mtproto') {
      badge.className = 'stream-tag stream-tag-live';
      badge.textContent = '● Live MTProto Stream';
    } else {
      badge.className = 'stream-tag stream-tag-demo';
      badge.textContent = 'Demo Fallback MP4';
    }
    return badge;
  }

  function renderInspector() {
    const resolved = state.currentResolved;
    if (!resolved || !Array.isArray(resolved.videos) || resolved.videos.length === 0) {
      els.inspectorEmptyState.classList.remove('hidden');
      els.inspectorContent.classList.add('hidden');
      els.resolvedMetaBadges.classList.add('hidden');
      els.inspectorSubtitle.textContent = 'Inspect a link above to view, preview, and select its videos.';
      return;
    }

    els.inspectorEmptyState.classList.add('hidden');
    els.inspectorContent.classList.remove('hidden');
    els.resolvedMetaBadges.classList.remove('hidden');

    const msgSuffix = resolved.messageId ? ` • Message #${resolved.messageId}` : '';
    els.inspectorSubtitle.textContent = `${resolved.chatTitle}${msgSuffix}`;

    els.resolvedPrivacyBadge.className = resolved.isPrivate ? 'badge badge-private' : 'badge badge-public';
    els.resolvedPrivacyBadge.textContent = resolved.isPrivate ? '🔒 Private Chat Link' : '🌐 Public Channel Link';

    const anyLive = resolved.videos.some((v) => isLiveStreamVideo(v));
    if (els.resolvedSourceBadge) {
      els.resolvedSourceBadge.classList.remove('hidden');
      els.resolvedSourceBadge.className = anyLive ? 'badge badge-live' : 'badge';
      els.resolvedSourceBadge.textContent = anyLive ? '🟢 Real Telegram Video' : '🧪 Demo Fallback';
    }

    const count = resolved.videos.length;
    els.resolvedCountBadge.textContent = `${count} ${count === 1 ? 'Video' : 'Videos'} Found`;

    if (count > 1) {
      els.multiVideoCountSpan.textContent = String(count);
      els.multiVideoNotice.classList.remove('hidden');
    } else {
      els.multiVideoNotice.classList.add('hidden');
    }

    // Render video cards safely using DOM APIs
    els.resolvedVideosList.textContent = '';
    resolved.videos.forEach((video, idx) => {
      const isSelected = state.selectedVideoIds.has(video.id);
      const alreadySaved = isVideoInBatch(video.id);
      const isLive = isLiveStreamVideo(video);

      const card = document.createElement('div');
      card.className = `video-item-card${isSelected ? ' selected' : ''}`;
      card.setAttribute('role', 'listitem');

      const topRow = document.createElement('div');
      topRow.className = 'video-item-row';

      const left = document.createElement('div');
      left.className = 'video-item-left';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'video-select-checkbox';
      checkbox.checked = isSelected;
      checkbox.id = `vid_chk_${idx}`;
      checkbox.setAttribute('aria-label', `Select ${video.title || `Video ${idx + 1}`}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          state.selectedVideoIds.add(video.id);
        } else {
          state.selectedVideoIds.delete(video.id);
        }
        card.classList.toggle('selected', checkbox.checked);
        updateSelectionToolbarState();
      });

      const subLabel = (video.resolution || 'HD').split('x')[1] ? `${(video.resolution || '').split('x')[1]}p` : 'MP4';
      const thumb = createThumbnailElement(video, `#${video.index || idx + 1}`, subLabel);

      const info = document.createElement('div');
      info.className = 'video-info';

      const titleRow = document.createElement('div');
      titleRow.className = 'video-title-row';

      const titleLabel = document.createElement('label');
      titleLabel.htmlFor = checkbox.id;
      titleLabel.className = 'video-title';
      titleLabel.textContent = video.title || `Video #${idx + 1}`;
      titleRow.appendChild(titleLabel);

      titleRow.appendChild(createStreamSourceBadge(video));

      if (alreadySaved) {
        const savedTag = document.createElement('span');
        savedTag.className = 'saved-tag';
        savedTag.textContent = '✓ Saved in Batch';
        titleRow.appendChild(savedTag);
      }

      const metaRow = document.createElement('div');
      metaRow.className = 'video-meta-row';

      const resSpan = document.createElement('span');
      resSpan.textContent = `🎞 ${video.resolution || 'HD MP4'}`;
      const durSpan = document.createElement('span');
      durSpan.textContent = `⏱ ${formatDuration(video.duration, isLive)}`;
      const sizeSpan = document.createElement('span');
      sizeSpan.textContent = `📦 ${formatBytes(video.size, isLive)}`;
      const fileSpan = document.createElement('span');
      fileSpan.textContent = sanitizeFileName(video.fileName, `${video.id}.mp4`);

      metaRow.append(resSpan, durSpan, sizeSpan, fileSpan);
      info.append(titleRow, metaRow);
      left.append(checkbox, thumb, info);

      const actions = document.createElement('div');
      actions.className = 'video-item-actions';

      const { toggleBtn: previewBtn, previewContainer } = createInlinePreviewControl(video, durSpan, resSpan);

      const saveSingleBtn = document.createElement('button');
      saveSingleBtn.type = 'button';
      saveSingleBtn.className = alreadySaved ? 'btn btn-secondary btn-sm' : 'btn btn-accent btn-sm';
      saveSingleBtn.textContent = alreadySaved ? 'Saved' : '+ Save';
      saveSingleBtn.addEventListener('click', () => {
        saveVideosToBatch([video]);
      });

      const directLink = document.createElement('button');
      directLink.type = 'button';
      directLink.className = 'btn btn-ghost btn-sm';
      directLink.title = 'Download this single MP4 immediately';
      directLink.textContent = '⬇ MP4';
      directLink.addEventListener('click', () => {
        downloadMp4(video).catch((err) => showToast(err.message || 'Video download failed.', 'error'));
      });

      actions.append(previewBtn, saveSingleBtn, directLink);
      topRow.append(left, actions);
      card.append(topRow, previewContainer);
      els.resolvedVideosList.appendChild(card);
    });

    updateSelectionToolbarState();
  }

  function updateSelectionToolbarState() {
    const resolved = state.currentResolved;
    const total = resolved ? resolved.videos.length : 0;
    const selectedCount = state.selectedVideoIds.size;

    els.selectionSummaryText.textContent = `${selectedCount} of ${total} selected`;
    els.selectAllCheckbox.checked = total > 0 && selectedCount === total;
    els.selectAllCheckbox.indeterminate = selectedCount > 0 && selectedCount < total;
    els.selectAllLabelText.textContent = total > 1 ? `Select All (${total} Videos)` : 'Select Video';
    els.saveSelectedBtn.disabled = selectedCount === 0;
    els.saveSelectedBtn.textContent =
      selectedCount > 0
        ? `+ Save Selected to Batch List (${selectedCount})`
        : '+ Save Selected to Batch List';
  }

  function selectAllCurrentVideos() {
    if (!state.currentResolved || !Array.isArray(state.currentResolved.videos)) return;
    for (const vid of state.currentResolved.videos) {
      if (vid && vid.id) {
        state.selectedVideoIds.add(vid.id);
      }
    }
    renderInspector();
  }

  function saveVideosToBatch(videosToSave) {
    if (!Array.isArray(videosToSave) || videosToSave.length === 0) {
      showToast('Please select at least one video to save to the batch list.', 'error');
      return;
    }

    const resolved = state.currentResolved;
    let addedCount = 0;
    let alreadyCount = 0;

    for (const video of videosToSave) {
      if (!video || !video.id) continue;
      const existingIndex = state.batchQueue.findIndex((item) => item.id === video.id);
      const normalizedItem = {
        id: String(video.id),
        index: Number(video.index) || 1,
        title: String(video.title || 'Telegram Video'),
        fileName: sanitizeFileName(video.fileName, `${video.id}.mp4`),
        duration: Number(video.duration) || 0,
        size: Number(video.size) || 0,
        resolution: String(video.resolution || 'Unknown'),
        isPrivate: Boolean(video.isPrivate ?? resolved?.isPrivate),
        streamSource: getVideoStreamSource(video),
        thumbnailUrl: getSafeThumbnailUrl(video),
        downloadUrl: getSafeDownloadUrl(video, false),
        sourceUrl: String(resolved?.url || ''),
        chatTitle: String(resolved?.chatTitle || 'Telegram Chat'),
        messageId: String(resolved?.messageId || '')
      };

      if (existingIndex >= 0) {
        state.batchQueue[existingIndex] = normalizedItem;
        alreadyCount += 1;
      } else {
        state.batchQueue.push(normalizedItem);
        addedCount += 1;
      }
    }

    saveBatchToStorage();
    renderBatchQueue();
    renderInspector();
    updateWorkflowStepIndicator();

    if (addedCount > 0) {
      showToast(
        `Saved ${addedCount} ${addedCount === 1 ? 'video' : 'videos'} to Batch List (Total: ${state.batchQueue.length}). Paste another link or click Download All!`,
        'success'
      );
    } else if (alreadyCount > 0) {
      showToast('Selected videos are already in your Saved Batch List.', 'info');
    }
  }

  // --- Step 3: Saved Batch Queue Rendering & Download All ---

  function renderBatchQueue() {
    const count = state.batchQueue.length;
    const manualSequentialActive = Array.isArray(state.sequentialDownloadItems);
    els.batchCountPill.textContent = String(count);
    els.clearBatchBtn.disabled = count === 0 || state.isDownloadingBatch;
    els.downloadAllZipBtn.disabled = count === 0 || state.isDownloadingBatch;
    els.downloadAllSequentialBtn.disabled = count === 0 || (state.isDownloadingBatch && !manualSequentialActive);

    if (count === 0) {
      els.batchEmptyState.classList.remove('hidden');
      els.batchItemsList.classList.add('hidden');
      els.batchStatsBar.classList.add('hidden');
      els.downloadAllZipText.textContent = '⬇ Download All Saved Videos (ZIP Archive)';
      els.downloadAllSeqText.textContent = manualSequentialActive ? '✕ Cancel Remaining MP4 Downloads' : '⬇ Download All Individually (Sequential MP4s)';
      return;
    }

    els.batchEmptyState.classList.add('hidden');
    els.batchItemsList.classList.remove('hidden');
    els.batchStatsBar.classList.remove('hidden');

    const uniqueLinks = new Set(state.batchQueue.map((item) => item.sourceUrl).filter(Boolean));
    const totalBytes = state.batchQueue.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    const totalDuration = state.batchQueue.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
    const anyLive = state.batchQueue.some((item) => isLiveStreamVideo(item));

    els.statTotalVideos.textContent = String(count);
    els.statTotalLinks.textContent = String(Math.max(1, uniqueLinks.size));
    els.statTotalSize.textContent = formatBytes(totalBytes, anyLive);
    els.statTotalDuration.textContent = formatDuration(totalDuration, anyLive);

    els.downloadAllZipText.textContent = `⬇ Download All ${count} Saved ${count === 1 ? 'Video' : 'Videos'} (ZIP Archive)`;
    els.downloadAllSeqText.textContent = manualSequentialActive
      ? '✕ Cancel Remaining MP4 Downloads'
      : `⬇ Download All ${count} Individually (Sequential MP4s)`;

    els.batchItemsList.textContent = '';
    state.batchQueue.forEach((item, idx) => {
      const isLive = isLiveStreamVideo(item);
      const card = document.createElement('div');
      card.className = 'video-item-card';
      card.setAttribute('role', 'listitem');

      const topRow = document.createElement('div');
      topRow.className = 'video-item-row';

      const left = document.createElement('div');
      left.className = 'video-item-left';

      const thumb = createThumbnailElement(item, `${idx + 1}`, item.isPrivate ? '🔒' : 'MP4');

      const info = document.createElement('div');
      info.className = 'video-info';

      const titleRow = document.createElement('div');
      titleRow.className = 'video-title-row';
      const titleEl = document.createElement('span');
      titleEl.className = 'video-title';
      titleEl.textContent = item.title;
      titleRow.appendChild(titleEl);
      titleRow.appendChild(createStreamSourceBadge(item));

      const metaRow = document.createElement('div');
      metaRow.className = 'video-meta-row';

      const sourceSpan = document.createElement('span');
      sourceSpan.textContent = `${item.isPrivate ? '🔒' : '🌐'} ${item.chatTitle}${item.messageId ? ` #${item.messageId}` : ''}`;
      const resSpan = document.createElement('span');
      resSpan.textContent = `🎞 ${item.resolution || 'HD MP4'}`;
      const durSpan = document.createElement('span');
      durSpan.textContent = `⏱ ${formatDuration(item.duration, isLive)}`;
      const sizeSpan = document.createElement('span');
      sizeSpan.textContent = `📦 ${formatBytes(item.size, isLive)}`;

      metaRow.append(sourceSpan, resSpan, durSpan, sizeSpan);
      info.append(titleRow, metaRow);
      left.append(thumb, info);

      const actions = document.createElement('div');
      actions.className = 'video-item-actions';

      const { toggleBtn: previewBtn, previewContainer } = createInlinePreviewControl(item, durSpan, resSpan);

      const singleDownloadLink = document.createElement('button');
      singleDownloadLink.type = 'button';
      singleDownloadLink.className = 'btn btn-secondary btn-sm';
      singleDownloadLink.textContent = '⬇ MP4';
      singleDownloadLink.addEventListener('click', () => {
        downloadMp4(item).catch((err) => showToast(err.message || 'Video download failed.', 'error'));
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn btn-ghost-danger btn-sm';
      removeBtn.title = 'Remove video from batch list';
      removeBtn.setAttribute('aria-label', `Remove ${item.title} from batch list`);
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        removeVideoFromBatch(item.id);
      });

      actions.append(previewBtn, singleDownloadLink, removeBtn);
      topRow.append(left, actions);
      card.append(topRow, previewContainer);
      els.batchItemsList.appendChild(card);
    });
  }

  function removeVideoFromBatch(videoId) {
    state.batchQueue = state.batchQueue.filter((item) => item.id !== videoId);
    saveBatchToStorage();
    renderBatchQueue();
    renderInspector();
    updateWorkflowStepIndicator();
  }

  function clearBatchQueue() {
    if (state.batchQueue.length === 0) return;
    state.batchQueue = [];
    saveBatchToStorage();
    renderBatchQueue();
    renderInspector();
    updateWorkflowStepIndicator();
    showToast('Cleared saved batch list.', 'info');
  }

  function setBatchProgress(visible, percent = 0, text = '') {
    if (!visible) {
      els.batchProgressBox.classList.add('hidden');
      els.batchProgressBar.style.width = '0%';
      els.batchProgressText.textContent = '';
      return;
    }
    els.batchProgressBox.classList.remove('hidden');
    els.batchProgressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    els.batchProgressText.textContent = text;
  }

  async function downloadAllAsZip() {
    if (state.batchQueue.length === 0 || state.isDownloadingBatch) return;

    state.isDownloadingBatch = true;
    renderBatchQueue();
    setBatchProgress(true, 25, `Packaging ${state.batchQueue.length} saved videos into ZIP archive...`);

    const videoIds = state.batchQueue.map((item) => item.id);
    try {
      const res = await fetch('/api/download-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoIds,
          items: state.batchQueue
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData?.error || errData?.message || `Batch download failed (HTTP ${res.status})`);
      }

      setBatchProgress(true, 75, 'Receiving ZIP archive stream...');
      const arrayBuf = await res.arrayBuffer();
      const blob = new Blob([arrayBuf], { type: 'application/zip' });
      const blobUrl = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = 'telegram_videos_batch.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();

      setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);

      setBatchProgress(true, 100, `Downloaded ${videoIds.length} videos in telegram_videos_batch.zip!`);
      showToast(`Batch download complete (${videoIds.length} videos)!`, 'success');
    } catch (err) {
      setBatchProgress(false);
      showToast(err.message || 'Failed to download batch ZIP.', 'error');
    } finally {
      state.isDownloadingBatch = false;
      renderBatchQueue();
    }
  }

  function requiresManualSequentialDownloads() {
    const userAgent = navigator.userAgent || '';
    return /iPhone|iPad|iPod/i.test(userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function startDirectMp4Download(video) {
    const link = document.createElement('a');
    link.href = getSafeDownloadUrl(video, false);
    link.download = sanitizeFileName(video.fileName, `${video.id}.mp4`);
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function downloadNextSequentialMp4() {
    const items = state.sequentialDownloadItems;
    const index = state.sequentialDownloadIndex;
    if (!Array.isArray(items) || index >= items.length) return;

    const item = items[index];
    const fileName = sanitizeFileName(item.fileName, `${item.id}.mp4`);
    startDirectMp4Download(item);
    state.sequentialDownloadIndex += 1;

    if (state.sequentialDownloadIndex < items.length) {
      const nextItem = items[state.sequentialDownloadIndex];
      const nextName = sanitizeFileName(nextItem.fileName, `${nextItem.id}.mp4`);
      const percent = Math.round((state.sequentialDownloadIndex / items.length) * 100);
      setBatchProgress(
        true,
        percent,
        `Started ${fileName}. Tap below to download MP4 ${state.sequentialDownloadIndex + 1} of ${items.length}: ${nextName}.`
      );
      els.batchNextDownloadBtn.textContent = `⬇ Download MP4 ${state.sequentialDownloadIndex + 1} of ${items.length}`;
      return;
    }

    state.sequentialDownloadItems = null;
    state.sequentialDownloadIndex = 0;
    state.isDownloadingBatch = false;
    els.batchNextDownloadBtn.classList.add('hidden');
    renderBatchQueue();
    setBatchProgress(true, 100, `Started all ${items.length} MP4 downloads.`);
    showToast(`Started all ${items.length} MP4 downloads.`, 'success');
  }

  function cancelManualSequentialDownloads() {
    state.sequentialDownloadItems = null;
    state.sequentialDownloadIndex = 0;
    state.isDownloadingBatch = false;
    els.batchNextDownloadBtn.classList.add('hidden');
    setBatchProgress(false);
    renderBatchQueue();
    showToast('Cancelled the remaining MP4 downloads.', 'info');
  }

  async function downloadAllSequentially() {
    if (Array.isArray(state.sequentialDownloadItems)) {
      cancelManualSequentialDownloads();
      return;
    }
    if (state.batchQueue.length === 0 || state.isDownloadingBatch) return;

    state.isDownloadingBatch = true;
    renderBatchQueue();
    const items = [...state.batchQueue];

    if (requiresManualSequentialDownloads()) {
      state.sequentialDownloadItems = items;
      state.sequentialDownloadIndex = 0;
      renderBatchQueue();
      els.batchNextDownloadBtn.classList.remove('hidden');
      downloadNextSequentialMp4();
      return;
    }

    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const fileName = sanitizeFileName(item.fileName, `${item.id}.mp4`);
        const pct = Math.round(((i + 1) / items.length) * 100);
        setBatchProgress(true, pct, `Downloading MP4 ${i + 1} of ${items.length}: ${fileName}...`);

        const res = await fetch(getSafeDownloadUrl(item, false));
        if (!res.ok) {
          throw new Error(`Failed to download ${fileName} (HTTP ${res.status})`);
        }
        const arrayBuf = await res.arrayBuffer();
        const blob = new Blob([arrayBuf], { type: 'video/mp4' });
        const blobUrl = URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);

        if (i < items.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 450));
        }
      }

      setBatchProgress(true, 100, `Finished downloading all ${items.length} MP4 videos!`);
      showToast(`Downloaded all ${items.length} MP4 files sequentially!`, 'success');
    } catch (err) {
      setBatchProgress(false);
      showToast(err.message || 'Error during sequential MP4 download.', 'error');
    } finally {
      state.isDownloadingBatch = false;
      renderBatchQueue();
    }
  }

  // --- Event Listeners Initialization ---

  function bindEvents() {
    // Auth panel toggle
    els.authToggleBtn.addEventListener('click', () => {
      const isHidden = els.authPanel.classList.toggle('hidden');
      els.authToggleBtn.setAttribute('aria-expanded', String(!isHidden));
    });

    els.closeAuthPanelBtn.addEventListener('click', () => {
      els.authPanel.classList.add('hidden');
      els.authToggleBtn.setAttribute('aria-expanded', 'false');
    });

    els.authForm.addEventListener('submit', handleAuthSubmit);
    els.authDisconnectBtn.addEventListener('click', handleAuthDisconnect);

    // URL Input & Clear Button
    els.telegramUrlInput.addEventListener('input', () => {
      showResolveError('');
      els.clearUrlBtn.classList.toggle('hidden', !els.telegramUrlInput.value);
    });

    els.clearUrlBtn.addEventListener('click', () => {
      els.telegramUrlInput.value = '';
      els.clearUrlBtn.classList.add('hidden');
      showResolveError('');
      els.telegramUrlInput.focus();
    });

    // Resolve Form Submit
    els.resolveForm.addEventListener('submit', (event) => {
      event.preventDefault();
      resolveTelegramUrl(els.telegramUrlInput.value);
    });

    // Sample Link Chips
    els.sampleLinkBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const sampleUrl = btn.getAttribute('data-url') || '';
        els.telegramUrlInput.value = sampleUrl;
        els.clearUrlBtn.classList.toggle('hidden', !sampleUrl);
        resolveTelegramUrl(sampleUrl);
      });
    });

    // Inspector Selection Controls
    els.selectAllCheckbox.addEventListener('change', () => {
      if (!state.currentResolved || !Array.isArray(state.currentResolved.videos)) return;
      if (els.selectAllCheckbox.checked) {
        for (const vid of state.currentResolved.videos) {
          if (vid && vid.id) state.selectedVideoIds.add(vid.id);
        }
      } else {
        state.selectedVideoIds.clear();
      }
      renderInspector();
    });

    els.selectAllBtn.addEventListener('click', () => {
      selectAllCurrentVideos();
      if (state.currentResolved?.videos?.length) {
        showToast(`Selected all ${state.currentResolved.videos.length} videos in this link.`, 'info');
      }
    });

    els.saveSelectedBtn.addEventListener('click', () => {
      if (!state.currentResolved || !Array.isArray(state.currentResolved.videos)) return;
      const selectedVideos = state.currentResolved.videos.filter((vid) => state.selectedVideoIds.has(vid.id));
      saveVideosToBatch(selectedVideos);
    });

    els.selectAllAndSaveBtn.addEventListener('click', () => {
      if (!state.currentResolved || !Array.isArray(state.currentResolved.videos)) return;
      selectAllCurrentVideos();
      saveVideosToBatch(state.currentResolved.videos);
    });

    // Batch Queue Controls
    els.addAnotherLinkBtn.addEventListener('click', () => {
      els.telegramUrlInput.value = '';
      els.clearUrlBtn.classList.add('hidden');
      showResolveError('');
      els.telegramUrlInput.focus();
      els.telegramUrlInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    els.clearBatchBtn.addEventListener('click', clearBatchQueue);
    els.downloadAllZipBtn.addEventListener('click', downloadAllAsZip);
    els.downloadAllSequentialBtn.addEventListener('click', downloadAllSequentially);
    els.batchNextDownloadBtn.addEventListener('click', downloadNextSequentialMp4);
  }

  function init() {
    loadBatchFromStorage();
    bindEvents();
    renderBatchQueue();
    updateWorkflowStepIndicator();
    checkApiHealth();
    fetchAuthStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
