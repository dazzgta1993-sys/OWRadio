/**
 * @file player/GuildPlayer.ts
 * @description Clean Triple-Deck Audio Player (Deck 1: Now Playing, Deck 2: Ready, Deck 3: Cued).
 * Every single file strictly under 300 lines of code.
 */

import { EventEmitter } from 'node:events';
import { AudioPlayer, AudioPlayerStatus, createAudioPlayer, createAudioResource, NoSubscriberBehavior, StreamType, VoiceConnection } from '@discordjs/voice';
import AudioTrack from './AudioTrack.js';
import BroadcastTee from './BroadcastTee.js';
import { ensureTrackStreamReady, prewarmPlayerDecks } from './DeckPrewarmer.js';
import { fetchNextVibeTrack, VibeMode, VibeEngineSource } from '../services/vibeEngine.js';
import { announceNextTrackIfDue, isDjVoiceEnabled } from '../services/djVoice.js';
import { extractPrimaryArtist, normalizeTrackKey } from '../utils/artistNormalizer.js';
import { savePlaybackHistory, recordTasteFeedback, removeTasteFeedback, getTasteProfile, getRuntimeSetting, setRuntimeSetting } from '../db/store.js';

export class GuildPlayer extends EventEmitter {
  public guildId: string;
  public audioPlayer: AudioPlayer;
  public voiceConnection: VoiceConnection | null = null;
  public broadcastTee: BroadcastTee;

  public currentTrack: AudioTrack | null = null;
  public queue: AudioTrack[] = [];
  public history: AudioTrack[] = [];
  public deck2Track: AudioTrack | null = null;
  public deck3Track: AudioTrack | null = null;

  public isPlaying = false;
  public isPaused = false;
  public autoplay = true;
  public loopMode: 'off' | 'track' | 'queue' = 'off';

  public vibeMode: VibeMode = 'balanced';
  public vibeEngineSource: VibeEngineSource = 'auto';
  public vibeAnchorArtist = '';
  public vibeAnchorTrack: AudioTrack | null = null;
  public consecutiveAutoplayCount = 0;
  public lastVibeDecision = 'Ready';

  private playStartTime = 0;
  private pauseStartTime = 0;
  private totalPausedMs = 0;
  private suppressIdleEvent = false;
  private isTransitioning = false;
  private isPrewarming = false;
  private consecutiveFailures = 0;
  private failedKeys = new Set<string>();
  private cachedStaticSnapshot: Record<string, any> | null = null;

