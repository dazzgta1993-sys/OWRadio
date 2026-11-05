/**
 * @file app.js
 * @description Real-time frontend synchronization for OWRadio Web Dashboard via Server-Sent Events (SSE).
 * Supports Level 1 (Minimal Quick Search), Level 2 (Studio Dashboard), and Level 3 (Settings).
 */

// --- Global API Interceptor for Admin Authentication ---
const originalFetch = window.fetch;
window.fetch = async function (...args) {
  const res = await originalFetch.apply(this, args);
  if (res.status === 401) {
    const rawUrl = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    if (rawUrl.startsWith('/api/') && !rawUrl.includes('/api/auth/')) {
      if (typeof showToast === 'function') {
        showToast('Admin authentication required', 'warning');
      }
      if (typeof openAuthModal === 'function') {
        openAuthModal();
      }
    }
  }
  return res;
};

let currentState = null;
let currentMode = 'song';
let isBrowserAudioPlaying = false;
let currentLevel = 1;
let evtSource = null;
let currentBrainData = null;
let currentBrainSubTab = 'pref';
let brainPollInterval = null;

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = String(Math.floor(seconds % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

// Switch between Level 1 (Minimal), Level 2 (Studio), Level 3 (Brain Logs), and Level 4 (Settings)
function switchLevel(lvl) {
  // If authentication is active and user is not logged in as Admin, lock out levels 2, 3, 4
  if (lvl > 1 && currentAuthState.enabled && !currentAuthState.authenticated) {
    if (typeof showToast === 'function') {
      showToast('Admin password required to unlock Studio Dashboard', 'warning');
    }
    if (typeof openAuthModal === 'function') {
      openAuthModal();
    }
    lvl = 1;
  }

  currentLevel = lvl;
  localStorage.setItem('vexo_ui_level', String(lvl));

  // Update tabs
  document.querySelectorAll('.level-tab').forEach((tab) => {
    const tabLvl = parseInt(tab.getAttribute('data-level'), 10);
    if (tabLvl === lvl) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  // Toggle views
  const v1 = document.getElementById('view-level-1');
  const v2 = document.getElementById('view-level-2');
  const v3 = document.getElementById('view-level-3');
  const v4 = document.getElementById('view-level-4');

  if (v1) v1.style.display = lvl === 1 ? 'flex' : 'none';
  if (v2) v2.style.display = lvl === 2 ? 'block' : 'none';
  if (v3) v3.style.display = lvl === 3 ? 'block' : 'none';
  if (v4) v4.style.display = lvl === 4 ? 'block' : 'none';

  if (lvl === 1) {
    const input = document.getElementById('hero-input');
    if (input) input.focus();
  }

  if (lvl === 2) {
    initWaveform();
    loadFeatureFlags();
  }

  if (lvl === 3) {
    fetchBrainData();
    fetchTasteRadar();
    if (!brainPollInterval) {
      brainPollInterval = setInterval(fetchBrainData, 4000);
    }
  } else if (brainPollInterval) {
    clearInterval(brainPollInterval);
    brainPollInterval = null;
  }

  if (lvl === 4) {
    loadFeatureFlags();
    loadSettingsSubsystems();
    loadVetoes();
  }
}

function setSyncStatus(status) {
  const statusEl = document.getElementById('server-status');
  const dotEl = document.querySelector('.status-badge .pulse-dot');
  if (!statusEl) return;

  if (status === 'live') {
    statusEl.innerText = 'LIVE SYNC';
    statusEl.style.color = 'var(--success)';
    if (dotEl) {
      dotEl.style.background = 'var(--success)';
      dotEl.style.boxShadow = '0 0 8px rgba(16, 185, 129, 0.7)';
      dotEl.style.animation = 'pulse 2s infinite';
    }
  } else if (status === 'reconnecting') {
    statusEl.innerText = 'RECONNECTING...';
    statusEl.style.color = '#eab308';
    if (dotEl) {
      dotEl.style.background = '#eab308';
      dotEl.style.boxShadow = '0 0 8px rgba(234, 179, 8, 0.7)';
      dotEl.style.animation = 'none';
    }
  } else {
    statusEl.innerText = 'OFFLINE';
    statusEl.style.color = 'var(--danger)';
    if (dotEl) {
      dotEl.style.background = 'var(--danger)';
      dotEl.style.boxShadow = '0 0 8px rgba(239, 68, 68, 0.7)';
      dotEl.style.animation = 'none';
    }
  }
}

// Connect to Server-Sent Events stream (with multi-state sync indicator)
function connectSSE() {
  if (evtSource) {
    try {
      evtSource.close();
    } catch {}
    evtSource = null;
  }
  evtSource = new EventSource('/api/events');

  evtSource.onopen = () => {
    setSyncStatus('live');
  };

  evtSource.addEventListener('open', () => {
    setSyncStatus('live');
  });

  evtSource.addEventListener('state', (e) => {
    setSyncStatus('live');
    try {
      const data = JSON.parse(e.data);
      updateDashboard(data);
    } catch (err) {
      console.error('Error parsing SSE state payload:', err);
    }
  });

  evtSource.addEventListener('ping', () => {
    setSyncStatus('live');
  });

  evtSource.onerror = () => {
    setSyncStatus('reconnecting');
    if (evtSource) {
      try {
        evtSource.close();
      } catch {}
      evtSource = null;
    }
    setTimeout(connectSSE, 3000);
  };
}

// Reconnect instantly when browser tab gains focus / un-sleeps
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!evtSource || evtSource.readyState === EventSource.CLOSED) {
      connectSSE();
    }
  }
});

let lastPlayedTrackId = undefined;

// ========================================================
// BRAIN MATRIX • NEURAL EXECUTION STACK (LEVEL 2)
// ========================================================
let lastRenderedBrainTrackId = undefined;
let lastRenderedBrainActiveCount = -1;

const DEFAULT_BRAIN_PILLS = [
  { id: 'jev_decision', name: 'Jev Decision Engine', category: 'engine', categoryLabel: 'Decision Engines', icon: '🎯', tag: 'DECISION', description: 'Discriminative multi-candidate ranking model scoring tracks by listener affinity overlap and freshness decay.', defaultOffTelemetry: 'Dormant: Station running in Hybrid JIT mode; Jev ranker not engaged.' },
  { id: 'vector_latent', name: 'Vector Latent JEPA', category: 'engine', categoryLabel: 'Decision Engines', icon: '⚡', tag: 'LATENT', description: '384-dimensional cosine similarity matching in RAM embedding space finding nearest acoustic neighbors to the room centroid.', defaultOffTelemetry: 'Dormant: Latent vector cosine space on standby; track resolved via collaborative open graph.' },
  { id: 'hybrid_jit', name: 'Hybrid JIT Graph', category: 'engine', categoryLabel: 'Decision Engines', icon: '🔀', tag: 'JIT-GRAPH', description: 'Real-time 300ms traversal of Deezer & Last.fm 100M+ open collaborative music graphs, completely bypassing static database scraping.', defaultOffTelemetry: 'Dormant: Collaborative graph not selected for this cut.' },
  { id: 'qwen_llm', name: 'Qwen 1.5B Local LLM', category: 'engine', categoryLabel: 'Decision Engines', icon: '🤖', tag: 'NEURAL-LLM', description: 'Local compact 1.5B parameter neural language model running locally (clamped to 2 CPU threads), translating human vibes and listener affinities into curated picks.', defaultOffTelemetry: 'Dormant: Local LLM inference idle; track curated without language model tokens.' },
  { id: 'anchor_20', name: '20% Core Anchor', category: 'engine', categoryLabel: 'Decision Engines', icon: '⚓', tag: 'ANTI-ECHO', description: '1st Anti-Echo shield: plays verified comfort favorites and cornerstone tracks directly from active listeners’ seeds.', defaultOffTelemetry: 'Dormant: Random roll bypassed core anchor slice in favor of deep-cut exploration.' },
  { id: 'deepcut_50', name: '50% Collaborative Deep-Cut', category: 'engine', categoryLabel: 'Decision Engines', icon: '🔍', tag: 'DEEP-CUT', description: '2nd Anti-Echo shield: explores 1st-degree related artist graphs (ranks 5–30) to unearth obscure album b-sides listeners haven’t heard recently.', defaultOffTelemetry: 'Dormant: Collaborative deep-cut slice was not chosen for this track.' },
  { id: 'bridge_30', name: '30% Musical Bridge', category: 'engine', categoryLabel: 'Decision Engines', icon: '🌉', tag: 'BRIDGE', description: '3rd Anti-Echo shield: identifies transitional artists that harmonize disparate musical tastes between multiple listeners in the channel.', defaultOffTelemetry: 'Dormant: Musical bridge slice not active for this playback cycle.' },
  { id: 'catalog_vault', name: 'Local Catalog Vault', category: 'engine', categoryLabel: 'Decision Engines', icon: '🏛️', tag: 'LIBRARY', description: 'Autonomous catalog library selection: mines unplayed deep discoveries (0 plays) or longest-rested anti-fatigue tracks from local SQLite storage.', defaultOffTelemetry: 'Dormant: Track sourced directly from online collaborative streaming.' },
  { id: 'time_capsule', name: 'Grounded Time Capsule', category: 'engine', categoryLabel: 'Decision Engines', icon: '⏳', tag: 'HISTORICAL', description: 'Strict historical release date grounding: locks curation into verified record release dates for a vintage era (e.g. 1984) with zero hallucination.', defaultOffTelemetry: 'Dormant: Time Capsule vintage era lock is currently inactive.' },
  { id: 'story_arc', name: 'Story Arc / Circadian', category: 'engine', categoryLabel: 'Decision Engines', icon: '🌅', tag: 'CIRCADIAN', description: 'Modulates station energy across the day via a 4-phase broadcast cycle (Warmup ➔ Build ➔ Climax ➔ Chill) aligned with real-time circadian hours.', defaultOffTelemetry: 'Dormant: Station running freeform autoplay without active story arc constraints.' },
  { id: 'user_request', name: 'User / VIP Request', category: 'engine', categoryLabel: 'Decision Engines', icon: '👑', tag: 'VIP-QUEUE', description: 'Explicit listener request submitted via Discord /play or Web Studio queue; bypasses all autoplay heuristics and gives instant priority.', defaultOffTelemetry: 'Dormant: Autonomous autoplay track (not a manual user submission).' },
  { id: 'vibe_recipe', name: 'AI Vibe Recipe', category: 'engine', categoryLabel: 'Decision Engines', icon: '✨', tag: 'VIBE-NLP', description: 'Natural language prompt steering: translates vibes (e.g., "cyberpunk rainy drive") into acoustic and genre filters.', defaultOffTelemetry: 'Dormant: No natural language vibe steering prompt currently applied.' },

  { id: 'camelot_lock', name: 'Camelot Harmonic Lock', category: 'harmonic', categoryLabel: 'Acoustic & Harmonics', icon: '🎚️', tag: 'HARMONIC', description: 'Evaluates musical key compatibility on the 12-hour Camelot Wheel between consecutive tracks (relative major/minor, +1/-1 step) for zero harmonic dissonance.', defaultOffTelemetry: 'Dormant: Key transition outside adjacent harmonic positions.' },
  { id: 'bpm_sync', name: 'BPM Beat-Sync Lock', category: 'harmonic', categoryLabel: 'Acoustic & Harmonics', icon: '⏱️', tag: 'TEMPO', description: 'Calculates tempo proximity (Δ ≤ 6% or ≤ 14%) to prevent jarring rhythm disruptions and ensure smooth, danceable station transitions.', defaultOffTelemetry: 'Dormant: Tempo delta greater than 14% (abrupt tempo change).' },
  { id: 'adaptive_crossfade', name: 'Adaptive Crossfade', category: 'harmonic', categoryLabel: 'Acoustic & Harmonics', icon: '🌊', tag: 'CROSSFADE', description: 'Dynamically modulates crossfade envelope length (1.0s to 4.0s) in real time based on harmonic compatibility and beat alignment.', defaultOffTelemetry: 'Dormant: Standard cut applied; dynamic crossfade curve disabled.' },
  { id: 'taste_radar', name: '8-Axis Taste Radar', category: 'consensus', categoryLabel: 'Taste Consensus', icon: '🕸️', tag: 'TASTE-DNA', description: 'Projects the room’s collective taste onto 8 acoustic dimensions (Electronic, Rock, Synth, Funk, Hip-Hop, Indie, Chill, Energy) and computes track alignment %.', defaultOffTelemetry: 'Dormant: No active Discord listeners in voice to compute collective taste centroid.' },
  { id: 'ebu_loudness', name: 'EBU R128 Loudness', category: 'harmonic', categoryLabel: 'Acoustic & Harmonics', icon: '🔊', tag: 'BROADCAST', description: 'Real-time integrated LUFS loudness normalization (-14 LUFS target) to eliminate volume jumps between disparate albums and production eras.', defaultOffTelemetry: 'Dormant: Loudness normalization bypassed.' },

  { id: 'cooldown_48h', name: '48h Song Cooldown', category: 'purity', categoryLabel: 'Purity & Gatekeepers', icon: '🛡️', tag: 'ANTI-REPEAT', description: 'Hard mathematical shield: guarantees zero songs can repeat within 48 hours across the entire station.', defaultOffTelemetry: 'Dormant: Manual request bypassed autoplay repetition cooldowns.' },
  { id: 'artist_cooldown_2h', name: '2h Artist Cooldown', category: 'purity', categoryLabel: 'Purity & Gatekeepers', icon: '🚫', tag: 'NO-CLUSTERING', description: 'Artist anti-clustering rule: mathematically blocks any artist from repeating within 120 minutes of their previous play.', defaultOffTelemetry: 'Dormant: Manual request bypassed artist anti-clustering cooldown.' },
  { id: 'lyrics_nlp', name: 'Lyrics NLP English Gate', category: 'purity', categoryLabel: 'Purity & Gatekeepers', icon: '🗣️', tag: 'LYRICS-NLP', description: 'Analyzes synchronized lyrics via LRCLIB with trigram & stopword language classification to ensure 99.9% English discovery.', defaultOffTelemetry: 'Dormant: Lyrics NLP verification idle or foreign cooldown lock active.' },
  { id: 'duration_clamp', name: 'Duration Clamp (±5s)', category: 'purity', categoryLabel: 'Purity & Gatekeepers', icon: '📏', tag: 'STUDIO-CLAMP', description: 'Compares YouTube stream duration against official canonical album duration (Δ ≤ 5s) to eradicate fake 1-hour loops, skits, and 45-minute album rips.', defaultOffTelemetry: 'Dormant: Duration delta clamp bypassed for manual user request.' },
  { id: 'topic_master', name: 'Topic Studio Master', category: 'purity', categoryLabel: 'Purity & Gatekeepers', icon: '🎯', tag: 'OFFICIAL-AUDIO', description: 'Prioritizes verified label "- Topic" channels and official studio masters, eliminating crowd noise, dialogue skits, and low-grade recordings.', defaultOffTelemetry: 'Dormant: Streamed from alternate verified source.' },
  { id: 'room_veto_shield', name: 'Room Veto Shield', category: 'purity', categoryLabel: 'Purity & Gatekeepers', icon: '⛔', tag: 'BLACKLIST', description: 'Real-time blacklist filter: cross-references candidate against active listeners’ vetoed artists and disliked tracks.', defaultOffTelemetry: 'Dormant: Room veto shield bypassed.' },

  { id: 'ram_prewarm', name: 'RAM Prewarm Deck', category: 'muscle', categoryLabel: 'Audio Muscle', icon: '⚡', tag: 'ZERO-GAP', description: 'Pre-buffers 512KB of upcoming audio into RAM before handover, delivering near-instantaneous sub-second transitions with zero dead air.', defaultOffTelemetry: 'Dormant: Cold-start stream resolution (prewarm buffer was not primed).' },
];

