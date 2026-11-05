/**
 * @file BroadcastTee.ts
 * @description Dual-Branch PCM Broadcast Tee decoding audio once into signed 16-bit 48kHz stereo PCM (s16le).
 * Feeds Discord Voice (Branch A) and an on-demand ffmpeg libmp3lame MP3 encoder exposed at GET /stream.mp3
 * with continuous 20ms silence keep-alive frames so VLC / browser streams never drop connection (Branch B).
 *
 * Features the Pro DJ Dual-Deck Engine:
 * - Active Channel (Deck A): Actively streaming to Discord & /stream.mp3
 * - Standby Channel (Deck B): Pre-buffers the next track into RAM while Deck A is playing
 * - Instant Handover: When Skip is pressed or track ends, Deck B is already in RAM -> 0.0s delay!
 * - 1.0-second equal-power cos/sin PCM crossfading with zero volume dips
 * - Micro fade-outs on stop/pause to prevent speaker pops and digital clicks
 * - Jitter-free, drift-compensated PCM Pacer with a 2-5 second safety cushion
 */

import { PassThrough, type Writable } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import dynamicSettings from '../services/dynamicSettings.js';

/**
 * 48,000 Hz * 2 channels (stereo) * 2 bytes (16-bit s16le) * 0.02 seconds = 3,840 bytes per 20ms frame.
 */
export const PCM_FRAME_SIZE = 3840;
export const SAMPLES_PER_FRAME = 1920; // 3840 / 2 (int16 samples)
export const CROSSFADE_FRAMES = 50; // 50 * 20ms = 1.000s equal-power crossfade
export const MIN_HANDOVER_FRAMES = 25; // 25 * 20ms = 500ms safety cushion before crossfade starts
export const JITTER_CUSHION_FRAMES = 150; // 150 * 20ms = 3.000s deep jitter cushion protecting Discord voice against event loop latency

interface FadeStep {
  gainA: number;
  gainB: number;
}

/** Precomputed equal-power crossfade curve: cos(t * pi/2)^2 + sin(t * pi/2)^2 = 1.0 (constant acoustic power) */
const CROSSFADE_CURVE: FadeStep[] = [];
for (let i = 0; i <= CROSSFADE_FRAMES; i++) {
  const t = i / CROSSFADE_FRAMES;
  CROSSFADE_CURVE.push({
    gainA: Math.cos((t * Math.PI) / 2),
    gainB: Math.sin((t * Math.PI) / 2),
  });
}

/**
 * Safely converts a Buffer to an Int16Array with byteOffset alignment fallback.
 */
function toInt16Array(buf: Buffer, sampleCount: number): Int16Array {
  if (buf.byteOffset % 2 === 0) {
    return new Int16Array(buf.buffer, buf.byteOffset, sampleCount);
  }
  return new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + sampleCount * 2));
}

/**
 * Mixes two 20ms s16le PCM frames together with specified gains and int16 clamping.
 */
function mixPcmFrames(frameA: Buffer, frameB: Buffer, gainA: number, gainB: number): Buffer {
  const int16A = toInt16Array(frameA, SAMPLES_PER_FRAME);
  const int16B = toInt16Array(frameB, SAMPLES_PER_FRAME);
  const int16Out = new Int16Array(SAMPLES_PER_FRAME);

  for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
    const val = Math.round(int16A[i] * gainA + int16B[i] * gainB);
    int16Out[i] = val > 32767 ? 32767 : val < -32768 ? -32768 : val;
  }
  return Buffer.from(int16Out.buffer, int16Out.byteOffset, int16Out.byteLength);
}

/**
 * Applies a gain factor to a 20ms s16le PCM frame with int16 clamping.
 */
function applyGainToFrame(frame: Buffer, gain: number): Buffer {
  if (gain >= 0.999) return frame;
  if (gain <= 0.001) return Buffer.alloc(PCM_FRAME_SIZE);
  const int16In = toInt16Array(frame, SAMPLES_PER_FRAME);
  const int16Out = new Int16Array(SAMPLES_PER_FRAME);

  for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
    const val = Math.round(int16In[i] * gain);
    int16Out[i] = val > 32767 ? 32767 : val < -32768 ? -32768 : val;
  }
  return Buffer.from(int16Out.buffer, int16Out.byteOffset, int16Out.byteLength);
}

/**
 * Synthesizes a warm, broadcast-quality 3-tone harmonic chime in pure 48kHz stereo PCM.
 * E5 (659.25 Hz) -> G#5 (830.61 Hz) -> B5 (987.77 Hz) with gentle exponential decay.
 */
function generateBroadcastChimePcm(): Buffer {
  const sampleRate = 48000;
  const totalDurationSec = 2.4;
  const totalSamples = Math.floor(sampleRate * totalDurationSec);
  const buffer = Buffer.alloc(totalSamples * 4); // 16-bit stereo = 4 bytes per sample

  const notes = [
    { freq: 659.25, startSec: 0.0, durSec: 0.35, decay: 4.2 },
    { freq: 830.61, startSec: 0.32, durSec: 0.35, decay: 4.2 },
    { freq: 987.77, startSec: 0.64, durSec: 1.65, decay: 2.2 },
  ];

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    let sample = 0;

    for (const note of notes) {
      if (t >= note.startSec && t < note.startSec + note.durSec) {
        const noteT = t - note.startSec;
        const attack = Math.min(1.0, noteT / 0.015);
        const env = attack * Math.exp(-note.decay * noteT);
        const fundamental = Math.sin(2 * Math.PI * note.freq * noteT);
        const harm2 = 0.22 * Math.sin(2 * Math.PI * (note.freq * 2) * noteT);
        const harm3 = 0.08 * Math.sin(2 * Math.PI * (note.freq * 3) * noteT);
        sample += (fundamental + harm2 + harm3) * env * 0.45;
      }
    }

    const intVal = Math.max(-32767, Math.min(32767, Math.round(sample * 32767)));
    buffer.writeInt16LE(intVal, i * 4);
    buffer.writeInt16LE(intVal, i * 4 + 2);
  }

  return buffer;
}

export type ChannelType = 'active' | 'incoming' | 'standby';

/**
 * Internal state for an audio decode channel.
 */
interface DecodeChannel {
  id: string;
  streamUrl: string;
  channelType: ChannelType;
  isPrimed: boolean;
  decoderProcess: ChildProcessWithoutNullStreams | null;
  ytdlpProcess: ChildProcessWithoutNullStreams | null;
  pcmQueue: Buffer[];
  playedPcmFrames: Buffer[];
  queueBytes: number;
  decoderClosed: boolean;
  audioBytesDecoded: number;
  lastYtDlpError: string;
  startupTimeout: NodeJS.Timeout | null;
  underrunStartTime: number | null;
}

interface CrossfadeState {
  status: 'buffering' | 'fading';
  fadeFramesElapsed: number;
  totalFadeFrames: number;
  isUserSkip?: boolean;
}

