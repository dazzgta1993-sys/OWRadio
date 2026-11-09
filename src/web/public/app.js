window.renderState = window.renderState || function (s) { window.pendingState = s; };
/**
 * @file web/public/app.js
 * @description Core Player, Live 192kbps Audio Stream, Volume Slider, Multi-Engine Search,
 * Queue & History Controller for OWRadio Studio v3.0.
 */

window.el = {
  searchInput: document.getElementById('searchInput'),
  searchSource: document.getElementById('searchSourceSelect'),
  playQueryBtn: document.getElementById('playQueryBtn'),
  queueQueryBtn: document.getElementById('queueQueryBtn'),
  searchDropdown: document.getElementById('searchResultsDropdown'),
  autoplayBtn: document.getElementById('autoplayBtn'),
  djVoiceBtn: document.getElementById('djVoiceBtn'),
  anchorPill: document.getElementById('anchorPill'),
  sourceBadge: document.getElementById('sourceBadge'),
  nowPlayingArt: document.getElementById('nowPlayingArt'),
  nowPlayingTitle: document.getElementById('nowPlayingTitle'),
  nowPlayingArtist: document.getElementById('nowPlayingArtist'),
  nowPlayingAlbum: document.getElementById('nowPlayingAlbum'),
  vibeReasonBadge: document.getElementById('vibeReasonBadge'),
  progressFill: document.getElementById('progressFill'),
  elapsedTime: document.getElementById('elapsedTime'),
  totalDuration: document.getElementById('totalDuration'),
  playPauseBtn: document.getElementById('playPauseBtn'),
  skipBtn: document.getElementById('skipBtn'),
  stopBtn: document.getElementById('stopBtn'),
  shuffleBtn: document.getElementById('shuffleBtn'),
  loopBtn: document.getElementById('loopBtn'),
  likeBtn: document.getElementById('likeBtn'),
  dislikeBtn: document.getElementById('dislikeBtn'),
  listenLiveBtn: document.getElementById('listenLiveBtn'),
  browserAudio: document.getElementById('browserAudio'),
  volumeSlider: document.getElementById('volumeSlider'),
  volumeLabel: document.getElementById('volumeLabel'),
  muteIcon: document.getElementById('muteIcon'),
  queueCount: document.getElementById('queueCount'),
  deck2Banner: document.getElementById('deck2Banner'),
  deck2Text: document.getElementById('deck2Text'),
  deck2PrewarmTag: document.getElementById('deck2PrewarmTag'),
  queueList: document.getElementById('queueList'),
  chartsList: document.getElementById('chartsList'),
  historyList: document.getElementById('historyList'),
  clearQueueBtn: document.getElementById('clearQueueBtn'),
  discoArtistInput: document.getElementById('discoArtistInput'),
  discoCategorySelect: document.getElementById('discoCategorySelect'),
  discoSearchBtn: document.getElementById('discoSearchBtn'),
  discoList: document.getElementById('discoList'),
  telAnchor: document.getElementById('telAnchor'),
  telChain: document.getElementById('telChain'),
  telDeck2: document.getElementById('telDeck2'),
  telDeck3: document.getElementById('telDeck3'),
  telDecision: document.getElementById('telDecision'),
};

let isListeningInBrowser = false;
let searchDebounce = null;
let savedVolume = Number(localStorage.getItem('owradio_vol') ?? 85);

