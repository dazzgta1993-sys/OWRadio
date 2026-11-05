/**
 * @file GuildPlayer.ts
 * @description Single-server audio engine, queue manager, voice room preference blender,
 * zero-gap prewarmer, and real-time state emitter.
 */

import { EventEmitter } from 'node:events';
import {
  AudioPlayer,
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnection,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { Routes, type VoiceBasedChannel, type Client } from 'discord.js';
import config from '../config.js';
import { sqlite, getBotState, setBotState } from '../db/index.js';
import { AudioTrack } from './AudioTrack.js';
import { BroadcastTee } from './BroadcastTee.js';
import PlaylistBlender from './PlaylistBlender.js';
import streamResolver from '../services/streamResolver.js';
import curator from '../services/curator.js';
import featureFlags from '../services/featureFlags.js';
import harmonicMixing from '../services/harmonicMixing.js';
import stationCurator from '../services/stationCurator.js';
import vetoService from '../services/vetoService.js';
import dynamicSettings from '../services/dynamicSettings.js';
import { getTrackDedupeKey, isDuplicateTrack, normalizeArtist } from '../utils/trackDedupe.js';

export interface PlayerStatePayload {
  state: 'playing' | 'paused' | 'idle';
  isAutoplay: boolean;
  volume: number;
  streamUrl: string;
  track: ReturnType<AudioTrack['toNowPlayingJson']> | null;
  upNext: { title: string; artist: string; curatedBy: string; requestType?: string } | null;
  roomListeners: string[];
  queueLength: number;
  storyArc?: ReturnType<typeof stationCurator['getStoryArcState']>;
  radioStation?: ReturnType<typeof stationCurator['getActiveStation']>;
  timeCapsuleYear?: number | null;
  morph?: ReturnType<typeof stationCurator['getMorphState']>;
  audioMeter?: { rms: number; peak: number; bands: number[] };
  brainPills?: any[];
  activeBrainCount?: number;
  totalBrainCount?: number;
}

export class GuildPlayer extends EventEmitter {
  public readonly broadcastTee: BroadcastTee;
  private audioPlayer: AudioPlayer;
  private voiceConnection: VoiceConnection | null = null;
  public activeVoiceChannel: VoiceBasedChannel | null = null;

  private queue: AudioTrack[] = [];
  public currentTrack: AudioTrack | null = null;
  public previousTrack: AudioTrack | null = null;
  public lastTransitionAnalysis: any | null = null;
  public isPaused = false;
  private volume = 80; // 0 - 100%
  public autoplayEnabled = true;

  public getActiveVoiceChannel(): VoiceBasedChannel | null {
    return this.activeVoiceChannel;
  }

  private isReplenishing = false;
  private isPreResolvingQueue = false;

  /**
   * Background pre-resolver that proactively resolves stream URLs for tracks in the queue.
   * Guarantees that when a user clicks any track in the Web UI or skips ahead,
   * the YouTube URL candidate is 100% pre-resolved without any search delay.
   */
  public async preResolveQueueStreams(): Promise<void> {
    if (this.isPreResolvingQueue || this.queue.length === 0) return;
    this.isPreResolvingQueue = true;

    try {
      // Pre-resolve ALL upcoming tracks in queue without limits
      for (const track of this.queue) {
        if (!track.streamUrl) {
          try {
            const resolved = await streamResolver.resolveStream(track);
            if (resolved) {
              track.streamUrl = resolved.streamUrl;
              if (resolved.source === 'deezer') {
                track.durationSec = resolved.durationSec;
              }
            }
          } catch (err) {
            console.warn(`[GuildPlayer] Background queue stream resolution error for "${track.title}":`, (err as Error).message);
          }
          await new Promise((r) => setTimeout(r, 100));
        }

        // Continuously feed newly resolved streams into multi-deck standby pool
        if (track.streamUrl) {
          const resolvedUrls = this.queue
            .map((t) => t.streamUrl)
            .filter((u): u is string => Boolean(u));
          if (resolvedUrls.length > 0) {
            this.broadcastTee.prepareStandbyDecks(resolvedUrls);
          }
        }
      }
    } finally {
      this.isPreResolvingQueue = false;
    }
  }
  private isPlayingNext = false;
  private pendingTrack: AudioTrack | null = null;
  private isTransitioning = false;
  private audioResource: any = null;

  /** Health & anti-cascade protection */
  private trackPlayStartTime = 0;
  private consecutiveFailures = 0;
  private currentTrackRetryCount = 0;
  private readonly MAX_CONSECUTIVE_FAILURES = 5;
  private isHandlingFailure = false;

  /** Skip Burst & Rapid Fast-Forward Protection */
  private lastSkipTimestamp = 0;
  private skipBurstCount = 0;
  private skipBurstDebounceTimer: NodeJS.Timeout | null = null;

  /** Discord Client Reference for Voice Channel Status REST API */
  private client: Client | null = null;

  /** Hourly notification tracker */
  private lastChimeHour: number = -1;

  /** Playback Health & Dead-Silence Watchdog */
  private consecutiveSilenceTicks = 0;
  private playbackHealthWatchdogTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.setMaxListeners(500);
    this.broadcastTee = new BroadcastTee();

    this.audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
        maxMissedFrames: 250,
      },
    });

    this.setupAudioPlayerListeners();
    this.startHourlyChimeScheduler();
    this.startPlaybackHealthWatchdog();
  }

  /**
   * Attaches the Discord client instance.
   */
  public setDiscordClient(client: Client): void {
    this.client = client;
  }

  public getDiscordClient(): Client | null {
    return this.client;
  }

  /**
   * Checks for the top of every hour (XX:00) and triggers the broadcast chime with ducking.
   */
  private startHourlyChimeScheduler(): void {
    setInterval(() => {
      if (!dynamicSettings.getBoolean('audio_chime_enabled', true)) return;
      const now = new Date();
      if (now.getMinutes() === 0 && now.getSeconds() < 12) {
        if (this.lastChimeHour !== now.getHours()) {
          this.lastChimeHour = now.getHours();
          console.log(`[GuildPlayer] 🕒 Top of the hour detected (${now.getHours()}:00). Triggering broadcast hourly chime!`);
          this.broadcastTee.triggerHourlyChime();
        }
      }
    }, 5000);
  }

  /**
   * Manually triggers the hourly broadcast chime (e.g. for testing via UI/API).
   */
  public triggerChime(): void {
    this.broadcastTee.triggerHourlyChime();
  }

  /**
   * Continuous playback health monitor (runs every 4 seconds):
   * 1. Detects track duration overruns (hung decoder beyond track.durationSec + 15s).
   * 2. Detects continuous dead digital silence (RMS === 0 && Peak === 0) for >= 16 seconds.
   * Automatically terminates hung streams and advances to the next track.
   */
  private startPlaybackHealthWatchdog(): void {
    if (this.playbackHealthWatchdogTimer) return;

    this.playbackHealthWatchdogTimer = setInterval(() => {
      // Check 0: Autonomous Self-Healing Idle Recovery (Guarantees zero persistent dead air)
      if (!this.currentTrack && this.autoplayEnabled && !this.isPaused && !this.isTransitioning && !this.isHandlingFailure && !this.isPlayingNext) {
        this.consecutiveSilenceTicks = 0;
        if (this.queue.length > 0) {
          console.log('[GuildPlayer] 🩺 Watchdog: Player is idle with pending tracks in queue. Triggering playNext().');
          void this.playNext();
        } else if (!this.isReplenishing) {
          console.log('[GuildPlayer] 🩺 Watchdog: Player is idle with empty queue. Triggering buffer replenishment.');
          void this.replenishAutoplayBuffer();
        }
        return;
      }

      // Only monitor active unpaused playback with a valid track
      if (this.isPaused || !this.currentTrack || this.isTransitioning || this.isHandlingFailure || this.isPlayingNext) {
        this.consecutiveSilenceTicks = 0;
        return;
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const elapsedSec = nowSec - (this.currentTrack.startedAtUnix || nowSec);

      // Check 1: Duration Overrun (e.g. hung decoder past song duration + 15s grace buffer)
      const duration = this.currentTrack.durationSec;
      if (duration && duration > 15 && elapsedSec > duration + 15) {
        console.warn(
          `[GuildPlayer] ⏱️ Playback watchdog: track "${this.currentTrack.title}" overrun detected (elapsed ${elapsedSec}s > duration ${duration}s + 15s). Advancing track.`
        );
        this.consecutiveSilenceTicks = 0;
        this.skip();
        return;
      }

      // Check 2: Continuous Dead Silence (RMS: 0.000, Peak: 0.000)
      // Allow 15 seconds grace period for track startup and initial intro
      if (elapsedSec > 15) {
        const meter = this.broadcastTee.getLiveAudioMeter();
        if (meter.rms === 0 && meter.peak === 0) {
          this.consecutiveSilenceTicks++;
          if (this.consecutiveSilenceTicks >= 4) {
            console.warn(
              `[GuildPlayer] 🔇 Playback watchdog: continuous dead silence detected for >=16s during active playback of "${this.currentTrack.title}". Advancing track.`
            );
            this.consecutiveSilenceTicks = 0;
            this.skip();
            return;
          }
        } else {
          this.consecutiveSilenceTicks = 0;
        }
      } else {
        this.consecutiveSilenceTicks = 0;
      }
    }, 4000);
  }

  /**
   * Configure listeners on the Discord AudioPlayer.
   */
  private setupAudioPlayerListeners(): void {
    this.audioPlayer.on('stateChange', (oldState, newState) => {
      console.log(`[GuildPlayer] AudioPlayer state: ${oldState.status} -> ${newState.status}`);
    });

    let audioPlayerErrorCount = 0;
    let lastAudioPlayerErrorTime = 0;

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      // AudioPlayer transitioned to Idle
      if (this.voiceConnection && this.currentTrack && !this.isPlayingNext && !this.isHandlingFailure && !this.isTransitioning) {
        // If BroadcastTee is still actively decoding or playing, check if stream is healthy
        if (this.broadcastTee.isPlayingActive()) {
          const stream = this.broadcastTee.discordPcmStream;
          if (stream && !stream.readableEnded && !stream.destroyed && !stream.errored) {
            console.warn(`[GuildPlayer] AudioPlayer went Idle while BroadcastTee is still playing. Re-subscribing stream.`);
            try {
              this.audioResource = createAudioResource(stream, {
                inputType: StreamType.Raw,
                inlineVolume: true,
              });
              this.audioResource.volume?.setVolume(this.volume / 100);
              this.audioPlayer.play(this.audioResource);
              return;
            } catch (resErr) {
              console.error('[GuildPlayer] Error re-subscribing idle audio resource:', (resErr as Error).message);
            }
          }
        }

        // BroadcastTee has finished this track or stream closed
        this.consecutiveFailures = 0;
        this.currentTrackRetryCount = 0;
        this.recordFullPlayReward(this.currentTrack);
        this.playNext();
      }
    });

    this.audioPlayer.on('error', (err) => {
      const now = Date.now();
      if (now - lastAudioPlayerErrorTime < 2500) {
        audioPlayerErrorCount++;
      } else {
        audioPlayerErrorCount = 1;
      }
      lastAudioPlayerErrorTime = now;

      console.error(`[GuildPlayer] AudioPlayer error (${audioPlayerErrorCount}/3):`, err.message);

      // Circuit breaker: if 3 errors fire within 2.5s, break out immediately
      if (audioPlayerErrorCount >= 3) {
        console.warn('[GuildPlayer] AudioPlayer error loop detected. Purging audio stream and skipping track.');
        audioPlayerErrorCount = 0;
        this.broadcastTee.resetDiscordPcmStream();
        if (this.currentTrack && !this.isPlayingNext) {
          this.playNext();
        }
        return;
      }

      const stream = this.broadcastTee.discordPcmStream;
      if (this.broadcastTee.isPlayingActive() && stream && !stream.readableEnded && !stream.destroyed && !stream.errored) {
        try {
          this.audioResource = createAudioResource(stream, {
            inputType: StreamType.Raw,
            inlineVolume: true,
          });
          this.audioResource.volume?.setVolume(this.volume / 100);
          this.audioPlayer.play(this.audioResource);
        } catch (resErr) {
          console.error('[GuildPlayer] Failed to recreate audio resource on error:', (resErr as Error).message);
          if (this.currentTrack && !this.isPlayingNext) {
            this.playNext();
          }
        }
      } else {
        console.warn('[GuildPlayer] Audio stream unavailable or closed. Advancing to next track.');
        if (this.currentTrack && !this.isPlayingNext) {
          this.playNext();
        }
      }
    });

    this.broadcastTee.on('trackStarted', () => {
      console.log(`[GuildPlayer] Track audio started decoding for "${this.currentTrack?.title}"`);
      this.trackPlayStartTime = Date.now();
    });

    this.broadcastTee.on('trackCrossfadeStart', () => {
      console.log(`[GuildPlayer] Crossfade started for incoming track "${this.pendingTrack?.title}"`);
      if (this.pendingTrack) {
        if (this.currentTrack && this.currentTrack.id !== this.pendingTrack.id) {
          this.previousTrack = this.currentTrack;
        }
        this.currentTrack = this.pendingTrack;
        this.pendingTrack = null;
        this.currentTrack.startedAtUnix = Math.floor(Date.now() / 1000);
        this.recordTrackStart(this.currentTrack);
        this.updateVoiceChannelStatus(this.currentTrack);
        this.emitStateChange();

        // Replenish decks in background after transition finishes (prevents CPU spikes during audio crossfade)
        setTimeout(() => {
          this.primeUpcomingDecks(BroadcastTee.MAX_STANDBY_DECKS);
          if (this.autoplayEnabled && this.queue.length < 5) {
            this.replenishAutoplayBuffer();
          }
        }, 1500);
      }
    });

    this.broadcastTee.on('trackTransitionComplete', () => {
      console.log(`[GuildPlayer] Crossfade transition complete for "${this.currentTrack?.title}"`);
      this.isTransitioning = false;
      this.consecutiveFailures = 0;
      this.currentTrackRetryCount = 0;
      this.emitStateChange();
      setTimeout(() => {
        this.primeUpcomingDecks(BroadcastTee.MAX_STANDBY_DECKS);
      }, 1000);
    });

    this.broadcastTee.on('trackEndingSoon', async () => {
      console.log(`[GuildPlayer] Track "${this.currentTrack?.title}" ending soon. Preparing seamless transition...`);
      if (this.isTransitioning || this.isPlayingNext || this.isHandlingFailure) return;
      await this.prepareAndTriggerHandover();
    });

    // When decoder in BroadcastTee finishes decoding and all frames are delivered
    this.broadcastTee.on('trackFinished', () => {
      console.log(`[GuildPlayer] BroadcastTee trackFinished for "${this.currentTrack?.title}"`);
      if (this.currentTrack && !this.isPlayingNext && !this.isHandlingFailure && !this.isTransitioning) {
        this.consecutiveFailures = 0;
        this.currentTrackRetryCount = 0;
        this.recordFullPlayReward(this.currentTrack);
        this.playNext();
      }
    });

    this.broadcastTee.on('trackError', (err: Error) => {
      console.warn(`[GuildPlayer] BroadcastTee emitted trackError: ${err.message}`);
      if (this.currentTrack && !this.isPlayingNext && !this.isHandlingFailure) {
        this.handleTrackFailure(this.currentTrack);
      }
    });

    this.broadcastTee.on('incomingTrackError', async (err: Error) => {
      console.warn(`[GuildPlayer] Incoming handover track failed: ${err.message}`);
      const failed = this.pendingTrack;
      this.pendingTrack = null;
      this.isTransitioning = false;
      if (failed) {
        await this.handleTrackFailure(failed);
      }
    });
  }

  /**
   * Connect to a Discord voice channel (or switch to a new one).
   */
  public async connectToVoice(channel: VoiceBasedChannel): Promise<void> {
    // If already connected to this exact voice channel and in Ready state, NO-OP!
    // Prevents interrupting or resetting the active audio stream when users send commands.
    if (
      this.voiceConnection &&
      this.activeVoiceChannel?.id === channel.id &&
      this.voiceConnection.state.status === VoiceConnectionStatus.Ready
    ) {
      return;
    }

    this.activeVoiceChannel = channel;

    this.voiceConnection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator as any,
      selfDeaf: true,
      selfMute: false,
    });

    this.voiceConnection.on('stateChange', (oldState, newState) => {
      console.log(`[GuildPlayer] VoiceConnection state: ${oldState.status} -> ${newState.status}`);
    });
    this.voiceConnection.on('error', (err) => {
      console.error(`[GuildPlayer] VoiceConnection error:`, (err as Error).message);
    });

    try {
      await entersState(this.voiceConnection, VoiceConnectionStatus.Ready, 15_000);
      this.voiceConnection.subscribe(this.audioPlayer);
      console.log(`[GuildPlayer] Connected to voice channel: "${channel.name}" (${channel.id})`);

      // Persist active voice channel for auto-resume across restarts
      setBotState('last_guild_id', channel.guild.id);
      setBotState('last_voice_channel_id', channel.id);
      setBotState('last_voice_channel_name', channel.name);

      // If currently playing, reset stream to purge old backlog and hook up live resource
      if (this.currentTrack && this.broadcastTee) {
        const stream = this.broadcastTee.resetDiscordPcmStream();
        this.audioResource = createAudioResource(stream, {
          inputType: StreamType.Raw,
          inlineVolume: true,
        });
        this.audioResource.volume?.setVolume(this.volume / 100);
        this.audioPlayer.play(this.audioResource);
      }
    } catch (err) {
      console.error('[GuildPlayer] Failed to connect to voice channel:', (err as Error).message);
      this.disconnectVoice();
    }
  }

  /**
   * Disconnect from Discord voice channel.
   */
  public disconnectVoice(): void {
    this.updateVoiceChannelStatus(null);
    if (this.voiceConnection) {
      this.voiceConnection.destroy();
      this.voiceConnection = null;
    }
    this.activeVoiceChannel = null;
  }

  /**
   * Add a track to the queue.
   * If isManualRequest is true, track is inserted ahead of autoplay buffer tracks.
   */
  public async enqueue(track: AudioTrack, playNextImmediately = false): Promise<void> {
    // 1. Guard against duplicate tracks: never allow the exact same song that is currently playing
    if (this.currentTrack && isDuplicateTrack(this.currentTrack, track)) {
      console.warn(`[GuildPlayer] Rejected duplicate track "${track.title}" by "${track.artist}" - already currently playing.`);
      return;
    }

    // 2. Reject duplicate if already anywhere in queue (for AI/Vibe/Autoplay tracks)
    if (track.curatedBy !== 'User Request') {
      const alreadyInQueue = this.queue.some((q) => isDuplicateTrack(q, track));
      if (alreadyInQueue) {
        console.warn(`[GuildPlayer] Rejected duplicate AI/vibe track "${track.title}" by "${track.artist}" - already in queue.`);
        return;
      }
    }

    // 3. Prevent consecutive duplicates (same song twice in a row) under ANY circumstance
    if (this.queue.length > 0) {
      const lastInQueue = this.queue[this.queue.length - 1];
      if (isDuplicateTrack(lastInQueue, track)) {
        console.warn(`[GuildPlayer] Rejected consecutive duplicate track "${track.title}" by "${track.artist}".`);
        return;
      }
    }

    if (playNextImmediately) {
      this.queue.unshift(track);
    } else if (track.requestType === 'single') {
      this.queue = PlaylistBlender.insertSingleRequest(this.queue, track);
    } else if (track.isManualRequest) {
      this.queue = PlaylistBlender.blendPlaylistBatch(this.queue, [track]);
    } else {
      this.queue.push(track);
    }

    // If currently idle, start playback immediately
    if (!this.currentTrack) {
      this.consecutiveFailures = 0;
      await this.playNext();
    } else {
      this.primeUpcomingDecks(BroadcastTee.MAX_STANDBY_DECKS);
      this.preResolveQueueStreams();
      if (track.requestType === 'single') {
        this.attemptVipSinglePromotion(track);
      }
    }

    this.emitStateChange();
  }

  /**
   * Enqueues an entire playlist batch with fair-share multi-user interleaving
   * and single-pass duplicate filtration.
   */
  public async enqueueBatch(tracks: AudioTrack[], playNextImmediately = false): Promise<number> {
    const validTracks: AudioTrack[] = [];
    const seenKeys = new Set<string>();

    for (const track of tracks) {
      if (this.currentTrack && isDuplicateTrack(this.currentTrack, track)) continue;
      const key = `${track.title.toLowerCase().trim()}|${track.artist.toLowerCase().trim()}`;
      if (seenKeys.has(key)) continue;
      if (this.queue.some((q) => isDuplicateTrack(q, track))) continue;

      seenKeys.add(key);
      validTracks.push(track);
    }

    if (validTracks.length === 0) return 0;

    if (playNextImmediately) {
      this.queue.unshift(...validTracks);
    } else {
      this.queue = PlaylistBlender.blendPlaylistBatch(this.queue, validTracks);
    }

    // If currently idle, start playback immediately
    if (!this.currentTrack) {
      this.consecutiveFailures = 0;
      await this.playNext();
    } else {
      this.primeStandbyDeck();
      this.preResolveQueueStreams();
    }

    this.emitStateChange();
    return validTracks.length;
  }

  /**
   * Pre-resolves and pre-buffers up to `depth` upcoming tracks into BroadcastTee's Multi-Deck Pool (Decks B, C, D).
   * Ensures instant 0.0s handovers even during rapid consecutive skips!
   */
  public async primeUpcomingDecks(depth = BroadcastTee.MAX_STANDBY_DECKS): Promise<void> {
    if (!this.broadcastTee.isPlayingActive()) return;

    if (this.queue.length < depth && this.autoplayEnabled) {
      await this.replenishAutoplayBuffer();
    }

    const upcomingTracks = this.queue.slice(0, depth);
    if (upcomingTracks.length === 0) return;

    const validUrls: string[] = [];
    for (let i = 0; i < upcomingTracks.length; i++) {
      const track = upcomingTracks[i];
      try {
        if (!track.streamUrl) {
          const resolved = await streamResolver.resolveStream(track);
          if (resolved) {
            track.streamUrl = resolved.streamUrl;
            if (resolved.source === 'deezer') {
              track.durationSec = resolved.durationSec;
            }
          }
        }
        if (track.streamUrl) {
          validUrls.push(track.streamUrl);
        }
      } catch (err) {
        console.warn(`[GuildPlayer] Failed to pre-resolve stream for "${track.title}":`, (err as Error).message);
      }
    }

    if (validUrls.length > 0) {
      this.broadcastTee.prepareStandbyDecks(validUrls);
    }
    this.preResolveQueueStreams();
  }

  /**
   * Backward-compatible single-track standby prewarmer.
   */
  public async primeStandbyDeck(): Promise<void> {
    await this.primeUpcomingDecks(BroadcastTee.MAX_STANDBY_DECKS);
  }

  /**
   * Promotes an individual VIP single request to Up Next (queue[0]) as soon as it is pre-buffered in RAM.
   * Gives listeners the best of both worlds:
   * 1. Safely placed at index 1 initially so active Deck B pre-buffering at index 0 is never disrupted.
   * 2. Rapidly pre-buffers its PCM frames into RAM on Standby Deck C (~1.5s).
   * 3. Once fully primed in RAM, smoothly swaps into index 0 directly ahead of bulk playlist tracks.
   */
  public async attemptVipSinglePromotion(track: AudioTrack): Promise<boolean> {
    const isVipPriority = dynamicSettings.getBoolean('curation_single_request_priority', true);
    if (!isVipPriority || track.requestType !== 'single') return false;

    // If track is already at index 0 (or queue has <= 1 track), nothing to promote
    if (this.queue.length <= 1 || this.queue[0] === track) return false;

    // Only promote ahead of playlist or autoplay tracks.
    // If queue[0] is ALREADY another user's VIP single request, don't steal their Up Next spot!
    if (this.queue[0].requestType === 'single') {
      console.log(`[GuildPlayer] VIP track "${track.title}" queued behind existing VIP request "${this.queue[0].title}".`);
      return false;
    }

    const promoteIfPrimed = (): boolean => {
      // 1. Is track still in queue?
      const currentIdx = this.queue.indexOf(track);
      if (currentIdx === -1) return false;

      // 2. Is track already at index 0?
      if (currentIdx === 0) return true;

      // 3. Is player currently transitioning?
      if (this.isTransitioning) return false;

      // 4. Is queue[0] still a playlist/autoplay track?
      if (this.queue[0].requestType === 'single') return false;

      // Promote to queue[0]
      this.queue.splice(currentIdx, 1);
      this.queue.unshift(track);
      console.log(
        `[GuildPlayer] 🚀 VIP Single Request "${track.title}" is now pre-buffered in RAM! Promoted to Up Next (queue[0]).`
      );
      this.emitStateChange();
      this.primeUpcomingDecks(BroadcastTee.MAX_STANDBY_DECKS);
      return true;
    };

    // 1. Pre-resolve stream URL if needed
    try {
      if (!track.streamUrl) {
        const resolved = await streamResolver.resolveStream(track);
        if (resolved) {
          track.streamUrl = resolved.streamUrl;
          if (resolved.source === 'deezer') {
            track.durationSec = resolved.durationSec;
          }
        }
      }
    } catch (err) {
      console.warn(`[GuildPlayer] VIP promotion resolve error for "${track.title}":`, (err as Error).message);
      return false;
    }

    if (!track.streamUrl) return false;

    // 2. If already primed in BroadcastTee standby pool, promote immediately!
    if (this.broadcastTee.isStreamPrimed(track.streamUrl)) {
      return promoteIfPrimed();
    }

    // 3. Trigger standby priming for upcoming tracks including this one
    this.primeUpcomingDecks(BroadcastTee.MAX_STANDBY_DECKS);

    // 4. Listen for standby ready event with a watchdog timeout
    return new Promise<boolean>((resolve) => {
      let settled = false;

      const onReady = () => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdogTimer);
        const promoted = promoteIfPrimed();
        resolve(promoted);
      };

      const watchdogTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.broadcastTee.off(`standbyReady:${track.streamUrl}`, onReady);
        // Fallback: check if it became primed before giving up
        if (track.streamUrl && this.broadcastTee.isStreamPrimed(track.streamUrl)) {
          resolve(promoteIfPrimed());
        } else {
          resolve(false);
        }
      }, 10000);

      this.broadcastTee.once(`standbyReady:${track.streamUrl}`, onReady);
    });
  }

  /**
   * Starts playback of a track on both Branch A (Discord) and Branch B (MP3 stream).
   */
  private startTrackPlayback(track: AudioTrack): void {
    this.trackPlayStartTime = Date.now();
    this.currentTrack = track;
    this.pendingTrack = null;
    this.isTransitioning = false;
    track.startedAtUnix = Math.floor(Date.now() / 1000);

    // Record track in database
    this.recordTrackStart(track);
    this.updateVoiceChannelStatus(track);

    // Warm up acoustic DNA tags via collaborative Last.fm graph
    // Persist playback state for auto-resume
    setBotState('was_playing', '1');
    setBotState('last_track_id', track.id);
    setBotState('last_track_title', `${track.artist} - ${track.title}`);

    // Decode once into Dual-Branch Broadcast Tee (paces output at 1x real-time)
    const trackPcmStream = this.broadcastTee.startDecoding(track.streamUrl!, track.prewarmedBuffer);

    // Only hook up Discord audio resource if bot is connected to a voice channel
    if (this.voiceConnection) {
      this.audioResource = createAudioResource(trackPcmStream, {
        inputType: StreamType.Raw,
        inlineVolume: true,
      });
      this.audioResource.volume?.setVolume(this.volume / 100);
      this.audioPlayer.play(this.audioResource);
    }
    this.isPaused = false;
    this.emitStateChange();

    // After 3 seconds, prime standby Deck B for the next track in queue
    setTimeout(() => {
      this.primeStandbyDeck();
    }, 3000);
  }

  /**
   * Handles premature track termination, decoder crashes, or bot-block extraction failures.
   * Attempts automatic multi-tier fallback (SoundCloud, Deezer) before advancing,
   * and prevents cascading skip loops by halting if consecutive failures exceed threshold.
   */
  private async handleTrackFailure(track: AudioTrack | null): Promise<void> {
    if (this.isHandlingFailure || !track) return;
    this.isHandlingFailure = true;

    try {
      // Record failed stream URL to prevent retry loops on the exact same YouTube video
      (track as any).failedStreamUrls = (track as any).failedStreamUrls || [];
      if (track.streamUrl) {
        (track as any).failedStreamUrls.push(track.streamUrl);
      }

      // If the failing track is the current active track and we're not in handover, stop active decoding
      if (track === this.currentTrack && !this.isTransitioning) {
        this.broadcastTee.stopDecoding(true);
        this.audioPlayer.stop();
      }

      // Attempt fallback if we haven't exhausted retry attempts for this track
      if (this.currentTrackRetryCount < 2) {
        this.currentTrackRetryCount++;
        console.log(`[GuildPlayer] Resolving alternative fallback stream for "${track.title}" (attempt ${this.currentTrackRetryCount})...`);

        const fallback = await streamResolver.resolveFallbackStream(track);
        if (fallback && fallback.streamUrl) {
          console.log(`[GuildPlayer] Resolved fallback stream for "${track.title}" via ${fallback.source}: ${fallback.streamUrl}`);
          track.streamUrl = fallback.streamUrl;
          track.durationSec = fallback.durationSec;
          track.prewarmedBuffer = undefined;
          this.isHandlingFailure = false;
          if (this.broadcastTee.isPlayingActive()) {
            this.pendingTrack = track;
            this.isTransitioning = true;
            this.broadcastTee.transitionTo(track.streamUrl);
          } else {
            this.startTrackPlayback(track);
          }
          return;
        }
      }

      // If fallback failed or retries exhausted:
      this.consecutiveFailures++;
      this.currentTrackRetryCount = 0;
      console.warn(`[GuildPlayer] Track "${track.title}" could not be played. Consecutive failures: ${this.consecutiveFailures}/${this.MAX_CONSECUTIVE_FAILURES}`);

      if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
        console.error(`[GuildPlayer] Pausing playback: ${this.consecutiveFailures} consecutive tracks failed. Halting queue skip loop.`);
        this.currentTrack = null;
        this.pendingTrack = null;
        this.isTransitioning = false;
        this.broadcastTee.stopDecoding(true);
        this.audioPlayer.stop();
        this.emitStateChange();
        return;
      }

      // Safety delay to prevent busy looping
      await new Promise((resolve) => setTimeout(resolve, 1000));
      this.isHandlingFailure = false;
      await this.playNext();
    } catch (err) {
      console.error('[GuildPlayer] Error in handleTrackFailure:', (err as Error).message);
      this.isHandlingFailure = false;
    }
  }

  /**
   * Play the next track in the queue.
   */
  public async playNext(): Promise<void> {
    if (this.isPlayingNext) return;
    this.isPlayingNext = true;

    try {
      if (this.queue.length === 0) {
        this.currentTrack = null;
        this.updateVoiceChannelStatus(null);
        this.pendingTrack = null;
        this.isTransitioning = false;
        this.broadcastTee.stopDecoding();
        this.audioPlayer.stop();
        this.emitStateChange();

        // Attempt autoplay replenishment if enabled
        if (this.autoplayEnabled) {
          await this.replenishAutoplayBuffer();
        }
        return;
      }

      const nextTrack = this.queue.shift()!;
      if (this.currentTrack && this.currentTrack.id !== nextTrack.id) {
        this.previousTrack = this.currentTrack;
      }
      this.currentTrack = nextTrack;
      this.pendingTrack = null;
      this.isTransitioning = false;
      this.currentTrackRetryCount = 0;

      // Resolve audio stream if not yet resolved during prewarming
      if (!nextTrack.streamUrl) {
        const resolved = await streamResolver.resolveStream(nextTrack);
        if (!resolved) {
          console.warn(`[GuildPlayer] Stream resolution failed for "${nextTrack.title}", handling failure`);
          this.isPlayingNext = false;
          await this.handleTrackFailure(nextTrack);
          return;
        }
        nextTrack.streamUrl = resolved.streamUrl;
        if (resolved.source === 'deezer') {
          nextTrack.durationSec = resolved.durationSec;
          console.log(`[GuildPlayer] Playing 30-second Deezer preview for "${nextTrack.title}" (full stream unavailable)`);
        }
      }

      this.startTrackPlayback(nextTrack);

      // Trigger prewarmer for upcoming decks in queue
      this.primeUpcomingDecks(BroadcastTee.MAX_STANDBY_DECKS);

      // Replenish buffer if queue is running low
      if (this.autoplayEnabled && this.queue.length < 5) {
        this.replenishAutoplayBuffer();
      }
    } finally {
      this.isPlayingNext = false;
    }
  }

  /**
   * Resolves the next track and triggers dynamic handover crossfade in BroadcastTee.
   * If isUserSkip is true, executes a responsive, punchy 500ms equal-power crossfade.
   */
  public async prepareAndTriggerHandover(isUserSkip = false): Promise<void> {
    if (this.isHandlingFailure) return;

    if (this.queue.length === 0 && this.autoplayEnabled) {
      await this.replenishAutoplayBuffer();
    }

    if (this.queue.length === 0) {
      console.log('[GuildPlayer] No tracks remaining in queue for handover, stopping playback smoothly.');
      this.currentTrack = null;
      this.pendingTrack = null;
      this.isTransitioning = false;
      this.broadcastTee.stopDecoding();
      this.audioPlayer.stop();
      this.emitStateChange();
      return;
    }

    const nextTrack = this.queue.shift()!;
    this.pendingTrack = nextTrack;
    this.isTransitioning = true;
    this.emitStateChange();

    try {
      if (!nextTrack.streamUrl) {
        const resolved = await streamResolver.resolveStream(nextTrack);
        if (!resolved) {
          console.warn(`[GuildPlayer] Failed to resolve handover stream for "${nextTrack.title}"`);
          const failed = this.pendingTrack;
          this.pendingTrack = null;
          this.isTransitioning = false;
          if (failed) {
            await this.handleTrackFailure(failed);
          }
          return;
        }
        nextTrack.streamUrl = resolved.streamUrl;
        if (resolved.source === 'deezer') {
          nextTrack.durationSec = resolved.durationSec;
        }
      }

      let customFadeFrames: number | undefined = undefined;
      if (isUserSkip) {
        // Fast, punchy, ultra-smooth crossfade for responsive user skips (configurable via dynamicSettings)
        const skipSec = dynamicSettings.getNumber('audio_skip_crossfade_sec', 0.5);
        customFadeFrames = Math.max(0, Math.round(skipSec / 0.02));
        console.log(`[GuildPlayer] ⏭️ User skip: executing ${skipSec}s (${customFadeFrames} frames) crossfade`);
      } else if (this.currentTrack && featureFlags.isEnabled('feature_harmonic_crossfade')) {
        const analysis = harmonicMixing.evaluateTransition(this.currentTrack, nextTrack);
        this.lastTransitionAnalysis = analysis;
        customFadeFrames = analysis.crossfadeFrames;
        console.log(`[GuildPlayer] 🎚️ Harmonic mixing: ${analysis.reason}`);
      }

      console.log(`[GuildPlayer] Initiating dynamic handover to "${nextTrack.title}" (${nextTrack.streamUrl})`);
      this.broadcastTee.transitionTo(nextTrack.streamUrl, customFadeFrames, isUserSkip);

      // Ensure Discord voice connection has audio playing
      if (this.voiceConnection && this.audioPlayer.state.status !== AudioPlayerStatus.Playing) {
        if (this.broadcastTee.discordPcmStream && !this.broadcastTee.discordPcmStream.readableEnded) {
          this.audioResource = createAudioResource(this.broadcastTee.discordPcmStream, {
            inputType: StreamType.Raw,
            inlineVolume: true,
          });
          this.audioResource.volume?.setVolume(this.volume / 100);
          this.audioPlayer.play(this.audioResource);
        }
      }
    } catch (err) {
      console.error('[GuildPlayer] Error in prepareAndTriggerHandover:', (err as Error).message);
      this.pendingTrack = null;
      this.isTransitioning = false;
    }
  }

  /**
   * Finalizes track handover after a rapid skip burst settles.
   */
  private async executeBurstHandover(track: AudioTrack): Promise<void> {
    if (this.isHandlingFailure) return;

    try {
      if (!track.streamUrl) {
        const resolved = await streamResolver.resolveStream(track);
        if (!resolved) {
          console.warn(`[GuildPlayer] Failed to resolve stream for landed track "${track.title}" after burst`);
          await this.handleTrackFailure(track);
          return;
        }
        track.streamUrl = resolved.streamUrl;
        if (resolved.source === 'deezer') {
          track.durationSec = resolved.durationSec;
        }
      }

      console.log(`[GuildPlayer] ⚡ Burst settled. Handing over to "${track.title}" (${track.streamUrl})`);
      this.pendingTrack = track;
      this.isTransitioning = true;
      this.recordTrackStart(track);
      this.updateVoiceChannelStatus(track);
      this.emitStateChange();

      this.broadcastTee.transitionTo(track.streamUrl);

      // Ensure Discord voice connection has audio playing
      if (this.voiceConnection && this.audioPlayer.state.status !== AudioPlayerStatus.Playing) {
        if (this.broadcastTee.discordPcmStream && !this.broadcastTee.discordPcmStream.readableEnded) {
          this.audioResource = createAudioResource(this.broadcastTee.discordPcmStream, {
            inputType: StreamType.Raw,
            inlineVolume: true,
          });
          this.audioResource.volume?.setVolume(this.volume / 100);
          this.audioPlayer.play(this.audioResource);
        }
      }
    } catch (err) {
      console.error('[GuildPlayer] Error in executeBurstHandover:', (err as Error).message);
      this.pendingTrack = null;
      this.isTransitioning = false;
    }
  }

  /**
   * User Skip with Early-Skip Penalty detection, multi-deck lookahead consumption,
   * and burst debounce protection.
   */
  public skip(invokingUserId?: string): boolean {
    if (!this.currentTrack) return false;

    // Pure Skip: Simple skipping without taste penalties. Dislikes handle preference deductions.

    this.consecutiveFailures = 0;
    this.currentTrackRetryCount = 0;

    const now = Date.now();
    const timeSinceLastSkip = now - this.lastSkipTimestamp;
    this.lastSkipTimestamp = now;

    // Detect burst mashing: consecutive skips occurring within 550ms
    const isRapidBurst = timeSinceLastSkip < 550;

    if (isRapidBurst) {
      this.skipBurstCount++;
      console.log(
        `[GuildPlayer] ⚡ Skip burst #${this.skipBurstCount} (interval ${timeSinceLastSkip}ms). Advancing queue instantly...`
      );

      // Replenish buffer if low
      if (this.queue.length < 5 && this.autoplayEnabled) {
        this.replenishAutoplayBuffer();
      }

      if (this.queue.length === 0) {
        console.log('[GuildPlayer] Queue empty during skip burst.');
        this.stop();
        return true;
      }

      // Pop next track immediately to advance state and UI
      const nextTrack = this.queue.shift()!;
      if (this.currentTrack && this.currentTrack.id !== nextTrack.id) {
        this.previousTrack = this.currentTrack;
      }
      this.currentTrack = nextTrack;
      this.currentTrack.startedAtUnix = Math.floor(Date.now() / 1000);
      this.updateVoiceChannelStatus(this.currentTrack);
      this.emitStateChange();

      // Clear existing debounce timer
      if (this.skipBurstDebounceTimer) {
        clearTimeout(this.skipBurstDebounceTimer);
        this.skipBurstDebounceTimer = null;
      }

      // Wait 400ms quiescence window for mashing to settle
      this.skipBurstDebounceTimer = setTimeout(async () => {
        this.skipBurstDebounceTimer = null;
        const totalBursts = this.skipBurstCount;
        this.skipBurstCount = 0;
        console.log(
          `[GuildPlayer] ⚡ Skip burst settled after ${totalBursts} rapid skips. Landing on: "${this.currentTrack?.title}"`
        );

        if (!this.currentTrack) return;
        await this.executeBurstHandover(this.currentTrack);
        this.primeUpcomingDecks(BroadcastTee.MAX_STANDBY_DECKS);
      }, 400);

      return true;
    }

    // Normal skip / Track-surfing (interval >= 550ms)
    this.skipBurstCount = 0;
    if (this.skipBurstDebounceTimer) {
      clearTimeout(this.skipBurstDebounceTimer);
      this.skipBurstDebounceTimer = null;
    }

    // If already playing active audio, perform dynamic crossfading handover!
    if (this.broadcastTee.isPlayingActive()) {
      this.prepareAndTriggerHandover(true);
      return true;
    }

    this.playNext();
    return true;
  }

  public pause(): boolean {
    if (this.isPaused || !this.currentTrack) return false;
    this.isPaused = true;
    this.audioPlayer.pause();
    this.broadcastTee.pause();
    this.emitStateChange();
    return true;
  }

  public resume(): boolean {
    if (!this.isPaused) return false;
    this.isPaused = false;
    this.audioPlayer.unpause();
    this.broadcastTee.resume();
    this.emitStateChange();
    return true;
  }

  public stop(): void {
    if (this.skipBurstDebounceTimer) {
      clearTimeout(this.skipBurstDebounceTimer);
      this.skipBurstDebounceTimer = null;
    }
    this.skipBurstCount = 0;
    this.updateVoiceChannelStatus(null);
    setBotState('was_playing', '0');
    this.queue = [];
    this.currentTrack = null;
    this.pendingTrack = null;
    this.isTransitioning = false;
    this.consecutiveFailures = 0;
    this.currentTrackRetryCount = 0;
    this.audioPlayer.stop();
    this.broadcastTee.stopDecoding();
    this.emitStateChange();
  }

  public setVolume(vol: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(vol)));
    this.volume = clamped;
    if (this.audioResource?.volume) {
      this.audioResource.volume.setVolume(clamped / 100);
    }
    this.emitStateChange();
  }

  public getVolume(): number {
    return this.volume;
  }

  /**
   * Discards unplayed autoplay buffer tracks while preserving explicit user requests.
   * If keepTopUpcoming is true, also preserves the immediately upcoming track to prevent
   * evicting pre-buffered standby decks in RAM.
   */
  public async recurateAutoplayBuffer(keepTopUpcoming = false): Promise<void> {
    if (!this.autoplayEnabled) return;

    let preservedTracks: AudioTrack[] = [];
    if (keepTopUpcoming && this.queue.length > 0) {
      // Keep manual requests AND the immediate upcoming primed track in Deck B
      const firstTrack = this.queue[0];
      const manualOnly = this.queue.filter((t) => t.isManualRequest);
      if (manualOnly.includes(firstTrack)) {
        preservedTracks = manualOnly;
      } else {
        preservedTracks = [firstTrack, ...manualOnly.filter((t) => t !== firstTrack)];
      }
    } else {
      preservedTracks = this.queue.filter((t) => t.isManualRequest);
    }

    const purgedCount = this.queue.length - preservedTracks.length;
    this.queue = preservedTracks;

    if (purgedCount > 0) {
      console.log(`[GuildPlayer] 🔄 Recurating autoplay buffer: refreshed ${purgedCount} tail tracks to reflect listener consensus.`);
      await this.replenishAutoplayBuffer();
      this.primeUpcomingDecks(BroadcastTee.MAX_STANDBY_DECKS);
      this.emitStateChange();
    }
  }

  /**
   * Triggered when room membership changes.
   * Discards unplayed tail autoplay buffer tracks and re-curates smoothly without evicting primed Deck B.
   */
  public async handleVoiceRoomMembershipChange(): Promise<void> {
    await this.recurateAutoplayBuffer(true);
    // If station is currently idle with listeners present, immediately kick off playback
    if (!this.currentTrack && this.autoplayEnabled && this.getActiveListenerUserIds().length > 0) {
      if (this.queue.length > 0) {
        void this.playNext();
      } else if (!this.isReplenishing) {
        void this.replenishAutoplayBuffer();
      }
    }
  }

  /**
   * Resumes playback automatically on startup or after reconnect.
   */
  public async autoResumePlayback(): Promise<boolean> {
    if (this.currentTrack) return true;
    if (this.queue.length > 0) {
      await this.playNext();
      return true;
    }
    await this.replenishAutoplayBuffer();
    return Boolean(this.currentTrack);
  }

  /**
   * Asynchronously fetches new autoplay tracks to maintain buffer.
   */
  public async replenishAutoplayBuffer(): Promise<void> {
    if (this.isReplenishing) return;
    this.isReplenishing = true;

    try {
      const activeMemberIds = this.getActiveListenerUserIds();
      const AUTOPLAY_BUFFER_TARGET = dynamicSettings.getNumber('curation_buffer_target', 6);
      const neededCount = Math.max(0, AUTOPLAY_BUFFER_TARGET - this.queue.length);
      if (neededCount === 0) return;

      const existingIds = [
        ...(this.currentTrack ? [this.currentTrack.id] : []),
        ...this.queue.map((t) => t.id),
      ];
      const existingArtists = [
        ...(this.currentTrack ? [this.currentTrack.artist] : []),
        ...this.queue.map((t) => t.artist),
      ];
      const existingTitles = [
        ...(this.currentTrack ? [this.currentTrack.title] : []),
        ...this.queue.map((t) => t.title),
      ];

      // Determine active Vibe Anchor: tail of upcoming queue or current track on deck
      const anchorTrack = this.queue.length > 0 
        ? this.queue[this.queue.length - 1] 
        : this.currentTrack;

      const curatedResults = await curator.getNextAutoplayTracks(
        activeMemberIds,
        neededCount,
        existingIds,
        existingArtists,
        existingTitles,
        anchorTrack ? { id: anchorTrack.id, title: anchorTrack.title, artist: anchorTrack.artist } : null
      );

      for (const res of curatedResults) {
        const audioTrack = AudioTrack.fromDeezer(
          res.track,
          'autoplay_llm',
          false,
          res.curatedBy,
          res.curationReason
        );

        if (this.currentTrack && isDuplicateTrack(this.currentTrack, audioTrack)) {
          console.warn(`[GuildPlayer] Discarded duplicate autoplay candidate "${audioTrack.title}" - currently playing.`);
          continue;
        }
        if (this.queue.some((q) => isDuplicateTrack(q, audioTrack))) {
          console.warn(`[GuildPlayer] Discarded duplicate autoplay candidate "${audioTrack.title}" - already in queue.`);
          continue;
        }

        this.queue.push(audioTrack);
      }

      this.primeStandbyDeck();
      this.preResolveQueueStreams();
      this.emitStateChange();

      // If currently idle, immediately start playing the replenished track
      if (!this.currentTrack && this.queue.length > 0) {
        await this.playNext();
      }
    } catch (err) {
      console.error('[GuildPlayer] Replenish autoplay buffer error:', (err as Error).message);
    } finally {
      this.isReplenishing = false;
    }
  }

  /**
   * Get non-bot Discord user IDs currently in the voice channel.
   */
  public getActiveListenerUserIds(): string[] {
    if (!this.activeVoiceChannel) return [];
    return this.activeVoiceChannel.members
      .filter((m) => !m.user.bot)
      .map((m) => m.id);
  }

  /**
   * Get non-bot Discord usernames currently in the voice channel.
   */
  public getActiveListenerNames(): string[] {
    if (!this.activeVoiceChannel) return [];
    return this.activeVoiceChannel.members
      .filter((m) => !m.user.bot)
      .map((m) => m.displayName || m.user.username);
  }

  /**
   * Pure Skip Directive: Skips do not penalize artist/track preferences.
   */
  private recordEarlySkipPenalty(_userId: string, _track: AudioTrack): void {
    // No-op: skips are treated as simple skipping
  }

  /**
   * Records full play reward on natural track completion.
   */
  private recordFullPlayReward(track: AudioTrack): void {
    const activeUserIds = this.getActiveListenerUserIds();
    if (activeUserIds.length === 0) return;

    const now = Math.floor(Date.now() / 1000);
    const weight = track.isManualRequest ? 1.0 : 0.5;

    for (const userId of activeUserIds) {
      try {
        sqlite.prepare(`
          INSERT INTO user_preferences (user_id, target_type, target_key, display_name, full_plays, affinity_score, updated_at)
          VALUES (?, 'artist', ?, ?, 1, ?, ?)
          ON CONFLICT(user_id, target_type, target_key) DO UPDATE SET
            full_plays = full_plays + 1,
            affinity_score = (likes * 3.0) + ((full_plays + 1) * 1.0) - (early_skips * 1.5) - (dislikes * 4.0),
            updated_at = ?
        `).run(userId, track.artist.toLowerCase(), track.artist, weight, now, now);
      } catch (err) {
        console.warn('[GuildPlayer] Error recording full-play reward:', (err as Error).message);
      }
    }
  }

  /**
   * Inserts track and playback history record.
   */
  private recordTrackStart(track: AudioTrack): void {
    const now = Math.floor(Date.now() / 1000);
    try {
      // Upsert into songs
      sqlite.prepare(`
        INSERT OR REPLACE INTO songs (id, title, artist, album, duration_sec, artwork_url, artwork_thumb_url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        track.id,
        track.title,
        track.artist,
        track.album || null,
        track.durationSec,
        track.artworkUrl,
        track.artworkThumbUrl,
        now
      );

      // Insert playback history record
      sqlite.prepare(`
        INSERT INTO playback_history (song_id, artist_name, played_at, requested_by, is_manual_request, completed)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(track.id, track.artist, now, track.requestedBy, track.isManualRequest ? 1 : 0);
    } catch (err) {
      console.warn('[GuildPlayer] Error recording track start in database:', (err as Error).message);
    }
  }

  /**
   * Updates the Discord Voice Channel Status to "Artist - Song - Album - Year"
   * or clears it when playback finishes or disconnects.
   */
  public async updateVoiceChannelStatus(track: AudioTrack | null): Promise<void> {
    if (!this.activeVoiceChannel) return;
    try {
      let statusText = '';
      if (track && dynamicSettings.getBoolean('discord_voice_status_enabled', true)) {
        const parts = [track.artist, track.title];
        if (track.album) parts.push(track.album);
        if (track.releaseYear) parts.push(String(track.releaseYear));
        statusText = parts.join(' - ');
        if (statusText.length > 490) {
          statusText = statusText.slice(0, 487) + '...';
        }
      }

      const channelId = this.activeVoiceChannel.id;

      if (typeof (this.activeVoiceChannel as any).setStatus === 'function') {
        await (this.activeVoiceChannel as any).setStatus(statusText);
      } else if (this.client?.rest) {
        await this.client.rest.put(Routes.channelVoiceStatus(channelId), {
          body: { status: statusText },
        });
      }

      if (statusText) {
        console.log(`[GuildPlayer] Discord Voice Channel Status updated: "${statusText}"`);
      } else {
        console.log(`[GuildPlayer] Cleared Discord Voice Channel Status.`);
      }
    } catch (err) {
      if ((err as any)?.code !== 50013 && !(err as Error)?.message?.includes('Missing Permissions')) {
        console.warn(`[GuildPlayer] Could not update Voice Channel Status: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Serializes current player state for API responses.
   */
  public getStatePayload(webBaseUrl?: string): PlayerStatePayload {
    const effectiveBaseUrl = config.PUBLIC_URL || webBaseUrl || `http://127.0.0.1:${config.WEB_PORT}`;
    const cleanBaseUrl = effectiveBaseUrl.replace(/\/+$/, '');
    const elapsedSec = this.currentTrack?.startedAtUnix
      ? Math.max(0, (Date.now() / 1000) - this.currentTrack.startedAtUnix)
      : 0;

    const upNextTrack = this.pendingTrack || this.queue[0];
    const brainPills: any[] = [];
    const activeBrainCount = brainPills.filter((p) => p.active).length;

    return {
      state: this.currentTrack ? (this.isPaused ? 'paused' : 'playing') : 'idle',
      isAutoplay: this.currentTrack ? !this.currentTrack.isManualRequest : true,
      volume: this.volume,
      streamUrl: `${cleanBaseUrl}/stream.mp3`,
      track: this.currentTrack ? this.currentTrack.toNowPlayingJson(elapsedSec) : null,
      upNext: upNextTrack
        ? {
            title: upNextTrack.title,
            artist: upNextTrack.artist,
            curatedBy: upNextTrack.curatedBy,
            requestType: upNextTrack.requestType,
          }
        : null,
      roomListeners: this.getActiveListenerNames(),
      queueLength: this.queue.length,
      storyArc: stationCurator.getStoryArcState(),
      radioStation: stationCurator.getActiveStation(),
      timeCapsuleYear: stationCurator.getTimeCapsuleYear(),
      morph: stationCurator.getMorphState(),
      audioMeter: this.broadcastTee.getLiveAudioMeter(),
      brainPills,
      activeBrainCount,
      totalBrainCount: brainPills.length,
    };
  }

  public getQueueList(): AudioTrack[] {
    return [...this.queue];
  }

  public clearQueue(): void {
    this.queue = [];
    this.emitStateChange();
  }

  /**
   * Removes and returns the track at the specified index in the queue.
   */
  public removeTrackAt(idx: number): AudioTrack | null {
    if (idx < 0 || idx >= this.queue.length) return null;
    const [removed] = this.queue.splice(idx, 1);
    this.emitStateChange();
    this.primeUpcomingDecks(BroadcastTee.MAX_STANDBY_DECKS);
    return removed || null;
  }

  public removeQueueTrack(indexOrId: number | string): boolean {
    if (typeof indexOrId === 'number') {
      if (indexOrId >= 0 && indexOrId < this.queue.length) {
        this.queue.splice(indexOrId, 1);
        this.emitStateChange();
        return true;
      }
      return false;
    }
    const idx = this.queue.findIndex(t => t.id === indexOrId);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      this.emitStateChange();
      return true;
    }
    return false;
  }

  /**
   * Jumps directly to a song in the queue by index or ID, removing previous songs and initiating playback.
   */
  public async jumpToQueueIndex(indexOrId: number | string): Promise<boolean> {
    let targetIdx = -1;
    if (typeof indexOrId === 'number') {
      targetIdx = indexOrId;
    } else {
      targetIdx = this.queue.findIndex((t) => t.id === indexOrId);
    }

    if (targetIdx < 0 || targetIdx >= this.queue.length) {
      return false;
    }

    const targetTrack = this.queue[targetIdx];
    console.log(`[GuildPlayer] ⏩ Jumping directly to #${targetIdx + 1} "${targetTrack.title}" by ${targetTrack.artist}`);

    if (!targetTrack.streamUrl) {
      const res = await streamResolver.resolveStream(targetTrack);
      if (res) targetTrack.streamUrl = res.streamUrl;
    }

    // Move target track to front of queue and drop preceding skipped ones
    this.queue.splice(0, targetIdx);
    this.skip();
    return true;
  }

  /**
   * Replays the current track from the beginning.
   */
  public replay(): boolean {
    if (!this.currentTrack) return false;
    console.log(`[GuildPlayer] 🔄 Instant Replay requested for "${this.currentTrack.title}"`);
    this.currentTrack.startedAtUnix = Math.floor(Date.now() / 1000);
    this.pendingTrack = null;
    this.isTransitioning = false;
    const replayed = this.broadcastTee.replayCurrentTrack();
    if (!replayed) {
      this.queue.unshift(this.currentTrack);
      this.skip();
    }
    this.updateVoiceChannelStatus(this.currentTrack);
    this.emitStateChange();
    return true;
  }

  /**
   * Shuffles upcoming tracks in the queue.
   */
  public shuffleQueue(): number {
    if (this.queue.length <= 1) return this.queue.length;
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    this.emitStateChange();
    return this.queue.length;
  }

  /**
   * Clears upcoming queue tracks without halting current song.
   */
  public clearUpcomingQueue(): void {
    this.queue = [];
    if (this.autoplayEnabled) {
      this.replenishAutoplayBuffer().catch(() => {});
    }
    this.emitStateChange();
  }

  private emitStateChange(): void {
    this.emit('stateChange', this.getStatePayload());
  }
}

export default GuildPlayer;
