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

document.querySelectorAll('.tab-btn').forEach((btn) =>
  btn.addEventListener('click', () => window.switchTab(btn.dataset.tab))
);

window.el.nowPlayingArtist.addEventListener('click', () => {
  const art = window.el.nowPlayingArtist.textContent.trim();
  if (art && !art.startsWith('Search ')) {
    window.el.discoArtistInput.value = art;
    window.switchTab('discography');
    loadArtistDiscography(art);
  }
});

// --- Official UK / US / Global Charts ---
async function loadOfficialCharts(country = 'gb') {
  window.el.chartsList.innerHTML = '<div style="padding:16px;color:#9ca3af;">Loading Official Top 40...</div>';
  const res = await fetch(`/api/charts?country=${country}`);
  const data = await res.json();
  const tracks = data.tracks || [];
  window.el.chartsList.innerHTML = tracks.map((t, i) => `
    <div class="track-row">
      <div class="track-row-left">
        <span style="width:24px;color:#9ca3af;font-weight:700;">#${i + 1}</span>
        <img src="${window.escapeHtml(t.cover)}" alt="" />
        <div>
          <div class="track-row-title">${window.escapeHtml(t.title)}</div>
          <div class="track-row-sub">${window.escapeHtml(t.artist)}${t.album ? ' • ' + window.escapeHtml(t.album) : ''}</div>
        </div>
      </div>
      <div class="track-row-actions">
        <button class="btn btn-primary chart-play" data-idx="${i}">▶ Play</button>
        <button class="btn btn-secondary chart-queue" data-idx="${i}">+ Queue</button>
      </div>
    </div>`).join('');

  window.el.chartsList.querySelectorAll('.chart-play').forEach((b) =>
    b.addEventListener('click', () => window.triggerPlayOrQueue({ track: tracks[Number(b.dataset.idx)] }, 'now'))
  );
  window.el.chartsList.querySelectorAll('.chart-queue').forEach((b) =>
    b.addEventListener('click', () => window.triggerPlayOrQueue({ track: tracks[Number(b.dataset.idx)] }, 'queue'))
  );
}

document.querySelectorAll('.chart-country-btn').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chart-country-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    loadOfficialCharts(btn.dataset.country);
  })
);