export class BroadcastTee extends EventEmitter {
  /** Output stream feeding @discordjs/voice createAudioResource */
  public discordPcmStream: PassThrough;

  /** Set of connected HTTP client response streams for /stream.mp3 */
  private clients = new Set<Writable>();

  /** Currently playing audio channel (Deck A) */
  private activeChannel: DecodeChannel | null = null;

  /** Standby preload pool (Decks B, C, D) pre-buffered and primed in RAM keyed by streamUrl */
  private standbyPool: Map<string, DecodeChannel> = new Map();
  public static readonly MAX_STANDBY_DECKS = 20;
  private standbyPrimeQueue: string[] = [];
  private isPrimingNextDeck = false;

  /** Incoming handover audio channel actively buffering or crossfading in */
  private incomingChannel: DecodeChannel | null = null;

  /** Current crossfade state machine */
  private crossfadeState: CrossfadeState | null = null;

  /** Prevent duplicate endingSoon events */
  private endingSoonEmitted = false;

  /** On-demand ffmpeg mp3 live encoder for external HTTP clients */
  private mp3EncoderProcess: ChildProcessWithoutNullStreams | null = null;

  /** Idle timer to terminate the MP3 encoder 30s after the last HTTP client disconnects */
  private teardownTimeout: NodeJS.Timeout | null = null;

  /** Tracks playback status */
  private isPlaying = false;
  private isPaused = false;

  /** High-precision pacer timer and timing state */
  private pacerInterval: NodeJS.Timeout | null = null;
  private pacerStartTime = 0;
  private framesDelivered = 0;
  private audioBytesDecoded = 0;
  private lastYtDlpError = '';

  /** Silence buffer (zeroed PCM frame: 20ms of pure digital silence) */
  private readonly silenceFrame: Buffer = Buffer.alloc(PCM_FRAME_SIZE);

  /** Real-time PCM Acoustic Audio Meter */
  private liveRms = 0;
  private livePeak = 0;
  private liveSpectrumBands: number[] = new Array(16).fill(0);

  /** Trailing outro silence frame counter for early crossfade triggering */
  private trailingSilenceFrames = 0;

  /** Hourly broadcast chime state and ducking interpolation */
  private broadcastChimeBuffer: Buffer = generateBroadcastChimePcm();
  private chimeActive: boolean = false;
  private chimeOffsetBytes: number = 0;
  private duckCurrentGain: number = 1.0;
  private duckTargetGain: number = 1.0;

  constructor() {
    super();
    this.discordPcmStream = new PassThrough({ highWaterMark: PCM_FRAME_SIZE * 200 });
    this.startPacer();
  }

  /**
   * Register an incoming HTTP client (e.g. VLC Media Player or browser audio tag).
   */
  public addHttpClient(res: Writable): void {
    this.clients.add(res);

    if (this.teardownTimeout) {
      clearTimeout(this.teardownTimeout);
      this.teardownTimeout = null;
    }

    if (!this.mp3EncoderProcess) {
      this.startMp3Encoder();
    }
  }

  /**
   * Unregister an HTTP client upon socket close or disconnect.
   */
  public removeHttpClient(res: Writable): void {
    this.clients.delete(res);

    if (this.clients.size === 0 && !this.teardownTimeout) {
      this.teardownTimeout = setTimeout(() => {
        this.stopMp3Encoder();
        this.teardownTimeout = null;
      }, 30_000);
    }
  }

  /**
   * Returns the count of actively connected external HTTP listeners.
   */
  public getListenerCount(): number {
    return this.clients.size;
  }

  /**
   * Returns whether playback is actively running or startup buffering.
   */
  public isPlayingActive(): boolean {
    return this.isPlaying;
  }

  /**
   * Returns whether the source decoder process has closed.
   */
  public isDecoderClosed(): boolean {
    return this.activeChannel ? this.activeChannel.decoderClosed : true;
  }

  /**
   * Returns the count of 20ms audio frames delivered for the current track.
   */
  public getFramesDelivered(): number {
    return this.framesDelivered;
  }

  /**
   * Returns the count of decoded raw PCM audio bytes for the current track.
   */
  public getAudioBytesDecoded(): number {
    return this.activeChannel ? this.activeChannel.audioBytesDecoded : this.audioBytesDecoded;
  }

  /**
   * Returns the last captured error string from yt-dlp stderr, if any.
   */
  public getLastYtDlpError(): string {
    return this.activeChannel?.lastYtDlpError || this.incomingChannel?.lastYtDlpError || this.lastYtDlpError;
  }

  /**
   * Resets the Discord PCM PassThrough stream to purge any stale buffered audio
   * from before the bot joined the voice channel.
   */
  public resetDiscordPcmStream(): PassThrough {
    try {
      if (this.discordPcmStream && !this.discordPcmStream.writableEnded) {
        this.discordPcmStream.end();
      }
    } catch {}
    this.discordPcmStream = new PassThrough({ highWaterMark: PCM_FRAME_SIZE * 200 });
    return this.discordPcmStream;
  }

  /**
   * Triggers the broadcast hourly chime.
   * Smoothly ducks active stream volume to 20%, overlays the synthesized 3-tone chime, and smoothly restores volume.
   */
  public triggerHourlyChime(): void {
    if (!dynamicSettings.getBoolean('audio_chime_enabled', true)) return;
    const duckGain = dynamicSettings.getNumber('audio_chime_duck_gain', 0.20);
    console.log(`[BroadcastTee] 🔔 Hourly broadcast chime activated! Ducking music to ${Math.round(duckGain * 100)}%...`);
    this.chimeActive = true;
    this.chimeOffsetBytes = 0;
    this.duckTargetGain = duckGain;
    this.emit('hourlyChimeStart');
  }

  /**
   * Returns whether the hourly chime is currently playing.
   */
  public isChimePlaying(): boolean {
    return this.chimeActive;
  }