function renderBrainMatrix() { return; }

function updateDashboard(state) {
  setSyncStatus('live');
  currentState = state;

  // --- Update Level 2 Elements ---
  const titleEl = document.getElementById('track-title');
  const artistEl = document.getElementById('track-artist');
  const artEl = document.getElementById('track-art');
  const badgeEl = document.getElementById('track-badge');
  const reasonEl = document.getElementById('track-reason');
  const pauseBtn = document.getElementById('btn-pause');

  // --- Update Level 1 Mini-Player Elements ---
  const miniTitleEl = document.getElementById('mini-title');
  const miniArtistEl = document.getElementById('mini-artist');
  const miniArtEl = document.getElementById('mini-art');
  const miniPauseBtn = document.getElementById('mini-btn-pause');

  if (state.track) {
    if (lastPlayedTrackId !== state.track.id) {
      lastPlayedTrackId = state.track.id;
      if (isFlagActive('feature_taste_radar_chart')) {
        fetchTasteRadar();
      }
    }
    const artwork = state.track.artworkUrl || state.track.artworkThumbUrl || 'https://e-cdn-images.dzcdn.net/images/cover/d41d8cd98f00b204e9800998ecf8427e/500x500-000000-80-0-0.jpg';

    if (titleEl) titleEl.innerText = state.track.title;
    if (artistEl) artistEl.innerText = state.track.artist;
    if (artEl) artEl.src = artwork;
    if (badgeEl) badgeEl.innerText = state.track.curatedBy || 'AUTOPLAY';
    if (reasonEl) reasonEl.innerText = state.track.curationReason ? `💡 ${state.track.curationReason}` : '';

    if (miniTitleEl) miniTitleEl.innerText = state.track.title;
    if (miniArtistEl) miniArtistEl.innerText = state.track.artist;
    if (miniArtEl) miniArtEl.src = artwork;

    const timeTotalEl = document.getElementById('time-total');
    if (timeTotalEl) timeTotalEl.innerText = formatTime(state.track.durationSec);
    updateProgress(state.track.elapsedSec, state.track.durationSec);
  } else {
    if (lastPlayedTrackId !== null) {
      lastPlayedTrackId = null;
      if (isFlagActive('feature_taste_radar_chart')) {
        fetchTasteRadar();
      }
    }
    if (titleEl) titleEl.innerText = 'Waiting for playback...';
    if (artistEl) artistEl.innerText = 'Autonomous Music Engine';
    if (badgeEl) badgeEl.innerText = 'IDLE';
    if (reasonEl) reasonEl.innerText = '';

    if (miniTitleEl) miniTitleEl.innerText = 'Waiting for track...';
    if (miniArtistEl) miniArtistEl.innerText = 'Autonomous Music Engine';

    const progressFill = document.getElementById('progress-fill');
    if (progressFill) progressFill.style.width = '0%';
    const timeElapsed = document.getElementById('time-elapsed');
    if (timeElapsed) timeElapsed.innerText = '0:00';
    const timeTotal = document.getElementById('time-total');
    if (timeTotal) timeTotal.innerText = '0:00';
  }

  const isPlaying = state.state === 'playing';
  if (pauseBtn) pauseBtn.innerText = isPlaying ? '⏸️' : '▶️';
  if (miniPauseBtn) miniPauseBtn.innerText = isPlaying ? '⏸️' : '▶️';

  // Update room listeners
  const listenersBox = document.getElementById('listeners-box');
  if (listenersBox) {
    if (state.roomListeners && state.roomListeners.length > 0) {
      listenersBox.innerHTML = state.roomListeners
        .map((name) => `<div class="listener-pill"><span>👤</span> ${name}</div>`)
        .join('');
    } else {
      listenersBox.innerHTML = '<span style="color: var(--text-subtle); font-size: 13px;">No active Discord listeners</span>';
    }
  }

  // Fetch full queue for the sidebar
  fetchQueue();

  // Update live waveform cues & transition timer
  updateWaveformCues();

  // Update Brain Matrix Neural Stack
  renderBrainMatrix(state.brainPills, state.track);
}

function updateProgress(elapsed, total) {
  if (!total) return;
  const pct = Math.min(100, (elapsed / total) * 100);
  const fill = document.getElementById('progress-fill');
  const elapsedEl = document.getElementById('time-elapsed');
  if (fill) fill.style.width = `${pct}%`;
  if (elapsedEl) elapsedEl.innerText = formatTime(elapsed);
}

// Local progress ticker between SSE updates
setInterval(() => {
  if (currentState && currentState.track && currentState.state === 'playing') {
    currentState.track.elapsedSec += 1;
    updateProgress(currentState.track.elapsedSec, currentState.track.durationSec);
    updateWaveformCues();
  }
}, 1000);

async function fetchQueue() {
  try {
    const res = await fetch('/api/queue');
    const data = await res.json();
    const queueBox = document.getElementById('queue-box');
    if (!queueBox) return;

    if (!data.upcoming || data.upcoming.length === 0) {
      queueBox.innerHTML = '<div style="color: var(--text-subtle); font-size: 13px; text-align: center; padding: 20px;">Queue is empty</div>';
      return;
    }

    queueBox.innerHTML = data.upcoming
      .map((t, idx) => {
        let badgeHtml = escapeHtml(t.curatedBy || 'Upcoming');
        let badgeStyle = '';
        if (t.requestType === 'single') {
          badgeHtml = '⭐ VIP Single';
          badgeStyle = 'background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4);';
        } else if (t.requestType === 'playlist') {
          badgeHtml = escapeHtml(t.playlistTitle ? `📋 ${t.playlistTitle}` : '📋 Blend');
          badgeStyle = 'background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3);';
        }
        return `
      <div class="queue-item" style="cursor: pointer;" onclick="skipToQueueIndex(${idx})" title="Click to jump and play immediately">
        <img class="queue-thumb" src="${t.artworkThumbUrl || t.artworkUrl || ''}" alt="thumb">
        <div class="queue-meta">
          <div class="queue-title">${escapeHtml(t.title)}</div>
          <div class="queue-artist">${escapeHtml(t.artist)}</div>
        </div>
        <div class="queue-badge" style="${badgeStyle}">${badgeHtml}</div>
      </div>
    `;
      })
      .join('');
  } catch (err) {
    console.error('Failed to fetch queue:', err);
  }
}

async function triggerAction(action) {
  try {
    const res = await fetch(`/api/player/${action}`, { method: 'POST' });
    if (res.status === 401) {
      openAuthModal();
      return;
    }
  } catch (err) {
    console.error(`Action ${action} failed:`, err);
  }
}

function togglePlayPause() {
  if (!currentState) return;
  if (currentState.state === 'playing') {
    triggerAction('pause');
  } else {
    triggerAction('resume');
  }
}

function toggleBrowserAudio() {
  const audio = document.getElementById('browser-audio');
  const btn = document.getElementById('btn-listen');
  if (!audio || !btn) return;

  if (isBrowserAudioPlaying) {
    audio.pause();
    isBrowserAudioPlaying = false;
    btn.innerText = '▶ Listen in Browser';
  } else {
    audio.src = `/stream.mp3?t=${Date.now()}`;
    audio.play();
    isBrowserAudioPlaying = true;
    btn.innerText = '⏹ Stop Listening';
  }
}

function copyStreamUrl() {
  const url = `${window.location.origin}/stream.mp3`;
  navigator.clipboard.writeText(url).then(() => {
    alert(`Stream URL copied to clipboard:\n${url}`);
  });
}

// Level 1: Quick Search Form Submission
function handleHeroEnterKey() {
  const isAuth = !currentAuthState.enabled || !!currentAuthState.authenticated;
  submitHero(isAuth);
}

async function submitHero(playNow) {
  const isAuth = !currentAuthState.enabled || !!currentAuthState.authenticated;
  const effectivePlayNow = isAuth && Boolean(playNow);
  const input = document.getElementById('hero-input');
  const feedback = document.getElementById('hero-feedback');
  const query = input ? input.value.trim() : '';

  if (!query) {
    if (feedback) {
      feedback.style.color = 'var(--danger)';
      feedback.innerText = 'Please enter a song name or YouTube/Spotify URL.';
    }
    return;
  }

  if (feedback) {
    feedback.style.color = 'var(--accent)';
    feedback.innerText = effectivePlayNow ? 'Resolving & playing track...' : 'Searching & adding to queue...';
  }

  try {
    const res = await fetch('/api/queue/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, mode: 'song', playNow: effectivePlayNow }),
    });

    const data = await res.json();
    if (res.ok) {
      if (feedback) {
        feedback.style.color = 'var(--success)';
        const trackTitle = data.track ? `${data.track.artist} - ${data.track.title}` : (data.enqueuedCount ? `${data.enqueuedCount} tracks` : query);
        feedback.innerText = effectivePlayNow ? `▶ Playing: ${trackTitle}` : `✓ Added to Queue: ${trackTitle}`;
      }
      if (input) input.value = '';
    } else {
      if (feedback) {
        feedback.style.color = 'var(--danger)';
        feedback.innerText = data.error || 'Could not find or stream this track.';
      }
    }
  } catch (err) {
    if (feedback) {
      feedback.style.color = 'var(--danger)';
      feedback.innerText = `Network error: ${err.message}`;
    }
  }
}

function setHeroQuery(query) {
  const input = document.getElementById('hero-input');
  if (input) {
    input.value = query;
    input.focus();
  }
}

// Modal handling (for Level 2)
function openModal() {
  const modal = document.getElementById('add-modal');
  if (modal) modal.style.display = 'flex';
}

function closeModal() {
  const modal = document.getElementById('add-modal');
  if (modal) modal.style.display = 'none';
}

function switchTab(mode) {
  currentMode = mode;
  const tabSong = document.getElementById('tab-song');
  const tabVibe = document.getElementById('tab-vibe');
  const contentSong = document.getElementById('content-song');
  const contentVibe = document.getElementById('content-vibe');

  if (tabSong && tabVibe && contentSong && contentVibe) {
    tabSong.classList.toggle('active', mode === 'song');
    tabVibe.classList.toggle('active', mode === 'vibe');
    contentSong.style.display = mode === 'song' ? 'block' : 'none';
    contentVibe.style.display = mode === 'vibe' ? 'block' : 'none';
  }
}

async function submitAdd() {
  const query = currentMode === 'song'
    ? document.getElementById('input-query')?.value.trim()
    : document.getElementById('input-vibe')?.value.trim();

  if (!query) return;

  try {
    await fetch('/api/queue/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, mode: currentMode }),
    });
    closeModal();
    const queryInput = document.getElementById('input-query');
    const vibeInput = document.getElementById('input-vibe');
    if (queryInput) queryInput.value = '';
    if (vibeInput) vibeInput.value = '';
  } catch (err) {
    alert(`Failed to enqueue track: ${err.message}`);
  }
}

// ========================================================
// AUTHENTICATION SUBSYSTEM (Double Auth: Password + Google)
// ========================================================

let currentAuthState = {
  enabled: false,
  authMode: 'none',
  authenticated: true,
  user: null,
  supabaseConfig: null,
};

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth/status');
    if (!res.ok) return;
    currentAuthState = await res.json();
    renderAuthUI();
  } catch (err) {
    console.error('Failed to check auth status:', err);
  }
}