// --- Artist Discography Explorer (MusicBrainz + Apple/Deezer) ---
async function loadArtistDiscography(artist) {
  const q = (artist || window.el.discoArtistInput.value || '').trim();
  if (!q) return;
  window.el.discoList.innerHTML = '<div style="padding:16px;color:#9ca3af;">Querying MusicBrainz & Studio Catalogs...</div>';
  const res = await fetch(`/api/discography?artist=${encodeURIComponent(q)}`);
  const data = await res.json();
  cachedDiscoArtist = data.artist || q;
  cachedDiscoAlbums = data.albums || [];
  renderDiscographyGrid();
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
      <img src="${window.escapeHtml(a.cover)}" alt="" onerror="this.src='https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=400'" />
      <div class="album-card-title" title="${window.escapeHtml(a.title)}">${window.escapeHtml(a.title)}</div>
      <div class="album-card-meta"><span>${window.escapeHtml(a.year || 'LP')}</span><span>${window.escapeHtml(a.category)}</span></div>
      <div style="display:flex;gap:6px;margin-top:4px;">
        <button class="btn btn-primary alb-play" data-idx="${i}" style="flex:1;padding:5px;">▶ Play LP</button>
        <button class="btn btn-secondary alb-queue" data-idx="${i}" style="padding:5px 8px;">+Q</button>
      </div>
    </div>`).join('');

  window.el.discoList.querySelectorAll('.alb-play').forEach((b) =>
    b.addEventListener('click', () => {
      const alb = filtered[Number(b.dataset.idx)];
      fetch('/api/play-album', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ artist: cachedDiscoArtist, album: alb.title, mode: 'now' }) });
    })
  );
  window.el.discoList.querySelectorAll('.alb-queue').forEach((b) =>
    b.addEventListener('click', () => {
      const alb = filtered[Number(b.dataset.idx)];
      fetch('/api/play-album', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ artist: cachedDiscoArtist, album: alb.title, mode: 'queue' }) });
    })
  );
}

window.el.discoSearchBtn.addEventListener('click', () => loadArtistDiscography());
window.el.discoArtistInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadArtistDiscography(); });
window.el.discoCategorySelect.addEventListener('change', renderDiscographyGrid);
window.el.nowPlayingArtist.addEventListener('click', () => {
  const art = window.currentShow?.nowPlaying?.artist;
  if (art) {
    document.querySelector('.tab-btn[data-tab="discography"]')?.click();
    loadArtistDiscography(art);
  }
});

// --- Vibe Engine Controls ---
const postVibe = async (payload) => {
  const res = await fetch('/api/vibe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json();
  if (data.state) renderState(data.state);
};
document.querySelectorAll('#vibeModeGroup .choice-btn').forEach((btn) =>
  btn.addEventListener('click', () => postVibe({ mode: btn.dataset.mode }))
);
document.querySelectorAll('#vibeEngineGroup .choice-btn').forEach((btn) =>
  btn.addEventListener('click', () => postVibe({ engine: btn.dataset.engine }))
);

// --- Render Live State ---
function renderState(s) {
  if (!s) return;
  window.currentShow = s;
  const el = window.el;
  if (el.autoplayBtn) {
    el.autoplayBtn.textContent = s.autoplay !== false ? '🤖 Autoplay: ON' : '🤖 Autoplay: OFF';
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
          <img src="${window.escapeHtml(t.artworkUrl || '')}" alt="" />
          <div>
            <div class="track-row-title">${window.escapeHtml(t.title)}</div>
            <div class="track-row-sub">${window.escapeHtml(t.artist)}${t.vibeReason ? ' • ' + window.escapeHtml(t.vibeReason) : ''}</div>
          </div>
        </div>
        <div class="track-row-actions">
          <span style="font-size:11px;color:#9ca3af;">${window.escapeHtml(t.durationFormatted || window.formatSecs(t.duration))}</span>
          <button class="btn btn-primary q-play" data-idx="${i}" title="Play Now">▶</button>
          <button class="btn btn-small q-remove" data-idx="${i}" title="Remove">✕</button>
        </div>
      </div>`).join('')
    : '<div style="padding:20px;color:#9ca3af;text-align:center;">Queue is clear — Autoplay Vibe Engine will cue Deck 2 & Deck 3 automatically once a song plays.</div>';

  el.queueList.querySelectorAll('.q-play').forEach((b) =>
    b.addEventListener('click', () => window.triggerPlayOrQueue({ track: qList[Number(b.dataset.idx)] }, 'now'))
  );
  el.queueList.querySelectorAll('.q-remove').forEach((b) =>
    b.addEventListener('click', async () => {
      const res = await fetch(`/api/queue/${b.dataset.idx}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.state) renderState(data.state);
    })
  );

  el.historyList.innerHTML = (s.history || []).map((t, idx) => `
    <div class="track-row">
      <div class="track-row-left">
        <img src="${window.escapeHtml(t.artworkUrl || '')}" alt="" />
        <div><div class="track-row-title">${window.escapeHtml(t.title)}</div><div class="track-row-sub">${window.escapeHtml(t.artist)}</div></div>
      </div>
      <div class="track-row-actions">
        <button class="btn btn-primary hist-play" data-idx="${idx}">▶ Replay</button>
      </div>
    </div>`).join('');
  el.historyList.querySelectorAll('.hist-play').forEach((b) =>
    b.addEventListener('click', () => window.triggerPlayOrQueue({ track: s.history[Number(b.dataset.idx)] }, 'now'))
  );

  document.querySelectorAll('#vibeModeGroup .choice-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === s.vibeMode));
  document.querySelectorAll('#vibeEngineGroup .choice-btn').forEach((b) => b.classList.toggle('active', b.dataset.engine === s.vibeEngineSource));
}
window.renderState = renderState;

fetch('/api/nowplaying').then((r) => r.json()).then(renderState).catch(() => {});
setInterval(() => {
  const s = window.currentShow;
  if (s && s.isPlaying && !s.isPaused && s.nowPlaying) {
    s.elapsed = Math.min(s.nowPlaying.duration || 999, (s.elapsed || 0) + 1);
    window.el.elapsedTime.textContent = window.formatSecs(s.elapsed);
    if (s.nowPlaying.duration > 0) {
      window.el.progressFill.style.width = `${Math.min(100, (s.elapsed / s.nowPlaying.duration) * 100)}%`;
    }
  }
}, 1000);

const evtSource = new EventSource('/api/events');
evtSource.addEventListener('state', (e) => {
  try { renderState(JSON.parse(e.data)); } catch {}
});