  /**
   * Writes a 20ms PCM frame to both Branch A (Discord) and Branch B (MP3 Encoder),
   * applying ducking and mixing the hourly chime when active.
   */
  private writePcmToBranches(frame: Buffer): void {
    let outputFrame = frame;

    // Apply hourly chime overlay and ducking if active
    if (this.chimeActive) {
      // 1. Duck or unduck music gain smoothly towards target
      if (this.duckCurrentGain > this.duckTargetGain) {
        this.duckCurrentGain = Math.max(this.duckTargetGain, this.duckCurrentGain - 0.05);
      } else if (this.duckCurrentGain < this.duckTargetGain) {
        this.duckCurrentGain = Math.min(this.duckTargetGain, this.duckCurrentGain + 0.04);
      }

      // Apply duck gain to incoming music frame
      const duckedFrame = this.duckCurrentGain < 0.99 ? applyGainToFrame(frame, this.duckCurrentGain) : frame;

      // 2. Mix chime PCM if still playing
      if (this.chimeOffsetBytes < this.broadcastChimeBuffer.length) {
        const chimeEnd = Math.min(this.chimeOffsetBytes + PCM_FRAME_SIZE, this.broadcastChimeBuffer.length);
        const chimeSlice = this.broadcastChimeBuffer.subarray(this.chimeOffsetBytes, chimeEnd);
        let chimeFrame = chimeSlice;
        if (chimeFrame.length < PCM_FRAME_SIZE) {
          chimeFrame = Buffer.concat([chimeFrame, Buffer.alloc(PCM_FRAME_SIZE - chimeFrame.length)]);
        }

        outputFrame = mixPcmFrames(duckedFrame, chimeFrame, 1.0, 0.90);
        this.chimeOffsetBytes += PCM_FRAME_SIZE;

        if (this.chimeOffsetBytes >= this.broadcastChimeBuffer.length) {
          // Chime finished; start restoring music volume
          this.duckTargetGain = 1.0;
        }
      } else {
        // Chime audio is done, waiting for volume to restore back to 1.0
        outputFrame = duckedFrame;
        if (this.duckCurrentGain >= 0.99) {
          this.chimeActive = false;
          this.duckCurrentGain = 1.0;
          this.duckTargetGain = 1.0;
          console.log('[BroadcastTee] 🔔 Hourly chime complete. Music volume restored to 100%.');
          this.emit('hourlyChimeEnd');
        }
      }
    }

    // Analyze live acoustic energy from real 48kHz stereo s16le PCM frame
    if (outputFrame.length >= PCM_FRAME_SIZE) {
      const numSamples = outputFrame.length / 4; // 960 stereo pairs
      let sumSquares = 0;
      let peak = 0;
      const bandEnergies = new Array(16).fill(0);
      const samplesPerBand = Math.floor(numSamples / 16); // 60 samples per band

      for (let i = 0; i < numSamples; i++) {
        const left = outputFrame.readInt16LE(i * 4);
        const right = outputFrame.readInt16LE(i * 4 + 2);
        const mono = (left + right) * 0.5;
        const absVal = Math.abs(mono);
        if (absVal > peak) peak = absVal;
        sumSquares += mono * mono;

        const bandIdx = Math.min(15, Math.floor(i / samplesPerBand));
        bandEnergies[bandIdx] += mono * mono;
      }

      const frameRms = Math.sqrt(sumSquares / numSamples) / 32768;
      const framePeak = peak / 32768;

      // Exponential decay smoothing
      this.liveRms = this.liveRms * 0.75 + frameRms * 0.25;
      this.livePeak = Math.max(framePeak, this.livePeak * 0.92);

      for (let b = 0; b < 16; b++) {
        const bandVal = Math.min(1.0, (Math.sqrt(bandEnergies[b] / samplesPerBand) / 32768) * 1.8);
        this.liveSpectrumBands[b] = this.liveSpectrumBands[b] * 0.70 + bandVal * 0.30;
      }
    }

    if (this.discordPcmStream && !this.discordPcmStream.writableEnded) {
      this.discordPcmStream.write(outputFrame);
    }
    if (this.clients.size > 0 && this.mp3EncoderProcess?.stdin?.writable) {
      this.mp3EncoderProcess.stdin.write(outputFrame);
    }
  }