function renderAuthUI() {
  const container = document.getElementById('auth-status-container');
  const btn = document.getElementById('auth-btn');
  const icon = document.getElementById('auth-btn-icon');
  const text = document.getElementById('auth-btn-text');
  const supaContainer = document.getElementById('supabase-oauth-container');

  if (!container || !btn) return;

  if (!currentAuthState.enabled) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'flex';
  const isAuth = !!currentAuthState.authenticated;

  // Toggle Level 1 Play Now button (Admin only; unauthenticated visitors only see '+ Add to Queue')
  const heroPlayBtn = document.getElementById('btn-hero-play');
  const heroQueueBtn = document.getElementById('btn-hero-queue');
  if (heroPlayBtn && heroQueueBtn) {
    if (isAuth) {
      heroPlayBtn.style.display = 'inline-flex';
      heroQueueBtn.className = 'btn';
      heroQueueBtn.style.padding = '14px 24px';
    } else {
      heroPlayBtn.style.display = 'none';
      heroQueueBtn.className = 'btn btn-primary';
      heroQueueBtn.style.padding = '14px 28px';
    }
  }

  // Hide or show Level 2 (Studio), Level 3 (Brain), Level 4 (Settings) navigation tabs
  document.querySelectorAll('.level-tab').forEach((tab) => {
    const tabLvl = parseInt(tab.getAttribute('data-level'), 10);
    if (tabLvl > 1) {
      tab.style.display = isAuth ? 'inline-flex' : 'none';
    }
  });

  // Toggle Studio button on Level 1 Quick Search mini-player
  const studioBtn = document.getElementById('mini-studio-btn') || document.querySelector('.mini-controls button[onclick*="switchLevel(2)"]');
  if (studioBtn) {
    if (isAuth) {
      studioBtn.innerHTML = 'Studio ↗';
      studioBtn.setAttribute('onclick', 'switchLevel(2)');
      studioBtn.title = 'Open Full Studio Dashboard';
    } else {
      studioBtn.innerHTML = '🔐 Unlock Studio';
      studioBtn.setAttribute('onclick', 'openAuthModal()');
      studioBtn.title = 'Enter Admin Password to Unlock Studio Dashboard';
    }
  }

  // Toggle header radar pill and + Add Track button (Admin only)
  const radarPill = document.getElementById('header-radar-pill');
  if (radarPill) radarPill.style.display = isAuth ? 'flex' : 'none';

  const addTrackBtn = document.querySelector('header.studio-header button[onclick="openModal()"]');
  if (addTrackBtn) addTrackBtn.style.display = isAuth ? 'inline-flex' : 'none';

  // If locked, strictly force the UI to remain on Level 1
  if (!isAuth && currentLevel > 1) {
    switchLevel(1);
  }

  if (isAuth) {
    if (icon) icon.innerText = '🔓';
    if (text) {
      const label = currentAuthState.user?.name ? `Admin (${currentAuthState.user.name})` : 'Admin';
      text.innerText = `${label} • Logout`;
    }
    btn.title = 'Click to log out of Admin session';
    btn.style.borderColor = 'rgba(16, 185, 129, 0.4)';
    btn.style.background = 'rgba(16, 185, 129, 0.1)';
  } else {
    if (icon) icon.innerText = '🔐';
    if (text) text.innerText = 'Admin Login';
    btn.title = 'Authenticate as Admin for full studio controls & dashboard';
    btn.style.borderColor = 'rgba(255, 255, 255, 0.12)';
    btn.style.background = 'rgba(255, 255, 255, 0.06)';
  }

  if (supaContainer) {
    supaContainer.style.display = (currentAuthState.supabaseConfig?.url && currentAuthState.supabaseConfig?.anonKey) ? 'block' : 'none';
  }
}

function handleAuthButtonClick() {
  if (currentAuthState.authenticated) {
    if (confirm('Log out of Admin session?')) {
      logoutAdmin();
    }
  } else {
    openAuthModal();
  }
}

function openAuthModal() {
  const modal = document.getElementById('auth-modal');
  const errEl = document.getElementById('auth-error-msg');
  const input = document.getElementById('admin-password-input');
  if (errEl) {
    errEl.style.display = 'none';
    errEl.innerText = '';
  }
  if (input) {
    input.value = '';
  }
  if (modal) {
    modal.style.display = 'flex';
    setTimeout(() => input?.focus(), 100);
  }
}

function closeAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.style.display = 'none';
}

async function submitAdminPassword(event) {
  if (event) event.preventDefault();
  const input = document.getElementById('admin-password-input');
  const errEl = document.getElementById('auth-error-msg');
  const btn = document.getElementById('admin-login-submit-btn');
  const password = input?.value || '';

  if (!password) {
    if (errEl) {
      errEl.innerText = 'Please enter password';
      errEl.style.display = 'block';
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerText = 'Verifying...';
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (errEl) {
        errEl.innerText = data.error || 'Incorrect admin password';
        errEl.style.display = 'block';
      }
      return;
    }

    if (typeof showToast === 'function') {
      showToast('Admin session unlocked! Welcome to Studio.', 'success');
    }
    closeAuthModal();
    await checkAuthStatus();
    switchLevel(2);
  } catch (err) {
    if (errEl) {
      errEl.innerText = `Login failed: ${err.message}`;
      errEl.style.display = 'block';
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = 'Unlock Admin';
    }
  }
}

async function logoutAdmin() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
    if (typeof showToast === 'function') {
      showToast('Logged out of Admin session', 'info');
    }
    await checkAuthStatus();
    switchLevel(1);
  } catch (err) {
    console.error('Logout failed:', err);
  }
}

async function loginWithGoogle() {
  if (!currentAuthState.supabaseConfig?.url || !currentAuthState.supabaseConfig?.anonKey) {
    if (typeof showToast === 'function') {
      showToast('Supabase Google OAuth is not configured on server', 'error');
    }
    return;
  }
  const supaUrl = currentAuthState.supabaseConfig.url.replace(/\/+$/, '');
  window.location.href = `${supaUrl}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(window.location.origin)}`;
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', async () => {
  await checkAuthStatus();
  const savedLevel = (currentAuthState.enabled && !currentAuthState.authenticated)
    ? 1
    : parseInt(localStorage.getItem('vexo_ui_level') || '1', 10);
  switchLevel(savedLevel);
  connectSSE();
  loadFeatureFlags();
  initWaveform();
  fetchBrainData(); // Fetch initial radar & brain stats for header
  setInterval(fetchBrainData, 8000); // Periodic header & radar refresh
});

// ========================================================
// LEVEL 3: BRAIN OBSERVABILITY & LOGS LOGIC
// ========================================================

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatTimeAgo(timestampSec) {
  if (!timestampSec) return 'Never';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestampSec;
  if (diff < 5) return 'Just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatCountdown(remainingSec) {
  if (remainingSec <= 0) return 'Expired';
  const h = Math.floor(remainingSec / 3600);
  const m = Math.floor((remainingSec % 3600) / 60);
  const s = remainingSec % 60;
  if (h > 0) return `${h}h ${m}m left`;
  if (m > 0) return `${m}m ${s}s left`;
  return `${s}s left`;
}

function switchBrainSubTab(tab) {
  currentBrainSubTab = tab;
  const tabs = ['cooldown', 'pref'];
  tabs.forEach((t) => {
    const btn = document.getElementById(`brain-tab-${t}`);
    const sec = document.getElementById(`brain-section-${t}`);
    if (btn) btn.classList.toggle('active', t === tab);
    if (sec) sec.style.display = t === tab ? 'block' : 'none';
  });
  if (tab === 'baseline') {
    loadBaselineData();
  }
}

async function fetchBrainData() {
  try {
    const res = await fetch('/api/brain');
    if (!res.ok) return;
    const data = await res.json();
    currentBrainData = data;

    // Update KPI metrics
    const modelEl = document.getElementById('brain-kpi-model');
    const threadsEl = document.getElementById('brain-kpi-threads');
    const latencyEl = document.getElementById('brain-kpi-latency');
    const successEl = document.getElementById('brain-kpi-success');
    const queriesEl = document.getElementById('brain-kpi-queries');
    const lastTimeEl = document.getElementById('brain-kpi-last-time');
    const listenersEl = document.getElementById('brain-kpi-listeners');
    const vetoesEl = document.getElementById('brain-kpi-vetoes');

    if (modelEl) {
      const activeEngine = data.currentEngine || 'embedding';
      if (activeEngine === 'embedding') {
        modelEl.innerHTML = '⚡ Dense Latent Vector';
        modelEl.style.color = '#38bdf8';
        if (threadsEl) threadsEl.innerText = `all-minilm (384-d | ${data.indexedVectorsCount || 9587} vectors)`;
      } else if (activeEngine === 'jev') {
        modelEl.innerHTML = '🎯 Jev Decision Engine';
        modelEl.style.color = '#fbbf24';
        if (threadsEl) threadsEl.innerText = `${data.model || 'qwen2.5'} (Calibrated SemIf Logit Pass)`;
      } else if (activeEngine === 'llm') {
        modelEl.innerHTML = `🤖 ${data.model || 'qwen2.5:1.5b'}`;
        modelEl.style.color = '#c084fc';
        if (threadsEl) threadsEl.innerText = `Autoregressive (Clamped: ${data.threadClamp || 3} Threads)`;
      } else {
        modelEl.innerHTML = `🔀 Hybrid Blend`;
        modelEl.style.color = '#34d399';
        if (threadsEl) threadsEl.innerText = `Dense Latent + Jev Decision + Generative`;
      }
    }

    // Update engine switcher buttons
    const currentEng = data.currentEngine || 'embedding';
    ['embedding', 'jev', 'llm', 'hybrid'].forEach((eng) => {
      const b = document.getElementById(`engine-btn-${eng}`);
      if (b) {
        if (eng === currentEng) {
          b.classList.add('active');
        } else {
          b.classList.remove('active');
        }
      }
    });

    if (latencyEl) latencyEl.innerText = data.stats.avgDurationMs ? `${data.stats.avgDurationMs}ms` : '0ms';
    if (successEl) {
      const rate = data.stats.totalQueries
        ? Math.round((data.stats.successCount / data.stats.totalQueries) * 100)
        : 100;
      successEl.innerText = `${rate}% Success Rate (${data.stats.timeoutCount} timeouts)`;
    }
    if (queriesEl) queriesEl.innerText = String(data.stats.totalQueries || 0);
    if (lastTimeEl) lastTimeEl.innerText = `Last: ${formatTimeAgo(data.stats.lastInteractionAt)}`;
    if (listenersEl) listenersEl.innerText = `${data.activeListeners?.length || 0} Active`;
    if (vetoesEl) vetoesEl.innerText = `${data.roomProfile?.dislikedArtists?.length || 0} Disliked Artists Vetoed`;

    // Update Autonomous Taste Radar 50k Progress
    if (data.tasteRadar) {
      const radar = data.tasteRadar;
      const totalSongs = radar.totalSongs || 0;
      const totalVectors = radar.totalEmbeddings || 0;
      const target = radar.target || 50000;
      const pct = radar.progressPct || ((totalSongs / target) * 100).toFixed(1);

      // Top bar header radar pill
      const headerRadarText = document.getElementById('header-radar-text');
      const headerRadarFill = document.getElementById('header-radar-fill');
      if (headerRadarText) headerRadarText.innerText = `50k Radar: ${totalSongs.toLocaleString()} (${pct}%)`;
      if (headerRadarFill) headerRadarFill.style.width = `${Math.min(100, pct)}%`;

      // Level 3 Taste Radar card
      const radarCurrent = document.getElementById('radar-current-songs');
      const radarVectors = document.getElementById('radar-embedded-vectors');
      const radarPct = document.getElementById('radar-percent-val');
      const radarFill = document.getElementById('radar-progress-fill');
      const radarStatus = document.getElementById('radar-status-msg');
      const radarBadge = document.getElementById('radar-live-indicator');

      if (radarCurrent) radarCurrent.innerText = `${totalSongs.toLocaleString()} Tracks`;
      if (radarVectors) radarVectors.innerText = `${totalVectors.toLocaleString()} Vectors`;
      if (radarPct) radarPct.innerText = `${pct}%`;
      if (radarFill) radarFill.style.width = `${Math.min(100, pct)}%`;

      if (radarBadge) {
        if (totalSongs >= target) {
          radarBadge.innerText = 'TARGET REACHED';
          radarBadge.style.color = '#a78bfa';
          radarBadge.style.borderColor = 'rgba(167, 139, 250, 0.4)';
          radarBadge.style.background = 'rgba(167, 139, 250, 0.15)';
        } else {
          radarBadge.innerText = 'EXPANDING';
          radarBadge.style.color = '#34d399';
          radarBadge.style.borderColor = 'rgba(52, 211, 153, 0.4)';
          radarBadge.style.background = 'rgba(52, 211, 153, 0.15)';
        }
      }

      if (radarStatus) {
        if (totalSongs >= target) {
          radarStatus.innerText = `🎯 50,000 Milestone achieved! Catalog is fully enriched with 384-d latent vectors.`;
        } else {
          radarStatus.innerText = `🛰️ Taste Radar active: Crawling related artists & deep-cuts. (${(target - totalSongs).toLocaleString()} tracks remaining to 50k)`;
        }
      }
    }

    // Badges on tabs
    const bInteractions = document.getElementById('brain-badge-interactions-count');
    const bPref = document.getElementById('brain-badge-pref-count');
    const bCooldown = document.getElementById('brain-badge-cooldown-count');

    if (bInteractions) bInteractions.innerText = String(data.recentInteractions?.length || 0);
    if (bPref) bPref.innerText = String(data.preferences?.length || 0);
    if (bCooldown) {
      bCooldown.innerText = String((data.songCooldowns?.length || 0) + (data.artistCooldowns?.length || 0) + (data.languageCooldowns?.length || 0));
    }

    // Render Subsections
    renderBrainInteractions();
    renderPreferencesTable();
    renderCooldowns();
    renderRoomTaste();
    renderVetoesTable();
    const vetoesCountBadge = document.getElementById('brain-badge-vetoes-count');
    if (vetoesCountBadge) vetoesCountBadge.innerText = (data.vetoes || []).length;
  } catch (err) {
    console.error('Error fetching brain data:', err);
  }
}

function filterBrainInteractions() {
  renderBrainInteractions();
}

