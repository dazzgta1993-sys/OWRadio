/**
 * @file web/public/catalog.js
 * @description Official UK/US/Global Charts, MusicBrainz Artist Discography Explorer,
 * Vibe & Brain Hub Controls, and Live SSE State Renderer for OWRadio Studio v3.0.
 */

let cachedDiscoAlbums = [];
let cachedDiscoArtist = '';

window.switchTab = function (tabName) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
  document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${tabName}`));
  if (tabName === 'charts' && !window.el.chartsList.children.length) loadOfficialCharts('gb');
};
document.querySelectorAll('.tab-btn').forEach((btn) => btn.addEventListener('click', () => window.switchTab(btn.dataset.tab)));

window.el.nowPlayingArtist.addEventListener('click', () => {
  const art = window.currentShow?.nowPlaying?.artist || window.el.nowPlayingArtist.textContent.trim();
  if (art && !art.startsWith('Search ')) {
    window.el.discoArtistInput.value = art;
    window.switchTab('discography');
    loadArtistDiscography(art);
  }
});

// --- Official UK / US / Global Charts ---
async function loadOfficialCharts(country = 'gb') {
  window.el.chartsList.innerHTML = '<div style="padding:16px;color:#9ca3af;">Loading Official Top 40...</div>';
  try {
    const res = await fetch(`/api/charts?country=${country}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const tracks = data.tracks || [];
    window.el.chartsList.innerHTML = tracks.length ? tracks.map((t, i) => `
      <div class="track-row">
        <div class="track-row-left">
          <span style="width:24px;color:#9ca3af;font-weight:700;">#${i + 1}</span>
          <img src="${window.escapeHtml(t.cover)}" alt="" />
          <div><div class="track-row-title">${window.escapeHtml(t.title)}</div><div class="track-row-sub">${window.escapeHtml(t.artist)}${t.album ? ' • ' + window.escapeHtml(t.album) : ''}</div></div>
        </div>
        <div class="track-row-actions"><button class="btn btn-primary chart-play" data-idx="${i}">▶ Play</button><button class="btn btn-secondary chart-queue" data-idx="${i}">+ Queue</button></div>
      </div>`).join('') : '<div style="padding:16px;color:#9ca3af;">No chart tracks available.</div>';
    window.el.chartsList.querySelectorAll('.chart-play').forEach((b) => b.addEventListener('click', () => window.triggerPlayOrQueue({ track: tracks[Number(b.dataset.idx)] }, 'now')));
    window.el.chartsList.querySelectorAll('.chart-queue').forEach((b) => b.addEventListener('click', () => window.triggerPlayOrQueue({ track: tracks[Number(b.dataset.idx)] }, 'queue')));
  } catch (err) {
    window.el.chartsList.innerHTML = `<div style="padding:16px;color:#f87171;">⚠️ Failed to load charts. <button class="btn btn-small" onclick="loadOfficialCharts('${country}')">Retry</button></div>`;
  }
}

document.querySelectorAll('.chart-country-btn').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chart-country-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    loadOfficialCharts(btn.dataset.country);
  })
);

// --- Artist Discography Explorer (MusicBrainz + Apple/Deezer) ---
const triggerAlbumAction = (alb, mode) =>
  fetch('/api/play-album', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ artist: cachedDiscoArtist, album: alb.title, mbid: alb.mbid, deezerAlbumId: alb.deezerAlbumId, mode }) })
    .then((r) => r.json())
    .then((d) => d.state && renderState(d.state));

