/**
 * @file dynamicSettings.ts
 * @description Dynamic runtime configuration manager for VEXO.
 * Persists settings in SQLite (bot_settings) and maintains a high-speed synchronous in-memory cache.
 * Emits reactive events so player, audio, and curation engines apply updates immediately without restarts.
 */

import { EventEmitter } from 'node:events';
import { sqlite } from '../db/index.js';

export interface SettingDefinition<T = any> {
  key: string;
  category: 'Curation' | 'Audio & Mixing' | 'Discord' | 'Radar & Storage';
  name: string;
  description: string;
  type: 'number' | 'boolean' | 'string';
  control: 'slider' | 'toggle' | 'select' | 'radio' | 'number' | 'text';
  defaultValue: T;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: Array<{ label: string; value: any; description?: string }>;
}

export interface SettingItem extends SettingDefinition {
  value: any;
  updatedAt: number;
}

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  // --- Curation & Recommendation Engine ---
  {
    key: 'curation_song_cooldown_hours',
    category: 'Curation',
    name: 'Song Repeat Cooldown',
    description: 'Minimum hours before the exact same song can autoplay again.',
    type: 'number',
    control: 'slider',
    defaultValue: 48,
    min: 1,
    max: 168,
    step: 1,
    unit: 'h',
  },
  {
    key: 'curation_artist_cooldown_hours',
    category: 'Curation',
    name: 'Artist Repeat Cooldown',
    description: 'Minimum hours before another track by the same artist can autoplay.',
    type: 'number',
    control: 'slider',
    defaultValue: 2.0,
    min: 0.5,
    max: 12.0,
    step: 0.5,
    unit: 'h',
  },
  {
    key: 'curation_language_cooldown_minutes',
    category: 'Curation',
    name: 'Global Foreign Track Cooldown',
    description: 'Minimum minutes between any foreign language tracks across the station (1440m = maximum 1 foreign track per 24 hours).',
    type: 'number',
    control: 'slider',
    defaultValue: 1440,
    min: 60,
    max: 2880,
    step: 60,
    unit: 'min',
  },
  {
    key: 'curation_baseline_artists',
    category: 'Curation',
    name: 'Baseline Seed Artists',
    description: 'Comma-separated seed artists providing initial station DNA when room taste is empty. User likes/plays easily steer or overwrite this baseline.',
    type: 'string',
    control: 'text',
    defaultValue: 'Dua Lipa, Eminem, Metallica, Placebo, Muse, Ed Sheeran',
  },
  {
    key: 'curation_baseline_genres',
    category: 'Curation',
    name: 'Baseline Seed Genres',
    description: 'Comma-separated seed genres providing initial station DNA when room taste is empty.',
    type: 'string',
    control: 'text',
    defaultValue: 'hip hop, pop, alt rock',
  },
  {
    key: 'curation_baseline_weight',
    category: 'Curation',
    name: 'Baseline Influence Weight',
    description: 'Initial affinity weight for baseline seeds (0.1 = very subtle scaffold, 2.0 = strong station anchor).',
    type: 'number',
    control: 'slider',
    defaultValue: 0.5,
    min: 0.1,
    max: 2.0,
    step: 0.1,
  },
  {
    key: 'curation_buffer_target',
    category: 'Curation',
    name: 'Autoplay Buffer Depth',
    description: 'Target number of upcoming curated tracks maintained ahead in the queue.',
    type: 'number',
    control: 'slider',
    defaultValue: 6,
    min: 3,
    max: 15,
    step: 1,
    unit: 'tracks',
  },
  {
    key: 'curation_diversity_threshold',
    category: 'Curation',
    name: 'Latent Diversity Guard (Anti-Clustering)',
    description: 'Maximum cosine similarity between consecutive autoplay picks in 384-d latent space.',
    type: 'number',
    control: 'slider',
    defaultValue: 0.85,
    min: 0.60,
    max: 0.98,
    step: 0.01,
    unit: 'cos',
  },
  {
    key: 'curation_consensus_ratio',
    category: 'Curation',
    name: 'Tug-of-War Consensus Weight',
    description: 'Weight of multi-listener mathematical consensus (1.0 = pure intersection, 0.0 = individual taste).',
    type: 'number',
    control: 'slider',
    defaultValue: 0.30,
    min: 0.0,
    max: 1.0,
    step: 0.05,
    unit: '%',
  },
  {
    key: 'curation_morph_steps',
    category: 'Curation',
    name: 'DJ Morph Trajectory Steps',
    description: 'Number of intermediate tracks used when smoothly steering from current room taste to a target vibe.',
    type: 'number',
    control: 'radio',
    defaultValue: 4,
    options: [
      { label: '2 Tracks (Fast)', value: 2 },
      { label: '4 Tracks (Standard)', value: 4 },
      { label: '6 Tracks (Gradual)', value: 6 },
      { label: '8 Tracks (Extended)', value: 8 },
    ],
  },
  {
    key: 'curation_playlist_blend_mode',
    category: 'Curation',
    name: 'Playlist Multi-User Blending Mode',
    description: 'How multiple user playlists are blended in the queue: Interleaved (fair round-robin) vs Sequential (bulk blocks).',
    type: 'string',
    control: 'radio',
    defaultValue: 'interleaved',
    options: [
      { label: 'Fair Round-Robin (1:1)', value: 'interleaved' },
      { label: 'Harmonic Smart Blend', value: 'harmonic' },
      { label: 'Sequential Blocks (Legacy)', value: 'sequential' },
    ],
  },
  {
    key: 'curation_dj_only_queue',
    category: 'Curation',
    name: 'DJ-Only Queue Lock',
    description: 'Restrict track queueing to Admins and DJ roles only (blocks public listener requests).',
    type: 'boolean',
    control: 'toggle',
    defaultValue: false,
  },
  {
    key: 'curation_english_purity',
    category: 'Curation',
    name: '95% English Track Purity Guard',
    description: 'Strictly filter out foreign and non-Latin chart tracks from autonomous discovery.',
    type: 'boolean',
    control: 'toggle',
    defaultValue: true,
  },
  {
    key: 'curation_filter_live',
    category: 'Curation',
    name: 'Live Recordings Filter',
    description: 'Control how concert and live performance audio is curated.',
    type: 'string',
    control: 'radio',
    defaultValue: 'none',
    options: [
      { label: '🚫 No Lives', value: 'none', description: 'Strictly studio recordings only. Rejects any live versions.' },
      { label: '⭐ High Quality Live', value: 'high_quality', description: 'Allows official live albums & broadcasts (MTV Unplugged, BBC Live Lounge); rejects bootlegs/audience audio.' },
      { label: '📻 Any Live', value: 'any', description: 'Allows all live recordings and concert tracks.' },
    ],
  },
  {
    key: 'curation_filter_covers',
    category: 'Curation',
    name: 'Cover Tracks Filter',
    description: 'Control how cover songs and artist tributes are curated.',
    type: 'string',
    control: 'radio',
    defaultValue: 'none',
    options: [
      { label: '🚫 No Covers', value: 'none', description: 'Original artists only. Rejects all covers, karaoke, and tributes.' },
      { label: '⭐ High Quality Covers', value: 'high_quality', description: 'Allows notable / verified artist covers; rejects amateur bedroom/karaoke covers.' },
      { label: '📻 Any Covers', value: 'any', description: 'Allows all cover versions.' },
    ],
  },
  {
    key: 'curation_filter_instrumentals',
    category: 'Curation',
    name: 'Instrumentals & Backing Tracks Filter',
    description: 'Control how instrumental and karaoke audio is curated.',
    type: 'string',
    control: 'radio',
    defaultValue: 'none',
    options: [
      { label: '🚫 No Instrumentals', value: 'none', description: 'Vocal tracks only. Rejects karaoke, backing tracks, and instrumental cuts.' },
      { label: '⭐ High Quality Instrumentals', value: 'high_quality', description: 'Allows official studio instrumentals and orchestral scores; rejects generic karaoke/backing tracks.' },
      { label: '📻 Any Instrumentals', value: 'any', description: 'Allows all instrumental audio.' },
    ],
  },
  {
    key: 'curation_filter_remixes',
    category: 'Curation',
    name: 'Remixes & Edits Filter',
    description: 'Control how remixes, edits, and VIP versions are curated.',
    type: 'string',
    control: 'radio',
    defaultValue: 'none',
    options: [
      { label: '🚫 No Remixes', value: 'none', description: 'Original album / single master only. Rejects all remixes and edits.' },
      { label: '⭐ High Quality Remixes', value: 'high_quality', description: 'Allows official artist VIP/club remixes; rejects unofficial bootlegs, nightcore, slowed+reverb.' },
      { label: '📻 Any Remixes', value: 'any', description: 'Allows all remixes and bootlegs.' },
    ],
  },
  {
    key: 'curation_filter_rerecorded',
    category: 'Curation',
    name: 'Re-Recorded Versions Filter',
    description: 'Control whether vintage tracks re-recorded decades later are allowed.',
    type: 'string',
    control: 'radio',
    defaultValue: 'none',
    options: [
      { label: '🚫 Original Masters Only', value: 'none', description: 'Strictly original vintage recordings only. Rejects modern re-recordings (e.g. 2014 re-recordings, later remakes).' },
      { label: '📻 Any Version', value: 'any', description: 'Allows modern re-recorded versions and later studio cuts.' },
    ],
  },
  {
    key: 'curation_single_request_priority',
    category: 'Curation',
    name: 'Single Song Request VIP Priority',
    description: 'Single song requests jump ahead of bulk playlist tracks to play Up Next.',
    type: 'boolean',
    control: 'toggle',
    defaultValue: true,
  },

  // --- Audio Engine & Mixing Console ---
  {
    key: 'audio_skip_crossfade_sec',
    category: 'Audio & Mixing',
    name: 'User Skip Crossfade Duration',
    description: 'Duration of equal-power crossfade when users click Skip (0.0s is an instant cut).',
    type: 'number',
    control: 'slider',
    defaultValue: 0.5,
    min: 0.0,
    max: 2.0,
    step: 0.1,
    unit: 's',
  },
  {
    key: 'audio_silence_threshold_db',
    category: 'Audio & Mixing',
    name: 'Silence Trimming Threshold',
    description: 'RMS audio level in dBFS below which track lead-in silence is trimmed out.',
    type: 'number',
    control: 'slider',
    defaultValue: -46,
    min: -60,
    max: -25,
    step: 1,
    unit: 'dBFS',
  },
  {
    key: 'audio_outro_trigger_sec',
    category: 'Audio & Mixing',
    name: 'Outro Silence Handover Trigger',
    description: 'Duration of trailing silence before initiating early crossfade to Deck B.',
    type: 'number',
    control: 'slider',
    defaultValue: 1.5,
    min: 0.5,
    max: 4.0,
    step: 0.1,
    unit: 's',
  },
  {
    key: 'audio_chime_enabled',
    category: 'Audio & Mixing',
    name: 'Hourly Broadcast Chime',
    description: 'Play a warm synthesized 3-tone harmonic chime at the top of every hour.',
    type: 'boolean',
    control: 'toggle',
    defaultValue: true,
  },
  {
    key: 'audio_chime_duck_gain',
    category: 'Audio & Mixing',
    name: 'Hourly Chime Music Ducking Volume',
    description: 'Music volume level while the synthesized hourly chime sounds.',
    type: 'number',
    control: 'slider',
    defaultValue: 0.20,
    min: 0.0,
    max: 0.50,
    step: 0.05,
    unit: '%',
  },
  {
    key: 'audio_standby_decks_count',
    category: 'Audio & Mixing',
    name: 'Multi-Deck Pre-Buffering Horizon',
    description: 'Number of upcoming tracks actively decoded and pre-buffered in RAM for 0ms transitions.',
    type: 'number',
    control: 'select',
    defaultValue: 15,
    options: [
      { label: '3 Decks', value: 3 },
      { label: '5 Decks', value: 5 },
      { label: '10 Decks (Extended)', value: 10 },
      { label: '15 Decks (Full Queue Pre-Buffer)', value: 15 },
      { label: '20 Decks (Maximum Horizon)', value: 20 },
    ],
  },
  {
    key: 'audio_mp3_bitrate_kbps',
    category: 'Audio & Mixing',
    name: 'HTTP / VLC Radio Stream Bitrate',
    description: 'MP3 audio encoding quality for external VLC and browser stream listeners.',
    type: 'number',
    control: 'radio',
    defaultValue: 192,
    options: [
      { label: '128 kbps (Mobile)', value: 128 },
      { label: '192 kbps (Standard)', value: 192 },
      { label: '256 kbps (HQ)', value: 256 },
      { label: '320 kbps (Lossless Source)', value: 320 },
    ],
  },

  // --- Discord Bot & UI Experience ---
  {
    key: 'discord_sticky_ui_enabled',
    category: 'Discord',
    name: 'Sticky Now-Playing Discord Message',
    description: 'Keep an auto-updating interactive player widget pinned at the bottom of the chat channel.',
    type: 'boolean',
    control: 'toggle',
    defaultValue: true,
  },
  {
    key: 'discord_ui_update_interval_sec',
    category: 'Discord',
    name: 'Discord Progress Bar Update Rate',
    description: 'Frequency of progress bar timestamp edits on the Discord sticky widget.',
    type: 'number',
    control: 'select',
    defaultValue: 15,
    options: [
      { label: '5s (High Precision)', value: 5 },
      { label: '10s', value: 10 },
      { label: '15s (Default)', value: 15 },
      { label: '30s', value: 30 },
      { label: '60s (Low API Rate)', value: 60 },
    ],
  },
  {
    key: 'discord_ui_debounce_ms',
    category: 'Discord',
    name: 'Chat Reposition Debounce Delay',
    description: 'Delay in milliseconds before repositioning the sticky widget after user messages in chat.',
    type: 'number',
    control: 'slider',
    defaultValue: 1200,
    min: 500,
    max: 3000,
    step: 100,
    unit: 'ms',
  },
  {
    key: 'discord_voice_status_enabled',
    category: 'Discord',
    name: 'Voice Channel Status Text',
    description: 'Display "🎵 Artist - Title" as the Discord voice channel status.',
    type: 'boolean',
    control: 'toggle',
    defaultValue: true,
  },
  {
    key: 'discord_pinned_voice_channel_id',
    category: 'Discord',
    name: 'Auto-Resume Pinned Voice Channel',
    description: 'Specific Voice Channel ID to auto-join on reboot (leave blank to follow last active channel).',
    type: 'string',
    control: 'text',
    defaultValue: '',
  },
  {
    key: 'discord_skip_penalty_ratio',
    category: 'Discord',
    name: 'Early-Skip Taste Penalty Threshold',
    description: 'Fraction of song completion below which skipping applies a taste penalty to the artist.',
    type: 'number',
    control: 'slider',
    defaultValue: 0.35,
    min: 0.10,
    max: 0.60,
    step: 0.05,
    unit: '%',
  },
  {
    key: 'discord_artist_ui_mode',
    category: 'Discord',
    name: 'Artist Discography UI Mode',
    description: 'Switch /artist between interactive dropdown select menus and cover carousel buttons.',
    type: 'string',
    control: 'radio',
    defaultValue: 'dropdown',
    options: [
      { label: 'Dropdown Menus (Compact Select)', value: 'dropdown' },
      { label: 'Carousel Buttons (Cover Flip)', value: 'buttons' },
    ],
  },
];