function renderBrainInteractions() {
  if (!currentBrainData || !currentBrainData.recentInteractions) return;
  const container = document.getElementById('brain-interactions-list');
  if (!container) return;

  const filter = document.getElementById('brain-filter-action')?.value || 'all';
  const items = currentBrainData.recentInteractions.filter((it) => {
    if (filter === 'all') return true;
    return it.action === filter;
  });

  if (items.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px; color: var(--text-muted); background: var(--card-bg); border-radius: 12px; border: 1px solid var(--card-border);">
        No brain interactions recorded for filter "${escapeHtml(filter)}".
      </div>
    `;
    return;
  }

  container.innerHTML = items.map((it) => {
    let actionBadge = `<span class="badge-tag">${escapeHtml(it.action)}</span>`;
    if (it.action === 'taste_radar') {
      actionBadge = `<span class="badge-tag" style="background: rgba(56, 189, 248, 0.25); color: #38bdf8;">🛰️ TASTE RADAR EXPANSION</span>`;
    } else if (it.action === 'jev_decision') {
      actionBadge = `<span class="badge-tag" style="background: rgba(245, 158, 11, 0.25); color: #fbbf24;">🎯 JEV DECISION ENGINE</span>`;
    } else if (it.action === 'vector_curation') {
      actionBadge = `<span class="badge-tag" style="background: rgba(56, 189, 248, 0.25); color: #38bdf8;">⚡ VECTOR LATENT</span>`;
    } else if (it.action === 'curation') {
      actionBadge = `<span class="badge-tag" style="background: rgba(99, 102, 241, 0.25); color: #a5b4fc;">🤖 AI CURATION</span>`;
    } else if (it.action === 'vibe') {
      actionBadge = `<span class="badge-tag" style="background: rgba(236, 72, 153, 0.25); color: #f472b6;">✨ VIBE GENERATOR</span>`;
    } else if (it.action === 'tier2_fallback') {
      actionBadge = `<span class="badge-tag" style="background: rgba(245, 158, 11, 0.25); color: #fbbf24;">🌿 DEEZER GRAPH FALLBACK</span>`;
    } else if (it.action === 'enrichment') {
      actionBadge = `<span class="badge-tag" style="background: rgba(16, 185, 129, 0.25); color: #34d399;">🏷️ METADATA ENRICHMENT</span>`;
    } else if (it.action === 'custom') {
      actionBadge = `<span class="badge-tag" style="background: rgba(168, 85, 247, 0.25); color: #c084fc;">⚙️ SYSTEM SWITCH</span>`;
    }

    let statusBadge = `<span class="badge-success">SUCCESS</span>`;
    if (it.status === 'timeout') statusBadge = `<span class="badge-timeout">TIMEOUT</span>`;
    if (it.status === 'error') statusBadge = `<span class="badge-timeout">ERROR</span>`;
    if (it.status === 'fallback') statusBadge = `<span class="badge-fallback">DYNAMIC FALLBACK</span>`;

    const durationDisplay = it.durationMs >= 1000
      ? `${(it.durationMs / 1000).toFixed(2)}s`
      : `${it.durationMs}ms`;

    const formattedTime = new Date(it.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const timeAgo = formatTimeAgo(it.timestamp);

    // Format response JSON if valid
    let responseFormatted = escapeHtml(it.response || '(No response body / timeout)');
    try {
      if (it.response) {
        const parsed = JSON.parse(it.response);
        responseFormatted = escapeHtml(JSON.stringify(parsed, null, 2));
      }
    } catch {
      // keep raw
    }

    return `
      <div class="brain-interaction-card">
        <div class="interaction-header">
          <div class="interaction-meta">
            ${actionBadge}
            ${statusBadge}
            <span style="font-size: 12px; color: var(--text-muted);">${formattedTime} (${timeAgo})</span>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="code-pill">Model: ${escapeHtml(it.model)}</span>
            <span class="code-pill" style="color: #34d399;">⏱️ ${durationDisplay}</span>
          </div>
        </div>
        <div class="interaction-body">
          <div>
            <div class="code-box-header">
              <span>📤 Raw Prompt Sent to Model</span>
              <span style="color: var(--text-subtle);">${it.prompt.length} chars</span>
            </div>
            <pre class="code-box">${escapeHtml(it.prompt)}</pre>
          </div>
          <div>
            <div class="code-box-header">
              <span>📥 Raw Model Output / Returned JSON</span>
              <span style="color: var(--text-subtle);">${it.response ? it.response.length : 0} chars</span>
            </div>
            <pre class="code-box">${responseFormatted}</pre>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderPreferencesTable() {
  if (!currentBrainData || !currentBrainData.preferences) return;
  const tbody = document.getElementById('brain-preferences-tbody');
  const countLabel = document.getElementById('brain-pref-total-label');
  if (!tbody) return;

  const search = (document.getElementById('brain-pref-search')?.value || '').toLowerCase().trim();
  const filtered = currentBrainData.preferences.filter((p) => {
    if (!search) return true;
    return (
      (p.user_name && p.user_name.toLowerCase().includes(search)) ||
      p.target_key.toLowerCase().includes(search) ||
      p.display_name.toLowerCase().includes(search) ||
      p.user_id.toLowerCase().includes(search) ||
      p.target_type.toLowerCase().includes(search)
    );
  });

  if (countLabel) {
    countLabel.innerText = `Showing ${filtered.length} of ${currentBrainData.preferences.length} preferences`;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" style="text-align: center; padding: 30px; color: var(--text-muted);">
          No preferences match "${escapeHtml(search)}".
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map((p) => {
    const scoreVal = typeof p.affinity_score === 'number' ? p.affinity_score : 0;
    let scoreClass = 'score-neutral';
    let scoreText = scoreVal.toFixed(1);
    if (scoreVal > 0) {
      scoreClass = 'score-positive';
      scoreText = `+${scoreText}`;
    } else if (scoreVal < 0) {
      scoreClass = 'score-negative';
    }

    let targetBadge = `<span class="badge-tag" style="background: rgba(236, 72, 153, 0.2); color: #f472b6;">SONG</span>`;
    if (p.target_type === 'artist') {
      targetBadge = `<span class="badge-tag" style="background: rgba(99, 102, 241, 0.2); color: #a5b4fc;">ARTIST</span>`;
    } else if (p.target_type === 'genre') {
      targetBadge = `<span class="badge-tag" style="background: rgba(139, 92, 246, 0.2); color: #c4b5fd;">GENRE</span>`;
    }

    const userLabel = p.user_name || `User ${p.user_id.slice(-4)}`;

    return `
      <tr>
        <td style="font-weight: 600; color: #e2e8f0;" title="${escapeHtml(p.user_id)}">${escapeHtml(userLabel)}</td>
        <td>${targetBadge}</td>
        <td style="font-weight: 700; color: #fff;">${escapeHtml(p.display_name || p.target_key)}</td>
        <td class="${scoreClass}" style="font-size: 14px;">${scoreText}</td>
        <td style="color: #34d399;">+${p.likes || 0}</td>
        <td style="color: #38bdf8;">+${p.full_plays || 0}</td>
        <td style="color: #f59e0b;">-${p.early_skips || 0}</td>
        <td style="color: #f87171;">-${p.dislikes || 0}</td>
        <td style="font-size: 12px; color: var(--text-subtle);">${formatTimeAgo(p.updated_at)}</td>
        <td><button class="btn btn-danger" style="padding: 3px 8px; font-size: 11px;" onclick="popPreference('${p.target_type}', '${escapeJs(p.target_key)}')" title="Quick Pop from Taste Profile">✕</button></td>
      </tr>
    `;
  }).join('');
}

function renderCooldowns() {
  if (!currentBrainData) return;
  const songContainer = document.getElementById('brain-cooldown-songs-list');
  const artistContainer = document.getElementById('brain-cooldown-artists-list');
  const songBadge = document.getElementById('badge-song-cooldown-count');
  const artistBadge = document.getElementById('badge-artist-cooldown-count');

  const now = Math.floor(Date.now() / 1000);
  const songHours = currentBrainData.cooldownConfig?.songCooldownHours || 48;
  const artistHours = currentBrainData.cooldownConfig?.artistCooldownHours || 2;

  // 1. Song cooldowns
  const songs = currentBrainData.songCooldowns || [];
  if (songBadge) songBadge.innerText = `${songs.length} LOCKED`;
  if (songContainer) {
    if (songs.length === 0) {
      songContainer.innerHTML = `<div style="text-align: center; padding: 20px; color: var(--text-muted);">No songs currently on 48h cooldown</div>`;
    } else {
      songContainer.innerHTML = songs.map((s) => {
        const remaining = Math.max(0, (s.played_at + songHours * 3600) - now);
        return `
          <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--card-border); border-radius: 8px; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-weight: 600; color: #fff; font-size: 13px;">${escapeHtml(s.title)}</div>
              <div style="font-size: 11px; color: var(--text-muted);">${escapeHtml(s.artist)} • Played ${formatTimeAgo(s.played_at)}</div>
            </div>
            <span class="code-pill" style="color: #f87171; font-size: 11px;">🔒 ${formatCountdown(remaining)}</span>
          </div>
        `;
      }).join('');
    }
  }

  // 2. Artist cooldowns
  const artists = currentBrainData.artistCooldowns || [];
  if (artistBadge) artistBadge.innerText = `${artists.length} LOCKED`;
  if (artistContainer) {
    if (artists.length === 0) {
      artistContainer.innerHTML = `<div style="text-align: center; padding: 20px; color: var(--text-muted);">No artists currently on 2h cooldown</div>`;
    } else {
      artistContainer.innerHTML = artists.map((a) => {
        const remaining = Math.max(0, (a.last_played_at + artistHours * 3600) - now);
        return `
          <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--card-border); border-radius: 8px; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-weight: 700; color: #fff; font-size: 13px;">${escapeHtml(a.artist_name)}</div>
              <div style="font-size: 11px; color: var(--text-muted);">Last played ${formatTimeAgo(a.last_played_at)}</div>
            </div>
            <span class="code-pill" style="color: #fbbf24; font-size: 11px;">🔒 ${formatCountdown(remaining)}</span>
          </div>
        `;
      }).join('');
    }
  }

  // 3. Foreign Language cooldowns
  const languages = currentBrainData.languageCooldowns || [];
  const langBadge = document.getElementById('badge-language-cooldown-count');
  const langContainer = document.getElementById('brain-cooldown-languages-list');
  const langMinutes = currentBrainData.cooldownConfig?.languageCooldownMinutes || 120;
  if (langBadge) langBadge.innerText = `${languages.length} LOCKED`;
  if (langContainer) {
    if (languages.length === 0) {
      langContainer.innerHTML = `<div style="text-align: center; padding: 20px; color: var(--text-muted);">No foreign languages currently on cooldown</div>`;
    } else {
      langContainer.innerHTML = languages.map((l) => `
        <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--card-border); border-radius: 8px; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <div style="font-weight: 700; color: #fff; font-size: 13px;">${l.flag || '🌍'} ${escapeHtml(l.languageName || l.language.toUpperCase())}</div>
            <div style="font-size: 11px; color: var(--text-muted);">${escapeHtml(l.lastArtist)} - ${escapeHtml(l.lastTitle)} • ${formatTimeAgo(l.lastPlayedAt)}</div>
          </div>
          <span class="code-pill" style="color: #60a5fa; font-size: 11px;">🔒 ${formatCountdown(l.remainingSec)}</span>
        </div>
      `).join('');
    }
  }
}

function renderRoomTaste() {
  if (!currentBrainData) return;
  const listEl = document.getElementById('brain-room-listeners-list');
  const badgeEl = document.getElementById('brain-room-listeners-badge');
  const artistsEl = document.getElementById('brain-room-artists-list');
  const vetoesEl = document.getElementById('brain-room-vetoes-list');

  const listeners = currentBrainData.activeListeners || [];
  if (badgeEl) badgeEl.innerText = `${listeners.length} PRESENT`;
  if (listEl) {
    if (listeners.length === 0) {
      listEl.innerHTML = `<span style="color: var(--text-muted);">No active listeners in voice channel</span>`;
    } else {
      listEl.innerHTML = listeners.map((name) => `
        <div class="settings-row">
          <span class="settings-label">🎧 ${escapeHtml(name)}</span>
          <span class="badge-tag" style="background: rgba(16, 185, 129, 0.2); color: #34d399;">CONNECTED</span>
        </div>
      `).join('');
    }
  }

  // Top Liked Artists in Room
  const topArtists = currentBrainData.roomProfile?.topLikedArtists || [];
  if (artistsEl) {
    if (topArtists.length === 0) {
      artistsEl.innerHTML = `<span style="color: var(--text-muted);">No common liked artists yet</span>`;
    } else {
      artistsEl.innerHTML = topArtists.map((artist) => `
        <div class="settings-row">
          <span style="font-weight: 600; color: #fff;">${escapeHtml(artist)}</span>
          <span class="code-pill" style="color: #34d399;">FAVORED</span>
        </div>
      `).join('');
    }
  }

  // Disliked / Vetoed Artists in Room
  const vetoes = currentBrainData.roomProfile?.dislikedArtists || [];
  if (vetoesEl) {
    if (vetoes.length === 0) {
      vetoesEl.innerHTML = `<span style="color: var(--text-muted);">Zero active room vetoes (Room taste is aligned)</span>`;
    } else {
      vetoesEl.innerHTML = vetoes.map((artist) => `
        <div class="settings-row" style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0;">
          <span style="font-weight: 600; color: #f87171;">⛔ ${escapeHtml(artist)}</span>
          <div style="display: flex; gap: 6px; align-items: center;">
            <span class="badge-tag" style="background: rgba(239, 68, 68, 0.25); color: #f87171;">VETOED</span>
            <button class="btn btn-danger" style="padding: 2px 7px; font-size: 11px;" onclick="popVetoItem('${escapeJs(artist)}', '${escapeJs(artist)}')" title="Pop from Blacklist">✕ Pop</button>
          </div>
        </div>
      `).join('') + `
        <div style="margin-top: 10px; text-align: right;">
          <a href="javascript:void(0)" onclick="switchBrainSubTab('vetoes')" style="font-size: 11px; color: #818cf8; text-decoration: none; font-weight: 600;">
            View all in Dedicated Veto Manager (${(currentBrainData.vetoes || []).length || vetoes.length}) ↗
          </a>
        </div>
      `;
    }
  }
}

// --- Station DNA / Baseline Preferences ---
let currentBaselineData = null;

async function loadBaselineData() {
  try {
    const res = await fetch('/api/baseline');
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && data.baseline) {
      currentBaselineData = data.baseline;
      renderBaselineChips(data.baseline);
    }
  } catch (err) {
    console.warn('[Baseline] Load error:', err);
  }
}

function renderBaselineChips(baseline) {
  const artistsContainer = document.getElementById('baseline-artists-chips');
  const genresContainer = document.getElementById('baseline-genres-chips');
  const artistsCount = document.getElementById('baseline-artists-count');
  const genresCount = document.getElementById('baseline-genres-count');
  const weightSlider = document.getElementById('baseline-weight-slider');
  const weightVal = document.getElementById('baseline-weight-val');

  if (artistsCount) artistsCount.innerText = `${baseline.artists.length} Artists`;
  if (genresCount) genresCount.innerText = `${baseline.genres.length} Genres`;
  if (weightSlider) weightSlider.value = baseline.weight;
  if (weightVal) weightVal.innerText = Number(baseline.weight).toFixed(1);

  if (artistsContainer) {
    if (baseline.artists.length === 0) {
      artistsContainer.innerHTML = '<span style="color: var(--text-muted); font-size: 12px;">No baseline artists configured</span>';
    } else {
      artistsContainer.innerHTML = baseline.artists.map((artist) => `
        <span class="badge-tag" style="background: rgba(99, 102, 241, 0.15); border: 1px solid rgba(99, 102, 241, 0.3); color: #c7d2fe; font-size: 12px; padding: 5px 10px; border-radius: 6px; display: inline-flex; align-items: center; gap: 6px;">
          <span>${escapeHtml(artist)}</span>
          <button onclick="removeBaselineArtist('${escapeJs(artist)}')" style="background: none; border: none; color: #a5b4fc; cursor: pointer; padding: 0; font-size: 13px; line-height: 1;" title="Remove artist">×</button>
        </span>
      `).join('');
    }
  }

  if (genresContainer) {
    if (baseline.genres.length === 0) {
      genresContainer.innerHTML = '<span style="color: var(--text-muted); font-size: 12px;">No baseline genres configured</span>';
    } else {
      genresContainer.innerHTML = baseline.genres.map((genre) => `
        <span class="badge-tag" style="background: rgba(236, 72, 153, 0.15); border: 1px solid rgba(236, 72, 153, 0.3); color: #fbcfe8; font-size: 12px; padding: 5px 10px; border-radius: 6px; display: inline-flex; align-items: center; gap: 6px;">
          <span>${escapeHtml(genre)}</span>
          <button onclick="removeBaselineGenre('${escapeJs(genre)}')" style="background: none; border: none; color: #f472b6; cursor: pointer; padding: 0; font-size: 13px; line-height: 1;" title="Remove genre">×</button>
        </span>
      `).join('');
    }
  }
}

async function addBaselineArtist() {
  const input = document.getElementById('input-new-baseline-artist');
  if (!input || !input.value.trim()) return;
  const artist = input.value.trim();
  try {
    const res = await fetch('/api/baseline/artist/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artist }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      input.value = '';
      currentBaselineData = data.baseline;
      renderBaselineChips(data.baseline);
      showToast(`Added "${artist}" to Baseline Station DNA`, 'success');
    } else {
      showToast(data.error || 'Failed to add artist', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function removeBaselineArtist(artist) {
  try {
    const res = await fetch('/api/baseline/artist/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artist }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      currentBaselineData = data.baseline;
      renderBaselineChips(data.baseline);
      showToast(`Removed "${artist}" from Baseline DNA`, 'info');
    } else {
      showToast(data.error || 'Failed to remove artist', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function addBaselineGenre() {
  const input = document.getElementById('input-new-baseline-genre');
  if (!input || !input.value.trim()) return;
  const genre = input.value.trim().toLowerCase();
  try {
    const res = await fetch('/api/baseline/genre/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ genre }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      input.value = '';
      currentBaselineData = data.baseline;
      renderBaselineChips(data.baseline);
      showToast(`Added genre "${genre}" to Baseline DNA`, 'success');
    } else {
      showToast(data.error || 'Failed to add genre', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function removeBaselineGenre(genre) {
  try {
    const res = await fetch('/api/baseline/genre/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ genre }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      currentBaselineData = data.baseline;
      renderBaselineChips(data.baseline);
      showToast(`Removed genre "${genre}" from Baseline DNA`, 'info');
    } else {
      showToast(data.error || 'Failed to remove genre', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function saveBaselineWeight(weight) {
  try {
    const res = await fetch('/api/baseline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weight: Number(weight) }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`Baseline influence weight set to ${Number(weight).toFixed(1)}`, 'success');
    }
  } catch (err) {
    console.warn('[Baseline] Error saving weight:', err);
  }
}

async function resetBaselineToDefaults() {
  if (!confirm('Reset Baseline DNA to default artists (Dua Lipa, Eminem, Metallica, Placebo, Muse, Ed Sheeran) and genres?')) return;
  try {
    const res = await fetch('/api/baseline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        artists: ['Dua Lipa', 'Eminem', 'Metallica', 'Placebo', 'Muse', 'Ed Sheeran'],
        genres: ['hip hop', 'pop', 'alt rock'],
        weight: 0.5,
      }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      currentBaselineData = data.baseline;
      renderBaselineChips(data.baseline);
      showToast('Baseline DNA reset to default configuration', 'success');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast-msg';
  if (type === 'error') {
    toast.style.borderColor = 'var(--danger)';
    toast.style.background = 'rgba(239, 68, 68, 0.2)';
  } else if (type === 'success') {
    toast.style.borderColor = 'var(--success)';
    toast.style.background = 'rgba(16, 185, 129, 0.2)';
  }
  toast.innerText = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.4s ease';
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

async function switchCurationEngine(engine) {
  try {
    const res = await fetch('/api/brain/engine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine }),
    });
    const data = await res.json();
    if (data.success) {
      const descriptions = {
        embedding: '⚡ Vector Latent: Ultra-fast dense metric dot product, zero hallucination.',
        jev: '🎯 Jev Decision Engine: "System One" discriminative candidate scoring in a single forward pass.',
        llm: '🤖 Autoregressive LLM: Multi-factor token prompt reasoning via local Ollama.',
        hybrid: '🔀 Hybrid Blend: Dense latent retrieval combined with Jev decision rankings.',
      };
      showToast(descriptions[engine] || `Engine switched to ${engine}`, 'success');
      await fetchBrainData();
    } else {
      showToast(`Failed to switch engine: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast(`Error switching engine: ${err.message}`, 'error');
  }
}

async function triggerTestCuration() {
  const btn = document.getElementById('btn-test-curation');
  if (btn) {
    btn.disabled = true;
    btn.innerText = '⏳ Testing...';
  }

  try {
    const res = await fetch('/api/brain/test-curation', { method: 'POST' });
    const data = await res.json();
    await fetchBrainData();
    switchBrainSubTab('llm');
    const latency = data.durationMs >= 1000 ? `${(data.durationMs / 1000).toFixed(2)}s` : `${data.durationMs}ms`;
    showToast(`Curated ${data.recommendations?.length || 0} tracks in ${latency} via [${data.engine || 'active'}]!`, 'success');
  } catch (err) {
    showToast(`Test curation error: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '🧪 Dry-Run Curation';
    }
  }
}

async function triggerTestChime() {
  const btn = document.getElementById('btn-test-chime');
  if (btn) {
    btn.disabled = true;
    btn.innerText = '🔔 Playing Chime...';
  }
  try {
    await fetch('/api/player/chime', { method: 'POST' });
  } catch (err) {
    alert(`Chime error: ${err.message}`);
  } finally {
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.innerText = '🔔 Test Hourly Chime';
      }
    }, 2500);
  }
}

async function submitOnboardPlaylist() {
  const input = document.getElementById('onboard-playlist-input');
  const url = input ? input.value.trim() : '';
  if (!url) {
    showToast('Please paste a valid Spotify or YouTube playlist URL', 'error');
    return;
  }

  showToast('🧬 Ingesting playlist DNA...');
  try {
    const res = await fetch('/api/taste/onboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || 'Failed to ingest playlist');
    }
    showToast(`🧬 Ingested "${data.profile.title}" (${data.profile.totalTracks} tracks)!`);
    if (input) input.value = '';
    await fetchBrainData();
  } catch (err) {
    showToast(`Ingestion error: ${err.message}`, 'error');
  }
}

async function triggerManualRadarScan() {
  const btn = document.getElementById('radar-scan-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerText = '🛰️ Probing Taste Graph...';
  }

  try {
    const res = await fetch('/api/brain/radar/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (data.success && data.result) {
      showToast(`🛰️ Mined ${data.result.mined} deep-cuts around "${data.result.seedArtist}"! Total: ${data.result.total?.toLocaleString()}`);
    } else {
      showToast('🛰️ Taste Radar probe completed.');
    }
    await fetchBrainData();
  } catch (err) {
    showToast(`Radar scan error: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '⚡ Probe Taste Graph Now';
    }
  }
}

// ========================================================
// 🎛️ RUNTIME FEATURE FLAGS SUBSYSTEM
// ========================================================

let currentFeatureFlags = [];
let currentFilter = { l2: 'all', l4: 'all' };

function applyFeatureSideEffects() {
  const isWaveformActive = isFlagActive('feature_live_waveform');
  const wf = document.getElementById('live-waveform-container');
  if (wf) wf.style.display = isWaveformActive ? 'flex' : 'none';

  const isRadarActive = isFlagActive('feature_taste_radar_chart');
  const radarCard = document.getElementById('taste-radar-chart-card');
  if (radarCard) radarCard.style.display = isRadarActive ? 'block' : 'none';

  const isRadioActive = isFlagActive('feature_radio_stations');
  const radioCard = document.getElementById('radio-station-buttons')?.closest('.settings-card');
  if (radioCard) {
    radioCard.style.opacity = isRadioActive ? '1' : '0.5';
    radioCard.style.filter = isRadioActive ? 'none' : 'grayscale(0.6)';
  }

  const isThrowbackActive = isFlagActive('feature_time_capsule');
  const throwbackCard = document.getElementById('input-throwback-year')?.closest('.settings-card');
  if (throwbackCard) {
    throwbackCard.style.opacity = isThrowbackActive ? '1' : '0.5';
    throwbackCard.style.filter = isThrowbackActive ? 'none' : 'grayscale(0.6)';
  }

  const isSteeringActive = isFlagActive('feature_vibe_latent');
  const steerCard = document.getElementById('input-steering-prompt')?.closest('.settings-card');
  if (steerCard) {
    steerCard.style.opacity = isSteeringActive ? '1' : '0.5';
    steerCard.style.filter = isSteeringActive ? 'none' : 'grayscale(0.6)';
  }

  const isVaultActive = isFlagActive('feature_offline_vault');
  const vaultCard = document.getElementById('settings-vault-tracks')?.closest('.settings-card');
  if (vaultCard) {
    vaultCard.style.opacity = isVaultActive ? '1' : '0.5';
    vaultCard.style.filter = isVaultActive ? 'none' : 'grayscale(0.6)';
  }
}

async function loadFeatureFlags() {
  try {
    const res = await fetch('/api/settings/features');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    currentFeatureFlags = Array.isArray(data) ? data : (data.flags || []);
    renderFeatureFlags();
    updateFeatureCounters();
    applyFeatureSideEffects();
  } catch (err) {
    console.error('Failed to load feature flags:', err);
  }
}

function isFlagActive(featureId) {
  if (!currentFeatureFlags || currentFeatureFlags.length === 0) return true;
  const flag = currentFeatureFlags.find((f) => f.id === featureId);
  return flag !== undefined ? flag.enabled : true;
}

async function toggleFeatureFlag(featureId, enabled) {
  // Optimistic UI update
  const flag = currentFeatureFlags.find((f) => f.id === featureId);
  const oldState = flag ? flag.enabled : !enabled;
  if (flag) {
    flag.enabled = enabled;
    renderFeatureFlags();
    updateFeatureCounters();
    applyFeatureSideEffects();
  }

  try {
    const res = await fetch('/api/settings/features/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId, enabled }),
    });

    const data = await res.json();
    if (res.ok && data.success && Array.isArray(data.flags)) {
      currentFeatureFlags = data.flags;
      renderFeatureFlags();
      updateFeatureCounters();
    }
    applyFeatureSideEffects();
    showToast(`${flag?.icon || '⚙️'} ${flag?.name || featureId}: ${enabled ? 'ENABLED' : 'DISABLED'}`, 'success');

    if (featureId === 'feature_taste_radar_chart' && enabled) {
      fetchTasteRadar();
    }
  } catch (err) {
    showToast(`Error toggling feature: ${err.message}`, 'error');
    // Rollback optimistic state
    if (flag) {
      flag.enabled = oldState;
      renderFeatureFlags();
      updateFeatureCounters();
      applyFeatureSideEffects();
    }
  }
}

function filterFeatureFlags(category, target = 'l2') {
  currentFilter[target] = category;
  const filterContainer = document.getElementById(`features-filter-${target}`);
  if (filterContainer) {
    filterContainer.querySelectorAll('.btn-filter').forEach((btn) => {
      if (btn.getAttribute('data-filter') === category) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }
  renderFeatureFlags();
}

function renderFeatureFlags() { return; }

function updateFeatureCounters() {
  const total = currentFeatureFlags.length;
  const active = currentFeatureFlags.filter((f) => f.enabled).length;
  ['l2', 'l4'].forEach((target) => {
    const el = document.getElementById(`features-active-count-${target}`);
    if (el) {
      el.innerText = `${active} / ${total} ACTIVE`;
      el.style.color = active === total ? '#34d399' : (active > 0 ? '#38bdf8' : '#f59e0b');
    }
  });
}

// ========================================================
// 🌊 LIVE AUDIO WAVEFORM & HARMONIC TRANSITION CUES
// ========================================================

let waveformAnimId = null;
let webAudioContext = null;
let webAudioAnalyser = null;
let webAudioSource = null;
let webAudioDataArray = null;
let smoothedWaveformBars = new Array(54).fill(0.03);
let lastMeterFetchTime = 0;

function setupWebAudioAnalyser() {
  const audioEl = document.getElementById('browser-audio');
  if (!audioEl) return null;
  if (!webAudioContext) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      webAudioContext = new AudioCtx();
      webAudioAnalyser = webAudioContext.createAnalyser();
      webAudioAnalyser.fftSize = 128;
      webAudioAnalyser.smoothingTimeConstant = 0.82;
      webAudioSource = webAudioContext.createMediaElementSource(audioEl);
      webAudioSource.connect(webAudioAnalyser);
      webAudioAnalyser.connect(webAudioContext.destination);
      webAudioDataArray = new Uint8Array(webAudioAnalyser.frequencyBinCount);
    } catch (err) {
      return null;
    }
  }

  if (webAudioContext && webAudioContext.state === 'suspended' && !audioEl.paused) {
    webAudioContext.resume().catch(() => {});
  }

  return (!audioEl.paused && webAudioAnalyser) ? webAudioAnalyser : null;
}

function initWaveform() {
  const canvas = document.getElementById('waveform-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  if (waveformAnimId) return; // Already running

  const numBars = 54;

  // Poll server PCM meter periodically when listening via Discord (browser audio idle)
  setInterval(async () => {
    const isPlaying = currentState && currentState.state === 'playing';
    const audioEl = document.getElementById('browser-audio');
    const isBrowserPlaying = audioEl && !audioEl.paused;

    if (isPlaying && !isBrowserPlaying && isFlagActive('feature_live_waveform')) {
      try {
        const res = await fetch('/api/player/meter');
        if (res.ok) {
          const data = await res.json();
          if (currentState) {
            currentState.audioMeter = data;
          }
        }
      } catch {}
    }
  }, 120);

  function renderWave() {
    waveformAnimId = requestAnimationFrame(renderWave);

    const targetWidth = Math.floor(canvas.clientWidth * (window.devicePixelRatio || 1)) || 600;
    const targetHeight = Math.floor(canvas.clientHeight * (window.devicePixelRatio || 1)) || 60;
    if (canvas.width !== targetWidth) canvas.width = targetWidth;
    if (canvas.height !== targetHeight) canvas.height = targetHeight;
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    const isPlaying = currentState && currentState.state === 'playing';
    const isFeatureEnabled = isFlagActive('feature_live_waveform');

    const container = document.getElementById('live-waveform-container');
    if (container) {
      container.style.display = isFeatureEnabled ? 'flex' : 'none';
    }
    if (!isFeatureEnabled) return;

    // Check if browser HTML5 audio element is actively outputting sound
    const liveAnalyser = setupWebAudioAnalyser();
    const rawTargetAmps = new Array(numBars).fill(0.02);

    if (isPlaying) {
      if (liveAnalyser && webAudioDataArray) {
        // --- 1. TRUE LOCAL WEB AUDIO FFT SPECTRUM (Browser Stream Mode) ---
        liveAnalyser.getByteFrequencyData(webAudioDataArray);
        const binCount = webAudioDataArray.length; // 64 bins
        for (let i = 0; i < numBars; i++) {
          const binIdx = Math.min(binCount - 1, Math.floor((i / numBars) * (binCount * 0.85)));
          const rawByte = webAudioDataArray[binIdx];
          rawTargetAmps[i] = Math.max(0.04, rawByte / 255);
        }
      } else if (currentState?.audioMeter?.bands && currentState.audioMeter.bands.length > 0) {
        // --- 2. TRUE SERVER-SYNCED 48kHz PCM SPECTRUM (Discord Mode) ---
        const bands = currentState.audioMeter.bands; // 16 bands from BroadcastTee
        const rms = currentState.audioMeter.rms || 0.1;
        for (let i = 0; i < numBars; i++) {
          const bandIdx = Math.min(15, Math.floor((i / numBars) * 16));
          const bandVal = bands[bandIdx] || 0.05;
          // Subtly weight bass on left, mids in center, treble on right
          const spectralTilt = 1.0 + Math.sin((i / numBars) * Math.PI) * 0.3;
          rawTargetAmps[i] = Math.max(0.04, Math.min(1.0, bandVal * spectralTilt + rms * 0.2));
        }
      } else {
        // Minimal pulse if waiting for first meter packet
        for (let i = 0; i < numBars; i++) {
          rawTargetAmps[i] = 0.08;
        }
      }
    } else {
      // Paused or Idle: flat zero baseline
      for (let i = 0; i < numBars; i++) {
        rawTargetAmps[i] = 0.02;
      }
    }

    // Apply smooth physical attack/decay
    for (let i = 0; i < numBars; i++) {
      const target = rawTargetAmps[i];
      if (target > smoothedWaveformBars[i]) {
        // Fast attack (snappy jump to transients/beats)
        smoothedWaveformBars[i] = smoothedWaveformBars[i] * 0.45 + target * 0.55;
      } else {
        // Smooth exponential gravity decay
        smoothedWaveformBars[i] = smoothedWaveformBars[i] * 0.86 + target * 0.14;
      }
    }

    const barWidth = width / numBars;
    const centerY = height / 2;

    for (let i = 0; i < numBars; i++) {
      const amp = smoothedWaveformBars[i];
      const barH = Math.max(2, amp * (height * 0.90));
      const x = i * barWidth;
      const y = centerY - barH / 2;

      const grad = ctx.createLinearGradient(0, y, 0, y + barH);
      if (isPlaying) {
        grad.addColorStop(0, '#38bdf8');
        grad.addColorStop(0.5, '#6366f1');
        grad.addColorStop(1, '#ec4899');
      } else {
        grad.addColorStop(0, '#475569');
        grad.addColorStop(1, '#1e293b');
      }

      ctx.fillStyle = grad;
      ctx.beginPath();
      const r = Math.min(2, barWidth / 3);
      if (ctx.roundRect) {
        ctx.roundRect(x + 1, y, Math.max(1, barWidth - 2), barH, r);
      } else {
        ctx.fillRect(x + 1, y, Math.max(1, barWidth - 2), barH);
      }
      ctx.fill();
    }
  }

  renderWave();
}

const CAMELOT_KEYS = [
  '1A', '1B', '2A', '2B', '3A', '3B', '4A', '4B',
  '5A', '5B', '6A', '6B', '7A', '7B', '8A', '8B',
  '9A', '9B', '10A', '10B', '11A', '11B', '12A', '12B',
];

const STANDARD_KEY_MAP = {
  'abm': '1A', 'g#m': '1A', 'b': '1B',
  'ebm': '2A', 'd#m': '2A', 'f#': '2B', 'gb': '2B',
  'bbm': '3A', 'a#m': '3A', 'db': '3B', 'c#': '3B',
  'fm': '4A', 'ab': '4B',
  'cm': '5A', 'eb': '5B',
  'gm': '6A', 'bb': '6B',
  'dm': '7A', 'f': '7B',
  'am': '8A', 'c': '8B',
  'em': '9A', 'g': '9B',
  'bm': '10A', 'd': '10B',
  'f#m': '11A', 'gbm': '11A', 'a': '11B',
  'c#m': '12A', 'dbm': '12A', 'e': '12B',
};

function stringHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function estimateTrackBpm(title, artist) {
  const t = (title || '').toLowerCase();
  const a = (artist || '').toLowerCase();
  const hash = stringHash(`${t}::${a}`);
  return 95 + (Math.abs(hash) % 40); // 95 - 134 bpm
}

function estimateTrackKey(title, artist) {
  const t = (title || '').toLowerCase();
  const a = (artist || '').toLowerCase();
  const hash = stringHash(`${a} - ${t}`);
  const camelot = CAMELOT_KEYS[Math.abs(hash) % CAMELOT_KEYS.length];
  let keyName = camelot;
  for (const [name, cam] of Object.entries(STANDARD_KEY_MAP)) {
    if (cam === camelot) {
      keyName = name.toUpperCase();
      break;
    }
  }
  return { camelot, key: keyName };
}

function updateWaveformCues() {
  const bpmTag = document.getElementById('waveform-bpm-tag');
  const keyTag = document.getElementById('waveform-key-tag');
  const dropTag = document.getElementById('waveform-drop-tag');
  const cueBadge = document.getElementById('waveform-cue-badge');

  if (!currentState || !currentState.track) {
    if (bpmTag) bpmTag.innerText = 'BPM: --';
    if (keyTag) keyTag.innerText = 'Key: --';
    if (dropTag) dropTag.innerText = 'Drop / Cue: --';
    if (cueBadge) {
      cueBadge.innerText = 'IDLE';
      cueBadge.style.color = '#94a3b8';
      cueBadge.style.borderColor = 'rgba(255, 255, 255, 0.1)';
    }
    return;
  }

  const t = currentState.track;
  const remaining = Math.max(0, (t.durationSec || 0) - (t.elapsedSec || 0));

  const bpm = t.bpm || estimateTrackBpm(t.title, t.artist);
  const keyInfo = (t.camelot && t.key)
    ? { camelot: t.camelot, key: t.key }
    : (t.camelot ? { camelot: t.camelot, key: t.camelot } : estimateTrackKey(t.title, t.artist));

  if (bpmTag) bpmTag.innerText = `BPM: ~${bpm}`;
  if (keyTag) {
    const keyDisplay = keyInfo.key && keyInfo.key !== keyInfo.camelot
      ? `${keyInfo.key} (${keyInfo.camelot})`
      : (keyInfo.camelot || '--');
    keyTag.innerText = `Key: ${keyDisplay}`;
  }

  if (remaining <= 8 && remaining > 0) {
    if (dropTag) dropTag.innerText = `Drop / Cue: in ${Math.ceil(remaining)}s`;
    if (cueBadge) {
      cueBadge.innerText = '⚡ CROSSFADE CUE';
      cueBadge.style.color = '#ec4899';
      cueBadge.style.borderColor = 'rgba(236, 72, 153, 0.5)';
    }
  } else if (remaining > 8) {
    const dropIn = Math.max(0, remaining - 8);
    if (dropTag) dropTag.innerText = `Drop / Cue: in ${formatTime(dropIn)}`;
    if (cueBadge) {
      cueBadge.innerText = 'HARMONIC MIX READY';
      cueBadge.style.color = '#38bdf8';
      cueBadge.style.borderColor = 'rgba(56, 189, 248, 0.3)';
    }
  } else {
    if (dropTag) dropTag.innerText = 'Drop / Cue: 0:00';
  }
}

// ========================================================
// 🕸️ 6-AXIS COLLECTIVE TASTE RADAR CANVAS CHART (LEVEL 3)
// ========================================================

async function fetchTasteRadar() {
  const isRadarActive = isFlagActive('feature_taste_radar_chart');
  const radarCard = document.getElementById('taste-radar-chart-card');
  if (radarCard) radarCard.style.display = isRadarActive ? 'block' : 'none';
  if (!isRadarActive) return;

  try {
    const res = await fetch('/api/taste/radar');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderTasteRadarChart(data);
  } catch (err) {
    console.error('Failed to fetch taste radar fingerprint:', err);
  }
}

function renderTasteRadarChart(fingerprint) {
  if (!fingerprint || !fingerprint.dimensions) return;
  const canvas = document.getElementById('taste-radar-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const width = 420;
  const height = 360;

  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const dims = fingerprint.dimensions;
  const total = dims.length;
  const centerX = width / 2;
  const centerY = height / 2 - 8;
  const maxRadius = Math.min(centerX, centerY) - 36;

  // 1. Draw concentric polygon grid lines (25%, 50%, 75%, 100%)
  const levels = [0.25, 0.5, 0.75, 1.0];
  levels.forEach((lvl) => {
    ctx.beginPath();
    for (let i = 0; i < total; i++) {
      const angle = (i / total) * 2 * Math.PI - Math.PI / 2;
      const r = maxRadius * lvl;
      const x = centerX + r * Math.cos(angle);
      const y = centerY + r * Math.sin(angle);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = lvl === 1.0 ? 'rgba(255, 255, 255, 0.22)' : 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Subtle level percentage indicator
    if (lvl > 0.25) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.font = '8px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${Math.round(lvl * 100)}%`, centerX + 4, centerY - maxRadius * lvl + 2);
    }
  });

  // 2. Draw radial axis rays & vertex text labels
  ctx.font = '10px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let i = 0; i < total; i++) {
    const angle = (i / total) * 2 * Math.PI - Math.PI / 2;
    const xEnd = centerX + maxRadius * Math.cos(angle);
    const yEnd = centerY + maxRadius * Math.sin(angle);

    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(xEnd, yEnd);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.stroke();

    const labelRadius = maxRadius + 20;
    const lx = centerX + labelRadius * Math.cos(angle);
    const ly = centerY + labelRadius * Math.sin(angle);

    ctx.fillStyle = '#94a3b8';
    ctx.fillText(dims[i].axis.toUpperCase(), lx, ly);
  }

  // 3. Draw Room Taste Fingerprint Polygon (Cyan / Indigo Glow)
  ctx.beginPath();
  const roomPoints = [];
  for (let i = 0; i < total; i++) {
    const angle = (i / total) * 2 * Math.PI - Math.PI / 2;
    const r = (Math.max(10, dims[i].value) / 100) * maxRadius;
    const x = centerX + r * Math.cos(angle);
    const y = centerY + r * Math.sin(angle);
    roomPoints.push({ x, y, value: dims[i].value });
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();

  const roomGrad = ctx.createRadialGradient(centerX, centerY, 5, centerX, centerY, maxRadius);
  roomGrad.addColorStop(0, 'rgba(99, 102, 241, 0.38)');
  roomGrad.addColorStop(1, 'rgba(56, 189, 248, 0.16)');
  ctx.fillStyle = roomGrad;
  ctx.fill();

  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2.5;
  ctx.shadowColor = 'rgba(56, 189, 248, 0.65)';
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Draw glowing room vertex points
  roomPoints.forEach((pt) => {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 2;
    ctx.stroke();
  });

  // 4. Draw Currently Playing Song Polygon (Coral / Rose Neon Glow) if track is active!
  const trackFp = fingerprint.currentTrackFingerprint;
  if (trackFp && trackFp.dimensions && trackFp.dimensions.length > 0) {
    ctx.beginPath();
    const trackPoints = [];
    for (let i = 0; i < total; i++) {
      const angle = (i / total) * 2 * Math.PI - Math.PI / 2;
      const trackDim = trackFp.dimensions.find((td) => td.axis === dims[i].axis) || { value: 15 };
      const r = (Math.max(10, trackDim.value) / 100) * maxRadius;
      const x = centerX + r * Math.cos(angle);
      const y = centerY + r * Math.sin(angle);
      trackPoints.push({ x, y, value: trackDim.value });
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    const trackGrad = ctx.createRadialGradient(centerX, centerY, 5, centerX, centerY, maxRadius);
    trackGrad.addColorStop(0, 'rgba(244, 63, 94, 0.35)');
    trackGrad.addColorStop(1, 'rgba(251, 113, 133, 0.14)');
    ctx.fillStyle = trackGrad;
    ctx.fill();

    ctx.strokeStyle = '#f43f5e';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = 'rgba(244, 63, 94, 0.75)';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Glowing track vertex points
    trackPoints.forEach((pt) => {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#f43f5e';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }

  ctx.restore();

  // 5. Update Dimension Meters and Deltas on the right
  const metersEl = document.getElementById('taste-dim-meters');
  if (metersEl) {
    metersEl.innerHTML = dims.map((d) => {
      const trackDim = trackFp?.dimensions.find((td) => td.axis === d.axis);
      if (trackDim) {
        const delta = trackDim.delta;
        let deltaHtml = '';
        if (delta > 0) {
          deltaHtml = `<span class="badge-tag" style="background: rgba(16, 185, 129, 0.18); color: #34d399; font-weight: 700; font-size: 11px; padding: 2px 7px;">Δ +${delta}%</span>`;
        } else if (delta < 0) {
          deltaHtml = `<span class="badge-tag" style="background: rgba(239, 68, 68, 0.18); color: #f87171; font-weight: 700; font-size: 11px; padding: 2px 7px;">Δ ${delta}%</span>`;
        } else {
          deltaHtml = `<span class="badge-tag" style="background: rgba(148, 163, 184, 0.15); color: #94a3b8; font-weight: 700; font-size: 11px; padding: 2px 7px;">Δ 0%</span>`;
        }

        return `
          <div class="taste-dim-row" style="background: rgba(255, 255, 255, 0.02); padding: 5px 10px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.04);">
            <div class="taste-dim-meta" style="align-items: center; margin-bottom: 5px;">
              <span style="color: #f1f5f9; font-weight: 600;">${escapeHtml(d.label)}</span>
              ${deltaHtml}
            </div>
            <div style="display: flex; flex-direction: column; gap: 4px;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 10px; color: #38bdf8; width: 44px; font-weight: 700;">ROOM</span>
                <div class="taste-dim-bar-bg" style="flex: 1; height: 5px;">
                  <div class="taste-dim-bar-fill" style="width: ${d.value}%; background: linear-gradient(90deg, #6366f1, #38bdf8);"></div>
                </div>
                <span style="font-size: 11px; font-family: 'JetBrains Mono', monospace; color: #38bdf8; width: 34px; text-align: right; font-weight: 600;">${d.value}%</span>
              </div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 10px; color: #fb7185; width: 44px; font-weight: 700;">TRACK</span>
                <div class="taste-dim-bar-bg" style="flex: 1; height: 5px;">
                  <div class="taste-dim-bar-fill" style="width: ${trackDim.value}%; background: linear-gradient(90deg, #ec4899, #f43f5e);"></div>
                </div>
                <span style="font-size: 11px; font-family: 'JetBrains Mono', monospace; color: #fb7185; width: 34px; text-align: right; font-weight: 600;">${trackDim.value}%</span>
              </div>
            </div>
          </div>
        `;
      } else {
        return `
          <div class="taste-dim-row">
            <div class="taste-dim-meta">
              <span style="color: #e2e8f0;">${escapeHtml(d.label)}</span>
              <span style="font-family: 'JetBrains Mono', monospace; color: #38bdf8;">${d.value}%</span>
            </div>
            <div class="taste-dim-bar-bg">
              <div class="taste-dim-bar-fill" style="width: ${d.value}%;"></div>
            </div>
          </div>
        `;
      }
    }).join('');
  }

  // 6. Update Badges & Legend
  const archEl = document.getElementById('radar-archetype-badge');
  if (archEl && fingerprint.dominantArchetype) {
    archEl.innerText = fingerprint.dominantArchetype;
  }
  const listenerEl = document.getElementById('radar-listener-count-badge');
  if (listenerEl) {
    listenerEl.innerText = `${fingerprint.listenerCount || 0} LISTENERS`;
  }
  const energyEl = document.getElementById('radar-energy-badge');
  if (energyEl && fingerprint.energyIndex !== undefined) {
    energyEl.innerText = `ROOM ENERGY: ${fingerprint.energyIndex}%`;
  }

  const alignmentEl = document.getElementById('radar-alignment-badge');
  const trackBadgeEl = document.getElementById('radar-track-badge');
  const legendTrack = document.getElementById('radar-legend-track');
  const legendTitle = document.getElementById('radar-legend-track-title');

  if (trackFp) {
    if (alignmentEl) {
      alignmentEl.style.display = 'inline-block';
      alignmentEl.innerText = `🎯 ${trackFp.alignmentScore}% ROOM MATCH`;
      if (trackFp.alignmentScore >= 80) {
        alignmentEl.style.background = 'rgba(16, 185, 129, 0.2)';
        alignmentEl.style.color = '#34d399';
        alignmentEl.style.borderColor = 'rgba(16, 185, 129, 0.35)';
      } else if (trackFp.alignmentScore >= 60) {
        alignmentEl.style.background = 'rgba(56, 189, 248, 0.2)';
        alignmentEl.style.color = '#38bdf8';
        alignmentEl.style.borderColor = 'rgba(56, 189, 248, 0.35)';
      } else {
        alignmentEl.style.background = 'rgba(245, 158, 11, 0.2)';
        alignmentEl.style.color = '#fbbf24';
        alignmentEl.style.borderColor = 'rgba(245, 158, 11, 0.35)';
      }
    }
    if (trackBadgeEl) {
      trackBadgeEl.style.display = 'inline-block';
      trackBadgeEl.innerText = `🎵 ${trackFp.dominantGenre} (~${trackFp.bpm} BPM)`;
    }
    if (legendTrack) {
      legendTrack.style.display = 'flex';
      if (legendTitle) {
        const cleanTitle = trackFp.title.length > 22 ? trackFp.title.slice(0, 20) + '...' : trackFp.title;
        legendTitle.innerText = `🎵 ${cleanTitle} (${trackFp.artist})`;
      }
    }
  } else {
    if (alignmentEl) alignmentEl.style.display = 'none';
    if (trackBadgeEl) trackBadgeEl.style.display = 'none';
    if (legendTrack) legendTrack.style.display = 'none';
  }
}

// ========================================================
// ⚙️ SETTINGS SUBSYSTEMS CONTROLS (LEVEL 4)
// ========================================================

async function loadSettingsSubsystems() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Render Dynamic Runtime Settings Console
    if (data.configSettings && Array.isArray(data.configSettings)) {
      currentConfigSettings = data.configSettings;
      renderConfigSettings(data.configSettings);
    }

    // Radio stations
    const radioBox = document.getElementById('radio-station-buttons');
    if (radioBox && data.radioStations) {
      radioBox.innerHTML = `
        <button class="btn ${!data.activeStation ? 'btn-primary' : ''}" style="font-size: 12px; padding: 7px 12px; text-align: left;" onclick="setRadioStation(null)">
          ⏹️ Disable Radio Preset (Freeform Autoplay)
        </button>
        ${data.radioStations.map((st) => `
          <button class="btn ${data.activeStation?.id === st.id ? 'btn-primary' : ''}" style="font-size: 12px; padding: 7px 12px; display: flex; justify-content: space-between; align-items: center;" onclick="setRadioStation('${st.id}')">
            <span>${st.icon} ${escapeHtml(st.name)}</span>
            <span style="font-size: 10px; opacity: 0.8; font-family: 'JetBrains Mono', monospace;">${st.bpmRange[0]}-${st.bpmRange[1]} BPM</span>
          </button>
        `).join('')}
      `;
      const stBadge = document.getElementById('settings-active-station-badge');
      if (stBadge) {
        stBadge.innerText = data.activeStation ? data.activeStation.name.toUpperCase() : 'OFF';
        stBadge.style.color = data.activeStation ? '#38bdf8' : 'var(--text-muted)';
      }
    }

    // Time Capsule
    const yearInput = document.getElementById('input-throwback-year');
    const yearBadge = document.getElementById('settings-time-capsule-badge');
    if (yearBadge) {
      yearBadge.innerText = data.timeCapsuleYear ? `YEAR ${data.timeCapsuleYear}` : 'OFF';
      yearBadge.style.color = data.timeCapsuleYear ? '#fbbf24' : 'var(--text-muted)';
    }
    if (yearInput && data.timeCapsuleYear) {
      yearInput.value = data.timeCapsuleYear;
    }

    // Latent Vibe Steering
    const steerBadge = document.getElementById('settings-steering-badge');
    const steerInput = document.getElementById('input-steering-prompt');
    if (steerBadge) {
      steerBadge.innerText = data.steering?.active ? 'ACTIVE' : 'NONE';
      steerBadge.style.color = data.steering?.active ? '#a855f7' : 'var(--text-muted)';
    }
    if (steerInput && data.steering?.prompt) {
      steerInput.value = data.steering.prompt;
    }

    // Vault stats
    if (data.vaultStats) {
      const vTracks = document.getElementById('settings-vault-tracks');
      const vSize = document.getElementById('settings-vault-size');
      const vCountBadge = document.getElementById('settings-vault-count-badge');
      const trackCount = data.vaultStats.count !== undefined ? data.vaultStats.count : (data.vaultStats.trackCount || 0);
      const sizeFormatted = data.vaultStats.formattedSize || `${((data.vaultStats.totalSizeBytes || 0) / 1024 / 1024).toFixed(2)} MB`;
      if (vTracks) vTracks.innerText = `${trackCount} Tracks`;
      if (vSize) vSize.innerText = sizeFormatted;
      if (vCountBadge) vCountBadge.innerText = `${trackCount} CACHED`;
    }
  } catch (err) {
    console.error('Failed to load settings subsystems:', err);
  }
}

async function setRadioStation(stationId) {
  try {
    const res = await fetch('/api/settings/radio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stationId }),
    });
    const data = await res.json();
    showToast(stationId ? `📻 Radio preset set: ${data.activeStation?.name}` : '📻 Radio preset disabled', 'success');
    loadSettingsSubsystems();
  } catch (err) {
    showToast(`Radio setting error: ${err.message}`, 'error');
  }
}

async function setThrowbackYearFromInput() {
  const input = document.getElementById('input-throwback-year');
  const year = parseInt(input?.value, 10);
  if (!year || isNaN(year)) {
    showToast('Please enter a valid year (1950 - 2026)', 'error');
    return;
  }
  await setThrowbackPreset(year);
}

async function setThrowbackPreset(year) {
  try {
    const res = await fetch('/api/settings/throwback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year }),
    });
    const data = await res.json();
    showToast(`⏳ Time Capsule locked to year: ${data.timeCapsuleYear}`, 'success');
    loadSettingsSubsystems();
  } catch (err) {
    showToast(`Time capsule error: ${err.message}`, 'error');
  }
}

async function clearThrowbackYear() {
  try {
    await fetch('/api/settings/throwback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year: null }),
    });
    const input = document.getElementById('input-throwback-year');
    if (input) input.value = '';
    showToast('⏳ Time Capsule reset (all eras enabled)', 'info');
    loadSettingsSubsystems();
  } catch (err) {
    showToast(`Error clearing time capsule: ${err.message}`, 'error');
  }
}

async function submitSteeringFromInput() {
  const input = document.getElementById('input-steering-prompt');
  const prompt = input?.value.trim();
  if (!prompt) {
    showToast('Please enter a vibe description', 'error');
    return;
  }
  try {
    showToast('Embedding steering prompt in latent space...', 'info');
    const res = await fetch('/api/settings/vibe-steering', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✨ Latent steering active: "${prompt}"`, 'success');
    } else {
      showToast(`Steering error: ${data.error}`, 'error');
    }
    loadSettingsSubsystems();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function clearSteeringPrompt() {
  try {
    await fetch('/api/settings/vibe-steering', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '' }),
    });
    const input = document.getElementById('input-steering-prompt');
    if (input) input.value = '';
    showToast('Latent steering cleared', 'info');
    loadSettingsSubsystems();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function clearVaultCache() {
  if (!confirm('Are you sure you want to clear the offline audio vault cache?')) return;
  try {
    const res = await fetch('/api/settings/vault/clear', { method: 'POST' });
    const data = await res.json();
    showToast('💾 Server audio vault cache cleared', 'success');
    loadSettingsSubsystems();
  } catch (err) {
    showToast(`Error clearing vault: ${err.message}`, 'error');
  }
}

// ========================================================
// 🎛️ DYNAMIC RUNTIME CONFIGURATION SETTINGS (LEVEL 4)
// ========================================================

let currentConfigSettings = [];
const settingSaveDebounceTimers = {};

function formatSettingValue(val, unit, type) {
  if (type === 'boolean') return val ? 'ON' : 'OFF';
  if (unit === '%') return `${Math.round(val * 100)}%`;
  if (unit === 's') return `${Number(val).toFixed(1)}s`;
  if (unit === 'h') return `${val}h`;
  if (unit === 'ms') return `${val}ms`;
  if (unit === 'dBFS') return `${val} dBFS`;
  if (unit === 'tracks') return `${Number(val).toLocaleString()} tracks`;
  if (unit === 'cos') return `${Number(val).toFixed(2)}`;
  return String(val);
}

function renderConfigSettings(settings) {
  const container = document.getElementById('dynamic-settings-container');
  if (!container) return;

  const categories = [
    {
      id: 'Audio & Mixing',
      title: '🎛️ Audio Engine & Mixing Console',
      badge: 'DSP',
      extraHeaderHtml: `
        <button class="btn" style="font-size: 11px; padding: 4px 10px;" onclick="testHourlyChime()" title="Preview synthesized 3-tone hourly chime">
          🔔 Test Chime
        </button>
      `,
    },
    {
      id: 'Curation',
      title: '🧠 Curation & Recommendation Tuners',
      badge: 'AI Brain',
    },
    {
      id: 'Discord',
      title: '🤖 Discord Bot & Sticky Widget Experience',
      badge: 'Discord',
    },
  ];

  let html = '';

  for (const cat of categories) {
    const catSettings = settings.filter((s) => s.category === cat.id);
    if (catSettings.length === 0) continue;

    html += `
      <div class="config-card">
        <div class="config-card-header">
          <div class="config-card-title">
            <span>${cat.title}</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            ${cat.extraHeaderHtml || ''}
            <span class="badge-tag">${cat.badge}</span>
          </div>
        </div>
        <div class="settings-list">
    `;

    for (const item of catSettings) {
      const formattedVal = formatSettingValue(item.value, item.unit, item.type);
      const isDefault = item.value === item.defaultValue;

      html += `
        <div class="config-item" id="item-${item.key}">
          <div class="config-item-header">
            <div class="config-item-title">
              <span>${escapeHtml(item.name)}</span>
              <button class="config-reset-btn" onclick="resetConfigSetting('${item.key}')" title="Reset to default (${formatSettingValue(item.defaultValue, item.unit, item.type)})" style="${isDefault ? 'opacity: 0.3;' : 'opacity: 0.8;'}">
                ↺
              </button>
            </div>
            <span class="config-badge" id="badge-${item.key}">${formattedVal}</span>
          </div>
          <div class="config-item-desc">${escapeHtml(item.description)}</div>
          <div class="config-item-control">
      `;

      if (item.control === 'slider') {
        html += `
          <input type="range" class="config-slider"
            id="input-${item.key}"
            min="${item.min}"
            max="${item.max}"
            step="${item.step || 1}"
            value="${item.value}"
            oninput="handleSliderInput(this, '${item.key}', '${item.unit || ''}', '${item.type}')">
        `;
      } else if (item.control === 'toggle') {
        html += `
          <label class="switch">
            <input type="checkbox"
              id="input-${item.key}"
              ${item.value ? 'checked' : ''}
              onchange="handleToggleChange(this, '${item.key}')">
            <span class="slider"></span>
          </label>
          <span style="font-size: 12px; color: var(--text-muted);">${item.value ? 'Enabled' : 'Disabled'}</span>
        `;
      } else if (item.control === 'radio' && item.options) {
        html += `
          <div class="config-radio-group">
            ${item.options.map((opt) => `
              <button class="config-radio-pill ${item.value === opt.value ? 'active' : ''}"
                onclick="saveConfigSetting('${item.key}', ${typeof opt.value === 'string' ? `'${opt.value}'` : opt.value})">
                ${escapeHtml(opt.label)}
              </button>
            `).join('')}
          </div>
        `;
      } else if (item.control === 'select' && item.options) {
        html += `
          <select class="config-select" id="input-${item.key}" onchange="saveConfigSetting('${item.key}', Number(this.value))">
            ${item.options.map((opt) => `
              <option value="${opt.value}" ${item.value === opt.value ? 'selected' : ''}>
                ${escapeHtml(opt.label)}
              </option>
            `).join('')}
          </select>
        `;
      } else if (item.control === 'number') {
        html += `
          <div style="display: flex; gap: 8px; width: 100%;">
            <input type="number" class="input-field"
              id="input-${item.key}"
              min="${item.min || 0}"
              max="${item.max || 1000000}"
              step="${item.step || 1}"
              value="${item.value}"
              style="margin-bottom: 0; flex: 1;">
            <button class="btn btn-primary" style="white-space: nowrap;" onclick="saveConfigSetting('${item.key}', Number(document.getElementById('input-${item.key}').value))">
              Save
            </button>
          </div>
        `;
      } else if (item.control === 'text') {
        html += `
          <div style="display: flex; gap: 8px; width: 100%;">
            <input type="text" class="input-field"
              id="input-${item.key}"
              placeholder="e.g. 1063852037315514469"
              value="${escapeHtml(item.value || '')}"
              style="margin-bottom: 0; flex: 1;">
            <button class="btn btn-primary" style="white-space: nowrap;" onclick="saveConfigSetting('${item.key}', document.getElementById('input-${item.key}').value)">
              Save
            </button>
          </div>
        `;
      }

      html += `
          </div>
        </div>
      `;
    }

    html += `
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
}

function handleSliderInput(input, key, unit, type) {
  const val = Number(input.value);
  const badge = document.getElementById(`badge-${key}`);
  if (badge) {
    badge.innerText = formatSettingValue(val, unit, type);
    badge.style.borderColor = '#6366f1';
    badge.style.color = '#fff';
  }

  if (settingSaveDebounceTimers[key]) {
    clearTimeout(settingSaveDebounceTimers[key]);
  }
  settingSaveDebounceTimers[key] = setTimeout(() => {
    saveConfigSetting(key, val);
  }, 350);
}

function handleToggleChange(checkbox, key) {
  saveConfigSetting(key, checkbox.checked);
}

async function saveConfigSetting(key, value) {
  try {
    const res = await fetch('/api/settings/config/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to update setting');
    }

    const badge = document.getElementById(`badge-${key}`);
    if (badge) {
      badge.style.background = 'rgba(16, 185, 129, 0.25)';
      badge.style.borderColor = '#34d399';
      badge.style.color = '#34d399';
      setTimeout(() => {
        badge.style.background = 'rgba(99, 102, 241, 0.15)';
        badge.style.borderColor = 'rgba(99, 102, 241, 0.3)';
        badge.style.color = '#a5b4fc';
      }, 1000);
    }

    // Refresh settings list in memory and re-render if options or buttons changed
    if (data.settings) {
      currentConfigSettings = data.settings;
      renderConfigSettings(data.settings);
    }
  } catch (err) {
    showToast(`Setting update error: ${err.message}`, 'error');
  }
}

async function resetConfigSetting(key) {
  try {
    const res = await fetch('/api/settings/config/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Setting reset to default`, 'info');
      loadSettingsSubsystems();
    }
  } catch (err) {
    showToast(`Error resetting setting: ${err.message}`, 'error');
  }
}

async function resetAllConfigSettings() {
  if (!confirm('Are you sure you want to reset ALL dynamic settings to factory defaults?')) return;
  try {
    const res = await fetch('/api/settings/config/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (data.success) {
      showToast('All settings reset to defaults', 'success');
      loadSettingsSubsystems();
    }
  } catch (err) {
    showToast(`Error resetting settings: ${err.message}`, 'error');
  }
}

async function testHourlyChime() {
  try {
    const res = await fetch('/api/player/chime', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('🔔 Hourly broadcast chime triggered!', 'success');
    }
  } catch (err) {
    showToast(`Error triggering chime: ${err.message}`, 'error');
  }
}

async function triggerServerRestart() {
  if (!confirm('Are you sure you want to restart the OWRadio daemon? The server process will reload and resume playback.')) {
    return;
  }
  try {
    showToast('Initiating server restart...', 'warning');
    const res = await fetch('/api/settings/restart', { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || 'Failed to initiate restart', 'error');
      return;
    }
    showToast('Server daemon restarting... Reconnecting in 5s', 'info');

    let attempts = 0;
    const pollInterval = setInterval(async () => {
      attempts++;
      try {
        const ping = await originalFetch('/api/auth/status');
        if (ping.ok) {
          clearInterval(pollInterval);
          showToast('Server daemon restarted and back online!', 'success');
          setTimeout(() => window.location.reload(), 1200);
        }
      } catch (e) {
        if (attempts > 30) {
          clearInterval(pollInterval);
          showToast('Restart is taking longer than expected. Please reload manually.', 'warning');
        }
      }
    }, 1500);
  } catch (err) {
    showToast(`Error initiating restart: ${err.message}`, 'error');
  }
}


// ⏩ Click to Jump to Song in Queue
async function skipToQueueIndex(index) {
  try {
    const res = await fetch('/api/player/skip-to', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index }),
    });
    if (res.status === 401) {
      openAuthModal();
      return;
    }
    if (res.ok) {
      showToast('⏭️ Jumped to selected track', 'success');
      fetchQueue();
    } else {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || 'Failed to jump to track', 'error');
    }
  } catch (err) {
    showToast('Jump error: ' + err.message, 'error');
  }
}

// ⚠️ Wipe All Taste Preferences with Admin Password Re-Prompt
async function wipeAllPreferences() {
  const pass = prompt('⚠️ DOUBLE CONFIRMATION REQUIRED:\nAre you sure you want to permanently wipe ALL listener preferences and room taste history?\n\nPlease enter the Admin Password to confirm:');
  if (!pass) return;

  try {
    const res = await fetch('/api/preferences/wipe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass }),
    });
    const data = await res.json();
    if (res.ok) {
      showToast('✅ All taste preferences wiped!', 'success');
      fetchBrainData();
    } else {
      showToast('Wipe failed: ' + (data.error || 'Unauthorized'), 'error');
    }
  } catch (err) {
    showToast('Error wiping preferences: ' + err.message, 'error');
  }
}

// ✕ Quick Pop Single Preference
async function popPreference(targetType, targetKey) {
  if (!confirm('Remove "' + targetKey + '" from preferences?')) return;
  try {
    const res = await fetch('/api/preferences/pop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType, targetKey }),
    });
    if (res.status === 401) {
      openAuthModal();
      return;
    }
    if (res.ok) {
      showToast('Popped "' + targetKey + '" from taste profile', 'success');
      fetchBrainData();
    } else {
      showToast('Failed to pop preference', 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// 🚫 VETO / BLACKLIST MANAGEMENT
async function loadVetoes() {
  try {
    const res = await fetch('/api/vetoes');
    if (!res.ok) return;
    const data = await res.json();
    renderVetoList(data.vetoes || []);
  } catch (err) {
    console.error('Failed to load vetoes:', err);
  }
}

function renderVetoList(vetoes) {
  const container = document.getElementById('settings-vetoes-list');
  const countBadge = document.getElementById('settings-veto-count-badge');
  if (countBadge) countBadge.innerText = vetoes.length + ' VETOED';
  if (!container) return;

  if (vetoes.length === 0) {
    container.innerHTML = '<span style="color: var(--text-muted); font-size: 12px;">No active vetoes</span>';
    return;
  }

  container.innerHTML = vetoes.map(function(v) {
    return '<div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--card-border); border-radius: 8px; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">' +
      '<div>' +
        '<span class="badge-tag" style="background: rgba(239, 68, 68, 0.2); color: #f87171; font-size: 10px; margin-right: 6px;">' + v.targetType.toUpperCase() + '</span>' +
        '<span style="font-weight: 600; font-size: 13px; color: #fff;">' + escapeHtml(v.displayName) + '</span>' +
        '<span style="font-size: 11px; color: var(--text-muted); margin-left: 6px;">(' + (v.reason === 'community_dislikes' ? '3 Room Dislikes' : 'Manual Admin') + ')</span>' +
      '</div>' +
      '<button class="btn btn-danger" style="padding: 2px 7px; font-size: 11px;" onclick="removeVetoItem(' + v.id + ')" title="Remove Veto">✕</button>' +
    '</div>';
  }).join('');
}

async function addVetoFromInput() {
  const nameInput = document.getElementById('input-veto-name');
  const typeInput = document.getElementById('select-veto-type');
  const name = nameInput ? nameInput.value.trim() : '';
  const targetType = typeInput ? typeInput.value : 'artist';
  if (!name) return;

  try {
    const res = await fetch('/api/vetoes/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType: targetType, name: name }),
    });
    if (res.status === 401) {
      openAuthModal();
      return;
    }
    if (res.ok) {
      showToast('🚫 Vetoed ' + targetType + ' "' + name + '"', 'success');
      if (nameInput) nameInput.value = '';
      loadVetoes();
    } else {
      showToast('Failed to add veto', 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function removeVetoItem(id) {
  try {
    const res = await fetch('/api/vetoes/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id }),
    });
    if (res.status === 401) {
      openAuthModal();
      return;
    }
    if (res.ok) {
      showToast('Removed veto', 'success');
      loadVetoes();
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function vetoCurrentlyPlaying() {
  if (!confirm('Permanently veto this artist from the station and skip to next track?')) return;
  try {
    const res = await fetch('/api/player/veto-current', { method: 'POST' });
    if (res.status === 401) {
      openAuthModal();
      return;
    }
    if (res.ok) {
      showToast('🚫 Artist vetoed and track skipped!', 'success');
      loadVetoes();
    } else {
      showToast('Failed to veto current track', 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

function escapeJs(str) {
  return (str || '').replace(/'/g, "\\'");
}

// 🚫 Pop & Unveto Item from Blacklist (Easy 1-Click Action)
async function popVetoItem(idOrKey, displayName) {
  const label = displayName || idOrKey;
  if (!confirm(`Unveto and remove "${label}" from station blacklist?`)) return;
  try {
    const payload = typeof idOrKey === 'number' ? { id: idOrKey } : { key: idOrKey };
    const res = await fetch('/api/vetoes/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) {
      openAuthModal();
      return;
    }
    if (res.ok) {
      showToast(`Popped "${label}" from station blacklist!`, 'success');
      await fetchBrainData();
      if (typeof loadVetoes === 'function') loadVetoes();
    } else {
      showToast('Failed to pop veto', 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// 📋 Render Dedicated Vetoes Data Table (Sustainable for hundreds of entries)
function renderVetoesTable() {
  if (!currentBrainData || !currentBrainData.vetoes) return;
  const tbody = document.getElementById('brain-vetoes-tbody');
  const countLabel = document.getElementById('brain-veto-total-label');
  if (!tbody) return;

  const search = (document.getElementById('brain-veto-search')?.value || '').toLowerCase().trim();
  const filtered = currentBrainData.vetoes.filter((v) => {
    if (!search) return true;
    return (
      (v.displayName && v.displayName.toLowerCase().includes(search)) ||
      (v.targetKey && v.targetKey.toLowerCase().includes(search)) ||
      (v.targetType && v.targetType.toLowerCase().includes(search)) ||
      (v.reason && v.reason.toLowerCase().includes(search))
    );
  });

  if (countLabel) {
    countLabel.innerText = `Showing ${filtered.length} of ${currentBrainData.vetoes.length} blacklisted items`;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; padding: 30px; color: var(--text-muted);">
          ${search ? `No vetoed items match "${escapeHtml(search)}".` : 'No active vetoes on the station.'}
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map((v) => {
    const isArtist = v.targetType === 'artist';
    const typeBadge = isArtist
      ? `<span class="badge-tag" style="background: rgba(99, 102, 241, 0.2); color: #a5b4fc;">ARTIST</span>`
      : `<span class="badge-tag" style="background: rgba(236, 72, 153, 0.2); color: #f472b6;">SONG</span>`;

    const reasonLabel = v.reason === 'community_dislikes' ? '🚫 3 Room Dislikes' : '🛡️ Manual Admin';
    const dateStr = v.createdAt ? formatTimeAgo(v.createdAt) : 'Recently';

    return `
      <tr>
        <td>${typeBadge}</td>
        <td style="font-weight: 700; color: #fff; font-size: 13px;">${escapeHtml(v.displayName || v.targetKey)}</td>
        <td style="color: #f87171; font-size: 12px;">${escapeHtml(reasonLabel)}</td>
        <td style="font-size: 12px; color: var(--text-subtle);">${dateStr}</td>
        <td style="text-align: right;">
          <button class="btn btn-danger" style="padding: 4px 10px; font-size: 11px; font-weight: 600;" onclick="popVetoItem(${v.id}, '${escapeJs(v.displayName || v.targetKey)}')">
            ✕ Pop
          </button>
        </td>
      </tr>
    `;
  }).join('');
}