async function loadArtistDiscography(artist) {
  const q = (artist || window.el.discoArtistInput.value || '').trim();
  if (!q) return;
  document.getElementById('albumTracklistPanel')?.classList.add('hidden');
  window.el.discoList.innerHTML = '<div style="padding:16px;color:#9ca3af;">Querying MusicBrainz & Studio Catalogs...</div>';
  try {
    const res = await fetch(`/api/discography?artist=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cachedDiscoArtist = data.artist || q;
    cachedDiscoAlbums = data.albums || [];
    renderDiscographyGrid();
  } catch (err) {
    window.el.discoList.innerHTML = `<div style="padding:16px;color:#f87171;">⚠️ Discography lookup failed (${window.escapeHtml(err.message)}). <button class="btn btn-small" onclick="loadArtistDiscography('${window.escapeHtml(q)}')">Retry</button></div>`;
  }
}

async function openAlbumTracklist(alb) {
  const panel = document.getElementById('albumTracklistPanel');
  if (!panel) return;
  panel.classList.remove('hidden');
  panel.innerHTML = `<div class="setting-box"><div style="color:#9ca3af;">⏳ Loading studio tracklist for <b>${window.escapeHtml(alb.title)}</b>...</div></div>`;
  try {
    const params = new URLSearchParams({ artist: cachedDiscoArtist, album: alb.title, mbid: alb.mbid || '', deezerAlbumId: alb.deezerAlbumId || '' });
    const res = await fetch(`/api/album-tracks?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const tracks = data.tracks || [];
    panel.innerHTML = `
      <div class="setting-box" style="border-color:var(--accent);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:10px;flex-wrap:wrap;">
          <div><h3 style="margin:0;">💿 ${window.escapeHtml(alb.title)} (${window.escapeHtml(alb.year || 'LP')})</h3><div style="font-size:11px;color:#9ca3af;">${window.escapeHtml(cachedDiscoArtist)} • ${window.escapeHtml(alb.category)} • ${tracks.length} tracks</div></div>
          <div style="display:flex;gap:6px;"><button id="tlPlayAll" class="btn btn-primary">▶ Play Album</button><button id="tlQueueAll" class="btn btn-secondary">+ Queue Album</button><button id="tlClose" class="btn btn-small">✕ Close</button></div>
        </div>
        <div class="track-list" style="max-height:240px;">
          ${tracks.length ? tracks.map((t, idx) => `
            <div class="track-row">
              <div class="track-row-left"><span style="width:22px;color:#9ca3af;font-weight:700;">${t.trackNumber || idx + 1}.</span><div><div class="track-row-title">${window.escapeHtml(t.title)}</div><div class="track-row-sub">${window.escapeHtml(t.artist || cachedDiscoArtist)}</div></div></div>
              <div class="track-row-actions"><span style="font-size:11px;color:#9ca3af;">${t.duration ? window.formatSecs(t.duration) : ''}</span><button class="btn btn-primary tl-play" data-idx="${idx}">▶ Play</button><button class="btn btn-secondary tl-queue" data-idx="${idx}">+Q</button></div>
            </div>`).join('') : '<div style="padding:10px;color:#9ca3af;">No individual tracklist found.</div>'}
        </div>
      </div>`;
    document.getElementById('tlClose')?.addEventListener('click', () => panel.classList.add('hidden'));
    document.getElementById('tlPlayAll')?.addEventListener('click', () => triggerAlbumAction(alb, 'now'));
    document.getElementById('tlQueueAll')?.addEventListener('click', () => triggerAlbumAction(alb, 'queue'));
    panel.querySelectorAll('.tl-play').forEach((b) => b.addEventListener('click', () => window.triggerPlayOrQueue({ track: { ...tracks[Number(b.dataset.idx)], album: alb.title, cover: tracks[Number(b.dataset.idx)].cover || alb.cover } }, 'now')));
    panel.querySelectorAll('.tl-queue').forEach((b) => b.addEventListener('click', () => window.triggerPlayOrQueue({ track: { ...tracks[Number(b.dataset.idx)], album: alb.title, cover: tracks[Number(b.dataset.idx)].cover || alb.cover } }, 'queue')));
  } catch (err) {
    panel.innerHTML = `<div class="setting-box"><div style="color:#f87171;">⚠️ Failed to load tracklist (${window.escapeHtml(err.message)}). <button class="btn btn-small" id="tlCloseErr">✕ Close</button></div></div>`;
    document.getElementById('tlCloseErr')?.addEventListener('click', () => panel.classList.add('hidden'));
  }
}

function renderDiscographyGrid() {
  const cat = window.el.discoCategorySelect.value;
  const filtered = cachedDiscoAlbums.filter((a) => cat === 'All' || a.category === cat);
  if (!filtered.length) {
    window.el.discoList.innerHTML = '<div style="padding:16px;color:#9ca3af;">No releases found in this category.</div>';
    return;
  }
  window.el.discoList.innerHTML = filtered.map((a, i) => `
    <div class="album-card">
      <img class="alb-open" data-idx="${i}" style="cursor:pointer;" title="Click to view album tracks" src="${window.escapeHtml(a.cover)}" alt="" onerror="this.src='https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=400'" />
      <div class="album-card-title alb-open" data-idx="${i}" style="cursor:pointer;" title="Click to view tracks: ${window.escapeHtml(a.title)}">${window.escapeHtml(a.title)}</div>
      <div class="album-card-meta"><span>${window.escapeHtml(a.year || 'LP')}</span><span>${window.escapeHtml(a.category)}</span></div>
      <div style="display:flex;gap:5px;margin-top:4px;">
        <button class="btn btn-primary alb-play" data-idx="${i}" style="flex:1;padding:5px;">▶ Play</button>
        <button class="btn btn-secondary alb-open" data-idx="${i}" style="padding:5px 7px;" title="View Tracks">📋</button>
        <button class="btn btn-secondary alb-queue" data-idx="${i}" style="padding:5px 7px;" title="Add Album to Queue">+Q</button>
      </div>
    </div>`).join('');

  window.el.discoList.querySelectorAll('.alb-open').forEach((b) => b.addEventListener('click', () => openAlbumTracklist(filtered[Number(b.dataset.idx)])));
  window.el.discoList.querySelectorAll('.alb-play').forEach((b) => b.addEventListener('click', () => triggerAlbumAction(filtered[Number(b.dataset.idx)], 'now')));
  window.el.discoList.querySelectorAll('.alb-queue').forEach((b) => b.addEventListener('click', () => triggerAlbumAction(filtered[Number(b.dataset.idx)], 'queue')));
}

window.el.discoSearchBtn.addEventListener('click', () => loadArtistDiscography());
window.el.discoArtistInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadArtistDiscography(); });
window.el.discoCategorySelect.addEventListener('change', renderDiscographyGrid);

