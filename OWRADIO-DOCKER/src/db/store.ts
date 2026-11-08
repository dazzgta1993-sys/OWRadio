/**
 * @file db/store.ts
 * @description L2 SQLite persistence store for API cache, 6-pass stream resolutions,
 * playback history, and guild taste feedback (likes/dislikes).
 */

import sqlite from './index.js';

export interface StreamResolutionRecord {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  channel?: string;
  matchType?: string;
}

export interface CooldownEntry {
  key: string;
  type: 'artist' | 'track';
  remainingMins: number;
}

export interface TasteProfile {
  likedArtists: Set<string>;
  dislikedArtists: Set<string>;
  dislikedTracks: Set<string>;
  cooldowns: CooldownEntry[];
}

const memApiCache = new Map<string, { data: any; expiresAt: number }>();

export function getApiCache<T = any>(key: string): T | null {
  const now = Math.floor(Date.now() / 1000);
  const mem = memApiCache.get(key);
  if (mem) {
    if (mem.expiresAt > now) return mem.data as T;
    memApiCache.delete(key);
  }
  try {
    const row = sqlite
      .prepare('SELECT payload_json, expires_at FROM api_cache WHERE cache_key = ?')
      .get(key);
    if (row && Number(row.expires_at) > now) {
      const parsed = JSON.parse(String(row.payload_json));
      memApiCache.set(key, { data: parsed, expiresAt: Number(row.expires_at) });
      return parsed as T;
    }
  } catch {}
  return null;
}

export function setApiCache(key: string, data: any, ttlSeconds = 1800, namespace = 'general'): void {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  if (memApiCache.size > 400) {
    const now = Math.floor(Date.now() / 1000);
    for (const [k, v] of memApiCache.entries()) {
      if (v.expiresAt <= now) memApiCache.delete(k);
    }
    if (memApiCache.size > 400) memApiCache.clear();
    try { sqlite.prepare('DELETE FROM api_cache WHERE expires_at <= ?').run(now); } catch {}
  }
  memApiCache.set(key, { data, expiresAt });
  try {
    sqlite
      .prepare(
        `INSERT INTO api_cache (cache_key, namespace, payload_json, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           payload_json = excluded.payload_json,
           expires_at = excluded.expires_at`
      )
      .run(key, namespace, JSON.stringify(data), expiresAt);
  } catch {}
}

export function getStreamResolution(cacheKey: string): StreamResolutionRecord | null {
  try {
    const row = sqlite
      .prepare('SELECT * FROM stream_resolutions WHERE cache_key = ?')
      .get(cacheKey);
    if (!row) return null;
    const ageSecs = Math.floor(Date.now() / 1000) - Number(row.updated_at || 0);
    if (ageSecs > 86400 * 30) return null;
    return {
      id: String(row.video_id),
      title: String(row.title),
      artist: String(row.artist),
      album: String(row.album || ''),
      duration: Number(row.duration_sec || 0),
      channel: String(row.channel || ''),
      matchType: String(row.match_type || ''),
    };
  } catch {
    return null;
  }
}

export function setStreamResolution(cacheKey: string, rec: StreamResolutionRecord): void {
  try {
    sqlite
      .prepare(
        `INSERT INTO stream_resolutions (cache_key, video_id, title, artist, album, duration_sec, channel, match_type, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           video_id = excluded.video_id,
           title = excluded.title,
           artist = excluded.artist,
           album = excluded.album,
           duration_sec = excluded.duration_sec,
           channel = excluded.channel,
           match_type = excluded.match_type,
           updated_at = excluded.updated_at`
      )
      .run(
        cacheKey,
        rec.id,
        rec.title,
        rec.artist,
        rec.album || '',
        rec.duration || 0,
        rec.channel || '',
        rec.matchType || 'ytmusic_studio',
        Math.floor(Date.now() / 1000)
      );
  } catch {}
}