  /**
   * Spawns a decode channel (yt-dlp pipe or direct ffmpeg).
   */
  private spawnDecodeChannel(streamUrl: string, channelType: ChannelType): DecodeChannel {
    const id = Math.random().toString(36).substring(2, 9);
    const channel: DecodeChannel = {
      id,
      streamUrl,
      channelType,
      isPrimed: false,
      decoderProcess: null,
      ytdlpProcess: null,
      pcmQueue: [],
      playedPcmFrames: [],
      queueBytes: 0,
      decoderClosed: false,
      audioBytesDecoded: 0,
      lastYtDlpError: '',
      startupTimeout: null,
      underrunStartTime: null,
    };

    channel.startupTimeout = setTimeout(() => {
      if (channel.audioBytesDecoded === 0 && !channel.decoderClosed) {
        console.warn(`[BroadcastTee] Channel ${channel.id} (${channelType}) startup buffering timed out after 30s with 0 bytes decoded.`);
        this.teardownChannel(channel);
        if (channelType === 'standby') {
          this.standbyPool.delete(channel.streamUrl);
          this.emit('standbyError', new Error(channel.lastYtDlpError || 'Standby deck buffering timed out after 30s'));
          this.emit(`standbyError:${channel.streamUrl}`);
        } else if (channelType === 'incoming') {
          if (this.incomingChannel === channel) {
            this.incomingChannel = null;
            this.crossfadeState = null;
          }
          this.emit('incomingTrackError', new Error(channel.lastYtDlpError || 'Incoming track buffering timed out after 30s'));
        } else {
          if (this.activeChannel === channel) {
            this.activeChannel = null;
            this.isPlaying = false;
          }
          this.emit('trackError', new Error(channel.lastYtDlpError || 'Track startup buffering timed out after 30s'));
        }
      }
    }, 30_000);

    const isYouTube =
      streamUrl.includes('youtube.com') ||
      streamUrl.includes('youtu.be') ||
      streamUrl.startsWith('yt_') ||
      streamUrl.startsWith('yt:');

    if (isYouTube) {
      let targetUrl = streamUrl;
      if (streamUrl.startsWith('yt_') || streamUrl.startsWith('yt:')) {
        const cleanId = streamUrl.replace(/^(yt_|yt:)/, '');
        if (/^[a-zA-Z0-9_-]{11}$/.test(cleanId)) {
          targetUrl = `https://www.youtube.com/watch?v=${cleanId}`;
        }
      }

      const ytdlpArgs = [
        '-o', '-',
        '-f', 'bestaudio[acodec=opus]/bestaudio/18/best',
        '--no-playlist',
        '--no-warnings',
        '--no-check-certificates',
        '--js-runtimes', 'node',
        '--cache-dir', path.resolve(process.cwd(), 'data', '.cache', 'yt-dlp'),
      ];

      if (config.ENABLE_SPONSORBLOCK) {
        ytdlpArgs.push('--sponsorblock-remove', 'music_offtopic,intro,outro');
      }

      if (config.YOUTUBE_PROXY) {
        ytdlpArgs.push('--proxy', config.YOUTUBE_PROXY);
      }
      const cookiesPath = config.YOUTUBE_COOKIES_PATH || (existsSync(path.resolve(process.cwd(), 'cookies.txt')) ? path.resolve(process.cwd(), 'cookies.txt') : undefined);
      if (cookiesPath) {
        ytdlpArgs.push('--cookies', cookiesPath);
      }
      ytdlpArgs.push(targetUrl);

      console.log(`[BroadcastTee] [${channelType.toUpperCase()}] Spawning yt-dlp pipe for: ${targetUrl}`);
      const ytdlp = spawn('yt-dlp', ytdlpArgs);
      channel.ytdlpProcess = ytdlp;

      const ffmpegArgs = [
        '-i', 'pipe:0',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        '-vn',
        '-loglevel', 'error',
      ];

      const afFilters: string[] = [];
      if (config.ENABLE_SILENCE_TRIMMING) {
        afFilters.push(`silenceremove=start_periods=1:start_duration=0.08:start_threshold=${config.SILENCE_THRESHOLD_DB}dB`);
      }
      if (dynamicSettings.getBoolean('audio_normalization_enabled', true)) {
        afFilters.push('dynaudnorm=f=150:g=15:m=10');
      }
      if (afFilters.length > 0) {
        ffmpegArgs.push('-af', afFilters.join(','));
      }

      ffmpegArgs.push('pipe:1');

      const decoder = spawn('ffmpeg', ffmpegArgs);
      channel.decoderProcess = decoder;

      ytdlp.stdout.pipe(decoder.stdin);

      ytdlp.stdout.on('error', () => {});
      decoder.stdin.on('error', () => {});

      ytdlp.stderr.on('data', (errChunk: Buffer) => {
        const msg = errChunk.toString().trim();
        channel.lastYtDlpError = msg;
        this.lastYtDlpError = msg;
        if (msg.toLowerCase().includes('error:') && !msg.toLowerCase().includes('retrying')) {
          console.warn(`[BroadcastTee] yt-dlp error: ${msg}`);
        }
      });

      ytdlp.on('error', (err) => {
        console.error(`[BroadcastTee] yt-dlp error on channel ${channel.id}:`, err.message);
        channel.lastYtDlpError = err.message;
      });

      ytdlp.on('close', (code) => {
        if (code !== 0 && code !== null && channel.queueBytes === 0) {
          console.warn(`[BroadcastTee] yt-dlp process exited with non-zero code ${code} on channel ${channel.id}`);
        }
        channel.ytdlpProcess = null;
      });
    } else {
      const ffmpegArgs: string[] = [];
      if (!existsSync(streamUrl)) {
        ffmpegArgs.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
      }
      ffmpegArgs.push(
        '-i', streamUrl,
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        '-vn',
        '-loglevel', 'error'
      );

      const afFilters: string[] = [];
      if (config.ENABLE_SILENCE_TRIMMING) {
        afFilters.push(`silenceremove=start_periods=1:start_duration=0.08:start_threshold=${config.SILENCE_THRESHOLD_DB}dB`);
      }
      if (dynamicSettings.getBoolean('audio_normalization_enabled', true)) {
        afFilters.push('dynaudnorm=f=150:g=15:m=10');
      }
      if (afFilters.length > 0) {
        ffmpegArgs.push('-af', afFilters.join(','));
      }

      ffmpegArgs.push('pipe:1');

      const decoder = spawn('ffmpeg', ffmpegArgs);
      channel.decoderProcess = decoder;
    }

    const currentDecoder = channel.decoderProcess!;

    currentDecoder.stdout.on('data', (chunk: Buffer) => {
      if (channel.audioBytesDecoded === 0) {
        if (channel.startupTimeout) {
          clearTimeout(channel.startupTimeout);
          channel.startupTimeout = null;
        }
        if (channelType === 'active') {
          this.pacerStartTime = Date.now();
          this.framesDelivered = 0;
          this.emit('trackStarted');
        }
      }

      channel.pcmQueue.push(chunk);
      channel.queueBytes += chunk.length;
      channel.audioBytesDecoded += chunk.length;

      if (channel.channelType === 'active') {
        this.audioBytesDecoded = channel.audioBytesDecoded;
      }

      // Standby Decks (B, C, D): Pre-buffer ~3.0s (150 frames = 576,000 bytes) of PCM, then pause decoder stdout
      if (channel.channelType === 'standby') {
        if (channel.queueBytes >= PCM_FRAME_SIZE * 150) {
          if (!channel.isPrimed) {
            channel.isPrimed = true;
            if (channel.decoderProcess && !channel.decoderProcess.stdout.isPaused()) {
              channel.decoderProcess.stdout.pause();
            }
            console.log(
              `[BroadcastTee] Standby Deck (${channel.id}) primed with ${channel.queueBytes} bytes in RAM for: ${channel.streamUrl}. Ready for instant skip!`
            );
            this.emit('standbyReady', channel.streamUrl);
            this.emit(`standbyReady:${channel.streamUrl}`);
          }
        }
        return;
      }

      // Cushion limit: Buffer up to 5 seconds of audio (960,000 bytes) for active playback
      if (channel.queueBytes > 960_000 && channel.decoderProcess && !channel.decoderProcess.stdout.isPaused()) {
        channel.decoderProcess.stdout.pause();
      }
    });

    currentDecoder.stderr.on('data', (errChunk: Buffer) => {
      const msg = errChunk.toString().trim();
      if (msg) {
        console.warn(`[BroadcastTee] Decoder stderr on channel ${channel.id}: ${msg}`);
      }
    });

    currentDecoder.on('error', (err) => {
      console.error(`[BroadcastTee] Decoder process error on channel ${channel.id}:`, err.message);
      if (channelType === 'active') {
        this.emit('error', err);
      }
    });

    currentDecoder.on('close', (code) => {
      if (channel.startupTimeout) {
        clearTimeout(channel.startupTimeout);
        channel.startupTimeout = null;
      }

      channel.decoderClosed = true;
      channel.decoderProcess = null;

      if (channelType === 'standby') {
        this.standbyPool.delete(channel.streamUrl);
        if (channel.audioBytesDecoded < PCM_FRAME_SIZE * MIN_HANDOVER_FRAMES) {
          console.warn(`[BroadcastTee] Standby Deck exited prematurely (${channel.audioBytesDecoded} bytes) for: ${channel.streamUrl}`);
          this.emit('standbyError', new Error(channel.lastYtDlpError || `Standby decoder exited prematurely (code ${code})`));
          this.emit(`standbyError:${channel.streamUrl}`);
        }
        return;
      }

      if (channelType === 'incoming' && channel === this.incomingChannel) {
        if (channel.audioBytesDecoded < PCM_FRAME_SIZE * MIN_HANDOVER_FRAMES) {
          console.warn(
            `[BroadcastTee] Incoming handover channel exited prematurely (${channel.audioBytesDecoded} bytes) for: ${channel.streamUrl}`
          );
          this.teardownChannel(this.incomingChannel);
          this.incomingChannel = null;
          this.crossfadeState = null;
          const errMsg = channel.lastYtDlpError || `Incoming handover decoder exited prematurely (code ${code})`;
          this.emit('incomingTrackError', new Error(errMsg));
        }
        return;
      }

      if (channelType === 'active' && channel === this.activeChannel && !this.crossfadeState) {
        if (channel.audioBytesDecoded < 3840 * 100) {
          if (this.isPlaying) {
            this.isPlaying = false;
            const errMsg = channel.lastYtDlpError || `Decoder exited prematurely (code ${code}, ${channel.audioBytesDecoded} audio bytes decoded)`;
            this.emit('trackError', new Error(errMsg));
          }
        }
      }
    });

    return channel;
  }

