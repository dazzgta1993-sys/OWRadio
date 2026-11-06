/**
 * @file player/AudioTrack.ts
 * @description Clean, 100% real studio AudioTrack data model.
 * Zero fake BPM hashes or fabricated Camelot keys.
 */

export type TrackSource =
  | 'ytmusic'
  | 'youtube'
  | 'deezer'
  | 'apple'
  | 'spotify'
  | 'musicbrainz'
  | 'soundcloud'
  | 'autoplay';

export interface AudioTrackInit {
  id?: string;
  videoId?: string;
  deezerId?: string;
  title: string;
  artist: string;
  artistId?: string;
  album?: string;
  duration?: number;
  artworkUrl?: string;
  isrc?: string;
  upc?: string;
  releaseYear?: string;
  genre?: string;
  explicit?: boolean;
  source?: TrackSource;
  isAutoplay?: boolean;
  requestedBy?: string;
  vibeReason?: string;
  streamUrl?: string;
  streamHeaders?: Record<string, string>;
}

export class AudioTrack {
  public id: string;
  public videoId: string;
  public deezerId?: string;
  public title: string;
  public artist: string;
  public artistId?: string;
  public album: string;
  public duration: number;
  public artworkUrl: string;
  public isrc: string;
  public upc: string;
  public releaseYear: string;
  public genre: string;
  public explicit: boolean;
  public source: TrackSource;
  public isAutoplay: boolean;
  public requestedBy: string;
  public vibeReason?: string;
  public streamUrl?: string;
  public streamHeaders?: Record<string, string>;
  public streamExpiresAt?: number;

  constructor(init: AudioTrackInit) {
    const rawVid = (init.videoId || (init.id?.startsWith('yt_') ? init.id : '')).replace(/^yt_/, '').trim();
    this.videoId = rawVid && !/^(dz_|trk_|chart_|mb_)/i.test(rawVid) ? rawVid : '';
    this.deezerId = init.deezerId || (init.id?.startsWith('dz_') ? init.id.replace(/^dz_/, '') : undefined);
    this.id = init.id || (this.videoId ? `yt_${this.videoId}` : `trk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    this.title = (init.title || 'Unknown Title').trim();
    this.artist = (init.artist || 'Unknown Artist').trim();
    this.artistId = init.artistId;
    this.album = (init.album || '').trim();
    this.duration = Math.max(0, Math.floor(Number(init.duration) || 0));
    this.artworkUrl =
      init.artworkUrl ||
      (this.videoId ? `https://i.ytimg.com/vi/${this.videoId}/hqdefault.jpg` : '');
    this.isrc = (init.isrc || '').trim().toUpperCase();
    this.upc = (init.upc || '').trim();
    this.releaseYear = (init.releaseYear || '').trim().slice(0, 4);
    this.genre = (init.genre || '').trim();
    this.explicit = Boolean(init.explicit);
    this.source = init.source || 'ytmusic';
    this.isAutoplay = Boolean(init.isAutoplay);
    this.requestedBy = init.requestedBy || (this.isAutoplay ? 'Autoplay DJ' : 'Listener');
    this.vibeReason = init.vibeReason;
    this.streamUrl = init.streamUrl;
    this.streamHeaders = init.streamHeaders;
  }

  public get formattedDuration(): string {
    if (!this.duration || this.duration <= 0) return '0:00';
    const mins = Math.floor(this.duration / 60);
    const secs = Math.floor(this.duration % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  public hasFreshStreamUrl(): boolean {
    if (!this.streamUrl) return false;
    if (this.streamExpiresAt && Date.now() > this.streamExpiresAt) return false;
    return true;
  }

  public toJSON() {
    return {
      id: this.id,
      videoId: this.videoId,
      deezerId: this.deezerId,
      title: this.title,
      artist: this.artist,
      artistId: this.artistId,
      album: this.album,
      duration: this.duration,
      durationFormatted: this.formattedDuration,
      artworkUrl: this.artworkUrl,
      isrc: this.isrc,
      upc: this.upc,
      releaseYear: this.releaseYear,
      genre: this.genre,
      explicit: this.explicit,
      source: this.source,
      isAutoplay: this.isAutoplay,
      requestedBy: this.requestedBy,
      vibeReason: this.vibeReason,
      isPrewarmed: this.hasFreshStreamUrl(),
    };
  }
}

export default AudioTrack;