export function savePlaybackHistory(track: {
  id: string;
  videoId?: string;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  artworkUrl?: string;
  source?: string;
  isAutoplay?: boolean;
  requestedBy?: string;
}, guildId = 'global'): void {
  try {
    sqlite
      .prepare(
        `INSERT INTO playback_history
         (guild_id, track_id, video_id, title, artist, album, duration_sec, artwork_url, source, is_autoplay, requested_by, played_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        guildId,
        track.id,
        track.videoId || '',
        track.title,
        track.artist,
        track.album || '',
        track.duration || 0,
        track.artworkUrl || '',
        track.source || 'ytmusic',
        track.isAutoplay ? 1 : 0,
        track.requestedBy || 'Listener',
        Date.now()
      );
  } catch {}
}

export function getRecentHistory(limit = 30, guildId = 'global'): Record<string, any>[] {
  try {
    return sqlite
      .prepare('SELECT * FROM playback_history WHERE guild_id = ? ORDER BY played_at DESC LIMIT ?')
      .all(guildId, limit);
  } catch {
    return [];
  }
}

export function recordTasteFeedback(artist: string, title: string, vote: 'up' | 'down', guildId = 'global'): TasteProfile {
  const now = Math.floor(Date.now() / 1000);
  const artKey = (artist || '').trim().toLowerCase();
  const trkKey = `${artKey} - ${(title || '').trim().toLowerCase()}`;
  try {
    sqlite.exec('BEGIN IMMEDIATE');
    if (artKey) {
      sqlite
        .prepare(
          `INSERT INTO taste_feedback (guild_id, entity_type, entity_key, vote, updated_at)
           VALUES (?, 'artist', ?, ?, ?)
           ON CONFLICT(guild_id, entity_type, entity_key) DO UPDATE SET vote = excluded.vote, updated_at = excluded.updated_at`
        )
        .run(guildId, artKey, vote, now);
    }
    if (title) {
      sqlite
        .prepare(
          `INSERT INTO taste_feedback (guild_id, entity_type, entity_key, vote, updated_at)
           VALUES (?, 'track', ?, ?, ?)
           ON CONFLICT(guild_id, entity_type, entity_key) DO UPDATE SET vote = excluded.vote, updated_at = excluded.updated_at`
        )
        .run(guildId, trkKey, vote, now);
    }
    sqlite.exec('COMMIT');
  } catch {
    try { sqlite.exec('ROLLBACK'); } catch {}
  }
  return getTasteProfile(guildId);
}

export function getTasteProfile(guildId = 'global'): TasteProfile {
  const likedArtists = new Set<string>();
  const dislikedArtists = new Set<string>();
  const dislikedTracks = new Set<string>();
  const cooldowns: CooldownEntry[] = [];
  const expiredArtists: string[] = [];
  const expiredTracks: string[] = [];
  const now = Math.floor(Date.now() / 1000);
  try {
    const rows = sqlite
      .prepare('SELECT entity_type, entity_key, vote, updated_at FROM taste_feedback WHERE guild_id = ?')
      .all(guildId);
    for (const r of rows) {
      const key = String(r.entity_key);
      const age = now - Number(r.updated_at || now);
      if (r.entity_type === 'artist') {
        if (r.vote === 'up') likedArtists.add(key);
        else if (r.vote === 'down') {
          if (age < 7200) {
            dislikedArtists.add(key);
            cooldowns.push({ key, type: 'artist', remainingMins: Math.max(1, Math.ceil((7200 - age) / 60)) });
          } else expiredArtists.push(key);
        }
      } else if (r.entity_type === 'track' && r.vote === 'down') {
        if (age < 86400) {
          dislikedTracks.add(key);
          cooldowns.push({ key, type: 'track', remainingMins: Math.max(1, Math.ceil((86400 - age) / 60)) });
        } else expiredTracks.push(key);
      }
    }
    if (expiredArtists.length > 0 || expiredTracks.length > 0) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const delArt = sqlite.prepare("DELETE FROM taste_feedback WHERE guild_id = ? AND entity_type = 'artist' AND entity_key = ?");
        for (const k of expiredArtists) delArt.run(guildId, k);
        const delTrk = sqlite.prepare("DELETE FROM taste_feedback WHERE guild_id = ? AND entity_type = 'track' AND entity_key = ?");
        for (const k of expiredTracks) delTrk.run(guildId, k);
        sqlite.exec('COMMIT');
      } catch {
        try { sqlite.exec('ROLLBACK'); } catch {}
      }
    }
  } catch {}
  return { likedArtists, dislikedArtists, dislikedTracks, cooldowns };
}

export function removeTasteFeedback(entityKey: string, guildId = 'global'): void {
  const clean = (entityKey || '').trim().toLowerCase();
  if (!clean) return;
  try {
    sqlite
      .prepare('DELETE FROM taste_feedback WHERE guild_id = ? AND (entity_key = ? OR entity_key LIKE ?)')
      .run(guildId, clean, `${clean} - %`);
  } catch {}
}

export function getRuntimeSetting(key: string, defaultVal = ''): string {
  try {
    const row = sqlite.prepare('SELECT value FROM runtime_settings WHERE key = ?').get(key);
    return row ? String(row.value) : defaultVal;
  } catch {
    return defaultVal;
  }
}

export function setRuntimeSetting(key: string, value: string): void {
  try {
    sqlite
      .prepare('INSERT INTO runtime_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  } catch {}
}