window.formatSecs = function (sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${s % 60 < 10 ? '0' : ''}${s % 60}`;
};

window.escapeHtml = function (str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
};

// --- Volume Control (Local Browser Audio + Server Broadcast Gain) ---
let volumeSyncDebounce = null;
function applyVolume(volPercent, syncServer = true) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(volPercent) || 0)));
  savedVolume = clamped;
  localStorage.setItem('owradio_vol', String(clamped));
  el.volumeSlider.value = String(clamped);
  el.volumeLabel.textContent = `${clamped}%`;
  el.muteIcon.textContent = clamped === 0 ? '🔇' : clamped < 50 ? '🔉' : '🔊';
  if (el.browserAudio) {
    el.browserAudio.volume = clamped / 100;
    el.browserAudio.muted = clamped === 0;
  }
  if (syncServer) {
    clearTimeout(volumeSyncDebounce);
    volumeSyncDebounce = setTimeout(() => {
      fetch('/api/player/volume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volume: clamped }),
      }).catch(() => {});
    }, 150);
  }
}

el.volumeSlider.addEventListener('input', (e) => applyVolume(e.target.value, true));
el.muteIcon.addEventListener('click', () => applyVolume(savedVolume > 0 ? 0 : 85, true));
applyVolume(savedVolume, false);

// --- Live Browser MP3 Audio Stream Toggle ---
el.listenLiveBtn.addEventListener('click', () => {
  if (!isListeningInBrowser) {
    el.browserAudio.src = `/stream.mp3?t=${Date.now()}`;
    el.browserAudio.volume = savedVolume / 100;
    isListeningInBrowser = true;
    el.listenLiveBtn.textContent = '⏳ Connecting Live Stream...';
    el.listenLiveBtn.classList.add('active');
    el.browserAudio.play().catch((err) => {
      console.warn('Playback error / autoplay blocked:', err);
      el.listenLiveBtn.textContent = '▶ Click to Listen Live (192kbps)';
      el.listenLiveBtn.classList.remove('active');
      isListeningInBrowser = false;
    });
  } else {
    el.browserAudio.pause();
    el.browserAudio.src = '';
    isListeningInBrowser = false;
    el.listenLiveBtn.textContent = '🎧 Listen Live in Browser (192kbps)';
    el.listenLiveBtn.classList.remove('active');
  }
});
el.browserAudio.addEventListener('waiting', () => {
  if (isListeningInBrowser) el.listenLiveBtn.textContent = '⏳ Re-buffering Audio...';
});
el.browserAudio.addEventListener('playing', () => {
  if (isListeningInBrowser) el.listenLiveBtn.textContent = '🎧 Streaming Live (Click to Mute)';
});
el.browserAudio.addEventListener('canplay', () => {
  if (isListeningInBrowser && el.browserAudio.paused) {
    el.browserAudio.play().catch(() => {});
  }
});
el.browserAudio.addEventListener('error', () => {
  if (isListeningInBrowser) {
    el.listenLiveBtn.textContent = '⚠️ Stream Disconnected (Click to Retry)';
    el.listenLiveBtn.classList.remove('active');
    isListeningInBrowser = false;
  }
});

// --- Search & Direct Play / Queue ---
window.triggerPlayOrQueue = async function (payload, mode = 'now') {
  el.searchDropdown.classList.add('hidden');
  try {
    const res = await fetch('/api/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: el.searchSource.value, ...payload, mode }),
    });
    const data = await res.json();
    if (data.state && window.renderState) window.renderState(data.state);
  } catch {}
};

el.playQueryBtn.addEventListener('click', () => {
  if (el.searchInput.value.trim()) window.triggerPlayOrQueue({ query: el.searchInput.value.trim() }, 'now');
});
el.queueQueryBtn.addEventListener('click', () => {
  if (el.searchInput.value.trim()) window.triggerPlayOrQueue({ query: el.searchInput.value.trim() }, 'queue');
});
el.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && el.searchInput.value.trim()) {
    window.triggerPlayOrQueue({ query: el.searchInput.value.trim() }, 'now');
  }
});

function runLiveSearch() {
  clearTimeout(searchDebounce);
  const q = el.searchInput.value.trim();
  if (q.length < 2 || q.startsWith('http')) {
    el.searchDropdown.classList.add('hidden');
    return;
  }
  searchDebounce = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&source=${encodeURIComponent(el.searchSource.value)}`);
      if (!res.ok) return;
      const data = await res.json();
      renderSearchDropdown(data.results || []);
    } catch {}
  }, 240);
}