// --- Vibe Engine Controls ---
const postVibe = async (payload) => {
  const res = await fetch('/api/vibe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json();
  if (data.state) renderState(data.state);
};
document.querySelectorAll('#vibeModeGroup .choice-btn').forEach((btn) => btn.addEventListener('click', () => postVibe({ mode: btn.dataset.mode })));
document.querySelectorAll('#vibeEngineGroup .choice-btn').forEach((btn) => btn.addEventListener('click', () => postVibe({ engine: btn.dataset.engine })));

let lastQueueSig = '', lastHistSig = '', lastTasteSig = '';
// --- Render Live State ---
function renderState(s) {
  if (!s) return;
  window.currentShow = s;
  const el = window.el;
  if (el.autoplayBtn) el.autoplayBtn.textContent = s.autoplay !== false ? '🤖 Autoplay: ON' : '🤖 Autoplay: OFF';
  if (el.djVoiceBtn) {
    el.djVoiceBtn.textContent = s.djVoice !== false ? '🎙️ AI DJ: ON' : '🎙️ AI DJ: OFF';
    el.djVoiceBtn.classList.toggle('pill-live', s.djVoice !== false);
    el.djVoiceBtn.classList.toggle('pill-anchor', s.djVoice === false);
  }
  el.anchorPill.textContent = `🌐 Engine: ${(s.vibeEngineSource || 'auto').toUpperCase()}`;
  el.playPauseBtn.textContent = s.isPlaying && !s.isPaused ? '⏸' : '▶';
  el.loopBtn.classList.toggle('active', s.loopMode && s.loopMode !== 'off');
  el.loopBtn.title = `Loop Mode: ${(s.loopMode || 'off').toUpperCase()}`;

  el.telAnchor.textContent = (s.vibeMode || 'balanced').replace('_', ' ').toUpperCase();
  el.telChain.textContent = `${s.consecutiveAutoplayCount || 0} tracks`;
  el.telDeck2.textContent = s.deck2 ? `${s.deck2.artist} - ${s.deck2.title}` : 'Standby';
  el.telDeck3.textContent = s.deck3 ? `${s.deck3.artist} - ${s.deck3.title}` : 'Standby';
  el.telDecision.textContent = s.lastVibeDecision || 'Ready';

  const np = s.nowPlaying;
  if (np) {
    el.nowPlayingTitle.textContent = np.title;
    el.nowPlayingArtist.textContent = np.artist;
    el.nowPlayingAlbum.textContent = np.album ? `${np.album}${np.releaseYear ? ' (' + np.releaseYear + ')' : ''}` : '';
    if (np.artworkUrl) el.nowPlayingArt.src = np.artworkUrl;
    el.sourceBadge.textContent = (np.source || 'STUDIO').toUpperCase();
    el.vibeReasonBadge.textContent = np.vibeReason || 'Direct Studio Selection';
    const dur = np.duration || 0;
    const elap = s.elapsed || 0;
    el.elapsedTime.textContent = window.formatSecs(elap);
    el.totalDuration.textContent = window.formatSecs(dur);
    el.progressFill.style.width = dur > 0 ? `${Math.min(100, (elap / dur) * 100)}%` : '0%';
  } else {
    el.nowPlayingTitle.textContent = 'Ready to Broadcast';
    el.nowPlayingArtist.textContent = 'Search a song or pick a chart hit';
    el.nowPlayingAlbum.textContent = '';
    el.elapsedTime.textContent = '0:00';
    el.totalDuration.textContent = '0:00';
    el.progressFill.style.width = '0%';
  }

  const nextUp = (s.queue && s.queue[0]) || s.deck2;
  if (nextUp) {
    el.deck2Banner.classList.remove('hidden');
    el.deck2Text.textContent = `⚡ Deck 2 Standby: ${nextUp.title} — ${nextUp.artist}`;
    el.deck2PrewarmTag.textContent = nextUp.isPrewarmed ? '⚡ STREAM READY' : '⏳ RESOLVING';
    if (el.deck3Text) {
      el.deck3Text.textContent = s.deck3 ? `🎯 Deck 3 Cued: ${s.deck3.title} — ${s.deck3.artist}` : '🎯 Deck 3: Standby';
    }
  } else {
    el.deck2Banner.classList.add('hidden');
  }

  const qList = s.queue || [];
  el.queueCount.textContent = String(qList.length);
  const qSig = qList.map((t) => `${t.id || t.title}:${t.isPrewarmed ? 1 : 0}`).join('|');
  if (qSig !== lastQueueSig) {
    lastQueueSig = qSig;
    el.queueList.innerHTML = qList.length ? qList.map((t, i) => `
      <div class="track-row">
        <div class="track-row-left"><span style="width:20px;color:#9ca3af;">${i + 1}</span><img src="${window.escapeHtml(t.artworkUrl || '')}" alt="" /><div><div class="track-row-title">${window.escapeHtml(t.title)}</div><div class="track-row-sub">${window.escapeHtml(t.artist)}${t.vibeReason ? ' • ' + window.escapeHtml(t.vibeReason) : ''}</div></div></div>
        <div class="track-row-actions"><span style="font-size:11px;color:#9ca3af;">${window.escapeHtml(t.durationFormatted || window.formatSecs(t.duration))}</span><button class="btn btn-primary q-play" data-idx="${i}">▶</button><button class="btn btn-small q-remove" data-idx="${i}">✕</button></div>
      </div>`).join('') : '<div style="padding:20px;color:#9ca3af;text-align:center;">Queue is clear — Autoplay Vibe Engine will cue Deck 2 & Deck 3 automatically.</div>';
    el.queueList.querySelectorAll('.q-play').forEach((b) => b.addEventListener('click', () => window.triggerPlayOrQueue({ track: qList[Number(b.dataset.idx)] }, 'now')));
    el.queueList.querySelectorAll('.q-remove').forEach((b) => b.addEventListener('click', async () => { const res = await fetch(`/api/queue/${b.dataset.idx}`, { method: 'DELETE' }); const data = await res.json(); if (data.state) renderState(data.state); }));
  }

  const hList = s.history || [];
  const hSig = hList.map((t) => t.id || t.title).join('|');
  if (hSig !== lastHistSig) {
    lastHistSig = hSig;
    el.historyList.innerHTML = hList.map((t, idx) => `
      <div class="track-row">
        <div class="track-row-left"><img src="${window.escapeHtml(t.artworkUrl || '')}" alt="" /><div><div class="track-row-title">${window.escapeHtml(t.title)}</div><div class="track-row-sub">${window.escapeHtml(t.artist)}</div></div></div>
        <div class="track-row-actions"><button class="btn btn-primary hist-play" data-idx="${idx}">▶ Replay</button></div>
      </div>`).join('');
    el.historyList.querySelectorAll('.hist-play').forEach((b) => b.addEventListener('click', () => window.triggerPlayOrQueue({ track: hList[Number(b.dataset.idx)] }, 'now')));
  }

  document.querySelectorAll('#vibeModeGroup .choice-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === s.vibeMode));
  document.querySelectorAll('#vibeEngineGroup .choice-btn').forEach((b) => b.classList.toggle('active', b.dataset.engine === s.vibeEngineSource));

  const likedEl = document.getElementById('likedList');
  const dislikedEl = document.getElementById('dislikedList');
  const tSig = s.taste ? JSON.stringify(s.taste) : '';
  if (tSig !== lastTasteSig) {
    lastTasteSig = tSig;
    if (likedEl && s.taste) {
      const liked = s.taste.likedArtists || [];
      likedEl.innerHTML = liked.length ? liked.map((k) => `<span class="pill pill-live" style="display:inline-flex;align-items:center;gap:6px;">👍 ${window.escapeHtml(k)} <button class="taste-rm" data-key="${window.escapeHtml(k)}" style="background:none;border:none;color:inherit;cursor:pointer;font-weight:700;">✕</button></span>`).join('') : '<span style="font-size:12px;color:#9ca3af;">No locked vibes yet — click 👍 Lock Vibe on any track.</span>';
    }
    if (dislikedEl && s.taste) {
      const cds = s.taste.cooldowns || [];
      const fmtMins = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
      dislikedEl.innerHTML = cds.length ? cds.map((c) => `<span class="pill pill-anchor" style="display:inline-flex;align-items:center;gap:6px;">❄️ ${window.escapeHtml(c.key)} <small style="opacity:0.8">(${fmtMins(c.remainingMins)})</small> <button class="taste-rm" data-key="${window.escapeHtml(c.key)}" style="background:none;border:none;color:inherit;cursor:pointer;font-weight:700;">✕</button></span>`).join('') : '<span style="font-size:12px;color:#9ca3af;">No active cooldowns.</span>';
    }
    document.querySelectorAll('.taste-rm').forEach((b) => b.addEventListener('click', async () => { const res = await fetch('/api/taste/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: b.dataset.key }) }); const data = await res.json(); if (data.state) renderState(data.state); }));
  }
}
window.renderState = renderState;
if (window.pendingState) { renderState(window.pendingState); window.pendingState = null; }

fetch('/api/nowplaying').then((r) => r.ok ? r.json() : null).then((d) => d && renderState(d)).catch(() => {});
setInterval(() => {
  const s = window.currentShow;
  if (s && s.isPlaying && !s.isPaused && s.nowPlaying) {
    s.elapsed = (s.elapsed || 0) + 1;
    if (s.nowPlaying.duration > 0 && s.elapsed > s.nowPlaying.duration) {
      s.nowPlaying.duration = s.elapsed;
      window.el.totalDuration.textContent = window.formatSecs(s.nowPlaying.duration);
    }
    window.el.elapsedTime.textContent = window.formatSecs(s.elapsed);
    if (s.nowPlaying.duration > 0) window.el.progressFill.style.width = `${Math.min(100, (s.elapsed / s.nowPlaying.duration) * 100)}%`;
  }
}, 1000);

const evtSource = new EventSource('/api/events');
evtSource.addEventListener('state', (e) => { try { renderState(JSON.parse(e.data)); } catch {} });
evtSource.onerror = () => { setTimeout(() => fetch('/api/nowplaying').then((r) => r.ok ? r.json() : null).then((d) => d && renderState(d)).catch(() => {}), 3000); };
