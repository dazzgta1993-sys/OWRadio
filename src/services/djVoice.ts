/**
 * @file services/djVoice.ts
 * @description Autonomous AI Radio DJ (British Host) Voice Announcement Engine.
 * Synthesizes natural British neural voiceovers announcing upcoming Deck 2 & Deck 3 tracks,
 * ducking background music gracefully during the intro ramp without interfering with track vocals.
 * Every single file strictly under 300 lines of code.
 */

import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { spawn } from 'node:child_process';
import { getRuntimeSetting, setRuntimeSetting } from '../db/store.js';

const BRITISH_VOICE = 'en-GB-RyanNeural';
let isVoiceEnabled = getRuntimeSetting('dj_voice_enabled', 'true') !== 'false';
let tracksSinceAnnouncement = 0;
let isSynthesizing = false;

const PHRASES = [
  (nextArt: string, nextTitle: string, d3Art: string) =>
    `You're locked into OWRadio Studio. Up next on Deck 2, we've got ${nextArt} with ${nextTitle}.${d3Art ? ` And keep it locked for ${d3Art} coming up on Deck 3.` : ''}`,
  (nextArt: string, nextTitle: string) =>
    `Keeping the music commercial-free on OWRadio. Coming up next on Deck 2, get ready for ${nextArt} — ${nextTitle}!`,
  (nextArt: string, nextTitle: string, d3Art: string) =>
    `OWRadio Studio Radio in the mix. Stand by on Deck 2 for ${nextArt} with ${nextTitle}.${d3Art ? ` Plus ${d3Art} lined up behind it.` : ''}`,
  (nextArt: string, nextTitle: string) =>
    `Broadcasting twenty-four seven in full studio audio. Up next on Deck 2: ${nextArt} — ${nextTitle}!`,
];

export function isDjVoiceEnabled(): boolean {
  return isVoiceEnabled;
}

export function setDjVoiceEnabled(enabled: boolean): boolean {
  isVoiceEnabled = enabled;
  setRuntimeSetting('dj_voice_enabled', enabled ? 'true' : 'false');
  console.log(`🎙️ [AI DJ] Voice announcements ${enabled ? 'ENABLED' : 'DISABLED'}`);
  return isVoiceEnabled;
}

export async function synthesizeSpeechToPcm(text: string): Promise<Buffer | null> {
  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(BRITISH_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);

    return await new Promise<Buffer | null>((resolve) => {
      const ff = spawn('ffmpeg', [
        '-loglevel', 'error',
        '-i', 'pipe:0',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1',
      ]);

      const chunks: Buffer[] = [];
      ff.stdout.on('data', (d: Buffer) => chunks.push(d));
      ff.on('close', (code) => {
        if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
        else resolve(null);
      });
      ff.on('error', () => resolve(null));
      audioStream.on('error', () => resolve(null));
      audioStream.pipe(ff.stdin);
    });
  } catch (err) {
    console.warn('⚠️ [AI DJ] Speech synthesis error:', (err as Error).message);
    return null;
  }
}

export async function announceNextTrackIfDue(player: any, force = false): Promise<void> {
  if (!isVoiceEnabled || isSynthesizing) return;
  tracksSinceAnnouncement++;

  // Announce every 3 songs or on force trigger
  if (!force && tracksSinceAnnouncement < 3) return;
  if (!player.deck2Track) return;

  const nextArt = String(player.deck2Track.artist || 'Unknown Artist').trim();
  const nextTitle = String(player.deck2Track.title || 'Upcoming Track').replace(/\s*\(.*?\)/g, '').trim();
  const d3Art = player.deck3Track ? String(player.deck3Track.artist || '').trim() : '';

  const phraseGen = PHRASES[Math.floor(Math.random() * PHRASES.length)];
  const script = phraseGen(nextArt, nextTitle, d3Art);

  isSynthesizing = true;
  try {
    const pcm = await synthesizeSpeechToPcm(script);
    if (pcm && player.isPlaying && !player.isPaused) {
      tracksSinceAnnouncement = 0;
      console.log(`🎙️ [AI DJ British Host] "${script}"`);
      player.broadcastTee.playVoicePcm(pcm);
    }
  } finally {
    isSynthesizing = false;
  }
}
