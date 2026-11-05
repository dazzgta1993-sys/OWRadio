/**
 * @file services/spotify.ts
 * @description Zero-key Spotify URL resolution service.
 * Parses public /embed/{type}/{id} __NEXT_DATA__ JSON for tracks, albums, and playlists,
 * with OpenGraph meta tags + official zero-key https://open.spotify.com/oembed fallback
 * and Deezer canonical studio duration enrichment.
 */

import { searchDeezerTracks } from './deezer.js';

const SPOTIFY_URL_REGEX =
  /(?:https?:\/\/)?(?:open\.)?spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist)\/([a-zA-Z0-9]+)/i;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface ResolvedSpotifyTrack {
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  cover: string;
}

export interface ResolvedSpotifyEntity {
  type: 'track' | 'album' | 'playlist';
  name: string;
  artist: string;
  cover: string;
  tracks: ResolvedSpotifyTrack[];
}

export function matchSpotifyUrl(url: string): { type: 'track' | 'album' | 'playlist'; id: string } | null {
  if (!url) return null;
  const m = SPOTIFY_URL_REGEX.exec(url.trim());
  if (!m) return null;
  return {
    type: m[1].toLowerCase() as 'track' | 'album' | 'playlist',
    id: m[2],
  };
}

function unescapeHtml(str: string): string {
  return (str || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function enrichSingleTrack(
  title: string,
  artist: string,
  cover = '',
  album = ''
): Promise<ResolvedSpotifyEntity> {
  let cleanTitle = (title || 'Unknown Title').trim();
  let cleanArtist = (artist || 'Unknown Artist').trim();
  let durSecs = 0;
  let bestCover = cover;
  let bestAlbum = album;

  try {
    const q = `${cleanArtist !== 'Unknown Artist' ? cleanArtist : ''} ${cleanTitle}`.trim();
    const dzHits = await searchDeezerTracks(q, 3);
    if (dzHits.length > 0) {
      const top = dzHits[0];
      if (!cleanArtist || cleanArtist === 'Unknown Artist') cleanArtist = top.artist;
      durSecs = top.duration || 0;
      bestAlbum = bestAlbum || top.album || '';
      bestCover = top.cover || bestCover;
    }
  } catch {}

  return {
    type: 'track',
    name: cleanTitle,
    artist: cleanArtist,
    cover: bestCover,
    tracks: [
      {
        title: cleanTitle,
        artist: cleanArtist,
        album: bestAlbum,
        durationSeconds: durSecs,
        cover: bestCover,
      },
    ],
  };
}

async function fallbackOembedAndMeta(
  type: 'track' | 'album' | 'playlist',
  id: string,
  embedHtml = ''
): Promise<ResolvedSpotifyEntity | null> {
  let title = '';
  let artist = '';
  let cover = '';

  if (embedHtml) {
    const tMatch = /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i.exec(embedHtml);
    const dMatch = /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i.exec(embedHtml);
    const iMatch = /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i.exec(embedHtml);
    if (tMatch) title = unescapeHtml(tMatch[1]).trim();
    if (iMatch) cover = iMatch[1].trim();
    if (dMatch) {
      const desc = unescapeHtml(dMatch[1]).trim();
      const parts = desc.split(/·|-/).map((p) => p.trim()).filter(Boolean);
      if (parts.length > 0) {
        artist = parts[0].replace(/^Song by\s+/i, '').trim();
      }
    }
  }

  if (!title) {
    try {
      const oembedUrl = `https://open.spotify.com/oembed?url=https://open.spotify.com/${type}/${id}`;
      const resp = await fetch(oembedUrl, {
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(7000),
      });
      if (resp.ok) {
        const odata: any = await resp.json();
        const rawTitle = String(odata?.title || '').trim();
        cover = String(odata?.thumbnail_url || cover);
        if (rawTitle.includes(' - ')) {
          const [p1, p2] = rawTitle.split(' - ', 2);
          title = p1.trim();
          artist = p2.trim();
        } else {
          title = rawTitle;
        }
      }
    } catch {}
  }

  if (title && type === 'track') {
    return enrichSingleTrack(title, artist, cover);
  }
  return null;
}

export async function resolveSpotifyUrl(url: string): Promise<ResolvedSpotifyEntity | null> {
  const matched = matchSpotifyUrl(url);
  if (!matched) return null;
  const { type, id } = matched;

  let html = '';
  try {
    const resp = await fetch(`https://open.spotify.com/embed/${type}/${id}`, {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(9000),
    });
    if (resp.ok) {
      html = await resp.text();
    }
  } catch {
    return fallbackOembedAndMeta(type, id);
  }

  const nextMatch = /<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s.exec(html);
  if (!nextMatch) {
    return fallbackOembedAndMeta(type, id, html);
  }

  try {
    const data = JSON.parse(nextMatch[1]);
    const entity = data?.props?.pageProps?.state?.data?.entity;
    if (!entity) return fallbackOembedAndMeta(type, id, html);

    const images = entity?.visualIdentity?.image || [];
    const cover = Array.isArray(images) && images.length > 0 ? String(images[0]?.url || '') : '';

    if (type === 'track') {
      const artistsList = Array.isArray(entity.artists) ? entity.artists : [];
      const artistName =
        artistsList.map((a: any) => a?.name).filter(Boolean).join(', ') || 'Unknown Artist';
      const durSecs = entity.duration ? Math.round(Number(entity.duration) / 1000) : 0;
      const title = String(entity.name || entity.title || 'Unknown Title');
      const albumName = String(entity?.album?.name || '');

      if (durSecs <= 0) {
        return enrichSingleTrack(title, artistName, cover, albumName);
      }

      return {
        type: 'track',
        name: title,
        artist: artistName,
        cover,
        tracks: [
          {
            title,
            artist: artistName,
            album: albumName,
            durationSeconds: durSecs,
            cover,
          },
        ],
      };
    }

    const name = String(entity.name || entity.title || 'Spotify Collection');
    const rawTracks = Array.isArray(entity.trackList) ? entity.trackList : [];
    const tracks: ResolvedSpotifyTrack[] = rawTracks.map((t: any) => ({
      title: String(t?.title || 'Unknown'),
      artist: String(t?.subtitle || 'Unknown Artist'),
      album: type === 'album' ? name : '',
      durationSeconds: t?.duration ? Math.round(Number(t.duration) / 1000) : 0,
      cover,
    }));

    return {
      type,
      name,
      artist: String(entity.subtitle || 'Various Artists'),
      cover,
      tracks,
    };
  } catch {
    return fallbackOembedAndMeta(type, id, html);
  }
}
