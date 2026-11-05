/**
 * @file web/server.ts
 * @description Clean Hono Web Server & REST/SSE API for OWRadio.
 * Serves:
 * - /stream.mp3 (Continuous 192kbps live MP3 audio broadcast)
 * - /api/nowplaying & /api/events (Live state + Triple-Deck status)
 * - /api/search (Multi-catalog YouTube Music WEB_REMIX + Deezer + iTunes studio search)
 * - /api/play & /api/queue (Play Now / Queue with Spotify & YouTube URL support)
 * - /api/player/volume & /api/player/:action (Transport controls)
 * - /api/vibe & /api/charts (Real Vibe Mode / Engine configuration & UK/US Top 40 Charts)
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
import { searchStudioCatalog, resolveQueryToTracks } from '../services/searchService.js';
import { getOfficialCharts } from '../services/itunes.js';
import { getArtistCategorizedDiscography } from '../services/musicbrainz.js';
import { VibeMode, VibeEngineSource } from '../services/vibeEngine.js';
import authService from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');

export const app = new Hono();

function checkAdmin(c: any): boolean {
  if (!authService.isAuthEnabled()) return true;
  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const verified = authService.verifySessionToken(token);
  return verified.valid;
}

// --- Static Web Dashboard Assets ---
app.get('/', (c) => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf-8');
  return c.html(html);
});

app.get('/app.js', (c) => {
  const js = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf-8');
  return c.text(js, 200, { 'Content-Type': 'application/javascript; charset=utf-8' });
});

app.get('/style.css', (c) => {
  const cssPath = path.join(publicDir, 'style.css');
  if (fs.existsSync(cssPath)) {
    return c.text(fs.readFileSync(cssPath, 'utf-8'), 200, { 'Content-Type': 'text/css; charset=utf-8' });
  }
  return c.text('', 200, { 'Content-Type': 'text/css' });
});

// --- Continuous 192kbps MP3 Audio Broadcast ---
app.get('/stream.mp3', (c) => {
  c.header('Content-Type', 'audio/mpeg');
  c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  c.header('Connection', 'keep-alive');
  c.header('icy-name', 'OWRadio Studio Stream');

  return stream(c, async (s) => {
    const mp3Client = globalPlayer.broadcastTee.addMp3Client();
    s.onAbort(() => {
      mp3Client.destroy();
    });
    for await (const chunk of mp3Client) {
      await s.write(chunk as Uint8Array);
    }
  });
});

// --- Live State & SSE Telemetry ---
app.get('/api/nowplaying', (c) => {
  return c.json(globalPlayer.getStateSnapshot());
});

app.get('/api/events', (c) => {
  return streamSSE(c, async (sse) => {
    let alive = true;
    const sendSnapshot = async () => {
      if (!alive) return;
      try {
        await sse.writeSSE({
          event: 'state',
          data: JSON.stringify(globalPlayer.getStateSnapshot()),
        });
      } catch {}
    };

    await sendSnapshot();
    const onUpdate = () => void sendSnapshot();
    globalPlayer.on('stateUpdate', onUpdate);
    const timer = setInterval(onUpdate, 1000);

    sse.onAbort(() => {
      alive = false;
      clearInterval(timer);
      globalPlayer.off('stateUpdate', onUpdate);
    });

    while (alive) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  });
});

// --- Authentication Endpoints ---
app.get('/api/auth/status', (c) => {
  return c.json({
    authEnabled: authService.isAuthEnabled(),
    authMode: authService.getAuthMode(),
    isAdmin: checkAdmin(c),
  });
});

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const pw = String(body.password || '');
  if (authService.verifyAdminPassword(pw)) {
    const token = authService.createSessionToken('password');
    return c.json({ ok: true, token });
  }
  return c.json({ error: 'Invalid admin password' }, 401);
});

// --- Studio Search, Charts & Discography ---
app.get('/api/search', async (c) => {
  const q = (c.req.query('q') || '').trim();
  if (!q) return c.json({ results: [] });
  const tracks = await searchStudioCatalog(q, 15, 'Web Dashboard');
  return c.json({ results: tracks.map((t) => t.toJSON()) });
});

app.get('/api/charts', async (c) => {
  const country = (c.req.query('country') === 'us' ? 'us' : 'gb') as 'gb' | 'us';
  const charts = await getOfficialCharts(country, 40);
  return c.json({ country, tracks: charts });
});

app.get('/api/discography', async (c) => {
  const artist = (c.req.query('artist') || '').trim();
  if (!artist) return c.json({ albums: [] });
  const albums = await getArtistCategorizedDiscography(artist, 40);
  return c.json({ artist, albums });
});

// --- Play Now & Queue Endpoints ---
app.post('/api/play', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const mode: 'now' | 'queue' = body.mode === 'queue' ? 'queue' : 'now';

  if (body.track && body.track.title) {
    const trk = new AudioTrack({
      videoId: body.track.videoId || body.track.id?.replace(/^yt_/, ''),
      deezerId: body.track.deezerId,
      title: body.track.title,
      artist: body.track.artist || 'Unknown Artist',
      album: body.track.album || '',
      duration: Number(body.track.duration) || 0,
      artworkUrl: body.track.artworkUrl || body.track.cover || '',
      isrc: body.track.isrc || '',
      source: body.track.source || 'deezer',
      isAutoplay: false,
      requestedBy: 'Web Dashboard',
    });
    if (mode === 'now') {
      await globalPlayer.playNow(trk);
    } else {
      globalPlayer.enqueue(trk);
    }
    return c.json({ ok: true, state: globalPlayer.getStateSnapshot() });
  }

  const query = String(body.query || '').trim();
  if (!query) return c.json({ error: 'Missing query or track' }, 400);

  const { tracks, collectionName } = await resolveQueryToTracks(query, 'Web Dashboard');
  if (tracks.length === 0) {
    return c.json({ error: `No studio matches found for "${query}"` }, 404);
  }

  if (mode === 'now') {
    const [first, ...rest] = tracks;
    await globalPlayer.playNow(first);
    if (rest.length > 0) globalPlayer.enqueueMany(rest);
  } else {
    globalPlayer.enqueueMany(tracks);
  }

  return c.json({
    ok: true,
    collectionName,
    count: tracks.length,
    state: globalPlayer.getStateSnapshot(),
  });
});

// --- Volume & Transport Controls (Volume registered before :action wildcard!) ---
app.post('/api/player/volume', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const vol = Number(body.volume ?? 100);
  const updated = globalPlayer.setVolume(vol);
  return c.json({ ok: true, volume: updated });
});

app.post('/api/player/:action', async (c) => {
  const action = c.req.param('action');
  if (['skip', 'stop', 'clear'].includes(action) && !checkAdmin(c)) {
    return c.json({ error: 'Admin authentication required' }, 403);
  }

  switch (action) {
    case 'pause':
      globalPlayer.pause();
      break;
    case 'resume':
      globalPlayer.resume();
      break;
    case 'toggle':
      if (globalPlayer.isPaused) globalPlayer.resume();
      else if (globalPlayer.isPlaying) globalPlayer.pause();
      else void globalPlayer.playNext();
      break;
    case 'skip':
      globalPlayer.skip();
      break;
    case 'stop':
      globalPlayer.stop();
      break;
    case 'clear':
      globalPlayer.queue = [];
      globalPlayer.deck2Track = null;
      globalPlayer.deck3Track = null;
      globalPlayer.emitStateUpdate();
      break;
    case 'like':
      globalPlayer.voteCurrentTrack('up');
      break;
    case 'dislike':
      globalPlayer.voteCurrentTrack('down');
      break;
    default:
      return c.json({ error: `Unknown action: ${action}` }, 400);
  }
  return c.json({ ok: true, state: globalPlayer.getStateSnapshot() });
});

app.delete('/api/queue/:index', (c) => {
  const idx = parseInt(c.req.param('index'), 10);
  if (!Number.isNaN(idx) && idx >= 0 && idx < globalPlayer.queue.length) {
    globalPlayer.queue.splice(idx, 1);
    globalPlayer.emitStateUpdate();
  }
  return c.json({ ok: true, state: globalPlayer.getStateSnapshot() });
});

app.post('/api/vibe', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const mode = body.mode as VibeMode | undefined;
  const engine = body.engine as VibeEngineSource | undefined;
  if (typeof body.autoplay === 'boolean') {
    globalPlayer.autoplay = body.autoplay;
  }
  globalPlayer.setVibeConfig(mode, engine);
  return c.json({ ok: true, state: globalPlayer.getStateSnapshot() });
});

export function startWebServer(): void {
  serve(
    {
      fetch: app.fetch,
      port: config.WEB_PORT,
      hostname: config.WEB_HOST,
    },
    (info) => {
      console.log(`🌐 [Web] OWRadio Studio Dashboard online at http://localhost:${info.port}`);
    }
  );
}