  /**
   * Pops exactly 3,840 bytes (one 20ms frame) from a channel's PCM queue.
   */
  private popFrameFromChannel(channel: DecodeChannel): Buffer | null {
    if (channel.queueBytes < PCM_FRAME_SIZE) return null;
    let needed = PCM_FRAME_SIZE;
    const chunksToTake: Buffer[] = [];

    while (needed > 0 && channel.pcmQueue.length > 0) {
      const head = channel.pcmQueue[0];
      if (head.length <= needed) {
        chunksToTake.push(head);
        needed -= head.length;
        channel.queueBytes -= head.length;
        channel.pcmQueue.shift();
      } else {
        chunksToTake.push(head.subarray(0, needed));
        channel.pcmQueue[0] = head.subarray(needed);
        channel.queueBytes -= needed;
        needed = 0;
      }
    }

    // Resume decoder if buffer drops below 2 seconds (384,000 bytes)
    if (
      channel.queueBytes < 384_000 &&
      channel.decoderProcess &&
      !channel.decoderClosed &&
      channel.decoderProcess.stdout.isPaused()
    ) {
      channel.decoderProcess.stdout.resume();
    }

    const frame = chunksToTake.length === 1 ? chunksToTake[0] : Buffer.concat(chunksToTake);
    if (channel.channelType === 'active') {
      channel.playedPcmFrames.push(frame);
    }
    return frame;
  }

  /**
   * Completely tears down and kills processes for a channel.
   */
  private teardownChannel(channel: DecodeChannel | null): void {
    if (!channel) return;

    if (channel.startupTimeout) {
      clearTimeout(channel.startupTimeout);
      channel.startupTimeout = null;
    }

    if (channel.ytdlpProcess) {
      channel.ytdlpProcess.removeAllListeners();
      try {
        channel.ytdlpProcess.kill('SIGKILL');
      } catch {}
      channel.ytdlpProcess = null;
    }

    if (channel.decoderProcess) {
      channel.decoderProcess.removeAllListeners();
      try {
        channel.decoderProcess.kill('SIGKILL');
      } catch {}
      channel.decoderProcess = null;
    }

    if (channel.streamUrl && this.standbyPool.get(channel.streamUrl) === channel) {
      this.standbyPool.delete(channel.streamUrl);
    }

    channel.pcmQueue = [];
    channel.playedPcmFrames = [];
    channel.queueBytes = 0;
    channel.decoderClosed = true;
  }

  /**
   * Pre-buffers up to MAX_STANDBY_DECKS tracks into RAM in a sliding pipeline (Decks B, C, D).
   * Evicts any standby channels that are no longer in the upcoming list.
   */
  public prepareStandbyDecks(streamUrls: string[]): void {
    const maxDecks = Math.max(15, dynamicSettings.getNumber('audio_standby_decks_count', BroadcastTee.MAX_STANDBY_DECKS));
    const targetUrls = streamUrls.slice(0, maxDecks);
    const targetSet = new Set(targetUrls);

    // 1. Evict any standby channels not in targetSet
    for (const [url, channel] of this.standbyPool) {
      if (!targetSet.has(url)) {
        console.log(`[BroadcastTee] Evicting bypassed standby deck (${channel.id}) for: ${url}`);
        this.teardownChannel(channel);
        this.standbyPool.delete(url);
      }
    }

    // 2. Queue up any missing URLs
    this.standbyPrimeQueue = targetUrls.filter((url) => !this.standbyPool.has(url));

    // 3. Process standby queue
    this.processStandbyQueue();
  }

  /**
   * Backward-compatible single-track standby prewarmer.
   */
  public prepareStandby(streamUrl: string): void {
    this.prepareStandbyDecks([streamUrl]);
  }

  /**
   * Process upcoming standby decks sequentially to prevent network thundering herd.
   */
  private processStandbyQueue(): void {
    if (this.isPrimingNextDeck) return;
    if (this.standbyPool.size >= BroadcastTee.MAX_STANDBY_DECKS) return;
    if (this.standbyPrimeQueue.length === 0) return;

    const nextUrl = this.standbyPrimeQueue.shift();
    if (!nextUrl || this.standbyPool.has(nextUrl)) {
      this.processStandbyQueue();
      return;
    }

    this.isPrimingNextDeck = true;
    console.log(
      `[BroadcastTee] Priming standby Deck (${this.standbyPool.size + 1}/${BroadcastTee.MAX_STANDBY_DECKS}) for: ${nextUrl}`
    );
    const channel = this.spawnDecodeChannel(nextUrl, 'standby');
    this.standbyPool.set(nextUrl, channel);

    // Safety watchdog: after 3.0s, if not yet primed, still unblock to allow next deck in queue
    const primeTimer = setTimeout(() => {
      this.isPrimingNextDeck = false;
      this.processStandbyQueue();
    }, 3000);

    const cleanupListeners = () => {
      clearTimeout(primeTimer);
      this.isPrimingNextDeck = false;
      this.processStandbyQueue();
    };

    this.once(`standbyReady:${nextUrl}`, cleanupListeners);
    this.once(`standbyError:${nextUrl}`, cleanupListeners);
  }

  /**
   * Returns whether any (or a specific) Standby Deck has pre-buffered enough audio for an instant crossfade.
   */
  public isStandbyReady(streamUrl?: string): boolean {
    if (streamUrl) {
      const channel = this.standbyPool.get(streamUrl);
      return !!channel && channel.queueBytes >= PCM_FRAME_SIZE * MIN_HANDOVER_FRAMES;
    }
    for (const channel of this.standbyPool.values()) {
      if (channel.queueBytes >= PCM_FRAME_SIZE * MIN_HANDOVER_FRAMES) return true;
    }
    return false;
  }

  /**
   * Returns diagnostic status of all currently preloaded standby decks in the pool.
   */
  public getStandbyPoolStatus(): Array<{ id: string; streamUrl: string; queueBytes: number; isPrimed: boolean; audioBytesDecoded: number }> {
    const result = [];
    for (const [url, channel] of this.standbyPool) {
      result.push({
        id: channel.id,
        streamUrl: url,
        queueBytes: channel.queueBytes,
        isPrimed: channel.isPrimed,
        audioBytesDecoded: channel.audioBytesDecoded,
      });
    }
    return result;
  }

  /**
   * Returns true if the given stream URL is fully primed in RAM in the standby pool.
   */
  public isStreamPrimed(streamUrl: string): boolean {
    const channel = this.standbyPool.get(streamUrl);
    return !!channel && channel.isPrimed;
  }