  constructor(guildId = 'global') {
    super();
    this.guildId = guildId;
    this.broadcastTee = new BroadcastTee();
    this.vibeMode = (getRuntimeSetting('vibe_mode', 'balanced') as VibeMode) || 'balanced';
    this.vibeEngineSource = (getRuntimeSetting('vibe_engine_source', 'auto') as VibeEngineSource) || 'auto';
    this.audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 250 } });
    this.audioPlayer.on(AudioPlayerStatus.Idle, () => { if (!this.suppressIdleEvent) void this.playNext(); });
    this.audioPlayer.on(AudioPlayerStatus.AutoPaused, () => console.warn('⚠️ [Discord Voice] AutoPaused: buffer underrun'));
    this.audioPlayer.on('error', (err) => { console.warn('⚠️ [Discord Voice] Error:', err.message); if (!this.suppressIdleEvent) void this.playNext(); });
    this.on('trackStart', (track) => savePlaybackHistory(track, this.guildId));
  }

  public attachVoiceConnection(conn: VoiceConnection): void {
    this.voiceConnection = conn;
    conn.subscribe(this.audioPlayer);
  }

  public getElapsedSeconds(): number {
    if (!this.currentTrack || this.playStartTime <= 0) return 0;
    const now = this.isPaused && this.pauseStartTime > 0 ? this.pauseStartTime : Date.now();
    const secs = Math.floor(Math.max(0, now - this.playStartTime - this.totalPausedMs) / 1000);
    if (this.currentTrack.duration > 0 && secs > this.currentTrack.duration) this.currentTrack.duration = secs;
    return secs;
  }

  public purgeAutoplayTracks(): void {
    this.queue = this.queue.filter((t) => !t.isAutoplay);
    this.deck2Track = null;
    this.deck3Track = null;
  }

  public async playNow(track: AudioTrack): Promise<void> {
    if (!track.isAutoplay) { this.purgeAutoplayTracks(); this.vibeAnchorArtist = extractPrimaryArtist(track.artist); this.consecutiveAutoplayCount = 0; }
    this.queue.unshift(track);
    await this.playNext(true);
  }

  public enqueue(track: AudioTrack, atFront = false): number {
    if (!track.isAutoplay) { this.vibeAnchorArtist = extractPrimaryArtist(track.artist); this.consecutiveAutoplayCount = 0; this.deck2Track = null; this.deck3Track = null; }
    if (atFront) this.queue.unshift(track); else this.queue.push(track);
    this.emitStateUpdate();
    if (this.isPlaying) void this.prewarmDecks(); else void this.playNext();
    return this.queue.length;
  }

  public enqueueMany(tracks: AudioTrack[]): number {
    if (tracks.length === 0) return this.queue.length;
    this.vibeAnchorArtist = extractPrimaryArtist(tracks[0].artist);
    this.consecutiveAutoplayCount = 0;
    this.deck2Track = null; this.deck3Track = null;
    this.queue.push(...tracks);
    this.emitStateUpdate();
    if (this.isPlaying) void this.prewarmDecks(); else void this.playNext();
    return this.queue.length;
  }

  public async prewarmDecks(): Promise<void> {
    if (this.isPrewarming || !this.currentTrack) return;
    this.isPrewarming = true;
    try { await prewarmPlayerDecks(this); } finally { this.isPrewarming = false; }
  }

  public async playNext(forceImmediate = false): Promise<void> {
    if (this.isTransitioning && !forceImmediate) return;
    this.isTransitioning = true;
    try {
      let nextTrack: AudioTrack | null = null;
      if (this.loopMode === 'track' && this.currentTrack && !forceImmediate) {
        nextTrack = this.currentTrack;
      } else if (this.queue.length > 0) {
        if (this.loopMode === 'queue' && this.currentTrack && !this.currentTrack.isAutoplay) this.queue.push(this.currentTrack);
        nextTrack = this.queue.shift()!;
      } else if (this.autoplay) {
        if (this.deck2Track) {
          nextTrack = this.deck2Track; this.deck2Track = this.deck3Track; this.deck3Track = null;
        } else if (this.deck3Track) {
          nextTrack = this.deck3Track; this.deck3Track = null;
        } else {
          nextTrack = await fetchNextVibeTrack(this.getVibeContext(), this.currentTrack);
        }
      }

      if (!nextTrack) {
        this.currentTrack = null; this.isPlaying = false; this.isPaused = false;
        this.broadcastTee.stopTrackStream(); this.emitStateUpdate();
        return;
      }

      this.currentTrack = nextTrack;
      if (nextTrack.isAutoplay) {
        this.consecutiveAutoplayCount++;
        if (nextTrack.vibeReason) this.lastVibeDecision = nextTrack.vibeReason;
      } else {
        this.vibeAnchorArtist = extractPrimaryArtist(nextTrack.artist);
        this.vibeAnchorTrack = nextTrack;
        this.consecutiveAutoplayCount = 0;
        this.lastVibeDecision = 'Direct Studio Selection';
        removeTasteFeedback(this.vibeAnchorArtist, this.guildId);
      }
      this.emitStateUpdate();

      const ready = await ensureTrackStreamReady(nextTrack, () => this.emitStateUpdate());
      if (!ready || !nextTrack.streamUrl) {
        this.failedKeys.add(normalizeTrackKey(nextTrack.artist, nextTrack.title));
        if (this.failedKeys.size > 100) { const f = this.failedKeys.values().next().value; if (f) this.failedKeys.delete(f); }
        this.consecutiveFailures++;
        this.isTransitioning = false;
        if (this.consecutiveFailures >= 5) {
          console.warn('⚠️ [Audio Pipeline] 5 consecutive stream resolution failures. Backing off 10s...');
          setTimeout(() => { this.consecutiveFailures = 0; void this.playNext(); }, 10000);
          return;
        }
        void this.playNext();
        return;
      }
      this.consecutiveFailures = 0;

      this.suppressIdleEvent = true;
      const pcmStream = this.broadcastTee.startTrackStream(nextTrack.streamUrl, nextTrack.streamHeaders || {});
      this.playStartTime = Date.now();
      this.pauseStartTime = 0;
      this.totalPausedMs = 0;
      this.isPlaying = true;
      this.isPaused = false;
      this.audioPlayer.play(createAudioResource(pcmStream, { inputType: StreamType.Raw }));
      setTimeout(() => { this.suppressIdleEvent = false; }, 250);

      this.history.push(nextTrack);
      if (this.history.length > 100) this.history.shift();
      console.log(`▶️ [Deck 1] ${nextTrack.artist} — ${nextTrack.title} [${nextTrack.formattedDuration}] (${nextTrack.source.toUpperCase()}${nextTrack.vibeReason ? ' • ' + nextTrack.vibeReason : ''})`);
      this.emitStateUpdate();
      this.emit('trackStart', nextTrack);
      void this.prewarmDecks().then(() => { setTimeout(() => void announceNextTrackIfDue(this), 3500); });
    } finally {
      this.isTransitioning = false;
    }
  }

  public pause(): boolean {
    if (!this.isPlaying || this.isPaused) return false;
    this.isPaused = true; this.pauseStartTime = Date.now();
    this.broadcastTee.setPaused(true); this.audioPlayer.pause();
    this.emitStateUpdate(); return true;
  }

  public resume(): boolean {
    if (!this.isPlaying || !this.isPaused) return false;
    if (this.pauseStartTime > 0) { this.totalPausedMs += Date.now() - this.pauseStartTime; this.pauseStartTime = 0; }
    this.isPaused = false; this.broadcastTee.setPaused(false);
    this.audioPlayer.unpause(); this.emitStateUpdate(); return true;
  }

  public skip(): void {
    this.suppressIdleEvent = true; this.broadcastTee.stopTrackStream(); void this.playNext(true);
  }

  public stop(): void {
    this.suppressIdleEvent = true; this.queue = []; this.deck2Track = null; this.deck3Track = null;
    this.currentTrack = null; this.isPlaying = false; this.isPaused = false;
    this.broadcastTee.stopTrackStream(); this.audioPlayer.stop(true); this.emitStateUpdate();
  }

  public setVolume(volPercent: number): number {
    this.broadcastTee.setVolume(volPercent); this.emitStateUpdate(); return this.broadcastTee.getVolumePercent();
  }

  public setVibeConfig(mode?: VibeMode, engine?: VibeEngineSource): void {
    if (mode) { this.vibeMode = mode; setRuntimeSetting('vibe_mode', mode); }
    if (engine) { this.vibeEngineSource = engine; setRuntimeSetting('vibe_engine_source', engine); }
    this.deck2Track = null; this.deck3Track = null; this.emitStateUpdate();
    if (this.isPlaying) void this.prewarmDecks();
  }

  public voteCurrentTrack(vote: 'up' | 'down'): void {
    if (!this.currentTrack) return;
    const art = extractPrimaryArtist(this.currentTrack.artist);
    recordTasteFeedback(art, this.currentTrack.title, vote, this.guildId);
    if (vote === 'down') {
      this.lastVibeDecision = `👎 Cooled: ${art} — ${this.currentTrack.title}`;
      console.log(`👎 [Taste] Cooled: ${art} — ${this.currentTrack.title}`);
      this.deck2Track = null; this.deck3Track = null; this.skip();
    } else {
      this.vibeAnchorArtist = art; this.vibeAnchorTrack = this.currentTrack;
      this.lastVibeDecision = `👍 Vibe Locked: ${art} — ${this.currentTrack.title}`;
      console.log(`👍 [Taste] Vibe Locked: ${art} — ${this.currentTrack.title}`);
      this.deck2Track = null; this.deck3Track = null; this.emitStateUpdate();
      if (this.isPlaying) void this.prewarmDecks();
    }
  }

  public getVibeContext() {
    return {
      guildId: this.guildId, vibeMode: this.vibeMode, vibeEngineSource: this.vibeEngineSource,
      vibeAnchorArtist: this.vibeAnchorArtist, vibeAnchorTrack: this.vibeAnchorTrack,
      consecutiveAutoplayCount: this.consecutiveAutoplayCount, currentTrack: this.currentTrack,
      queue: this.queue, history: this.history, deck2Track: this.deck2Track,
      deck3Track: this.deck3Track, failedKeys: this.failedKeys,
    };
  }

  public getStateSnapshot(): Record<string, any> {
    if (!this.cachedStaticSnapshot) {
      const effectiveQueue = [...this.queue];
      if (effectiveQueue.length === 0 && this.deck2Track) {
        effectiveQueue.push(this.deck2Track);
        if (this.deck3Track) effectiveQueue.push(this.deck3Track);
      }
      const tp = getTasteProfile(this.guildId);
      const autoCool = Array.from(new Set(this.history.slice(-45).map((t) => t.artist))).slice(0, 35);
      this.cachedStaticSnapshot = {
        autoplay: this.autoplay, loopMode: this.loopMode, djVoice: isDjVoiceEnabled(),
        vibeMode: this.vibeMode, vibeEngineSource: this.vibeEngineSource,
        vibeAnchorArtist: this.vibeAnchorArtist, lastVibeDecision: this.lastVibeDecision,
        nowPlaying: this.currentTrack ? this.currentTrack.toJSON() : null,
        deck2: this.deck2Track ? this.deck2Track.toJSON() : null,
        deck3: this.deck3Track ? this.deck3Track.toJSON() : null,
        queue: effectiveQueue.map((t) => t.toJSON()),
        history: this.history.slice(-25).reverse().map((t) => t.toJSON()),
        taste: { likedArtists: [...tp.likedArtists], dislikedArtists: [...tp.dislikedArtists], dislikedTracks: [...tp.dislikedTracks], cooldowns: tp.cooldowns, autoCool },
      };
    }
    return {
      state: this.isPlaying ? (this.isPaused ? 'paused' : 'playing') : 'idle',
      isPlaying: this.isPlaying, isPaused: this.isPaused, volume: this.broadcastTee.getVolumePercent(),
      rmsDb: this.broadcastTee.getRmsDb(), listeners: this.broadcastTee.getListenerCount(),
      elapsed: this.getElapsedSeconds(),
      ...this.cachedStaticSnapshot,
    } as any;
  }

  public emitStateUpdate(): void {
    this.cachedStaticSnapshot = null;
    this.emit('stateUpdate', this.getStateSnapshot());
  }
}

export const globalPlayer = new GuildPlayer('global');
export default globalPlayer;
