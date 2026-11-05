/**
 * @file stationCurator.ts
 * @description Curated Radio Station presets, Time Capsule temporal filters,
 * Story Arc progression sets, and Latent Vibe Morph trajectory state for VEXO.
 */

import featureFlags from './featureFlags.js';
import deezer, { type DeezerTrackMetadata } from './deezer.js';

export interface GroundedEraTrack {
  rank: number;
  title: string;
  artist: string;
  year: number;
}

export interface RadioStation {
  id: string;
  name: string;
  genre: string;
  description: string;
  icon: string;
  prompt: string;
  targetBpm: number;
}

export const RADIO_STATIONS: RadioStation[] = [
  {
    id: 'lofi',
    name: 'Lofi Chillhop Beats',
    genre: 'Lofi / Downtempo',
    description: 'Warm vinyl crackle, mellow jazz chords, and peaceful beats to relax or study to.',
    icon: '☕',
    prompt: 'Lofi hip hop beats, chillhop, jazz chords, smooth relaxed study session, tape saturation',
    targetBpm: 82,
  },
  {
    id: 'synthwave',
    name: 'Neon Cyber Synthwave',
    genre: 'Synthwave / Retro',
    description: 'Retrofuturistic 80s analog synthesizers, neon night drives, and cyberpunk energy.',
    icon: '🌆',
    prompt: '1980s retro synthwave, cyberpunk darksynth, outrun night drive, arpeggiated bassline, electronic',
    targetBpm: 120,
  },
  {
    id: 'workout',
    name: 'High-Voltage Workout',
    genre: 'Drum & Bass / Electro',
    description: '130-174 BPM peak energy dance, drum and bass, and driving rhythms for peak focus.',
    icon: '⚡',
    prompt: 'High energy fast drum and bass, aggressive bass house, peak workout pump, 140+ bpm electro',
    targetBpm: 140,
  },
  {
    id: 'nostalgia',
    name: 'Time Machine Throwback',
    genre: '70s / 80s / 90s Classics',
    description: 'Iconic timeless hits, disco funk grooves, and nostalgic golden era anthems.',
    icon: '📼',
    prompt: 'Classic golden 70s funk, 80s pop anthems, 90s alternative rock, unforgettable timeless melodies',
    targetBpm: 115,
  },
  {
    id: 'underground',
    name: 'Underground Deep-Cuts',
    genre: 'Indie / Post-Punk',
    description: 'Leftfield electronica, shoegaze, post-punk, and anti-cliché deep discovery.',
    icon: '🗝️',
    prompt: 'Underground post-punk, darkwave, shoegaze, experimental indie rock, non-commercial deep cuts',
    targetBpm: 110,
  },
  {
    id: 'ambient',
    name: 'Deep Space Ambient',
    genre: 'Ambient / Ethereal',
    description: 'Zero-beat atmospheric drones, dreamy soundscapes, and floating mindfulness.',
    icon: '🌌',
    prompt: 'Pure ambient drone, ethereal dream pop, atmospheric pads, space meditation, floating soundscapes',
    targetBpm: 60,
  },
];

export type StoryArcPhase = 'warmup' | 'build' | 'climax' | 'chill';

export interface StoryArcState {
  currentPhase: StoryArcPhase;
  phaseIndex: number; // 0 to 3
  phaseName: string;
  targetEnergyRange: [number, number]; // [min, max] on 1-10 scale
}

export const STORY_ARC_PHASES: Array<{ phase: StoryArcPhase; name: string; range: [number, number]; icon: string }> = [
  { phase: 'warmup', name: 'Warmup & Vibe Setter', range: [3, 5], icon: '🌅' },
  { phase: 'build', name: 'Build-Up & Energy Rise', range: [6, 7], icon: '⚡' },
  { phase: 'climax', name: 'Climax & Energy Peak', range: [8, 10], icon: '🔥' },
  { phase: 'chill', name: 'Chill Bridge & Cooldown', range: [2, 4], icon: '🍃' },
];