  /**
   * Returns real-time acoustic audio meter (RMS volume, peak level, and 16-band energy spectrum).
   * Computed directly from the 48kHz stereo s16le PCM stream.
   */
  public getLiveAudioMeter(): { rms: number; peak: number; bands: number[] } {
    if (!this.isPlaying || !this.activeChannel) {
      return { rms: 0, peak: 0, bands: new Array(16).fill(0) };
    }
    return {
      rms: Math.round(this.liveRms * 1000) / 1000,
      peak: Math.round(this.livePeak * 1000) / 1000,
      bands: this.liveSpectrumBands.map((b) => Math.round(b * 1000) / 1000),
    };
  }

  /**
   * Initiates dynamic handover to a new track.
   * If a matching Standby Deck (B, C, or D) is primed in RAM, crossfade begins IMMEDIATELY (0.0s delay)!
   * If not primed, buffers in background while current track plays at full volume.
   */
  public transitionTo(streamUrl: string, customFadeFrames?: number, isUserSkip = false): boolean {
    const fadeFrames = customFadeFrames && customFadeFrames >= 20 ? customFadeFrames : CROSSFADE_FRAMES;

    if (!this.isPlaying || !this.activeChannel) {
      this.startDecoding(streamUrl);
      return true;
    }

    const matchedStandby = this.standbyPool.get(streamUrl);

    // FAST PATH: Standby Deck (B, C, or D) is already primed with audio in RAM!
    if (
      matchedStandby &&
      matchedStandby.queueBytes >= PCM_FRAME_SIZE * MIN_HANDOVER_FRAMES
    ) {
      console.log(
        `[BroadcastTee] Instant handover! Standby Deck (${matchedStandby.id}) is primed (${matchedStandby.queueBytes} bytes in RAM). Starting crossfade immediately (${(fadeFrames * 0.02).toFixed(1)}s)!`
      );
      this.standbyPool.delete(streamUrl);

      if (this.crossfadeState && this.incomingChannel) {
        this.teardownChannel(this.incomingChannel);
        this.incomingChannel = null;
      }
      this.incomingChannel = matchedStandby;
      this.incomingChannel.channelType = 'incoming';
      this.incomingChannel.isPrimed = false;

      if (this.incomingChannel.decoderProcess && this.incomingChannel.decoderProcess.stdout.isPaused()) {
        this.incomingChannel.decoderProcess.stdout.resume();
      }
      this.crossfadeState = {
        status: 'fading',
        fadeFramesElapsed: 0,
        totalFadeFrames: fadeFrames,
      };
      this.emit('trackCrossfadeStart');
      // Advance standby queue processing to replenish pool
      this.processStandbyQueue();
      return true;
    }

    // Standby Deck exists for this URL but is still buffering:
    if (matchedStandby) {
      console.log(
        `[BroadcastTee] Standby Deck (${matchedStandby.id}) is buffering (${matchedStandby.queueBytes} bytes). Promoting to incoming handover channel.`
      );
      this.standbyPool.delete(streamUrl);

      if (this.crossfadeState && this.incomingChannel) {
        this.teardownChannel(this.incomingChannel);
        this.incomingChannel = null;
      }
      this.incomingChannel = matchedStandby;
      this.incomingChannel.channelType = 'incoming';
      this.incomingChannel.isPrimed = false;

      if (this.incomingChannel.decoderProcess && this.incomingChannel.decoderProcess.stdout.isPaused()) {
        this.incomingChannel.decoderProcess.stdout.resume();
      }
      this.crossfadeState = {
        status: 'buffering',
        fadeFramesElapsed: 0,
        totalFadeFrames: fadeFrames,
      };
      // Advance standby queue processing to replenish pool
      this.processStandbyQueue();
      return true;
    }

    // Cold transition: URL wasn't pre-buffered in standby pool
    if (this.crossfadeState) {
      if (this.crossfadeState.status === 'fading' && this.incomingChannel) {
        this.teardownChannel(this.activeChannel);
        this.activeChannel = this.incomingChannel;
        this.incomingChannel = null;
        this.crossfadeState = null;
      } else if (this.incomingChannel) {
        this.teardownChannel(this.incomingChannel);
        this.incomingChannel = null;
        this.crossfadeState = null;
      }
    }

    console.log(`[BroadcastTee] Dynamic handover initiated. Buffering next track: ${streamUrl}`);
    this.crossfadeState = {
      status: 'buffering',
      fadeFramesElapsed: 0,
      totalFadeFrames: fadeFrames,
      isUserSkip: isUserSkip || false,
    };
    this.incomingChannel = this.spawnDecodeChannel(streamUrl, 'incoming');
    return true;
  }

  /**
   * Starts decoding an audio stream and broadcasting PCM to both branches.
   * If already playing, initiates a smooth crossfade handover.
   */
  public startDecoding(streamUrl: string, _prewarmedBuffer?: Buffer): PassThrough {
    if (this.isPlaying && this.activeChannel && !this.activeChannel.decoderClosed) {
      this.transitionTo(streamUrl);
      return this.discordPcmStream;
    }

    // Cold start
    this.stopDecoding(true);

    this.isPlaying = true;
    this.isPaused = false;
    this.endingSoonEmitted = false;
    this.trailingSilenceFrames = 0;
    this.framesDelivered = 0;
    this.audioBytesDecoded = 0;
    this.lastYtDlpError = '';
    this.pacerStartTime = Date.now();

    if (!this.discordPcmStream || this.discordPcmStream.writableEnded) {
      this.discordPcmStream = new PassThrough({ highWaterMark: PCM_FRAME_SIZE * 200 });
    }

    this.activeChannel = this.spawnDecodeChannel(streamUrl, 'active');
    return this.discordPcmStream;
  }

  /**
   * Stop active decoding and drain audio buffers.
   * If not immediate, performs a quick 100ms micro-fadeout to eliminate pops.
   */
  public stopDecoding(immediate = false): void {
    this.crossfadeState = null;
    this.teardownChannel(this.incomingChannel);
    this.incomingChannel = null;
    this.liveRms = 0;
    this.livePeak = 0;
    this.liveSpectrumBands.fill(0);

    for (const [url, channel] of this.standbyPool) {
      this.teardownChannel(channel);
    }
    this.standbyPool.clear();
    this.standbyPrimeQueue = [];
    this.isPrimingNextDeck = false;

    if (immediate || !this.isPlaying || !this.activeChannel || this.activeChannel.queueBytes < PCM_FRAME_SIZE * 5) {
      this.teardownChannel(this.activeChannel);
      this.activeChannel = null;
      this.isPlaying = false;
      this.isPaused = false;
      try {
        if (this.discordPcmStream && !this.discordPcmStream.writableEnded) {
          this.discordPcmStream.end();
        }
      } catch {}
      return;
    }

    // Micro fade-out 5 frames (100ms) to silence
    for (let f = 0; f < 5; f++) {
      const frame = this.popFrameFromChannel(this.activeChannel);
      if (frame) {
        const gain = 1 - (f / 5);
        this.writePcmToBranches(applyGainToFrame(frame, gain));
      }
    }

    this.teardownChannel(this.activeChannel);
    this.activeChannel = null;
    this.isPlaying = false;
    this.isPaused = false;

    try {
      if (this.discordPcmStream && !this.discordPcmStream.writableEnded) {
        this.discordPcmStream.end();
      }
    } catch {}
  }

