/**
 * @file featureFlags.ts
 * @description Dynamic runtime feature flag manager for VEXO.
 * Persists toggles in SQLite and provides instant, zero-latency synchronous queries.
 */

import { EventEmitter } from 'node:events';
import { sqlite } from '../db/index.js';

export interface FeatureFlagDefinition {
  id: string;
  name: string;
  description: string;
  category: 'Curation' | 'Audio & Mixing' | 'Discord' | 'WebUI';
  defaultValue: boolean;
  icon: string;
}

export interface FeatureFlagStatus extends FeatureFlagDefinition {
  enabled: boolean;
  updatedAt: number;
}

export const FEATURE_DEFINITIONS: FeatureFlagDefinition[] = [
  {
    id: 'feature_vibe_latent',
    name: '/vibe 384-d Latent Steering',
    description: 'Embed natural language prompts into 384-d latent space via Ollama all-minilm to steer real-time autoplay curation.',
    category: 'Curation',
    defaultValue: true,
    icon: '✨',
  },
  {
    id: 'feature_artist_interactive',
    name: '/artist Interactive Discography',
    description: 'Discord interactive select menus displaying artist albums with timeout fallback to pick a song automatically if no choice is made.',
    category: 'Discord',
    defaultValue: true,
    icon: '🎤',
  },
  {
    id: 'feature_vibe_morph',
    name: 'DJ Morph Mode (Latent Interpolation)',
    description: 'Multi-track smooth transition trajectory in vector space from current room taste to a target vibe.',
    category: 'Curation',
    defaultValue: true,
    icon: '🌀',
  },
  {
    id: 'feature_tug_of_war',
    name: 'Collaborative Tug-of-War Consensus',
    description: 'Mathematical intersection curation finding fair common ground across distinct listeners in voice.',
    category: 'Curation',
    defaultValue: true,
    icon: '⚖️',
  },
  {
    id: 'feature_story_arc',
    name: 'Smart Auto-DJ Story Arc Sets',
    description: 'Thematic 4-phase mini-sets (Warmup -> Energy Peak -> Climax -> Chill Bridge) based on track energy.',
    category: 'Curation',
    defaultValue: true,
    icon: '📈',
  },
  {
    id: 'feature_harmonic_crossfade',
    name: 'Harmonic Mixing & Adaptive Crossfade',
    description: 'Adaptive crossfade durations (0.5s to 4.0s) dynamically modulated by BPM and musical key compatibility.',
    category: 'Audio & Mixing',
    defaultValue: true,
    icon: '🎚️',
  },
  {
    id: 'feature_offline_vault',
    name: 'Instant Offline Cache (Server Vault)',
    description: 'Local pre-cached audio vault for frequent tracks delivering zero-latency 0.0s playback without yt-dlp latency.',
    category: 'Audio & Mixing',
    defaultValue: true,
    icon: '💾',
  },

  {
    id: 'feature_taste_radar_chart',
    name: 'Collective Taste Fingerprint Radar Chart',
    description: 'Visual multi-axis spider/radar chart of room taste DNA in Web UI and /taste command.',
    category: 'WebUI',
    defaultValue: true,
    icon: '🕸️',
  },
  {
    id: 'feature_time_capsule',
    name: 'Time Capsule & Throwback Temporal Mode',
    description: '/throwback <year> or era-focused temporal curation locking playback to nostalgic eras.',
    category: 'Curation',
    defaultValue: true,
    icon: '⏳',
  },
  {
    id: 'feature_live_waveform',
    name: 'Live Audio Waveform & Visual Drop Cueing',
    description: 'Real-time animated audio waveform representation and drop/transition countdown cues in Web UI.',
    category: 'WebUI',
    defaultValue: true,
    icon: '🌊',
  },
  {
    id: 'feature_radio_stations',
    name: 'Curated Radio Station Presets',
    description: '/radio <station> instant one-click curation presets (lofi, workout, nostalgia, synthwave, underground).',
    category: 'Curation',
    defaultValue: true,
    icon: '📻',
  },
];