export interface MorphState {
  active: boolean;
  targetPrompt: string;
  targetVector: Float32Array | null;
  step: number;        // e.g. 1
  totalSteps: number;  // e.g. 4
  currentAlpha: number; // 0.0 to 1.0
}

class StationCuratorService {
  private activeStationId: string | null = null;
  private timeCapsuleYear: number | null = null;
  private groundedEraList: GroundedEraTrack[] = [];
  private groundedListCursor: number = 0;
  private timeCapsulePool: DeezerTrackMetadata[] = [];
  private timeCapsuleSeenIds = new Set<string>();
  private storyArcStep: number = 0;
  private morphState: MorphState = {
    active: false,
    targetPrompt: '',
    targetVector: null,
    step: 0,
    totalSteps: 4,
    currentAlpha: 0.0,
  };

  // --- Radio Station ---
  public getActiveStation(): RadioStation | null {
    if (!featureFlags.isEnabled('feature_radio_stations') || !this.activeStationId) {
      return null;
    }
    return RADIO_STATIONS.find((s) => s.id === this.activeStationId) || null;
  }

  public setStation(stationId: string | null): RadioStation | null {
    if (!stationId) {
      this.activeStationId = null;
      return null;
    }
    const station = RADIO_STATIONS.find((s) => s.id.toLowerCase() === stationId.toLowerCase());
    if (station) {
      this.activeStationId = station.id;
      return station;
    }
    return null;
  }

  public getAllStations(): RadioStation[] {
    return RADIO_STATIONS;
  }

  // --- Time Capsule Grounded Record Release Engine ---
  public getTimeCapsuleYear(): number | null {
    if (!featureFlags.isEnabled('feature_time_capsule')) {
      return null;
    }
    return this.timeCapsuleYear;
  }

  public setTimeCapsuleYear(year: number | null): void {
    this.timeCapsuleYear = year;
    if (year) {
      console.log(`[StationCurator] ⏳ Time Capsule engaged: Locked to year ${year}`);
    } else {
      this.timeCapsulePool = [];
      this.timeCapsuleSeenIds.clear();
      this.groundedEraList = [];
      this.groundedListCursor = 0;
      console.log('[StationCurator] ⏳ Time Capsule disengaged (Normal temporal curation)');
    }
  }

