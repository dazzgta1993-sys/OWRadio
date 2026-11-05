/**
 * @file server.ts
 * @description Embedded Hono HTTP server running on port 8091 with CORS enabled.
 * Provides /stream.mp3 live VLC audio broadcast, /api/nowplaying (<600B JSON),
 * /api/queue, /api/events (SSE), and serves the dark-mode web dashboard.
 */

import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serve } from '@hono/node-server';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import authService from './auth.js';
import type { GuildPlayer } from '../player/GuildPlayer.js';
import { AudioTrack } from '../player/AudioTrack.js';
import youtube from '../services/youtube.js';
import deezer from '../services/deezer.js';
import linkParser from '../services/linkParser.js';
import vibeService from '../services/vibeService.js';
import musicbrainz from '../services/musicbrainz.js';
import curator from '../services/curator.js';
import vectorCurator from '../services/vectorCurator.js';
import brainLogger from '../services/brainLogger.js';
import tasteRadar from '../services/tasteRadar.js';
import playlistParser from '../services/playlistParser.js';
import featureFlags from '../services/featureFlags.js';
import { detectTrackLanguage } from '../services/languageDetector.js';
import stationCurator from '../services/stationCurator.js';
import vault from '../services/vault.js';
import harmonicMixing from '../services/harmonicMixing.js';
import { normalizeArtist, normalizeTrackTitle, getTrackDedupeKey } from '../utils/trackDedupe.js';
import tasteRadarChart from '../services/tasteRadarChart.js';
import dynamicSettings from '../services/dynamicSettings.js';
import vetoService from '../services/vetoService.js';
import baselineService from '../services/baselineService.js';
import { sqlite, getBotState } from '../db/index.js';
import { executeAutoResume } from '../bot/autoResume.js';