class DynamicSettingsService extends EventEmitter {
  private cache = new Map<string, { value: any; updatedAt: number }>();
  private definitions = new Map<string, SettingDefinition>();

  constructor() {
    super();
    for (const def of SETTING_DEFINITIONS) {
      this.definitions.set(def.key, def);
    }
    this.bootstrapTable();
    this.loadAllFromDb();
  }

  private bootstrapTable(): void {
    try {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS bot_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          type TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    } catch (err) {
      console.error('[DynamicSettings] Table bootstrap failed:', (err as Error).message);
    }
  }

  private loadAllFromDb(): void {
    try {
      const rows = sqlite.prepare('SELECT key, value, type, updated_at FROM bot_settings').all() as Array<{
        key: string;
        value: string;
        type: string;
        updated_at: number;
      }>;

      const loadedKeys = new Set<string>();
      for (const row of rows) {
        const def = this.definitions.get(row.key);
        let parsedValue: any = row.value;

        if (row.type === 'number') {
          parsedValue = Number(row.value);
        } else if (row.type === 'boolean') {
          parsedValue = row.value === 'true' || row.value === '1';
        }

        // Clamp or fallback if invalid
        if (def && row.type === 'number' && isNaN(parsedValue)) {
          parsedValue = def.defaultValue;
        }

        this.cache.set(row.key, {
          value: parsedValue,
          updatedAt: row.updated_at,
        });
        loadedKeys.add(row.key);
      }

      // Seed defaults for any definitions missing in SQLite
      const insertStmt = sqlite.prepare(`
        INSERT OR IGNORE INTO bot_settings (key, value, type, updated_at)
        VALUES (?, ?, ?, ?)
      `);

      const now = Math.floor(Date.now() / 1000);
      for (const def of SETTING_DEFINITIONS) {
        if (!loadedKeys.has(def.key)) {
          insertStmt.run(def.key, String(def.defaultValue), def.type, now);
          this.cache.set(def.key, {
            value: def.defaultValue,
            updatedAt: now,
          });
        }
      }
    } catch (err) {
      console.error('[DynamicSettings] Failed to load settings from DB:', (err as Error).message);
      // Fallback in-memory
      for (const def of SETTING_DEFINITIONS) {
        this.cache.set(def.key, {
          value: def.defaultValue,
          updatedAt: Math.floor(Date.now() / 1000),
        });
      }
    }
  }

