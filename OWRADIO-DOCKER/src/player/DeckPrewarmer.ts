/**
 * @file player/DeckPrewarmer.ts
 * @description Background Triple-Deck Pre-Warmer & Studio Artwork Enricher.
 * Ensures Deck 1 (Now Playing), Deck 2 (Next Up), and Deck 3 (In The Chute) have
 * 6-pass verified studio videoIds, direct yt-dlp audio URLs, and 1400px studio covers ready.
 */

import AudioTrack from './AudioTrack.js';
import { resolveTrackStream, extractStreamInfo } from '../services/youtube.js';
import { searchDeezerTracks } from '../services/deezer.js';
import { lookupAlbumByUpc } from '../services/itunes.js';
import { extractPrimaryArtist } from '../utils/artistNormalizer.js';
import { fetchNextVibeTrack, VibeStateContext } from '../services/vibeEngine.js';

/**
 * Resolves a track's canonical studio videoId via the 6-pass resolver and extracts
 * its direct audio stream URL via yt-dlp so transitions have zero buffering delay.
 */
export async function ensureTrackStreamReady(
  track: AudioTrack,
  onMetadataUpdated?: () => void
): Promise<boolean> {
  try {
    if (!track.videoId) {
      const res = await resolveTrackStream({
        artist: track.artist,
        title: track.title,
        album: track.album,
        duration: track.duration,
        trackId: track.deezerId,
        isrc: track.isrc,
      });
      if (res?.id) {
        track.videoId = res.id;
        if ((!track.duration || track.duration <= 0) && res.duration > 0) {
          track.duration = res.duration;
        }
        if (!track.album && res.album) track.album = res.album;
      }
    }
    if (!track.videoId) return false;

    if (!track.hasFreshStreamUrl()) {
      const streamInfo = await extractStreamInfo(track.videoId);
      if (!streamInfo?.url) return false;
      track.streamUrl = streamInfo.url;
      track.streamHeaders = streamInfo.headers;
      track.streamExpiresAt = Date.now() + 2.5 * 3600 * 1000;
      if ((!track.duration || track.duration <= 0) && streamInfo.duration) {
        track.duration = streamInfo.duration;
      }
    }
    void enrichStudioArtwork(track, onMetadataUpdated);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pre-warms Deck 2 (Next Up) and Deck 3 (In The Chute) for a GuildPlayer instance.
 */
export async function prewarmPlayerDecks(player: {
  currentTrack: AudioTrack | null;
  queue: AudioTrack[];
  autoplay: boolean;
  deck2Track: AudioTrack | null;
  deck3Track: AudioTrack | null;
  getVibeContext: () => VibeStateContext;
  emitStateUpdate: () => void;
}): Promise<void> {
  if (!player.currentTrack) return;

  let t2: AudioTrack | null = player.queue[0] || null;
  if (!t2 && player.autoplay) {
    if (!player.deck2Track) {
      player.deck2Track = await fetchNextVibeTrack(player.getVibeContext(), player.currentTrack);
    }
    t2 = player.deck2Track;
  }
  if (t2) await ensureTrackStreamReady(t2, () => player.emitStateUpdate());

  let t3: AudioTrack | null = player.queue[1] || null;
  if (!t3 && player.autoplay && t2) {
    if (!player.deck3Track) {
      player.deck3Track = await fetchNextVibeTrack(player.getVibeContext(), t2);
    }
    t3 = player.deck3Track;
  }
  if (t3) await ensureTrackStreamReady(t3, () => player.emitStateUpdate());
  player.emitStateUpdate();
}

export async function enrichStudioArtwork(
  track: AudioTrack,
  onMetadataUpdated?: () => void
): Promise<void> {
  try {
    if (track.upc) {
      const upcArt = await lookupAlbumByUpc(track.upc);
      if (upcArt?.artworkUrl) {
        track.artworkUrl = upcArt.artworkUrl;
        if (!track.releaseYear && upcArt.year) track.releaseYear = upcArt.year;
        if (onMetadataUpdated) onMetadataUpdated();
        return;
      }
    }
    if (!track.artworkUrl || track.artworkUrl.includes('ytimg.com')) {
      const dzHits = await searchDeezerTracks(
        `${extractPrimaryArtist(track.artist)} ${track.title}`,
        2
      );
      if (dzHits.length > 0 && dzHits[0].cover) {
        track.artworkUrl = dzHits[0].cover;
        if (!track.album && dzHits[0].album) track.album = dzHits[0].album;
        if ((!track.duration || track.duration <= 0) && dzHits[0].duration > 0) {
          track.duration = dzHits[0].duration;
        }
        if (onMetadataUpdated) onMetadataUpdated();
      }
    }
  } catch {}
}
