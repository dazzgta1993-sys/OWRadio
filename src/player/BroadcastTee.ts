/**
 * @file player/BroadcastTee.ts
 * @description Clean Dual-Branch FFmpeg PCM Audio Pipeline.
 * Decodes live studio audio streams into 48kHz 16-bit stereo PCM (s16le) and tees it simultaneously to:
 * 1. Discord Voice Channel (via @discordjs/voice Raw PCM StreamType).
 * 2. Continuous 192kbps MP3 Web Radio Broadcast (/stream.mp3) so browser listeners stay in sync.
 * Zero FM radio chimes, zero synthetic tones, zero pitch distortion.
 */

import { spawn, ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';

export class BroadcastTee {
  private mp3Encoder: ChildProcessWithoutNullStreams | null = null;
  private trackDecoder: ChildProcess | null = null;
  private silenceInterval: NodeJS.Timeout | null = null;
  private mp3Clients = new Set<PassThrough>();
  private mp3RingBuffer: Buffer[] = [];
  private mp3RingBufferSize = 0;
  private readonly MAX_BURST_BYTES = 65536;
  private activeDiscordStream: PassThrough | null = null;
  private currentVolume = 1.0;
  private currentRmsDb = -100;
  private isPaused = false;

  constructor() {
    this.startContinuousMp3Encoder();
    this.startSilenceHeartbeat();
  }

  private startContinuousMp3Encoder(): void {
    try {
      this.mp3Encoder = spawn(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          's16le',
          '-ar',
          '48000',
          '-ac',
          '2',
          '-i',
          'pipe:0',
          '-codec:a',
          'libmp3lame',
          '-b:a',
          '192k',
          '-f',
          'mp3',
          'pipe:1',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );

      this.mp3Encoder.stdin.on('error', () => {});
      this.mp3Encoder.stdout.on('data', (chunk: Buffer) => {
        this.mp3RingBuffer.push(chunk);
        this.mp3RingBufferSize += chunk.length;
        while (this.mp3RingBufferSize > this.MAX_BURST_BYTES && this.mp3RingBuffer.length > 1) {
          const dropped = this.mp3RingBuffer.shift();
          if (dropped) this.mp3RingBufferSize -= dropped.length;
        }
        for (const client of this.mp3Clients) {
          if (!client.destroyed) {
            if (client.writableLength > 524288) {
              client.destroy();
              this.mp3Clients.delete(client);
            } else {
              client.write(chunk);
            }
          } else {
            this.mp3Clients.delete(client);
          }
        }
      });

      this.mp3Encoder.on('exit', () => {
        setTimeout(() => this.startContinuousMp3Encoder(), 1000);
      });
    } catch (err) {
      console.error('❌ [BroadcastTee] Failed to start MP3 encoder:', err);
    }
  }

  private startSilenceHeartbeat(): void {
    const silentFrame = Buffer.alloc(3840, 0);
    this.silenceInterval = setInterval(() => {
      if (!this.trackDecoder || this.isPaused) {
        this.currentRmsDb = -100;
        if (this.mp3Encoder && !this.mp3Encoder.stdin.destroyed) {
          try {
            this.mp3Encoder.stdin.write(silentFrame);
          } catch {}
        }
      }
    }, 20);
  }

  public startTrackStream(
    streamUrl: string,
    headers: Record<string, string> = {}
  ): PassThrough {
    this.stopTrackStream();
    this.isPaused = false;

    const discordPass = new PassThrough({ highWaterMark: 192000 });
    discordPass.on('error', () => {});
    this.activeDiscordStream = discordPass;

    const headerLines = Object.entries(headers)
      .filter(([k]) => ['user-agent', 'accept', 'accept-language', 'cookie', 'referer'].includes(k.toLowerCase()))
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('');

    const beforeArgs: string[] = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-re',
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_on_network_error',
      '1',
      '-reconnect_delay_max',
      '5',
      '-probesize',
      '131072',
      '-analyzeduration',
      '200000',
      '-nostdin',
    ];

    if (headerLines) beforeArgs.push('-headers', headerLines);

    const args = [
      ...beforeArgs,
      '-i',
      streamUrl,
      '-vn',
      '-af',
      'afade=t=in:ss=0:d=0.03',
      '-f',
      's16le',
      '-ar',
      '48000',
      '-ac',
      '2',
      'pipe:1',
    ];

    const decoder = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.trackDecoder = decoder;

    decoder.stderr?.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      if (/reconnect|drop|stalled|corrupt/i.test(msg)) {
        console.warn(`⚠️ [Audio Pipeline] Remote stream notice: ${msg.split('\n')[0]}`);
      }
    });

    decoder.stdout?.on('data', (chunk: Buffer) => {
      const scaled = this.applyVolumeAndMeter(chunk);
      if (this.mp3Encoder && !this.mp3Encoder.stdin.destroyed) {
        try {
          this.mp3Encoder.stdin.write(scaled);
        } catch {}
      }
      if (!discordPass.destroyed && !discordPass.writableEnded) {
        try {
          discordPass.write(scaled);
        } catch {}
      }
    });

    decoder.on('close', () => {
      if (this.trackDecoder === decoder) {
        this.trackDecoder = null;
        this.currentRmsDb = -100;
        if (!discordPass.destroyed) discordPass.end();
      }
    });

    return discordPass;
  }

  private applyVolumeAndMeter(buf: Buffer): Buffer {
    const vol = this.currentVolume;
    let sumSq = 0;
    const sampleCount = Math.floor(buf.length / 2);
    if (sampleCount === 0) return buf;

    const out = vol === 1.0 ? buf : Buffer.allocUnsafe(buf.length);
    for (let i = 0; i < sampleCount * 2; i += 2) {
      let s = buf.readInt16LE(i);
      if (vol !== 1.0) {
        s = Math.max(-32768, Math.min(32767, Math.round(s * vol)));
        out.writeInt16LE(s, i);
      }
      const norm = s / 32768;
      sumSq += norm * norm;
    }

    const rms = Math.sqrt(sumSq / sampleCount);
    this.currentRmsDb = rms > 0.00001 ? Math.round(20 * Math.log10(rms) * 10) / 10 : -100;
    return out;
  }

  public stopTrackStream(): void {
    if (this.trackDecoder) {
      const proc = this.trackDecoder;
      this.trackDecoder = null;
      try {
        proc.kill('SIGKILL');
      } catch {}
    }
    if (this.activeDiscordStream && !this.activeDiscordStream.destroyed) {
      this.activeDiscordStream.end();
    }
    this.activeDiscordStream = null;
    this.currentRmsDb = -100;
  }

  public setPaused(paused: boolean): void {
    this.isPaused = paused;
    if (paused) this.trackDecoder?.stdout?.pause();
    else this.trackDecoder?.stdout?.resume();
  }

  public setVolume(volumePercent: number): void {
    const clamped = Math.max(0, Math.min(200, Number(volumePercent) || 0));
    this.currentVolume = clamped / 100;
  }

  public getVolumePercent(): number {
    return Math.round(this.currentVolume * 100);
  }

  public getRmsDb(): number {
    return this.currentRmsDb;
  }

  public addMp3Client(): PassThrough {
    const client = new PassThrough({ highWaterMark: 131072 });
    for (const chunk of this.mp3RingBuffer) {
      if (!client.destroyed) client.write(chunk);
    }
    this.mp3Clients.add(client);
    client.on('close', () => this.mp3Clients.delete(client));
    client.on('error', () => this.mp3Clients.delete(client));
    return client;
  }

  public getListenerCount(): number {
    return this.mp3Clients.size;
  }
}

export default BroadcastTee;
