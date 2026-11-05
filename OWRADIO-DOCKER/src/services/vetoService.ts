/**
 * @file vetoService.ts
 * @description Centralized blacklist and veto manager for artists and tracks in OWRadio.
 * Prevents vetoed items from ever entering autonomous curation, with support for
 * admin manual bans and community consensus auto-vetos (e.g. 3 dislikes in a room).
 */

import { sqlite } from '../db/index.js';
import { normalizeArtist, normalizeTrackTitle } from '../utils/trackDedupe.js';

export interface VetoItem {
  id: number;
  targetType: 'artist' | 'song';
  targetKey: string;
  displayName: string;
  reason: 'manual_admin' | 'community_dislikes';
  createdAt: number;
}

class VetoService {
  private vetoedArtists = new Set<string>();
  private vetoedSongs = new Set<string>();
  private dislikeTracking = new Map<string, Set<string>>(); // targetKey -> Set of userIds

  constructor() {
    this.ensureTable();
    this.reloadCache();
  }

  private ensureTable(): void {
    try {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS vetoed_catalog (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          target_type TEXT NOT NULL,
          target_key TEXT NOT NULL,
          display_name TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT 'manual_admin',
          created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_veto_target_unique ON vetoed_catalog(target_type, target_key);
      `);
    } catch (err) {
      console.error('[VetoService] Failed to bootstrap vetoed_catalog table:', err);
    }
  }

  private reloadCache(): void {
    try {
      const rows = sqlite.prepare('SELECT target_type, target_key FROM vetoed_catalog').all() as Array<{
        target_type: string;
        target_key: string;
      }>;

      this.vetoedArtists.clear();
      this.vetoedSongs.clear();

      for (const row of rows) {
        if (row.target_type === 'artist') {
          this.vetoedArtists.add(row.target_key);
        } else if (row.target_type === 'song') {
          this.vetoedSongs.add(row.target_key);
        }
      }
      console.log(`[VetoService] Loaded ${this.vetoedArtists.size} vetoed artists and ${this.vetoedSongs.size} vetoed songs.`);
    } catch (err) {
      console.error('[VetoService] Failed to load veto cache:', err);
    }
  }

  public isArtistVetoed(artistName: string): boolean {
    if (!artistName) return false;
    const key = normalizeArtist(artistName);
    return this.vetoedArtists.has(key);
  }

  public isSongVetoed(title: string, artistName?: string): boolean {
    if (!title) return false;
    if (artistName && this.isArtistVetoed(artistName)) return true;

    const normTitle = normalizeTrackTitle(title);
    if (this.vetoedSongs.has(normTitle)) return true;

    if (artistName) {
      const compositeKey = `${normalizeArtist(artistName)}:${normTitle}`;
      if (this.vetoedSongs.has(compositeKey)) return true;
    }

    return false;
  }

  public addVeto(
    targetType: 'artist' | 'song',
    name: string,
    reason: 'manual_admin' | 'community_dislikes' = 'manual_admin'
  ): boolean {
    if (!name || name.trim().length === 0) return false;
    const displayName = name.trim();
    const key = targetType === 'artist' ? normalizeArtist(displayName) : normalizeTrackTitle(displayName);
    const now = Math.floor(Date.now() / 1000);

    try {
      sqlite.prepare(`
        INSERT INTO vetoed_catalog (target_type, target_key, display_name, reason, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(target_type, target_key) DO UPDATE SET
          reason = excluded.reason,
          created_at = excluded.created_at
      `).run(targetType, key, displayName, reason, now);

      if (targetType === 'artist') {
        this.vetoedArtists.add(key);
      } else {
        this.vetoedSongs.add(key);
      }
      console.log(`[VetoService] 🚫 Vetoed ${targetType}: "${displayName}" (reason: ${reason})`);
      return true;
    } catch (err) {
      console.error(`[VetoService] Failed to add veto for ${displayName}:`, err);
      return false;
    }
  }

  public removeVeto(idOrKey: number | string): boolean {
    try {
      if (typeof idOrKey === 'number' || !isNaN(Number(idOrKey))) {
        sqlite.prepare('DELETE FROM vetoed_catalog WHERE id = ?').run(Number(idOrKey));
      } else {
        sqlite.prepare('DELETE FROM vetoed_catalog WHERE target_key = ?').run(String(idOrKey));
      }
      this.reloadCache();
      return true;
    } catch (err) {
      console.error('[VetoService] Failed to remove veto:', err);
      return false;
    }
  }

  public getAllVetoes(): VetoItem[] {
    try {
      const rows = sqlite.prepare(`
        SELECT id, target_type as targetType, target_key as targetKey, display_name as displayName, reason, created_at as createdAt
        FROM vetoed_catalog
        ORDER BY created_at DESC
      `).all() as unknown as VetoItem[];
      return rows;
    } catch (err) {
      console.error('[VetoService] Failed to query vetoes:', err);
      return [];
    }
  }

  /**
   * Tracks listener dislikes and automatically vetos an artist if 3 unique listeners dislike them in voice.
   */
  public registerDislike(
    artistName: string,
    songTitle: string,
    userId: string
  ): { autoVetoed: boolean; message?: string } {
    if (!artistName || !userId) return { autoVetoed: false };
    const artistKey = normalizeArtist(artistName);

    if (!this.dislikeTracking.has(artistKey)) {
      this.dislikeTracking.set(artistKey, new Set());
    }

    const userSet = this.dislikeTracking.get(artistKey)!;
    userSet.add(userId);

    if (userSet.size >= 3 && !this.isArtistVetoed(artistName)) {
      this.addVeto('artist', artistName, 'community_dislikes');
      this.dislikeTracking.delete(artistKey);
      return {
        autoVetoed: true,
        message: `🚫 **${artistName}** has received 3 room dislikes and has been automatically vetoed from the station!`,
      };
    }

    return { autoVetoed: false };
  }
}

export const vetoService = new VetoService();
export default vetoService;