class FeatureFlagsService extends EventEmitter {
  private cache = new Map<string, { enabled: boolean; updatedAt: number }>();

  constructor() {
    super();
    this.bootstrapTable();
    this.loadAllFromDb();
  }

  private bootstrapTable(): void {
    try {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS feature_flags (
          id TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    } catch (err) {
      console.error('[FeatureFlags] Table bootstrap failed:', err);
    }
  }

  private loadAllFromDb(): void {
    try {
      const rows = sqlite.prepare('SELECT id, enabled, updated_at FROM feature_flags').all() as Array<{
        id: string;
        enabled: number;
        updated_at: number;
      }>;

      const loadedIds = new Set<string>();
      for (const row of rows) {
        this.cache.set(row.id, {
          enabled: row.enabled === 1,
          updatedAt: row.updated_at,
        });
        loadedIds.add(row.id);
      }

      // Initialize any newly added definitions that don't exist yet in DB
      const now = Math.floor(Date.now() / 1000);
      const insertStmt = sqlite.prepare(`
        INSERT OR IGNORE INTO feature_flags (id, enabled, updated_at)
        VALUES (?, ?, ?)
      `);

      for (const def of FEATURE_DEFINITIONS) {
        if (!loadedIds.has(def.id)) {
          insertStmt.run(def.id, def.defaultValue ? 1 : 0, now);
          this.cache.set(def.id, {
            enabled: def.defaultValue,
            updatedAt: now,
          });
        }
      }
    } catch (err) {
      console.error('[FeatureFlags] Failed to load flags from DB:', err);
      // Fallback to in-memory defaults
      for (const def of FEATURE_DEFINITIONS) {
        this.cache.set(def.id, {
          enabled: def.defaultValue,
          updatedAt: Math.floor(Date.now() / 1000),
        });
      }
    }
  }

  /**
   * Fast synchronous check whether a feature flag is enabled.
   */
  public isEnabled(featureId: string): boolean {
    const entry = this.cache.get(featureId);
    if (entry !== undefined) {
      return entry.enabled;
    }
    // Check if known in definitions
    const def = FEATURE_DEFINITIONS.find((d) => d.id === featureId);
    return def ? def.defaultValue : false;
  }

  /**
   * Persistently set a feature flag's state.
   */
  public setEnabled(featureId: string, enabled: boolean): void {
    const now = Math.floor(Date.now() / 1000);
    this.cache.set(featureId, { enabled, updatedAt: now });

    try {
      sqlite.prepare(`
        INSERT OR REPLACE INTO feature_flags (id, enabled, updated_at)
        VALUES (?, ?, ?)
      `).run(featureId, enabled ? 1 : 0, now);

      
      console.log(`[FeatureFlags] ⚙️ Feature "${featureId}" set to ${enabled ? 'ENABLED' : 'DISABLED'}`);
      this.emit('change', { featureId, enabled });
    } catch (err) {
      console.error(`[FeatureFlags] Failed to persist toggle for ${featureId}:`, err);
    }
  }

  /**
   * Toggles the feature flag and returns the new state.
   */
  public toggle(featureId: string): boolean {
    const current = this.isEnabled(featureId);
    const next = !current;
    this.setEnabled(featureId, next);
    return next;
  }

  /**
   * Returns all feature flags with their current status and metadata.
   */
  public getAllFlags(): FeatureFlagStatus[] {
    return FEATURE_DEFINITIONS.map((def) => {
      const entry = this.cache.get(def.id);
      return {
        ...def,
        enabled: entry !== undefined ? entry.enabled : def.defaultValue,
        updatedAt: entry !== undefined ? entry.updatedAt : 0,
      };
    });
  }
}

export const featureFlags = new FeatureFlagsService();
export default featureFlags;
