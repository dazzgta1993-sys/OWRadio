/**
 * @file web/public/app.js
 * @description Clean Frontend Controller for OWRadio Studio Dashboard.
 * Zero fake telemetry — binds directly to the Triple-Deck Player, Multi-Cloud Search,
 * Official Charts, and live 192kbps Browser Audio Stream with responsive volume control.
 */

const el = {
  searchInput: document.getElementById('searchInput'),
  playQueryBtn: document.getElementById('playQueryBtn'),
  queueQueryBtn: document.getElementById('queueQueryBtn'),
  searchDropdown: document.getElementById('searchResultsDropdown'),
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
};

let isListeningInBrowser = false;
let searchDebounce = null;
let savedVolume = Number(localStorage.getItem('owradio_vol') ?? 85);

function formatSecs(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem < 10 ? '0' : ''}${rem}`;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

// --- Volume Control (Local Browser Audio + Server Broadcast Gain) ---
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
    fetch('/api/player/volume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ volume: clamped }),
    }).catch(() => {});
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
    el.browserAudio.play().catch(() => {});
    isListeningInBrowser = true;
    el.listenLiveBtn.textContent = '🎧 Streaming Live (Click to Mute)';
    el.listenLiveBtn.classList.add('active');
  } else {
    el.browserAudio.pause();
    el.browserAudio.src = '';
    isListeningInBrowser = false;
    el.listenLiveBtn.textContent = '🎧 Listen Live in Browser (192kbps)';
    el.listenLiveBtn.classList.remove('active');
  }
});

// --- Search & Direct Play / Queue ---
async function triggerPlayOrQueue(payload, mode = 'now') {
  el.searchDropdown.classList.add('hidden');
  await fetch('/api/play', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, mode }),
  });
}

el.playQueryBtn.addEventListener('click', () => {
  const q = el.searchInput.value.trim();
  if (q) triggerPlayOrQueue({ query: q }, 'now');
});
el.queueQueryBtn.addEventListener('click', () => {
  const q = el.searchInput.value.trim();
  if (q) triggerPlayOrQueue({ query: q }, 'queue');
});
el.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && el.searchInput.value.trim()) {
    triggerPlayOrQueue({ query: el.searchInput.value.trim() }, 'now');
  }
});
el.searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = el.searchInput.value.trim();
  if (q.length < 2 || q.startsWith('http')) {
    el.searchDropdown.classList.add('hidden');
    return;
  }
  searchDebounce = setTimeout(async () => {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    renderSearchDropdown(data.results || []);
  }, 260);
});

function renderSearchDropdown(tracks) {
  if (!tracks.length) {
    el.searchDropdown.classList.add('hidden');
    return;
  }
  el.searchDropdown.innerHTML = tracks
    .map(
      (t, idx) => `
    <div class="track-row" data-idx="${idx}">
      <div class="track-row-left">
        <img src="${escapeHtml(t.artworkUrl || '')}" alt="" />
        <div>
          <div class="track-row-title">${escapeHtml(t.title)}</div>
          <div class="track-row-sub">${escapeHtml(t.artist)}${t.album ? ' • ' + escapeHtml(t.album) : ''} (${escapeHtml(t.durationFormatted || formatSecs(t.duration))})</div>
        </div>
      </div>
      <div class="track-row-actions">
        <button class="btn btn-primary btn-play-item" data-idx="${idx}">▶ Play</button>
        <button class="btn btn-secondary btn-queue-item" data-idx="${idx}">+ Queue</button>
      </div>
    </div>`
    )
    .join('');
  el.searchDropdown.classList.remove('hidden');

  el.searchDropdown.querySelectorAll('.btn-play-item').forEach((btn) => {
    btn.addEventListener('click', () => triggerPlayOrQueue({ track: tracks[Number(btn.dataset.idx)] }, 'now'));
  });
  el.searchDropdown.querySelectorAll('.btn-queue-item').forEach((btn) => {
    btn.addEventListener('click', () => triggerPlayOrQueue({ track: tracks[Number(btn.dataset.idx)] }, 'queue'));
  });
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) el.searchDropdown.classList.add('hidden');
});

// --- Transport Controls ---
const sendAction = (act) => fetch(`/api/player/${act}`, { method: 'POST' });
el.playPauseBtn.addEventListener('click', () => sendAction('toggle'));
el.skipBtn.addEventListener('click', () => sendAction('skip'));
el.stopBtn.addEventListener('click', () => sendAction('stop'));
el.likeBtn.addEventListener('click', () => sendAction('like'));
el.dislikeBtn.addEventListener('click', () => sendAction('dislike'));
el.clearQueueBtn.addEventListener('click', () => sendAction('clear'));

// --- Tabs & Official Charts ---
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.add('hidden'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById(`tab-${tab}`).classList.remove('hidden');
    if (tab === 'charts' && !el.chartsList.children.length) loadOfficialCharts('gb');
  });
});

async function loadOfficialCharts(country = 'gb') {
  el.chartsList.innerHTML = '<div style="padding:16px;color:#9ca3af;">Loading Official Top 40...</div>';
  const res = await fetch(`/api/charts?country=${country}`);
  const data = await res.json();
  const tracks = data.tracks || [];
  el.chartsList.innerHTML = tracks
    .map(
      (t, i) => `
    <div class="track-row">
      <div class="track-row-left">
        <span style="width:24px;color:#9ca3af;font-weight:700;">#${i + 1}</span>
        <img src="${escapeHtml(t.cover)}" alt="" />
        <div>
          <div class="track-row-title">${escapeHtml(t.title)}</div>
          <div class="track-row-sub">${escapeHtml(t.artist)} • ${escapeHtml(t.album || '')}</div>
        </div>
      </div>
      <div class="track-row-actions">
        <button class="btn btn-primary chart-play" data-idx="${i}">▶ Play</button>
        <button class="btn btn-secondary chart-queue" data-idx="${i}">+ Queue</button>
      </div>
    </div>`
    )
    .join('');

  el.chartsList.querySelectorAll('.chart-play').forEach((b) => {
    b.addEventListener('click', () => triggerPlayOrQueue({ track: tracks[Number(b.dataset.idx)] }, 'now'));
  });
  el.chartsList.querySelectorAll('.chart-queue').forEach((b) => {
    b.addEventListener('click', () => triggerPlayOrQueue({ track: tracks[Number(b.dataset.idx)] }, 'queue'));
  });
}

document.querySelectorAll('.chart-country-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chart-country-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    loadOfficialCharts(btn.dataset.country);
  });
});

// --- Vibe Engine Controls ---
document.querySelectorAll('#vibeModeGroup .choice-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    fetch('/api/vibe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: btn.dataset.mode }) });
  });
});
document.querySelectorAll('#vibeEngineGroup .choice-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    fetch('/api/vibe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: btn.dataset.engine }) });
  });
});

// --- Render Live State ---
function renderState(s) {
  if (!s) return;
  el.anchorPill.textContent = `⚓ Anchor: ${s.vibeAnchorArtist || 'Auto'}`;
  el.playPauseBtn.textContent = s.isPlaying && !s.isPaused ? '⏸' : '▶';

  const np = s.nowPlaying;
  if (np) {
    el.nowPlayingTitle.textContent = np.title;
    el.nowPlayingArtist.textContent = np.artist;
    el.nowPlayingAlbum.textContent = np.album ? `${np.album}${np.releaseYear ? ' (' + np.releaseYear + ')' : ''}` : '';
    if (np.artworkUrl) el.nowPlayingArt.src = np.artworkUrl;
    el.sourceBadge.textContent = (np.source || 'STUDIO').toUpperCase();
    el.vibeReasonBadge.textContent = np.vibeReason || s.lastVibeDecision || `⚓ Anchor: ${s.vibeAnchorArtist || np.artist}`;
    const dur = np.duration || 0;
    const elap = s.elapsed || 0;
    el.elapsedTime.textContent = formatSecs(elap);
    el.totalDuration.textContent = formatSecs(dur);
    el.progressFill.style.width = dur > 0 ? `${Math.min(100, (elap / dur) * 100)}%` : '0%';
  } else {
    el.nowPlayingTitle.textContent = 'Ready to Broadcast';
    el.nowPlayingArtist.textContent = 'Search any song or pick a chart track';
    el.nowPlayingAlbum.textContent = '';
    el.elapsedTime.textContent = '0:00';
    el.totalDuration.textContent = '0:00';
    el.progressFill.style.width = '0%';
  }

  const nextUp = (s.queue && s.queue[0]) || s.deck2;
  if (nextUp) {
    el.deck2Banner.classList.remove('hidden');
    el.deck2Text.textContent = `Deck 2 Ready: ${nextUp.title} — ${nextUp.artist}`;
    el.deck2PrewarmTag.textContent = nextUp.isPrewarmed ? '⚡ STREAM READY' : '⏳ RESOLVING';
  } else {
    el.deck2Banner.classList.add('hidden');
  }

  const qList = s.queue || [];
  el.queueCount.textContent = String(qList.length);
  el.queueList.innerHTML = qList.length
    ? qList.map((t, i) => `
      <div class="track-row">
        <div class="track-row-left">
          <span style="width:20px;color:#9ca3af;">${i + 1}</span>
          <img src="${escapeHtml(t.artworkUrl || '')}" alt="" />
          <div>
            <div class="track-row-title">${escapeHtml(t.title)}</div>
            <div class="track-row-sub">${escapeHtml(t.artist)}${t.vibeReason ? ' • ' + escapeHtml(t.vibeReason) : ''}</div>
          </div>
        </div>
        <div class="track-row-actions"><span style="font-size:11px;color:#9ca3af;">${escapeHtml(t.durationFormatted || formatSecs(t.duration))}</span></div>
      </div>`).join('')
    : '<div style="padding:20px;color:#9ca3af;text-align:center;">Queue is clear — Autoplay Vibe Engine will cue Deck 2 & Deck 3 automatically once a song plays.</div>';

  el.historyList.innerHTML = (s.history || []).map((t) => `
    <div class="track-row">
      <div class="track-row-left">
        <img src="${escapeHtml(t.artworkUrl || '')}" alt="" />
        <div><div class="track-row-title">${escapeHtml(t.title)}</div><div class="track-row-sub">${escapeHtml(t.artist)}</div></div>
      </div>
    </div>`).join('');

  document.querySelectorAll('#vibeModeGroup .choice-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === s.vibeMode));
  document.querySelectorAll('#vibeEngineGroup .choice-btn').forEach((b) => b.classList.toggle('active', b.dataset.engine === s.vibeEngineSource));
}

const evtSource = new EventSource('/api/events');
evtSource.addEventListener('state', (e) => {
  try { renderState(JSON.parse(e.data)); } catch {}
});