export function createWebServer(player: GuildPlayer) {
  const app = new Hono();

  // Enable open CORS for IoT devices, scripts, and local web dashboards
  app.use('*', cors());

  // --- 1. GET /stream.mp3 (VLC / Browser Audio Stream) ---
  app.get('/stream.mp3', (c) => {
    c.header('Content-Type', 'audio/mpeg');
    c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    c.header('Connection', 'keep-alive');
    c.header('Pragma', 'no-cache');
    c.header('Expires', '0');
    c.header('icy-name', 'OWRadio Live Radio');
    c.header('icy-genre', 'Eclectic Curation');
    c.header('icy-br', '192');

    const clientStream = new PassThrough();
    player.broadcastTee.addHttpClient(clientStream);

    c.req.raw.signal.addEventListener('abort', () => {
      player.broadcastTee.removeHttpClient(clientStream);
      clientStream.destroy();
    });

    return c.body(clientStream as any);
  });

  // --- Authentication Middleware ---
  const requireAdminAuth = async (c: any, next: any) => {
    if (!authService.isAuthEnabled()) {
      return next();
    }

    let token = getCookie(c, 'owradio_session');
    const authHeader = c.req.header('authorization');
    if (!token && authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    }

    if (!token) {
      return c.json({ error: 'Admin authentication required', code: 'AUTH_REQUIRED' }, 401);
    }

    const verification = authService.verifySessionToken(token);
    if (!verification.valid) {
      return c.json({ error: 'Invalid or expired session token', code: 'INVALID_TOKEN' }, 401);
    }

    c.set('authSession', verification.session);
    return next();
  };

  const checkIsAdmin = (c: Context): boolean => {
    if (!authService.isAuthEnabled()) return true;
    let token = getCookie(c, 'owradio_session');
    const authHeader = c.req.header('authorization');
    if (!token && authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    }
    if (!token) return false;
    return authService.verifySessionToken(token).valid;
  };

  // --- Auth API Endpoints ---
  app.get('/api/auth/status', (c) => {
    const isEnabled = authService.isAuthEnabled();
    const authMode = authService.getAuthMode();
    let token = getCookie(c, 'owradio_session');
    const authHeader = c.req.header('authorization');
    if (!token && authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    }
    const verification = token ? authService.verifySessionToken(token) : { valid: false };
    return c.json({
      enabled: isEnabled,
      authMode,
      authenticated: !isEnabled || verification.valid,
      user: verification.session?.user || null,
      supabaseConfig: (authMode === 'supabase' || authMode === 'both') ? {
        url: config.SUPABASE_URL,
        anonKey: config.SUPABASE_ANON_KEY,
      } : null,
    });
  });

  app.post('/api/auth/login', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const password = body.password;
    if (!password || typeof password !== 'string') {
      return c.json({ error: 'Password is required' }, 400);
    }

    if (!authService.verifyAdminPassword(password)) {
      return c.json({ error: 'Incorrect admin password' }, 401);
    }

    const token = authService.createSessionToken('password', { name: 'Admin', role: 'admin' });
    setCookie(c, 'owradio_session', token, {
      path: '/',
      httpOnly: false,
      sameSite: 'Lax',
      maxAge: 7 * 24 * 3600,
    });

    return c.json({ success: true, token, role: 'admin' });
  });

  app.post('/api/auth/supabase-verify', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const accessToken = body.accessToken || body.access_token;
    if (!accessToken || typeof accessToken !== 'string') {
      return c.json({ error: 'Access token is required' }, 400);
    }

    const result = await authService.verifySupabaseToken(accessToken);
    if (!result.valid) {
      return c.json({ error: 'Invalid Google OAuth token' }, 401);
    }

    const token = authService.createSessionToken('supabase', result.user);
    setCookie(c, 'owradio_session', token, {
      path: '/',
      httpOnly: false,
      sameSite: 'Lax',
      maxAge: 7 * 24 * 3600,
    });

    return c.json({ success: true, token, user: result.user, role: 'admin' });
  });

  app.post('/api/auth/logout', (c) => {
    deleteCookie(c, 'owradio_session', { path: '/' });
    return c.json({ success: true });
  });

  // --- 2. GET /api/nowplaying (<600 bytes JSON for IoT/ESP32) ---
  app.get('/api/nowplaying', (c) => {
    const host = c.req.header('host') || `127.0.0.1:${config.WEB_PORT}`;
    const protocol = c.req.header('x-forwarded-proto') || 'http';
    const baseUrl = `${protocol}://${host}`;

    const state = player.getStatePayload(baseUrl);
    return c.json(state);
  });

  // --- 3. GET /api/queue ---
  app.get('/api/queue', (c) => {
    const state = player.getStatePayload();
    const upcoming = player.getQueueList().map((t) => t.toQueueJson());

    // Fetch last 10 tracks from history
    const recentHistory = sqlite.prepare(`
      SELECT ph.id, s.title, ph.artist_name as artist, ph.played_at, ph.requested_by, ph.is_manual_request
      FROM playback_history ph
      JOIN songs s ON s.id = ph.song_id
      ORDER BY ph.played_at DESC
      LIMIT 10
    `).all();

    // Fetch active room affinities
    const activeUserIds = player.getActiveListenerUserIds();
    let roomAffinities: any[] = [];
    if (activeUserIds.length > 0) {
      const placeholders = activeUserIds.map(() => '?').join(',');
      roomAffinities = sqlite.prepare(`
        SELECT target_key, target_type, display_name, SUM(affinity_score) as total_affinity
        FROM user_preferences
        WHERE user_id IN (${placeholders})
        GROUP BY target_type, target_key
        ORDER BY total_affinity DESC
        LIMIT 10
      `).all(...activeUserIds);
    }

    return c.json({
      currentTrack: state.track,
      state: state.state,
      volume: state.volume,
      upcoming,
      recentHistory,
      roomAffinities,
      roomListeners: state.roomListeners,
    });
  });

  // --- 4. Queue Addition Handler (Public - Open to all users!) ---
  const handleQueueAdd = async (c: Context) => {
    const body = await c.req.json().catch(() => ({}));
    const query = body.query?.trim();
    const mode = body.mode || 'song';
    const isAdmin = checkIsAdmin(c);
    const playNow = Boolean(body.playNow) && isAdmin;
    const hadCurrentTrackBefore = Boolean(player.currentTrack);

    const maybePlayNow = () => {
      if (playNow && hadCurrentTrackBefore) {
        player.skip(body.userId || 'web_dashboard');
      }
    };

    if (!query) {
      return c.json({ error: 'Missing "query" parameter' }, 400);
    }

    if (mode === 'vibe') {
      const vibeItems = await vibeService.generateVibePlaylist(query, 5);

      const queuedSongIds = new Set<string>();
      const queuedArtists = new Set<string>();
      const queuedDedupeKeys = new Set<string>();
      const queuedLanguages = new Set<string>();

      if (player.currentTrack) {
        queuedSongIds.add(player.currentTrack.id);
        queuedArtists.add(player.currentTrack.artist.toLowerCase());
        const normCur = normalizeArtist(player.currentTrack.artist).replace(/\s+/g, '');
        if (normCur) queuedArtists.add(normCur);
        queuedDedupeKeys.add(getTrackDedupeKey(player.currentTrack.title, player.currentTrack.artist));
        const lang = detectTrackLanguage(player.currentTrack.title, player.currentTrack.artist);
        if (lang !== 'en') queuedLanguages.add(lang);
      }

      for (const q of player.getQueueList()) {
        queuedSongIds.add(q.id);
        queuedArtists.add(q.artist.toLowerCase());
        const normQ = normalizeArtist(q.artist).replace(/\s+/g, '');
        if (normQ) queuedArtists.add(normQ);
        queuedDedupeKeys.add(getTrackDedupeKey(q.title, q.artist));
        const lang = detectTrackLanguage(q.title, q.artist);
        if (lang !== 'en') queuedLanguages.add(lang);
      }

      let count = 0;
      for (const item of vibeItems) {
        const itemNormArtist = normalizeArtist(item.artist).replace(/\s+/g, '');
        if (itemNormArtist && queuedArtists.has(itemNormArtist)) {
          continue;
        }

        // Search YouTube first
        const ytResults = await youtube.searchTracks(`${item.artist} ${item.title}`, 1);
        const ytCandidate = ytResults[0];

        if (ytCandidate) {
          const candKey = getTrackDedupeKey(ytCandidate.title, ytCandidate.artist);
          const candNorm = normalizeArtist(ytCandidate.artist).replace(/\s+/g, '');

          if (
            !queuedDedupeKeys.has(candKey) &&
            (!candNorm || !queuedArtists.has(candNorm)) &&
            curator.isTrackEligibleForAutoplay(
              ytCandidate.id,
              ytCandidate.artist,
              queuedSongIds,
              queuedArtists,
              ytCandidate.title,
              queuedDedupeKeys,
              undefined,
              queuedLanguages
            )
          ) {
            const track = AudioTrack.fromYouTube(ytCandidate, 'web_dashboard', true, 'AI Vibe Mix', item.reason);
            await player.enqueue(track);
            queuedSongIds.add(ytCandidate.id);
            queuedArtists.add(ytCandidate.artist.toLowerCase());
            if (candNorm) queuedArtists.add(candNorm);
            if (itemNormArtist) queuedArtists.add(itemNormArtist);
            queuedDedupeKeys.add(candKey);
            const candLang = detectTrackLanguage(ytCandidate.title, ytCandidate.artist);
            if (candLang !== 'en') queuedLanguages.add(candLang);
            count++;
            continue;
          }
        }

        const results = await deezer.searchTracks(`${item.artist} ${item.title}`, 1);
        const meta = results[0];
        if (meta) {
          const metaKey = getTrackDedupeKey(meta.title, meta.artist);
          const metaNorm = normalizeArtist(meta.artist).replace(/\s+/g, '');

          if (
            !queuedDedupeKeys.has(metaKey) &&
            (!metaNorm || !queuedArtists.has(metaNorm)) &&
            curator.isTrackEligibleForAutoplay(
              meta.id,
              meta.artist,
              queuedSongIds,
              queuedArtists,
              meta.title,
              queuedDedupeKeys,
              meta.durationSec,
              queuedLanguages
            )
          ) {
            const track = AudioTrack.fromDeezer(meta, 'web_dashboard', true, 'AI Vibe Mix', item.reason);
            await player.enqueue(track);
            queuedSongIds.add(meta.id);
            queuedArtists.add(meta.artist.toLowerCase());
            if (metaNorm) queuedArtists.add(metaNorm);
            if (itemNormArtist) queuedArtists.add(itemNormArtist);
            queuedDedupeKeys.add(metaKey);
            const metaLang = detectTrackLanguage(meta.title, meta.artist);
            if (metaLang !== 'en') queuedLanguages.add(metaLang);
            count++;
          }
        }
      }
      maybePlayNow();
      return c.json({ success: true, enqueuedCount: count, mode: 'vibe' });
    }

    // Default song or link
    const parsed = linkParser.parseMusicLink(query);

    // YouTube Playlist
    if (parsed?.provider === 'youtube' && (parsed.type === 'playlist' || parsed.playlistId)) {
      const playlistId = parsed.playlistId || parsed.id;
      const ytTracks = await youtube.getPlaylistTracks(playlistId, 50);
      const tracks = ytTracks.map((meta) =>
        AudioTrack.fromYouTube(
          meta,
          'web_dashboard',
          true,
          'User Request',
          'Web Dashboard',
          'playlist',
          `yt_pl_${playlistId}`,
          'YouTube Playlist'
        )
      );
      const enqueuedCount = await player.enqueueBatch(tracks, playNow && hadCurrentTrackBefore);
      maybePlayNow();
      return c.json({ success: true, enqueuedCount, provider: 'youtube', type: 'playlist' });
    }

    // YouTube Single Track
    if (parsed?.provider === 'youtube' && parsed.type === 'track') {
      const ytMeta = await youtube.getTrack(parsed.id);
      if (!ytMeta) {
        return c.json({ error: `Could not resolve YouTube video: ${query}` }, 404);
      }
      const track = AudioTrack.fromYouTube(ytMeta, 'web_dashboard', true, 'User Request', undefined, 'single');
      await player.enqueue(track, playNow && hadCurrentTrackBefore);
      maybePlayNow();
      return c.json({ success: true, track: track.toNowPlayingJson(0) });
    }

    // Deezer Album
    if (parsed?.provider === 'deezer' && parsed.type === 'album') {
      const albumTracks = await deezer.getAlbumTracks(parsed.id);
      const tracks = albumTracks.map((meta) =>
        AudioTrack.fromDeezer(
          meta,
          'web_dashboard',
          true,
          'User Request',
          'Web Dashboard',
          'playlist',
          `dz_album_${parsed.id}`,
          'Deezer Album'
        )
      );
      const enqueuedCount = await player.enqueueBatch(tracks, playNow && hadCurrentTrackBefore);
      maybePlayNow();
      return c.json({ success: true, enqueuedCount });
    }

    // Deezer Playlist
    if (parsed?.provider === 'deezer' && parsed.type === 'playlist') {
      const playlistTracks = await deezer.getPlaylistTracks(parsed.id);
      const tracks = playlistTracks.map((meta) =>
        AudioTrack.fromDeezer(
          meta,
          'web_dashboard',
          true,
          'User Request',
          'Web Dashboard',
          'playlist',
          `dz_pl_${parsed.id}`,
          'Deezer Playlist'
        )
      );
      const enqueuedCount = await player.enqueueBatch(tracks, playNow && hadCurrentTrackBefore);
      maybePlayNow();
      return c.json({ success: true, enqueuedCount });
    }

    // Deezer Single Track
    if (parsed?.provider === 'deezer' && parsed.type === 'track') {
      const dzMeta = await deezer.getTrack(parsed.id);
      if (!dzMeta) {
        return c.json({ error: `Could not resolve Deezer track: ${query}` }, 404);
      }
      const track = AudioTrack.fromDeezer(dzMeta, 'web_dashboard', true, 'User Request', undefined, 'single');
      await player.enqueue(track, playNow && hadCurrentTrackBefore);
      maybePlayNow();
      return c.json({ success: true, track: track.toNowPlayingJson(0) });
    }

    // Freeform text query: Prioritize YouTube Search (99% YouTube)
    const ytResults = await youtube.searchTracks(query, 1);
    if (ytResults.length > 0) {
      const track = AudioTrack.fromYouTube(ytResults[0], 'web_dashboard', true, 'YouTube Search', undefined, 'single');
      await player.enqueue(track, playNow && hadCurrentTrackBefore);
      maybePlayNow();
      return c.json({ success: true, track: track.toNowPlayingJson(0) });
    }

    // Fallback to Deezer search
    const dzResults = await deezer.searchTracks(query, 1);
    if (dzResults.length > 0) {
      const track = AudioTrack.fromDeezer(dzResults[0], 'web_dashboard', true, 'User Request', undefined, 'single');
      await player.enqueue(track, playNow && hadCurrentTrackBefore);
      maybePlayNow();
      return c.json({ success: true, track: track.toNowPlayingJson(0) });
    }

    return c.json({ error: `Could not resolve track: ${query}` }, 404);
  };

  // Register Public Queue Endpoints (Unauthenticated guests can search & queue songs)
  app.post('/api/queue/add', handleQueueAdd);
  app.post('/api/player/queue', handleQueueAdd);

  // --- Click to Jump / Skip to specific track in queue ---
  app.post('/api/player/skip-to', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const index = typeof body.index === 'number' ? body.index : undefined;
    const id = typeof body.id === 'string' ? body.id : undefined;
    const target = index !== undefined ? index : id;
    if (target === undefined) {
      return c.json({ error: 'Missing "index" or "id" to skip to' }, 400);
    }
    const success = await player.jumpToQueueIndex(target);
    return c.json({ success, state: player.getStatePayload() });
  });

  // --- Instant Veto Currently Playing Track & Skip ---
  app.post('/api/player/veto-current', requireAdminAuth, (c) => {
    const current = player.currentTrack;
    if (!current) return c.json({ error: 'Nothing is currently playing' }, 400);
    vetoService.addVeto('artist', current.artist, 'manual_admin');
    player.skip();
    return c.json({ success: true, message: `Vetoed artist "${current.artist}" and skipped track.` });
  });

  // --- Veto / Blacklist Management Endpoints ---
  app.get('/api/vetoes', (c) => {
    return c.json({ vetoes: vetoService.getAllVetoes() });
  });

  app.post('/api/vetoes/add', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { targetType, name } = body;
    if (!targetType || !name) return c.json({ error: 'Missing targetType or name' }, 400);
    vetoService.addVeto(targetType, name, 'manual_admin');
    if (player.currentTrack && (vetoService.isArtistVetoed(player.currentTrack.artist) || vetoService.isSongVetoed(player.currentTrack.title, player.currentTrack.artist))) {
      player.skip();
    }
    return c.json({ success: true, vetoes: vetoService.getAllVetoes() });
  });

  app.post('/api/vetoes/remove', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { id, key } = body;
    const target = id !== undefined ? id : key;
    if (target === undefined) return c.json({ error: 'Missing id or key' }, 400);
    vetoService.removeVeto(target);
    if (typeof target === 'string') {
      sqlite.prepare("DELETE FROM user_preferences WHERE target_key = ? AND dislikes > 0").run(target.toLowerCase().trim());
    }
    return c.json({ success: true, vetoes: vetoService.getAllVetoes() });
  });

  app.post('/api/vetoes/pop', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { id, key } = body;
    const target = id !== undefined ? id : key;
    if (target === undefined) return c.json({ error: 'Missing id or key' }, 400);
    vetoService.removeVeto(target);
    if (typeof target === 'string') {
      sqlite.prepare("DELETE FROM user_preferences WHERE target_key = ? AND dislikes > 0").run(target.toLowerCase().trim());
    }
    return c.json({ success: true, vetoes: vetoService.getAllVetoes() });
  });

  // --- Wipe Taste Preferences (Requires re-entering Admin Password or Valid Admin Session) ---
  app.post('/api/preferences/wipe', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const provided = String(body.password || body.adminPassword || '');
    const isAdmin = checkIsAdmin(c);

    let isAuthorized = false;
    if (!authService.isAuthEnabled()) {
      isAuthorized = true;
    } else if (provided && authService.verifyAdminPassword(provided)) {
      isAuthorized = true;
    } else if (isAdmin && (!config.ADMIN_PASSWORD || authService.verifyAdminPassword(provided))) {
      isAuthorized = true;
    }

    if (!isAuthorized) {
      return c.json({ error: 'Invalid admin credentials. Authentication failed.' }, 401);
    }
    sqlite.prepare('DELETE FROM user_preferences').run();
    return c.json({ success: true, message: 'Taste preferences successfully wiped.' });
  });

  // --- Quick Pop Individual Taste Preference ---
  app.post('/api/preferences/pop', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { targetType, targetKey } = body;
    if (!targetType || !targetKey) return c.json({ error: 'Missing targetType or targetKey' }, 400);
    sqlite.prepare('DELETE FROM user_preferences WHERE target_type = ? AND target_key = ?').run(targetType, targetKey);
    return c.json({ success: true });
  });

  // --- Station DNA / Baseline Preferences (Editable in Web Studio) ---
  app.get('/api/baseline', (c) => {
    return c.json({
      success: true,
      baseline: baselineService.getBaseline(),
    });
  });

  app.post('/api/baseline', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const artists = Array.isArray(body.artists) ? body.artists : undefined;
    const genres = Array.isArray(body.genres) ? body.genres : undefined;
    const weight = typeof body.weight === 'number' ? body.weight : undefined;

    if (!artists && !genres && weight === undefined) {
      return c.json({ error: 'No baseline fields provided' }, 400);
    }

    const current = baselineService.getBaseline();
    const updated = baselineService.setBaseline(
      artists || current.artists,
      genres || current.genres,
      weight !== undefined ? weight : current.weight
    );

    return c.json({ success: true, baseline: updated });
  });

  app.post('/api/baseline/artist/add', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.artist) return c.json({ error: 'Missing artist name' }, 400);
    const updated = baselineService.addArtist(String(body.artist));
    return c.json({ success: true, baseline: updated });
  });

  app.post('/api/baseline/artist/remove', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.artist) return c.json({ error: 'Missing artist name' }, 400);
    const updated = baselineService.removeArtist(String(body.artist));
    return c.json({ success: true, baseline: updated });
  });

  app.post('/api/baseline/genre/add', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.genre) return c.json({ error: 'Missing genre' }, 400);
    const updated = baselineService.addGenre(String(body.genre));
    return c.json({ success: true, baseline: updated });
  });

  app.post('/api/baseline/genre/remove', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.genre) return c.json({ error: 'Missing genre' }, 400);
    const updated = baselineService.removeGenre(String(body.genre));
    return c.json({ success: true, baseline: updated });
  });
  // --- Queue Admin Controls (Clear & Remove) ---
  app.post('/api/queue/clear', requireAdminAuth, (c) => {
    player.clearQueue();
    return c.json({ success: true, message: 'Queue cleared' });
  });

  app.post('/api/queue/remove', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const index = typeof body.index === 'number' ? body.index : undefined;
    const id = typeof body.id === 'string' ? body.id : undefined;
    const target = index !== undefined ? index : id;
    if (target === undefined) {
      return c.json({ error: 'Missing "index" or "id" to remove' }, 400);
    }
    const removed = player.removeQueueTrack(target);
    return c.json({ success: removed, target });
  });

  // --- 5. POST /api/player/:action ---
  app.post('/api/player/:action', requireAdminAuth, async (c) => {
    const action = c.req.param('action');
    const body = await c.req.json().catch(() => ({}));

    switch (action) {
      case 'skip':
        player.skip(body.userId || 'web_dashboard');
        return c.json({ success: true, action: 'skip' });
      case 'pause':
        player.pause();
        return c.json({ success: true, action: 'pause' });
      case 'resume':
        if (!player.currentTrack && player.getQueueList().length > 0) {
          await player.playNext();
          return c.json({ success: true, action: 'resume' });
        }
        player.resume();
        return c.json({ success: true, action: 'resume' });
      case 'stop':
        player.stop();
        return c.json({ success: true, action: 'stop' });
      case 'clear':
        player.clearQueue();
        return c.json({ success: true, action: 'clear' });
      case 'volume':
        if (typeof body.volume === 'number') {
          player.setVolume(body.volume);
        }
        return c.json({ success: true, volume: player.getVolume() });
      case 'chime':
        player.triggerChime();
        return c.json({ success: true, action: 'chime' });
      default:
        return c.json({ error: `Unknown action: ${action}` }, 400);
    }
  });

  // --- 5b. GET /api/brain (Brain & LLM Telemetry) ---
  app.get('/api/brain', (c) => {
    const stats = brainLogger.getBrainStats();
    const recentInteractions = brainLogger.getRecentLogs(40);
    const activeUserIds = player.getActiveListenerUserIds();
    const roomProfile = curator.getActiveVoiceRoomProfile(activeUserIds);
    const activeListeners = player.getActiveListenerNames();

    // All user preferences joined with users table
    const preferences = sqlite.prepare(`
      SELECT p.id, p.user_id, COALESCE(u.display_name, u.username, 'User ' || SUBSTR(p.user_id, -4)) as user_name,
             p.target_type, p.target_key, p.display_name, p.likes, p.dislikes, p.early_skips, p.full_plays, p.affinity_score, p.updated_at
      FROM user_preferences p
      LEFT JOIN users u ON u.id = p.user_id
      ORDER BY p.affinity_score DESC, p.updated_at DESC
      LIMIT 100
    `).all();

    const now = Math.floor(Date.now() / 1000);
    const cutoff48h = now - (config.AUTOPLAY_COOLDOWN_HOURS * 3600);
    const cutoff2h = now - (config.ARTIST_COOLDOWN_HOURS * 3600);

    // Active 48h song cooldowns
    const songCooldowns = sqlite.prepare(`
      SELECT ph.id, s.title, ph.artist_name as artist, ph.played_at, ph.requested_by, ph.is_manual_request
      FROM playback_history ph
      JOIN songs s ON s.id = ph.song_id
      WHERE ph.played_at > ?
      ORDER BY ph.played_at DESC
      LIMIT 30
    `).all(cutoff48h);

    // Active 2h artist cooldowns
    const artistCooldowns = sqlite.prepare(`
      SELECT artist_name, MAX(played_at) as last_played_at
      FROM playback_history
      WHERE played_at > ?
      GROUP BY LOWER(artist_name)
      ORDER BY last_played_at DESC
      LIMIT 30
    `).all(cutoff2h);

    // Active foreign language cooldowns
    const languageCooldowns = curator.getActiveLanguageCooldowns();

    return c.json({
      vetoes: vetoService.getAllVetoes(),
      model: 'MusicBrainz + Deezer + YouTube Music',
      curationStatus: 'Active',
      currentEngine: curator.getEngine(),
      availableEngines: ['hybrid', 'graph', 'deezer'],
      indexedVectorsCount: vectorCurator.getIndexedCount(),
      threadClamp: 3,
      stats,
      recentInteractions,
      preferences,
      roomProfile,
      activeListeners,
      songCooldowns,
      artistCooldowns,
      languageCooldowns,
      cooldownConfig: {
        songCooldownHours: config.AUTOPLAY_COOLDOWN_HOURS,
        artistCooldownHours: config.ARTIST_COOLDOWN_HOURS,
        languageCooldownMinutes: dynamicSettings.getNumber('curation_language_cooldown_minutes', 120),
      },
      autoResume: {
        enabled: config.AUTO_RESUME,
        lastGuildId: getBotState('last_guild_id'),
        lastVoiceChannelId: getBotState('last_voice_channel_id'),
        lastVoiceChannelName: getBotState('last_voice_channel_name'),
        wasPlaying: getBotState('was_playing') === '1',
        lastTrackTitle: getBotState('last_track_title'),
      },
      tasteRadar: {
        target: 50_000,
        totalSongs: tasteRadar.getCatalogStats().totalSongs,
        totalEmbeddings: tasteRadar.getCatalogStats().totalEmbeddings,
        progressPct: ((tasteRadar.getCatalogStats().totalSongs / 50_000) * 100).toFixed(1),
      },
    });
  });

  // --- 5c. POST /api/brain/engine (Toggle Curation Architecture) ---
  app.post('/api/brain/engine', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const engine = body.engine;
    if (engine !== 'embedding' && engine !== 'graph' && engine !== 'deezer' && engine !== 'hybrid') {
      return c.json({ error: 'Invalid engine. Must be "embedding", "jev", "llm", or "hybrid"' }, 400);
    }
    curator.setEngine(engine);
    return c.json({ success: true, engine: curator.getEngine() });
  });

  // --- 5d. POST /api/brain/test-curation (On-Demand Dry Run with Active Engine) ---
  app.post('/api/brain/test-curation', requireAdminAuth, async (c) => {
    const activeUserIds = player.getActiveListenerUserIds();
    const roomProfile = curator.getActiveVoiceRoomProfile(activeUserIds);
    const SEED_ERAS = [
      '1980s Post-Punk & Synth',
      '1990s French Touch & Electro',
      'Cyberpunk Darksynth',
      '2000s Indie Dance',
      '1970s Funk & Soul',
      'Modern Melodic Techno',
    ];
    const randomSeedEra = SEED_ERAS[Math.floor(Math.random() * SEED_ERAS.length)];
    const t0 = performance.now();
    const activeEngine = curator.getEngine();
    let recommendations: any[] = [];

    recommendations = await curator.getNextAutoplayTracks(activeUserIds, 3);

    const durationMs = Math.round(performance.now() - t0);
    const latestInteraction = brainLogger.getRecentLogs(1)[0] || null;

    let modelName = 'MusicBrainz + Deezer + YouTube Music';

    return c.json({
      success: true,
      durationMs,
      engine: activeEngine,
      model: modelName,
      seedEra: randomSeedEra,
      roomProfile,
      recommendations,
      latestInteraction,
    });
  });

  // --- 5e. POST /api/player/autoresume (Trigger Auto-Resume on Demand) ---
  app.post('/api/player/autoresume', requireAdminAuth, async (c) => {
    const discordClient = player.getDiscordClient();
    if (!discordClient) {
      return c.json({ error: 'Discord bot client not initialized' }, 500);
    }
    const result = await executeAutoResume(discordClient, player);
    return c.json({ success: result.resumed, result });
  });

  // --- 5e-2. GET /api/player/meter (Live PCM Acoustic Energy Meter) ---
  app.get('/api/player/meter', (c) => {
    return c.json(player.broadcastTee.getLiveAudioMeter());
  });

  // --- 5e2. POST /api/taste/onboard (Ingest Spotify / YouTube playlist URL) ---
  app.post('/api/taste/onboard', async (c) => {
    try {
      const body = await c.req.json();
      const url = body?.url;
      if (!url || typeof url !== 'string') {
        return c.json({ error: 'Missing playlist URL' }, 400);
      }
      const userId = 'web_dashboard';
      const profile = await playlistParser.registerUserPlaylist(userId, url);
      return c.json({ success: true, profile });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- 5f. POST /api/brain/radar/scan (Trigger Taste Radar Expansion Cycle) ---
  app.post('/api/brain/radar/scan', requireAdminAuth, async (c) => {
    const result = await tasteRadar.runMiningCycle(35);
    return c.json({ success: true, result });
  });

  // --- 5g. GET /api/settings (Feature Flags, Dynamic Settings & System State) ---
  app.get('/api/settings', (c) => {
    const activeUserIds = player.getActiveListenerUserIds();
    const flags = featureFlags.getAllFlags();
    const configSettings = dynamicSettings.getAllSettings();
    const vaultStats = vault.getStats();
    const radioStations = stationCurator.getAllStations();
    const activeStation = stationCurator.getActiveStation();
    const timeCapsuleYear = stationCurator.getTimeCapsuleYear();
    const storyArc = stationCurator.getStoryArcState();
    const morph = stationCurator.getMorphState();
    const steering = vectorCurator.getVibeSteering();
    const currentTrackSummary = player.currentTrack ? {
      id: player.currentTrack.id,
      title: player.currentTrack.title,
      artist: player.currentTrack.artist,
      album: player.currentTrack.album,
      durationSec: player.currentTrack.durationSec,
    } : null;
    const tasteFingerprint = tasteRadarChart.getRoomFingerprint(activeUserIds, currentTrackSummary);

    return c.json({
      flags,
      configSettings,
      vaultStats,
      radioStations,
      activeStation,
      timeCapsuleYear,
      storyArc,
      morph,
      steering,
      tasteFingerprint,
    });
  });

  // --- 5g-2. GET /api/settings/config (Dedicated Config Settings List) ---
  app.get('/api/settings/config', (c) => {
    return c.json({
      success: true,
      settings: dynamicSettings.getAllSettings(),
    });
  });

  // --- 5g-3. POST /api/settings/config/update (Update Dynamic Runtime Setting) ---
  app.post('/api/settings/config/update', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const key = body.key;
    const value = body.value;

    if (!key || typeof key !== 'string') {
      return c.json({ error: 'Missing or invalid setting key' }, 400);
    }

    const res = dynamicSettings.set(key, value);
    if (!res.success) {
      return c.json({ error: res.error || 'Failed to update setting' }, 400);
    }

    return c.json({
      success: true,
      key,
      value: res.value,
      settings: dynamicSettings.getAllSettings(),
    });
  });

  // --- 5g-4. POST /api/settings/config/reset (Reset Dynamic Runtime Setting) ---
  app.post('/api/settings/config/reset', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const key = body.key;

    if (key && typeof key === 'string') {
      const res = dynamicSettings.reset(key);
      return c.json({ success: true, key, value: res.value });
    } else {
      dynamicSettings.resetAll();
      return c.json({ success: true, all: true, settings: dynamicSettings.getAllSettings() });
    }
  });

  // --- 5h. POST /api/settings/toggle (Toggle Individual Feature Flag) ---
  app.post('/api/settings/toggle', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const featureId = body.featureId;
    if (!featureId || typeof featureId !== 'string') {
      return c.json({ error: 'Missing or invalid featureId' }, 400);
    }

    let newState: boolean;
    if (typeof body.enabled === 'boolean') {
      featureFlags.setEnabled(featureId, body.enabled);
      newState = body.enabled;
    } else {
      newState = featureFlags.toggle(featureId);
    }

    return c.json({
      success: true,
      featureId,
      enabled: newState,
      flags: featureFlags.getAllFlags(),
    });
  });

  // --- 5q. POST /api/settings/restart (Graceful Server Daemon Restart) ---
  app.post('/api/settings/restart', requireAdminAuth, (c) => {
    console.log('[WebServer] ⚡ Admin requested server daemon restart via WebUI Settings.');
    setTimeout(() => {
      console.log('[WebServer] Exiting process for systemd auto-restart...');
      process.exit(0);
    }, 600);
    return c.json({ success: true, message: 'Server daemon restart initiated' });
  });

  // --- 5i. POST /api/settings/radio (Set Curated Radio Station Preset) ---
  app.post('/api/settings/radio', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const stationId = body.stationId || null;
    const station = stationCurator.setStation(stationId);
    await player.recurateAutoplayBuffer();
    return c.json({ success: true, activeStation: station });
  });

  // --- 5j. POST /api/settings/throwback (Set Time Capsule Year) ---
  app.post('/api/settings/throwback', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const year = typeof body.year === 'number' ? body.year : null;
    if (year) {
      await stationCurator.engageTimeCapsule(year);
    } else {
      stationCurator.setTimeCapsuleYear(null);
    }
    await player.recurateAutoplayBuffer();
    return c.json({ success: true, timeCapsuleYear: year });
  });

  // --- 5k. POST /api/settings/morph (Engage DJ Morph Mode) ---
  app.post('/api/settings/morph', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const targetVibe = body.targetVibe?.trim();
    if (!targetVibe) {
      stationCurator.cancelMorph();
      await player.recurateAutoplayBuffer();
      return c.json({ success: true, active: false });
    }

    const vector = await vectorCurator.embedText(targetVibe);
    if (!vector) {
      return c.json({ error: 'Could not generate embedding for target vibe' }, 400);
    }

    const morphSteps = body.steps || dynamicSettings.getNumber('curation_morph_steps', 4);
    stationCurator.startMorph(targetVibe, vector, morphSteps);
    await player.recurateAutoplayBuffer();
    return c.json({ success: true, morph: stationCurator.getMorphState() });
  });

  // --- 5l. POST /api/settings/vibe-steering (Engage Latent Vector Steering) ---
  app.post('/api/settings/vibe-steering', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const prompt = body.prompt?.trim();
    if (!prompt) {
      vectorCurator.setVibeSteering('', null);
      await player.recurateAutoplayBuffer();
      return c.json({ success: true, active: false });
    }

    const vector = await vectorCurator.embedText(prompt);
    if (!vector) {
      return c.json({ error: 'Could not generate embedding for prompt' }, 400);
    }

    vectorCurator.setVibeSteering(prompt, vector);
    await player.recurateAutoplayBuffer();
    return c.json({ success: true, steering: vectorCurator.getVibeSteering() });
  });

  // --- 5m. GET /api/settings/taste-radar (Room Taste DNA Fingerprint) ---
  app.get('/api/settings/taste-radar', (c) => {
    const activeUserIds = player.getActiveListenerUserIds();
    const currentTrackSummary = player.currentTrack ? {
      id: player.currentTrack.id,
      title: player.currentTrack.title,
      artist: player.currentTrack.artist,
      album: player.currentTrack.album,
      durationSec: player.currentTrack.durationSec,
    } : null;
    const fingerprint = tasteRadarChart.getRoomFingerprint(activeUserIds, currentTrackSummary);
    return c.json(fingerprint);
  });

  // --- 5n. POST /api/settings/vault/clear (Clear Server Vault Cache) ---
  app.post('/api/settings/vault/clear', requireAdminAuth, (c) => {
    vault.clear();
    return c.json({ success: true, vaultStats: vault.getStats() });
  });

  // --- 5o. GET /api/settings/features (Feature Flags List) ---
  app.get('/api/settings/features', (c) => {
    return c.json(featureFlags.getAllFlags());
  });

  // --- 5p. POST /api/settings/features/toggle (Toggle Feature Flag Alias) ---
  app.post('/api/settings/features/toggle', requireAdminAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const featureId = body.featureId;
    if (!featureId || typeof featureId !== 'string') {
      return c.json({ error: 'Missing or invalid featureId' }, 400);
    }

    let newState: boolean;
    if (typeof body.enabled === 'boolean') {
      featureFlags.setEnabled(featureId, body.enabled);
      newState = body.enabled;
    } else {
      newState = featureFlags.toggle(featureId);
    }

    return c.json({
      success: true,
      featureId,
      enabled: newState,
      flags: featureFlags.getAllFlags(),
    });
  });


  // --- 5q. GET /api/taste/radar (Taste Radar Fingerprint Alias) ---
  app.get('/api/taste/radar', (c) => {
    const activeUserIds = player.getActiveListenerUserIds();
    const currentTrackSummary = player.currentTrack ? {
      id: player.currentTrack.id,
      title: player.currentTrack.title,
      artist: player.currentTrack.artist,
      album: player.currentTrack.album,
      durationSec: player.currentTrack.durationSec,
    } : null;
    const fingerprint = tasteRadarChart.getRoomFingerprint(activeUserIds, currentTrackSummary);
    return c.json(fingerprint);
  });

  // --- 6. GET /api/events (Server-Sent Events) ---
  app.get('/api/events', (c) => {
    return streamSSE(c, async (stream) => {
      // Send initial state immediately
      const host = c.req.header('host') || `127.0.0.1:${config.WEB_PORT}`;
      const protocol = c.req.header('x-forwarded-proto') || 'http';
      const baseUrl = `${protocol}://${host}`;

      await stream.writeSSE({
        event: 'state',
        data: JSON.stringify(player.getStatePayload(baseUrl)),
      });

      const onStateChange = async (payload: any) => {
        try {
          await stream.writeSSE({
            event: 'state',
            data: JSON.stringify(payload),
          });
        } catch {
          clearInterval(heartbeat);
          player.off('stateChange', onStateChange);
        }
      };

      player.on('stateChange', onStateChange);

      let cleanedUp = false;
      let resolveClosed: () => void;
      const closedPromise = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(heartbeat);
        player.off('stateChange', onStateChange);
        resolveClosed?.();
      };

      stream.onAbort(cleanup);
      c.req.raw.signal.addEventListener('abort', cleanup);
      const rawReq = c.req.raw as any;
      if (rawReq?.socket) {
        rawReq.socket.once?.('close', cleanup);
        rawReq.socket.once?.('error', cleanup);
      }
      if (rawReq?.once) {
        rawReq.once('close', cleanup);
      }

      // Keep connection alive with periodic comments
      const heartbeat = setInterval(async () => {
        try {
          await stream.writeSSE({ event: 'ping', data: 'heartbeat' });
        } catch {
          cleanup();
        }
      }, 15_000);

      // Keep stream alive: block until client closes connection or aborts
      await closedPromise;
    });
  });

  // --- 7. Serve Embedded Dashboard ---
  const resolvePublicFile = (filename: string): string | null => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(process.cwd(), 'src', 'web', 'public', filename),
      path.join(process.cwd(), 'dist', 'web', 'public', filename),
      path.join(__dirname, 'public', filename),
      path.join(process.cwd(), 'public', filename),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  };

  const serveIndexHtml = (c: any) => {
    const htmlPath = resolvePublicFile('index.html');
    if (htmlPath) {
      return c.html(fs.readFileSync(htmlPath, 'utf-8'));
    }
    return c.text('OWRadio Web Dashboard loading...');
  };
  app.get('/', serveIndexHtml);
  app.get('/index.html', serveIndexHtml);

  app.get('/app.js', (c) => {
    const jsPath = resolvePublicFile('app.js');
    if (jsPath) {
      c.header('Content-Type', 'application/javascript');
      return c.body(fs.readFileSync(jsPath, 'utf-8'));
    }
    return c.text('// app.js not found', 404);
  });

  return app;
}

export function startWebServer(player: GuildPlayer) {
  const app = createWebServer(player);
  const server = serve({
    fetch: app.fetch,
    port: config.WEB_PORT,
    hostname: config.WEB_HOST,
  });
  console.log(`[WebServer] Hono server listening at http://${config.WEB_HOST}:${config.WEB_PORT}`);
  return server;
}

export default {
  createWebServer,
  startWebServer,
};