  /**
   * Pause playback.
   */
  public pause(): void {
    if (this.isPlaying && !this.isPaused && this.activeChannel) {
      for (let f = 0; f < 3; f++) {
        const frame = this.popFrameFromChannel(this.activeChannel);
        if (frame) {
          const gain = 1 - (f / 3);
          this.writePcmToBranches(applyGainToFrame(frame, gain));
        }
      }
    }
    this.isPaused = true;
  }

  /**
   * Resume playback.
   */
  public resume(): void {
    if (this.isPaused) {
      this.isPaused = false;
      this.pacerStartTime = Date.now() - (this.framesDelivered * 20);
    }
  }

  /**
   * Instantly rewinds the currently playing track to 0:00 (0.0s latency).
   * Restores all played PCM frames back to the head of the active channel queue without spawning yt-dlp.
   */
  public replayCurrentTrack(): boolean {
    if (!this.isPlaying || !this.activeChannel) return false;

    // If an incoming crossfade was underway, cancel it cleanly
    if (this.crossfadeState) {
      if (this.incomingChannel) {
        this.teardownChannel(this.incomingChannel);
        this.incomingChannel = null;
      }
      this.crossfadeState = null;
    }

    if (this.activeChannel.playedPcmFrames && this.activeChannel.playedPcmFrames.length > 0) {
      const count = this.activeChannel.playedPcmFrames.length;
      const restoredBytes = count * PCM_FRAME_SIZE;
      console.log(
        `[BroadcastTee] 🔄 Instant Replay! Restoring ${count} frames (${(restoredBytes / 1024).toFixed(1)} KB) back to 0:00 (0.0s latency).`
      );
      this.activeChannel.pcmQueue.unshift(...this.activeChannel.playedPcmFrames);
      this.activeChannel.queueBytes += restoredBytes;
      this.activeChannel.playedPcmFrames = [];
      this.trailingSilenceFrames = 0;
      this.endingSoonEmitted = false;
      return true;
    }

    this.trailingSilenceFrames = 0;
    this.endingSoonEmitted = false;
    return true;
  }