  /**
   * Fetches the official historical Billboard Year-End Hot 100 singles archive.
   * Authoritative, audited historical records with zero LLM hallucination.
   */
  private async fetchBillboardArchive(year: number): Promise<GroundedEraTrack[]> {
    try {
      const res = await fetch(
        `https://en.wikipedia.org/w/api.php?action=parse&page=Billboard_Year-End_Hot_100_singles_of_${year}&prop=wikitext&format=json`,
        {
          headers: { 'User-Agent': 'OWRadio/2.1.0 (https://github.com/clawdiapai/OWRadio)' },
          signal: AbortSignal.timeout(6000),
        }
      );
      if (!res.ok) return [];
      const data = (await res.json()) as any;
      const text = data.parse?.wikitext?.['*'];
      if (!text) return [];

      const lines: string[] = text.split('\n').filter((l: string) => l.startsWith('|') && l.includes('||'));
      const clean = (s: string) =>
        s
          .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1')
          .replace(/["']/g, '')
          .replace(/\(song\)/gi, '')
          .replace(/\(band\)/gi, '')
          .replace(/\(singer\)/gi, '')
          .replace(/\(musician\)/gi, '')
          .trim();

      return lines
        .map((line) => {
          const parts = line.split('||').map((p) => p.trim());
          const rankMatch = parts[0]?.match(/\d+/);
          const titleRaw = parts[1] || '';
          const artistRaw = parts[2] || '';
          return {
            rank: rankMatch ? parseInt(rankMatch[0], 10) : 0,
            title: clean(titleRaw),
            artist: clean(artistRaw),
            year,
          };
        })
        .filter((x) => x.rank > 0 && x.title && x.artist);
    } catch {
      return [];
    }
  }

  /**
   * Fallback for vintage years prior to 1958 or after 2024 via MusicBrainz official recordings.
   */
  private async fetchMusicBrainzArchive(year: number): Promise<GroundedEraTrack[]> {
    try {
      const res = await fetch(
        `https://musicbrainz.org/ws/2/recording?query=date:${year}%20AND%20status:official&fmt=json&limit=50`,
        {
          headers: { 'User-Agent': 'OWRadio/2.1.0 (https://github.com/clawdiapai/OWRadio)' },
          signal: AbortSignal.timeout(6000),
        }
      );
      if (!res.ok) return [];
      const data = (await res.json()) as any;
      if (!data.recordings) return [];

      return data.recordings
        .map((r: any, idx: number) => ({
          rank: idx + 1,
          title: r.title,
          artist: r['artist-credit']?.[0]?.name || 'Unknown',
          year,
        }))
        .filter((x: any) => x.title && x.artist);
    } catch {
      return [];
    }
  }

  /**
   * Engages Time Capsule by harvesting verified historical release archives.
   * Completely bypasses any hallucinating LLM.
   */
  public async engageTimeCapsule(year: number): Promise<DeezerTrackMetadata[]> {
    this.timeCapsuleYear = year;
    this.timeCapsulePool = [];
    this.timeCapsuleSeenIds.clear();
    this.groundedListCursor = 0;
    this.groundedEraList = [];

    // 1. Fetch audited historical chart archive
    let eraList = await this.fetchBillboardArchive(year);

    // 2. Fallback to MusicBrainz for early 1950s or latest years
    if (eraList.length === 0) {
      eraList = await this.fetchMusicBrainzArchive(year);
    }

    this.groundedEraList = eraList;

    // 3. Concurrently resolve verified Deezer tracks for the top 15 records
    const initialBatch = eraList.slice(0, 15);
    const resolvedTracks = await Promise.all(
      initialBatch.map(async (item) => {
        try {
          const res = await deezer.searchTracks(`${item.artist} ${item.title}`, 1);
          if (res.length > 0) {
            const track = res[0];
            track.releaseYear = year;
            return track;
          }
        } catch {}
        return null;
      })
    );

    for (const t of resolvedTracks) {
      if (t && !this.timeCapsuleSeenIds.has(t.id)) {
        this.timeCapsuleSeenIds.add(t.id);
        this.timeCapsulePool.push(t);
      }
    }

    this.groundedListCursor = 15;
    console.log(
      `[StationCurator] ⏳ Grounded Time Capsule: Loaded ${this.groundedEraList.length} verified records for ${year}. Primed ${this.timeCapsulePool.length} tracks.`
    );
    return this.timeCapsulePool;
  }

  /**
   * Supplies next grounded tracks from the verified era pool for autoplay.
   */
  public async getNextTimeCapsuleTracks(
    count = 2,
    queuedSongIds: Set<string> = new Set(),
    queuedArtists: Set<string> = new Set()
  ): Promise<DeezerTrackMetadata[]> {
    if (!this.timeCapsuleYear) return [];

    // If pool is empty, initialize or replenish
    if (this.timeCapsulePool.length === 0 && this.groundedEraList.length === 0) {
      await this.engageTimeCapsule(this.timeCapsuleYear);
    }

    const matched: DeezerTrackMetadata[] = [];

    // Pull from already-resolved pool
    while (this.timeCapsulePool.length > 0 && matched.length < count) {
      const track = this.timeCapsulePool.shift()!;
      if (!queuedSongIds.has(track.id) && !queuedArtists.has(track.artist.toLowerCase())) {
        matched.push(track);
      }
    }

    // Resolve next items from the grounded archive if needed
    while (matched.length < count && this.groundedListCursor < this.groundedEraList.length) {
      const nextBatch = this.groundedEraList.slice(this.groundedListCursor, this.groundedListCursor + 5);
      this.groundedListCursor += 5;

      const resolvedBatch = await Promise.all(
        nextBatch.map(async (item) => {
          try {
            const res = await deezer.searchTracks(`${item.artist} ${item.title}`, 1);
            if (res.length > 0) {
              const track = res[0];
              track.releaseYear = this.timeCapsuleYear!;
              return track;
            }
          } catch {}
          return null;
        })
      );

      for (const t of resolvedBatch) {
        if (
          t &&
          !this.timeCapsuleSeenIds.has(t.id) &&
          !queuedSongIds.has(t.id) &&
          !queuedArtists.has(t.artist.toLowerCase())
        ) {
          this.timeCapsuleSeenIds.add(t.id);
          if (matched.length < count) {
            matched.push(t);
          } else {
            this.timeCapsulePool.push(t);
          }
        }
      }
    }

    return matched;
  }

  public getGroundedEraList(): GroundedEraTrack[] {
    return this.groundedEraList;
  }

  public getTimeCapsulePool(): DeezerTrackMetadata[] {
    return this.timeCapsulePool;
  }

  // --- Story Arc ---
  public getStoryArcState(): StoryArcState {
    const isEnabled = featureFlags.isEnabled('feature_story_arc');
    const phaseDef = STORY_ARC_PHASES[this.storyArcStep % STORY_ARC_PHASES.length];
    return {
      currentPhase: isEnabled ? phaseDef.phase : 'warmup',
      phaseIndex: this.storyArcStep % STORY_ARC_PHASES.length,
      phaseName: isEnabled ? `${phaseDef.icon} ${phaseDef.name}` : 'Standard Flow (Story Arc OFF)',
      targetEnergyRange: phaseDef.range,
    };
  }

  public advanceStoryArc(): void {
    if (featureFlags.isEnabled('feature_story_arc')) {
      this.storyArcStep = (this.storyArcStep + 1) % STORY_ARC_PHASES.length;
      const next = STORY_ARC_PHASES[this.storyArcStep];
      console.log(`[StationCurator] 📈 Story Arc advanced to Phase ${this.storyArcStep + 1}/4: ${next.icon} ${next.name}`);
    }
  }

  // --- DJ Morph Mode (Latent Interpolation) ---
  public getMorphState(): MorphState {
    if (!featureFlags.isEnabled('feature_vibe_morph')) {
      return { ...this.morphState, active: false };
    }
    return this.morphState;
  }

  public startMorph(targetPrompt: string, targetVector: Float32Array, totalSteps = 4): void {
    this.morphState = {
      active: true,
      targetPrompt,
      targetVector,
      step: 1,
      totalSteps,
      currentAlpha: 1 / totalSteps,
    };
    console.log(`[StationCurator] 🌀 DJ Morph Trajectory initiated towards: "${targetPrompt}" over ${totalSteps} tracks.`);
  }

  public advanceMorphStep(): void {
    if (!this.morphState.active) return;
    this.morphState.step++;
    if (this.morphState.step >= this.morphState.totalSteps) {
      this.morphState.currentAlpha = 1.0;
      console.log(`[StationCurator] 🌀 DJ Morph complete! Reached target vibe: "${this.morphState.targetPrompt}"`);
      this.morphState.active = false;
    } else {
      this.morphState.currentAlpha = this.morphState.step / this.morphState.totalSteps;
      console.log(`[StationCurator] 🌀 DJ Morph step ${this.morphState.step}/${this.morphState.totalSteps} (α = ${this.morphState.currentAlpha.toFixed(2)})`);
    }
  }

  public cancelMorph(): void {
    this.morphState.active = false;
    this.morphState.targetVector = null;
  }
}

export const stationCurator = new StationCuratorService();
export default stationCurator;