  /**
   * Get raw setting value synchronously from cache.
   */
  public get<T = any>(key: string, fallback?: T): T {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached.value as T;
    }
    const def = this.definitions.get(key);
    if (def !== undefined) {
      return def.defaultValue as T;
    }
    return fallback as T;
  }

  public getNumber(key: string, fallback = 0): number {
    const val = this.get<number>(key, fallback);
    return typeof val === 'number' && !isNaN(val) ? val : fallback;
  }

  public getBoolean(key: string, fallback = false): boolean {
    const val = this.get<boolean>(key, fallback);
    return typeof val === 'boolean' ? val : fallback;
  }

  public getString(key: string, fallback = ''): string {
    const val = this.get<string>(key, fallback);
    return typeof val === 'string' ? val : fallback;
  }

  /**
   * Set setting value with validation, database persistence, and event emission.
   */
  public set(key: string, value: any): { success: boolean; value: any; error?: string } {
    const def = this.definitions.get(key);
    if (!def) {
      return { success: false, value: null, error: `Unknown setting: ${key}` };
    }

    let coercedValue = value;
    if (def.type === 'number') {
      coercedValue = Number(value);
      if (isNaN(coercedValue)) {
        return { success: false, value: null, error: `Setting ${key} must be a valid number` };
      }
      if (def.min !== undefined && coercedValue < def.min) coercedValue = def.min;
      if (def.max !== undefined && coercedValue > def.max) coercedValue = def.max;
    } else if (def.type === 'boolean') {
      coercedValue = Boolean(value);
    } else if (def.type === 'string') {
      coercedValue = String(value || '').trim();
    }

    const previous = this.cache.get(key)?.value;
    const now = Math.floor(Date.now() / 1000);

    try {
      sqlite.prepare(`
        INSERT INTO bot_settings (key, value, type, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `).run(key, String(coercedValue), def.type, now);

      this.cache.set(key, { value: coercedValue, updatedAt: now });

      
      this.emit('change', key, coercedValue, previous);
      this.emit(`change:${key}`, coercedValue, previous);

      return { success: true, value: coercedValue };
    } catch (err) {
      console.error(`[DynamicSettings] Failed to persist setting ${key}:`, (err as Error).message);
      return { success: false, value: previous, error: (err as Error).message };
    }
  }

  /**
   * Reset setting to default value.
   */
  public reset(key: string): { success: boolean; value: any } {
    const def = this.definitions.get(key);
    if (!def) return { success: false, value: null };
    return this.set(key, def.defaultValue);
  }

  /**
   * Reset all settings to defaults.
   */
  public resetAll(): void {
    for (const def of SETTING_DEFINITIONS) {
      this.reset(def.key);
    }
  }

  /**
   * Return full list of settings with current values, defaults, and definitions.
   */
  public getAllSettings(): SettingItem[] {
    return SETTING_DEFINITIONS.map((def) => {
      const cached = this.cache.get(def.key);
      return {
        ...def,
        value: cached !== undefined ? cached.value : def.defaultValue,
        updatedAt: cached !== undefined ? cached.updatedAt : Math.floor(Date.now() / 1000),
      };
    });
  }
}

export const dynamicSettings = new DynamicSettingsService();
export default dynamicSettings;
