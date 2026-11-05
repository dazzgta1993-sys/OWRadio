/**
 * @file app.js
 * @description Sleek, reactive client controller for OWRadio.
 * Handles SSE live sync, player transport, fast-play queueing, audio monitor,
 * and clean tabbed queue/history/listener inspection.
 */

(function () {
  'use strict';

  // --- State ---
  let currentState = {
    state: 'idle',
    track: null,
    upNext: null,
    volume: 80,
    elapsedSec: 0,
    durationSec: 0,
    lastUpdateTs: Date.now(),
    isAdmin: false,
    authEnabled: false,
  };

  let isAudioPlayingLocally = false;
  let tickerInterval = null;
  let pollInterval = null;
  let eventSource = null;

  // --- Elements ---
  const el = {
    fastPlayInput: document.getElementById('fastPlayInput'),
    liveStatusText: document.getElementById('liveStatusText'),
    authBtn: document.getElementById('authBtn'),
    authIcon: document.getElementById('authIcon'),
    authLabel: document.getElementById('authLabel'),
    adminStatusDisplay: document.getElementById('adminStatusDisplay'),
    settingsAuthActionBtn: document.getElementById('settingsAuthActionBtn'),
    authModal: document.getElementById('authModal'),
    adminPasswordInput: document.getElementById('adminPasswordInput'),
    authErrorMsg: document.getElementById('authErrorMsg'),

    voiceStatusText: document.getElementById('voiceStatusText'),
    trackCover: document.getElementById('trackCover'),
    coverPlaceholder: document.getElementById('coverPlaceholder'),
    trackTitle: document.getElementById('trackTitle'),
    trackArtist: document.getElementById('trackArtist'),
    curationPill: document.getElementById('curationPill'),

    progressBar: document.getElementById('progressBar'),
    progressFill: document.getElementById('progressFill'),
    timeElapsed: document.getElementById('timeElapsed'),
    timeTotal: document.getElementById('timeTotal'),

    btnPlayPause: document.getElementById('btnPlayPause'),
    btnBrowserAudio: document.getElementById('btnBrowserAudio'),
    browserAudioLabel: document.getElementById('browserAudioLabel'),
    browserAudioElement: document.getElementById('browserAudioElement'),
    volSlider: document.getElementById('volSlider'),
    volPct: document.getElementById('volPct'),

    queueBadge: document.getElementById('queueBadge'),
    queueSummaryText: document.getElementById('queueSummaryText'),
    upNextCard: document.getElementById('upNextCard'),
    upNextTitle: document.getElementById('upNextTitle'),
    queueListContainer: document.getElementById('queueListContainer'),

    historyListContainer: document.getElementById('historyListContainer'),
    listenersBadge: document.getElementById('listenersBadge'),
    listenersListContainer: document.getElementById('listenersListContainer'),
    toastContainer: document.getElementById('toastContainer'),
  };

  // --- Utility: Format Seconds ---
  function formatTime(sec) {
    if (!sec || isNaN(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // --- Toast Notifications ---
  function showToast(message, isError = false) {
    if (!el.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    if (isError) toast.style.borderColor = '#ef4444';
    toast.textContent = message;
    el.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  // --- Tab Switching ---
  window.switchHubTab = function (tabName) {
    const tabs = ['queue', 'history', 'listeners', 'settings'];
    tabs.forEach((t) => {
      const btn = document.getElementById(`tabBtn${capitalize(t)}`);
      const panel = document.getElementById(`panel${capitalize(t)}`);
      if (btn) btn.classList.toggle('active', t === tabName);
      if (panel) panel.classList.toggle('active', t === tabName);
    });
  };

  function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  // --- Fast-Play / Queue Submission ---
  window.executeFastPlay = async function (playNow = false) {
    const query = el.fastPlayInput ? el.fastPlayInput.value.trim() : '';
    if (!query) return;

    el.fastPlayInput.value = '';
    showToast(playNow ? `⚡ Playing: ${query}` : `📑 Queuing: ${query}`);

    try {
      const res = await fetch('/api/player/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, playNow }),
      });
      const data = await res.json();
      if (data.error) {
        showToast(`❌ ${data.error}`, true);
      } else {
        fetchStationData();
      }
    } catch (err) {
      showToast('❌ Failed to send track to player', true);
    }
  };

  // --- Player Transport Controls ---
  window.sendPlayerAction = async function (action) {
    try {
      const res = await fetch(`/api/player/${action}`, { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        if (data.code === 'AUTH_REQUIRED') {
          openAuthModal();
        } else {
          showToast(`❌ ${data.error}`, true);
        }
      } else {
        if (action === 'shuffle') showToast('🔀 Queue shuffled');
        if (action === 'skip') showToast('⏭ Track skipped');
        if (action === 'stop') showToast('⏹ Playback stopped');
        if (action === 'like') showToast('👍 Vibe trained: More like this artist!');
        if (action === 'dislike') showToast('👎 Vibe trained: Cooled down artist');
        fetchStationData();
      }
    } catch {
      showToast(`❌ Failed to execute ${action}`, true);
    }
  };

  window.togglePlayPause = function () {
    const isPlaying = currentState.state === 'playing';
    sendPlayerAction(isPlaying ? 'pause' : 'resume');
  };

  window.onVolumeChange = async function (val) {
    const volume = parseInt(val, 10);
    if (el.volPct) el.volPct.textContent = `${volume}%`;
    currentState.volume = volume;
    try {
      await fetch('/api/player/volume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volume }),
      });
    } catch {}
  };

  let lastUnmutedVolume = 80;
  window.toggleMute = function () {
    if (currentState.volume > 0) {
      lastUnmutedVolume = currentState.volume;
      if (el.volSlider) el.volSlider.value = 0;
      onVolumeChange(0);
    } else {
      if (el.volSlider) el.volSlider.value = lastUnmutedVolume || 80;
      onVolumeChange(lastUnmutedVolume || 80);
    }
  };

  // --- Browser Audio Streaming (/stream.mp3) ---
  window.toggleBrowserAudio = function () {
    const audio = el.browserAudioElement;
    if (!audio) return;

    if (isAudioPlayingLocally) {
      audio.pause();
      audio.src = '';
      isAudioPlayingLocally = false;
      if (el.btnBrowserAudio) el.btnBrowserAudio.classList.remove('active');
      if (el.browserAudioLabel) el.browserAudioLabel.textContent = 'Listen Live in Browser';
      showToast('🔇 Local browser audio muted');
    } else {
      audio.src = '/stream.mp3?t=' + Date.now();
      audio
        .play()
        .then(() => {
          isAudioPlayingLocally = true;
          if (el.btnBrowserAudio) el.btnBrowserAudio.classList.add('active');
          if (el.browserAudioLabel) el.browserAudioLabel.textContent = 'Streaming Live (Click to Mute)';
          showToast('🎧 Connected to live 192k audio stream!');
        })
        .catch(() => {
          showToast('❌ Click to allow browser audio playback', true);
        });
    }
  };

  // --- Queue Actions ---
  window.clearQueue = async function () {
    try {
      const res = await fetch('/api/queue/clear', { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        showToast(`❌ ${data.error}`, true);
      } else {
        showToast('🗑 Queue cleared');
        fetchStationData();
      }
    } catch {
      showToast('❌ Failed to clear queue', true);
    }
  };

  window.removeQueueItem = async function (index) {
    try {
      const res = await fetch('/api/queue/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index }),
      });
      const data = await res.json();
      if (data.error) {
        showToast(`❌ ${data.error}`, true);
      } else {
        fetchStationData();
      }
    } catch {
      showToast('❌ Failed to remove track', true);
    }
  };

  window.requeueTrack = function (query) {
    if (!query) return;
    executeFastPlayWithQuery(query, false);
  };

  async function executeFastPlayWithQuery(query, playNow) {
    showToast(`📑 Queuing: ${query}`);
    try {
      const res = await fetch('/api/player/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, playNow }),
      });
      const data = await res.json();
      if (data.error) {
        showToast(`❌ ${data.error}`, true);
      } else {
        fetchStationData();
      }
    } catch {
      showToast('❌ Failed to queue track', true);
    }
  }

  // --- Admin Authentication ---
  window.openAuthModal = function () {
    if (currentState.isAdmin) {
      if (confirm('Sign out from station admin?')) {
        fetch('/api/auth/logout', { method: 'POST' }).then(() => {
          currentState.isAdmin = false;
          updateAuthUI();
          showToast('Signed out from Admin');
        });
      }
      return;
    }
    if (el.authModal) el.authModal.style.display = 'flex';
    if (el.adminPasswordInput) {
      el.adminPasswordInput.value = '';
      el.adminPasswordInput.focus();
    }
    if (el.authErrorMsg) el.authErrorMsg.style.display = 'none';
  };

  window.closeAuthModal = function () {
    if (el.authModal) el.authModal.style.display = 'none';
  };

  window.submitAdminLogin = async function () {
    const password = el.adminPasswordInput ? el.adminPasswordInput.value : '';
    if (!password) return;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (data.success) {
        currentState.isAdmin = true;
        closeAuthModal();
        updateAuthUI();
        showToast('🔓 Admin authenticated successfully!');
      } else {
        if (el.authErrorMsg) {
          el.authErrorMsg.textContent = data.error || 'Incorrect password';
          el.authErrorMsg.style.display = 'block';
        }
      }
    } catch {
      if (el.authErrorMsg) {
        el.authErrorMsg.textContent = 'Server connection error';
        el.authErrorMsg.style.display = 'block';
      }
    }
  };

  async function checkAuthStatus() {
    try {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      currentState.authEnabled = data.enabled;
      currentState.isAdmin = data.authenticated;
      updateAuthUI();
    } catch {}
  }

  function updateAuthUI() {
    if (currentState.isAdmin) {
      if (el.authIcon) el.authIcon.textContent = '🔓';
      if (el.authLabel) el.authLabel.textContent = 'Admin: Unlocked';
      if (el.adminStatusDisplay) el.adminStatusDisplay.innerHTML = '<strong style="color:#4ade80;">Admin Active</strong>';
      if (el.settingsAuthActionBtn) el.settingsAuthActionBtn.textContent = 'Sign Out';
    } else {
      if (el.authIcon) el.authIcon.textContent = '🔐';
      if (el.authLabel) el.authLabel.textContent = 'Admin Login';
      if (el.adminStatusDisplay) el.adminStatusDisplay.textContent = 'Guest (Public Queueing)';
      if (el.settingsAuthActionBtn) el.settingsAuthActionBtn.textContent = 'Admin Login';
    }
  }

  // --- Rendering UI with Station Data ---
  function updatePlayerUI(data) {
    if (!data) return;

    currentState.state = data.state || 'idle';
    currentState.track = data.track || null;
    currentState.upNext = data.upNext || null;
    if (typeof data.volume === 'number') {
      currentState.volume = data.volume;
      if (el.volSlider) el.volSlider.value = data.volume;
      if (el.volPct) el.volPct.textContent = `${data.volume}%`;
    }

    // Now Playing Track Meta
    if (data.track) {
      const track = data.track;
      if (el.trackTitle) el.trackTitle.textContent = track.title || 'Unknown Title';
      if (el.trackArtist) el.trackArtist.textContent = track.artist || 'Unknown Artist';

      // Artwork
      const art = track.artworkUrl || track.artworkThumbUrl;
      if (art && el.trackCover) {
        el.trackCover.src = art;
        el.trackCover.style.display = 'block';
        if (el.coverPlaceholder) el.coverPlaceholder.style.display = 'none';
      } else {
        if (el.trackCover) el.trackCover.style.display = 'none';
        if (el.coverPlaceholder) el.coverPlaceholder.style.display = 'flex';
      }

      // Curation Reason / Continuity Info
      if (el.curationPill) {
        const reason = track.curationReason || (track.curatedBy ? `DJ Harmonic: ${track.curatedBy}` : 'Autoplay');
        el.curationPill.textContent = `✨ ${reason}`;
      }

      // Progress & Times
      currentState.durationSec = track.durationSec || 0;
      currentState.elapsedSec = track.elapsedSec || 0;
      currentState.lastUpdateTs = Date.now();
      updateProgressDisplay();
    } else {
      if (el.trackTitle) el.trackTitle.textContent = 'Station Idle';
      if (el.trackArtist) el.trackArtist.textContent = 'Ready for music';
      if (el.trackCover) el.trackCover.style.display = 'none';
      if (el.coverPlaceholder) el.coverPlaceholder.style.display = 'flex';
      if (el.curationPill) el.curationPill.textContent = '✨ Ready to queue tracks';
      currentState.durationSec = 0;
      currentState.elapsedSec = 0;
      updateProgressDisplay();
    }

    // Play / Pause button icon
    if (el.btnPlayPause) {
      el.btnPlayPause.textContent = currentState.state === 'playing' ? '⏸' : '▶';
    }

    // Voice / Stream status
    if (el.voiceStatusText) {
      el.voiceStatusText.textContent =
        currentState.state === 'playing' ? 'Broadcasting 24/7' : 'Station Idle';
    }
  }

  function updateProgressDisplay() {
    const elapsed = Math.min(currentState.elapsedSec, currentState.durationSec || currentState.elapsedSec);
    const duration = currentState.durationSec;

    if (el.timeElapsed) el.timeElapsed.textContent = formatTime(elapsed);
    if (el.timeTotal) el.timeTotal.textContent = formatTime(duration);

    const pct = duration > 0 ? (elapsed / duration) * 100 : 0;
    if (el.progressFill) el.progressFill.style.width = `${Math.min(pct, 100)}%`;
  }

  function updateQueueAndLists(queueData) {
    if (!queueData) return;

    // Up Next Banner
    const upNext = queueData.upcoming && queueData.upcoming.length > 0 ? queueData.upcoming[0] : currentState.upNext;
    if (upNext && el.upNextCard && el.upNextTitle) {
      el.upNextCard.style.display = 'flex';
      el.upNextTitle.textContent = `${upNext.title} — ${upNext.artist}`;
    } else if (el.upNextCard) {
      el.upNextCard.style.display = 'none';
    }

    // Upcoming Queue List
    const queue = queueData.upcoming || [];
    if (el.queueBadge) el.queueBadge.textContent = queue.length;
    if (el.queueSummaryText) el.queueSummaryText.textContent = `${queue.length} track${queue.length === 1 ? '' : 's'} in queue`;

    if (el.queueListContainer) {
      if (queue.length === 0) {
        el.queueListContainer.innerHTML = `
          <div class="empty-state">
            <span style="font-size:24px;">📑</span>
            <div>Queue is empty</div>
            <div style="font-size:0.75rem; color:var(--text-subtle);">Search any song above or let the Harmonic DJ automatically flow!</div>
          </div>
        `;
      } else {
        el.queueListContainer.innerHTML = queue
          .map((item, idx) => {
            const thumb = item.artworkUrl || item.artworkThumbUrl || 'https://e-cdn-images.dzcdn.net/images/cover/d41d8cd98f00b204e9800998ecf8427e/250x250-000000-80-0-0.jpg';
            const dur = formatTime(item.durationSec);
            return `
              <div class="track-row">
                <span class="track-index">${idx + 1}</span>
                <img src="${thumb}" class="track-thumb" alt="art" onerror="this.src='https://e-cdn-images.dzcdn.net/images/cover/d41d8cd98f00b204e9800998ecf8427e/250x250-000000-80-0-0.jpg'" />
                <div class="track-details">
                  <div class="track-row-title">${escapeHtml(item.title)}</div>
                  <div class="track-row-artist">${escapeHtml(item.artist)}</div>
                </div>
                <span class="track-row-time">${dur}</span>
                <button class="btn-row-del" onclick="removeQueueItem(${idx})" title="Remove track">✕</button>
              </div>
            `;
          })
          .join('');
      }
    }

    // History List
    const history = queueData.recentHistory || [];
    if (el.historyListContainer) {
      if (history.length === 0) {
        el.historyListContainer.innerHTML = `
          <div class="empty-state">
            <span style="font-size:24px;">🕒</span>
            <div>No history yet</div>
            <div style="font-size:0.75rem; color:var(--text-subtle);">Played tracks will appear here with one-click re-queue!</div>
          </div>
        `;
      } else {
        el.historyListContainer.innerHTML = history
          .map((item) => {
            const query = escapeHtml(`${item.artist} - ${item.title}`);
            return `
              <div class="track-row">
                <div class="track-details">
                  <div class="track-row-title">${escapeHtml(item.title)}</div>
                  <div class="track-row-artist">${escapeHtml(item.artist)}</div>
                </div>
                <button class="btn-action-small" onclick="requeueTrack('${query.replace(/'/g, "\\'")}')" title="Add back to queue">+ Queue</button>
              </div>
            `;
          })
          .join('');
      }
    }

    // Listeners List
    const listeners = queueData.roomListeners || [];
    if (el.listenersBadge) el.listenersBadge.textContent = listeners.length;
    if (el.listenersListContainer) {
      if (listeners.length === 0) {
        el.listenersListContainer.innerHTML = `
          <div class="empty-state">
            <span style="font-size:24px;">🎙️</span>
            <div>No listeners currently active in Discord voice channel</div>
            <div style="font-size:0.75rem; color:var(--text-subtle);">Station is broadcasting live 24/7 on Web &amp; Discord!</div>
          </div>
        `;
      } else {
        el.listenersListContainer.innerHTML = listeners
          .map((u) => {
            return `
              <div class="track-row">
                <span style="font-size:16px;">🎧</span>
                <div class="track-details">
                  <div class="track-row-title">${escapeHtml(u.username || 'Listener')}</div>
                  <div class="track-row-artist" style="color:#4ade80;">Listening Live</div>
                </div>
              </div>
            `;
          })
          .join('');
      }
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // --- Real-Time Progress Ticker ---
  function startTicker() {
    if (tickerInterval) clearInterval(tickerInterval);
    tickerInterval = setInterval(() => {
      if (currentState.state === 'playing' && currentState.durationSec > 0) {
        const now = Date.now();
        const deltaSec = (now - currentState.lastUpdateTs) / 1000;
        currentState.elapsedSec += deltaSec;
        currentState.lastUpdateTs = now;
        updateProgressDisplay();
      }
    }, 1000);
  }

  // --- Data Fetching ---
  window.fetchStationData = async function () {
    try {
      const [nowPlayingRes, queueRes] = await Promise.all([
        fetch('/api/nowplaying').then((r) => r.json()),
        fetch('/api/queue').then((r) => r.json()),
      ]);

      updatePlayerUI(nowPlayingRes);
      updateQueueAndLists(queueRes);
    } catch {}
  };

  // --- SSE Live Updates ---
  function setupSSE() {
    if (eventSource) {
      try {
        eventSource.close();
      } catch {}
    }

    try {
      eventSource = new EventSource('/api/events');
      eventSource.onopen = () => {
        if (el.liveStatusText) el.liveStatusText.textContent = 'LIVE BROADCAST';
      };
      eventSource.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data);
          if (payload.type === 'state_update' || payload.track) {
            updatePlayerUI(payload);
          }
          if (payload.type === 'queue_update' || payload.upcoming) {
            updateQueueAndLists(payload);
          }
        } catch {}
      };
      eventSource.onerror = () => {
        if (el.liveStatusText) el.liveStatusText.textContent = 'SYNCING';
      };
    } catch {}
  }

  // --- Initialization ---
  function init() {
    checkAuthStatus();
    fetchStationData();
    startTicker();
    setupSSE();

    // Polling fallback every 3 seconds to guarantee instant recovery
    pollInterval = setInterval(fetchStationData, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