  /**
   * High-precision pacer running at 10ms with drift compensation.
   * Feeds Branch A (Discord) and Branch B (MP3 / VLC) at exact 1.000x real-time speed.
   */
  private startPacer(): void {
    if (this.pacerInterval) return;

    this.pacerInterval = setInterval(() => {
      // Case 1: Idle or Paused -> Write silence keep-alive to MP3 encoder
      if (!this.isPlaying || this.isPaused) {
        if (this.clients.size > 0 && this.mp3EncoderProcess?.stdin?.writable) {
          this.mp3EncoderProcess.stdin.write(this.silenceFrame);
        }
        return;
      }

      // Case 2: Startup buffering on cold start
      if (!this.crossfadeState && this.activeChannel && this.activeChannel.audioBytesDecoded === 0) {
        const elapsedMs = Date.now() - this.pacerStartTime;
        const clockFrames = Math.floor(elapsedMs / 20);

        while (this.framesDelivered < clockFrames) {
          this.framesDelivered++;
          this.writePcmToBranches(this.silenceFrame);
        }
        return;
      }

      // Case 3: In crossfade state (buffering incoming or fading between channels)
      if (this.crossfadeState && this.incomingChannel) {
        if (this.crossfadeState.status === 'buffering') {
          // Fail-fast guard: if incoming channel decoder died before buffering enough frames
          if (
            this.incomingChannel.decoderClosed &&
            this.incomingChannel.queueBytes < PCM_FRAME_SIZE * MIN_HANDOVER_FRAMES
          ) {
            console.warn(`[BroadcastTee] Incoming channel died while buffering. Aborting crossfade.`);
            const failedUrl = this.incomingChannel.streamUrl;
            this.teardownChannel(this.incomingChannel);
            this.incomingChannel = null;
            this.crossfadeState = null;
            this.emit('incomingTrackError', new Error(`Incoming channel decoder closed prematurely for: ${failedUrl}`));
            return;
          }

          const minRequired = this.crossfadeState.isUserSkip ? 5 : MIN_HANDOVER_FRAMES;
          if (this.incomingChannel.queueBytes >= PCM_FRAME_SIZE * minRequired) {
            console.log(`[BroadcastTee] Incoming stream ready with ${this.incomingChannel.queueBytes} bytes buffered. Starting equal-power crossfade!`);
            this.crossfadeState.status = 'fading';
            this.crossfadeState.fadeFramesElapsed = 0;
            this.emit('trackCrossfadeStart');
          }
        }

        const elapsedMs = Date.now() - this.pacerStartTime;
        const clockFrames = Math.floor(elapsedMs / 20);
        const targetFrames = clockFrames + JITTER_CUSHION_FRAMES;

        while (this.framesDelivered < targetFrames) {
          if (this.crossfadeState.status === 'buffering') {
            // Keep current active channel playing continuously without dead silence!
            // When incoming stream has buffered enough frames, equal-power crossfade begins smoothly.
            let frame = this.activeChannel ? this.popFrameFromChannel(this.activeChannel) : null;
            if (!frame) frame = this.silenceFrame;
            this.framesDelivered++;
            this.writePcmToBranches(frame);
          } else if (this.crossfadeState.status === 'fading') {
            let frameB = this.incomingChannel ? this.popFrameFromChannel(this.incomingChannel) : null;
            let frameA = this.activeChannel ? this.popFrameFromChannel(this.activeChannel) : null;

            // If incoming channel momentarily has no frame buffered, keep playing current track smoothly without glitching
            if (!frameB) {
              if (!frameA) frameA = this.silenceFrame;
              this.framesDelivered++;
              this.writePcmToBranches(frameA);
              break;
            }

            if (!frameA) frameA = this.silenceFrame;

            const total = Math.max(1, this.crossfadeState.totalFadeFrames);
            const t = Math.min(1.0, this.crossfadeState.fadeFramesElapsed / total);
            const gainA = Math.cos((t * Math.PI) / 2);
            const gainB = Math.sin((t * Math.PI) / 2);
            const mixed = mixPcmFrames(frameA, frameB, gainA, gainB);

            this.framesDelivered++;
            this.writePcmToBranches(mixed);
            this.crossfadeState.fadeFramesElapsed++;

            if (this.crossfadeState.fadeFramesElapsed >= this.crossfadeState.totalFadeFrames) {
              console.log('[BroadcastTee] Crossfade complete. Swapping channels.');
              this.teardownChannel(this.activeChannel);
              this.activeChannel = this.incomingChannel;
              this.activeChannel.channelType = 'active';
              this.incomingChannel = null;
              this.crossfadeState = null;
              this.endingSoonEmitted = false;
              this.trailingSilenceFrames = 0;
              this.audioBytesDecoded = this.activeChannel.audioBytesDecoded;
              this.emit('trackTransitionComplete');
              break;
            }
          }
        }
        return;
      }

      // Case 4: Normal playback from activeChannel
      if (this.activeChannel) {
        const elapsedMs = Date.now() - this.pacerStartTime;
        const clockFrames = Math.floor(elapsedMs / 20);
        const targetFrames = clockFrames + JITTER_CUSHION_FRAMES;

        while (this.framesDelivered < targetFrames) {
          if (this.activeChannel.queueBytes >= PCM_FRAME_SIZE) {
            this.activeChannel.underrunStartTime = null;
            const frame = this.popFrameFromChannel(this.activeChannel);
            if (!frame) break;
            this.framesDelivered++;
            this.writePcmToBranches(frame);

            // Real-time RMS volume analysis for outro silence detection
            const int16 = new Int16Array(frame.buffer, frame.byteOffset, SAMPLES_PER_FRAME);
            let sumSq = 0;
            for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
              sumSq += int16[i] * int16[i];
            }
            const rms = Math.sqrt(sumSq / SAMPLES_PER_FRAME);
            const silenceDb = dynamicSettings.getNumber('audio_silence_threshold_db', config.SILENCE_THRESHOLD_DB);
            const silenceRmsThreshold = Math.round(32768 * Math.pow(10, silenceDb / 20));
            const isSilent = rms < silenceRmsThreshold;

            if (isSilent) {
              this.trailingSilenceFrames++;
            } else {
              this.trailingSilenceFrames = 0;
            }

            // Check if track is ending soon:
            // Condition A: Decoder closed and queue is down to 75 frames (1.5s remaining)
            const decoderFinishing =
              this.activeChannel.decoderClosed &&
              this.activeChannel.queueBytes <= PCM_FRAME_SIZE * 75;

            // Condition B: Trailing outro silence detected (played > 30s and continuous silence >= OUTRO_SILENCE_TRIGGER_SEC)
            const outroTriggerSec = dynamicSettings.getNumber('audio_outro_trigger_sec', config.OUTRO_SILENCE_TRIGGER_SEC);
            const requiredSilenceFrames = Math.round(outroTriggerSec / 0.02);
            const outroSilenceDetected =
              config.ENABLE_SILENCE_TRIMMING &&
              this.framesDelivered > 1500 &&
              this.trailingSilenceFrames >= requiredSilenceFrames &&
              (this.activeChannel.decoderClosed || this.activeChannel.queueBytes <= PCM_FRAME_SIZE * 300);

            if ((decoderFinishing || outroSilenceDetected) && !this.endingSoonEmitted) {
              console.log(
                `[BroadcastTee] Track ending detected (${outroSilenceDetected ? 'trailing outro silence: ' + (this.trailingSilenceFrames * 20) + 'ms' : 'decoder buffer draining'}). Triggering smooth transition...`
              );
              this.endingSoonEmitted = true;
              this.emit('trackEndingSoon');
            }
          } else if (this.activeChannel.decoderClosed && this.activeChannel.queueBytes === 0) {
            this.isPlaying = false;
            const totalDecoded = this.activeChannel.audioBytesDecoded;
            const lastErr = this.activeChannel.lastYtDlpError;
            this.teardownChannel(this.activeChannel);
            this.activeChannel = null;

            if (totalDecoded < 3840 * 100) {
              this.emit('trackError', new Error(lastErr || `Track finished with insufficient audio (${totalDecoded} bytes)`));
            } else {
              this.emit('trackFinished', 0);
            }
            break;
          } else {
            const now = Date.now();
            if (!this.activeChannel.underrunStartTime) {
              this.activeChannel.underrunStartTime = now;
            } else if (
              this.activeChannel.audioBytesDecoded > 0 &&
              now - this.activeChannel.underrunStartTime >= 5000
            ) {
              console.warn(
                `[BroadcastTee] ⚠️ Starvation watchdog triggered: channel ${this.activeChannel.id} stalled for 5s without decoder closing (${this.activeChannel.audioBytesDecoded} bytes decoded). Forcing teardown and advancing.`
              );
              this.isPlaying = false;
              this.teardownChannel(this.activeChannel);
              this.activeChannel = null;
              this.emit('trackFinished', 0);
              break;
            }

            // Buffer underrun: only write silence keep-alive if strictly behind real-time wall clock
            if (this.framesDelivered < clockFrames) {
              this.framesDelivered++;
              this.writePcmToBranches(this.silenceFrame);
            }
            break;
          }
        }
      }
    }, 10);
  }

  /**
   * Spawns the persistent MP3 encoder process (libmp3lame, 192k) feeding all connected HTTP clients.
   */
  private startMp3Encoder(): void {
    if (this.mp3EncoderProcess) return;

    const bitrateKbps = dynamicSettings.getNumber('audio_mp3_bitrate_kbps', 192);
    const mp3Args = [
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-i', 'pipe:0',
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', `${bitrateKbps}k`,
      '-f', 'mp3',
      '-fflags', '+nobuffer',
      '-flush_packets', '1',
      '-loglevel', 'error',
      'pipe:1',
    ];

    this.mp3EncoderProcess = spawn('ffmpeg', mp3Args);

    this.mp3EncoderProcess.stdout.on('data', (mp3Chunk: Buffer) => {
      for (const client of this.clients) {
        try {
          client.write(mp3Chunk);
        } catch {
          this.removeHttpClient(client);
        }
      }
    });

    this.mp3EncoderProcess.on('error', (err) => {
      console.error('[BroadcastTee] MP3 encoder error:', err.message);
    });

    this.mp3EncoderProcess.on('close', () => {
      this.mp3EncoderProcess = null;
    });
  }

  /**
   * Tears down the MP3 encoder when no HTTP clients are connected.
   */
  private stopMp3Encoder(): void {
    if (this.mp3EncoderProcess) {
      try {
        this.mp3EncoderProcess.kill('SIGTERM');
      } catch {}
      this.mp3EncoderProcess = null;
    }
  }

  /**
   * Complete cleanup for process termination.
   */
  public destroy(): void {
    this.stopDecoding(true);
    if (this.pacerInterval) {
      clearInterval(this.pacerInterval);
      this.pacerInterval = null;
    }
    this.stopMp3Encoder();
    for (const client of this.clients) {
      try {
        client.end();
      } catch {}
    }
    this.clients.clear();
  }
}

export default BroadcastTee;
