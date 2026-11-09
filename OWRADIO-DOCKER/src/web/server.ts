/**
 * @file web/server.ts
 * @description Clean Hono Web Server & REST/SSE API for OWRadio Studio v3.0.
 * Every single file strictly under 300 lines of code.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { stream, streamSSE } from 'hono/streaming';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import globalPlayer from '../player/GuildPlayer.js';
import AudioTrack from '../player/AudioTrack.js';
import {
  searchStudioCatalog,
  resolveQueryToTracks,
  searchArtistDiscography,
  getAlbumTracklist,
} from '../services/searchService.js';
import { getOfficialCharts } from '../services/itunes.js';
import { getDeezerChartTracks } from '../services/deezer.js';
import { VibeMode, VibeEngineSource } from '../services/vibeEngine.js';
import { removeTasteFeedback } from '../db/store.js';
import authService from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');

export const app = new Hono();

function checkAdmin(c: any): boolean {
  if (!authService.isAuthEnabled()) return true;
  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  return authService.verifySessionToken(token).valid;
}

const loadStatic = (f: string) => { try { return fs.readFileSync(path.join(publicDir, f), 'utf-8'); } catch { return ''; } };
const noCache = (c: any) => c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
app.get('/', (c) => { noCache(c); return c.html(loadStatic('index.html')); });
app.get('/app.js', (c) => { noCache(c); return c.text(loadStatic('app.js'), 200, { 'Content-Type': 'application/javascript; charset=utf-8' }); });
app.get('/catalog.js', (c) => { noCache(c); return c.text(loadStatic('catalog.js'), 200, { 'Content-Type': 'application/javascript; charset=utf-8' }); });
app.get('/style.css', (c) => { noCache(c); return c.text(loadStatic('style.css'), 200, { 'Content-Type': 'text/css; charset=utf-8' }); });

app.get('/stream.mp3', (c) => {
  c.header('Content-Type', 'audio/mpeg');
  c.header('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
  c.header('Pragma', 'no-cache'); c.header('Expires', '0'); c.header('Accept-Ranges', 'none');
  c.header('Access-Control-Allow-Origin', '*'); c.header('Connection', 'keep-alive');
  c.header('icy-name', 'OWRadio Studio Stream');

  return stream(c, async (s) => {
    const mp3Client = globalPlayer.broadcastTee.addMp3Client();
    s.onAbort(() => { mp3Client.destroy(); });
    try {
      for await (const chunk of mp3Client) await s.write(chunk as Uint8Array);
    } catch {}
  });
});

app.get('/api/nowplaying', (c) => c.json(globalPlayer.getStateSnapshot()));

app.get('/api/events', (c) => {
  return streamSSE(c, async (sse) => {
    let alive = true;
    const sendSnapshot = async () => {
      if (!alive) return;
      try {
        await sse.writeSSE({ event: 'state', data: JSON.stringify(globalPlayer.getStateSnapshot()) });
      } catch {
        alive = false;
        clearInterval(timer);
        globalPlayer.off('stateUpdate', onUpdate);
      }
    };
    await sendSnapshot();
    const onUpdate = () => void sendSnapshot();
    globalPlayer.on('stateUpdate', onUpdate);
    const timer = setInterval(onUpdate, 1000);
    sse.onAbort(() => { alive = false; clearInterval(timer); globalPlayer.off('stateUpdate', onUpdate); });
    while (alive) await new Promise((r) => setTimeout(r, 5000));
  });
});

app.get('/api/auth/status', (c) =>
  c.json({
    authEnabled: authService.isAuthEnabled(),
    authMode: authService.getAuthMode(),
    isAdmin: checkAdmin(c),
  })
);

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (authService.verifyAdminPassword(String(body.password || ''))) {
    return c.json({ ok: true, token: authService.createSessionToken('password') });
  }
  return c.json({ error: 'Invalid admin password' }, 401);
});

app.post('/api/auth/verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(authService.verifySessionToken(String(body.token || '')));
});

app.get('/api/search', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const source = (c.req.query('source') || 'auto').trim();
  if (!q) return c.json({ results: [] });
  const tracks = await searchStudioCatalog(q, 18, 'Web Studio', source);
  return c.json({ results: tracks.map((t) => t.toJSON()) });
});

app.get('/api/charts', async (c) => {
  const country = (c.req.query('country') || 'gb').toLowerCase();
  const mapT = (t: any, src: string) => ({ id: `chart_${t.id}`, title: t.title, artist: t.artist, album: t.album, duration: t.duration, durationFormatted: `${Math.floor(t.duration / 60)}:${String(t.duration % 60).padStart(2, '0')}`, artworkUrl: t.cover, source: src });
  if (country === 'global') { const dz = await getDeezerChartTracks(40); return c.json({ country: 'global', tracks: dz.map((t) => mapT(t, 'deezer')) }); }
  const it = await getOfficialCharts(country as any, 40);
  return c.json({ country, tracks: it.map((t) => mapT(t, 'apple')) });
});

app.get('/api/discography', async (c) => {
  const artist = (c.req.query('artist') || '').trim();
  if (!artist) return c.json({ albums: [] });
  return c.json(await searchArtistDiscography(artist));
});

app.get('/api/album-tracks', async (c) => {
  const artist = (c.req.query('artist') || '').trim();
  const album = (c.req.query('album') || '').trim();
  const mbid = (c.req.query('mbid') || '').trim();
  const dzId = (c.req.query('deezerAlbumId') || '').trim();
  if (!artist && !album && !mbid && !dzId) return c.json({ tracks: [] });
  const tracks = await getAlbumTracklist(artist, album, mbid, dzId);
  return c.json({ artist, album, tracks });
});

app.post('/api/play-album', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const artist = String(body.artist || '').trim();
  const album = String(body.album || '').trim();
  const mode: 'now' | 'queue' = body.mode === 'queue' ? 'queue' : 'now';
  if (!artist || !album) return c.json({ error: 'Missing artist or album' }, 400);

  const raw = await getAlbumTracklist(artist, album, String(body.mbid || ''), String(body.deezerAlbumId || ''));
  const tracks = raw.map(
    (t: any) =>
      new AudioTrack({
        title: t.title, artist: t.artist || artist, album, duration: t.duration || 0,
        artworkUrl: t.cover || '', deezerId: t.deezerId || t.id, isrc: t.isrc || '',
        source: t.source || 'deezer', requestedBy: 'Album Explorer',
      })
  );
  if (tracks.length === 0) return c.json({ error: 'No tracks found for album' }, 404);
  if (mode === 'now') {
    const [first, ...rest] = tracks;
    await globalPlayer.playNow(first);
    if (rest.length > 0) globalPlayer.enqueueMany(rest);
  } else {
    globalPlayer.enqueueMany(tracks);
  }
  return c.json({ ok: true, count: tracks.length, state: globalPlayer.getStateSnapshot() });
});

app.post('/api/play', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const mode = body.mode === 'now' ? 'now' : 'queue';

  if (body.track) {
    const rawId = String(body.track.id || body.track.videoId || '');
    const isYtId = Boolean(rawId && !rawId.includes('_') && !['chart', 'dz', 'mb', 'trk', 'it'].some((p) => rawId.startsWith(p)));
    const trk = new AudioTrack({
      title: body.track.title, artist: body.track.artist, album: body.track.album || '',
      duration: Number(body.track.duration || 0), artworkUrl: body.track.artworkUrl || body.track.cover || '',
      source: body.track.source || 'deezer', videoId: isYtId ? rawId : undefined,
      deezerId: body.track.deezerId, isrc: body.track.isrc, isAutoplay: false, requestedBy: 'Web Studio',
    });
    if (mode === 'now') await globalPlayer.playNow(trk); else globalPlayer.enqueue(trk);
    return c.json({ ok: true, state: globalPlayer.getStateSnapshot() });
  }

  const query = String(body.query || '').trim();
  if (!query) return c.json({ error: 'Missing query or track' }, 400);
  const { tracks, collectionName } = await resolveQueryToTracks(query, 'Web Studio', body.source || 'auto');
  if (tracks.length === 0) return c.json({ error: `No studio matches found for "${query}"` }, 404);

  if (mode === 'now') {
    const [first, ...rest] = tracks;
    await globalPlayer.playNow(first);
    if (rest.length > 0) globalPlayer.enqueueMany(rest);
  } else {
    globalPlayer.enqueueMany(tracks);
  }
  return c.json({ ok: true, collectionName, count: tracks.length, state: globalPlayer.getStateSnapshot() });
});

app.post('/api/player/volume', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const updated = globalPlayer.setVolume(Number(body.volume ?? 100));
  return c.json({ ok: true, volume: updated });
});

app.post('/api/player/:action', async (c) => {
  const action = c.req.param('action');
  switch (action) {
    case 'pause': globalPlayer.pause(); break;
    case 'resume': globalPlayer.resume(); break;
    case 'toggle':
      if (globalPlayer.isPaused) globalPlayer.resume();
      else if (globalPlayer.isPlaying) globalPlayer.pause();
      else void globalPlayer.playNext();
      break;
    case 'skip': globalPlayer.skip(); break;
    case 'stop': globalPlayer.stop(); break;
    case 'shuffle':
      if (globalPlayer.queue.length > 1) {
        for (let i = globalPlayer.queue.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [globalPlayer.queue[i], globalPlayer.queue[j]] = [globalPlayer.queue[j], globalPlayer.queue[i]];
        }
      } else {
        globalPlayer.deck2Track = null; globalPlayer.deck3Track = null;
        if (globalPlayer.isPlaying) void globalPlayer.prewarmDecks();
      }
      globalPlayer.emitStateUpdate(); break;
    case 'loop':
      globalPlayer.loopMode = globalPlayer.loopMode === 'off' ? 'queue' : globalPlayer.loopMode === 'queue' ? 'track' : 'off';
      globalPlayer.emitStateUpdate(); break;
    case 'clear':
      globalPlayer.queue = []; globalPlayer.deck2Track = null; globalPlayer.deck3Track = null;
      globalPlayer.emitStateUpdate();
      if (globalPlayer.isPlaying && globalPlayer.autoplay) void globalPlayer.prewarmDecks();
      break;
    case 'like': globalPlayer.voteCurrentTrack('up'); break;
    case 'dislike': globalPlayer.voteCurrentTrack('down'); break;
    default: return c.json({ error: `Unknown action: ${action}` }, 400);
  }
  return c.json({ ok: true, state: globalPlayer.getStateSnapshot() });
});

app.delete('/api/queue/:index', (c) => {
  const idx = parseInt(c.req.param('index'), 10);
  if (!Number.isNaN(idx) && idx >= 0) {
    if (globalPlayer.queue.length > 0 && idx < globalPlayer.queue.length) {
      globalPlayer.queue.splice(idx, 1);
    } else if (globalPlayer.queue.length === 0) {
      if (idx === 0) { globalPlayer.deck2Track = globalPlayer.deck3Track; globalPlayer.deck3Track = null; }
      else if (idx === 1) globalPlayer.deck3Track = null;
      if (globalPlayer.isPlaying) void globalPlayer.prewarmDecks();
    }
    globalPlayer.emitStateUpdate();
  }
  return c.json({ ok: true, state: globalPlayer.getStateSnapshot() });
});

app.post('/api/dj/toggle', async (c) => {
  const { isDjVoiceEnabled, setDjVoiceEnabled } = await import('../services/djVoice.js');
  const body = (await c.req.json().catch(() => ({}))) as any;
  const next = setDjVoiceEnabled(typeof body.enabled === 'boolean' ? body.enabled : !isDjVoiceEnabled());
  globalPlayer.emitStateUpdate();
  return c.json({ ok: true, djVoice: next, state: globalPlayer.getStateSnapshot() });
});

app.post('/api/dj/announce', async (c) => {
  const { announceNextTrackIfDue } = await import('../services/djVoice.js');
  void announceNextTrackIfDue(globalPlayer, true);
  return c.json({ ok: true });
});

app.post('/api/vibe', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.autoplay === 'boolean') globalPlayer.autoplay = body.autoplay;
  globalPlayer.setVibeConfig(body.mode as VibeMode | undefined, body.engine as VibeEngineSource | undefined);
  if (globalPlayer.autoplay && !globalPlayer.isPlaying) void globalPlayer.playNext();
  return c.json({ ok: true, state: globalPlayer.getStateSnapshot() });
});

app.post('/api/taste/remove', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body.key) removeTasteFeedback(String(body.key));
  globalPlayer.emitStateUpdate();
  return c.json({ ok: true, state: globalPlayer.getStateSnapshot() });
});

export function startWebServer(): void {
  serve({ fetch: app.fetch, port: config.WEB_PORT, hostname: config.WEB_HOST }, (info) => {
    console.log(`🌐 [Web] OWRadio Studio Dashboard online at http://localhost:${info.port}`);
  });
}