el.searchInput.addEventListener('input', runLiveSearch);
el.searchSource.addEventListener('change', runLiveSearch);

function renderSearchDropdown(tracks) {
  if (!tracks.length) {
    el.searchDropdown.classList.add('hidden');
    return;
  }
  el.searchDropdown.innerHTML = tracks
    .map((t, idx) => `
    <div class="track-row" data-idx="${idx}">
      <div class="track-row-left">
        <img src="${window.escapeHtml(t.artworkUrl || '')}" alt="" />
        <div>
          <div class="track-row-title">${window.escapeHtml(t.title)}</div>
          <div class="track-row-sub">${window.escapeHtml(t.artist)}${t.album ? ' • ' + window.escapeHtml(t.album) : ''} (${window.escapeHtml(t.durationFormatted || window.formatSecs(t.duration))})</div>
        </div>
      </div>
      <div class="track-row-actions">
        <button class="btn btn-primary btn-play-item" data-idx="${idx}">▶ Play</button>
        <button class="btn btn-secondary btn-queue-item" data-idx="${idx}">+ Queue</button>
      </div>
    </div>`).join('');
  el.searchDropdown.classList.remove('hidden');

  el.searchDropdown.querySelectorAll('.btn-play-item').forEach((b) =>
    b.addEventListener('click', () => window.triggerPlayOrQueue({ track: tracks[Number(b.dataset.idx)] }, 'now'))
  );
  el.searchDropdown.querySelectorAll('.btn-queue-item').forEach((b) =>
    b.addEventListener('click', () => window.triggerPlayOrQueue({ track: tracks[Number(b.dataset.idx)] }, 'queue'))
  );
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) el.searchDropdown.classList.add('hidden');
});

// --- Transport Controls ---
const sendAction = async (act) => {
  if (act === 'stop') {
    if (isListeningInBrowser && el.browserAudio) {
      el.browserAudio.pause();
      el.browserAudio.src = '';
      isListeningInBrowser = false;
      el.listenLiveBtn.textContent = '🎧 Listen Live in Browser (192kbps)';
      el.listenLiveBtn.classList.remove('active');
    }
  }
  try {
    const res = await fetch(`/api/player/${act}`, { method: 'POST' });
    const data = await res.json();
    if (data.state && window.renderState) window.renderState(data.state);
  } catch {}
};
el.playPauseBtn.addEventListener('click', () => sendAction('toggle'));
el.skipBtn.addEventListener('click', () => sendAction('skip'));
el.stopBtn.addEventListener('click', () => sendAction('stop'));
el.shuffleBtn.addEventListener('click', () => sendAction('shuffle'));
el.loopBtn.addEventListener('click', () => sendAction('loop'));
el.likeBtn.addEventListener('click', () => {
  el.likeBtn.textContent = '✅ Vibe Locked!';
  setTimeout(() => { el.likeBtn.textContent = '👍 Lock Vibe'; }, 1800);
  sendAction('like');
});
el.dislikeBtn.addEventListener('click', () => {
  el.dislikeBtn.textContent = '🚫 Blocked & Skipped!';
  setTimeout(() => { el.dislikeBtn.textContent = '👎 Skip & Cool'; }, 1800);
  sendAction('dislike');
});
el.clearQueueBtn.addEventListener('click', () => sendAction('clear'));
if (el.autoplayBtn) {
  el.autoplayBtn.addEventListener('click', async () => {
    const nextVal = !(window.currentShow && window.currentShow.autoplay !== false);
    const res = await fetch('/api/vibe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoplay: nextVal }) });
    const data = await res.json();
    if (data.state && window.renderState) window.renderState(data.state);
  });
}
if (el.djVoiceBtn) {
  el.djVoiceBtn.addEventListener('click', async () => {
    const res = await fetch('/api/dj/toggle', { method: 'POST' });
    const data = await res.json();
    if (data.state && window.renderState) window.renderState(data.state);
  });
}
