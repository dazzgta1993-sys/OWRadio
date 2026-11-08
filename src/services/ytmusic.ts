/**
 * @file services/ytmusic.ts
 * @description Direct YouTube Music WEB_REMIX InnerTube client.
 * Filters out 99% of YouTube junk by querying official studio audio masters
 * (MUSIC_VIDEO_TYPE_ATV and "{Artist} - Topic" channels) and algorithmic radio mixes.
 */

import { getApiCache, setApiCache } from '../db/store.js';

export interface YtMusicCandidate {
  id: string;
  title: string;
  channel: string;
  artists: string[];
  album: string;
  durationSeconds: number;
  durationText: string;
  thumbnail: string;
  videoType: string;
  isOfficialStudio: boolean;
}

const YTM_SEARCH_URL = 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false';
const YTM_NEXT_URL = 'https://music.youtube.com/youtubei/v1/next?prettyPrint=false';
let ytmCooldownUntil = 0;

const YTM_CONTEXT = {
  context: {
    client: {
      clientName: 'WEB_REMIX',
      clientVersion: '1.20240717.01.00',
      hl: 'en',
      gl: 'US',
    },
  },
};

const YTM_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Origin: 'https://music.youtube.com',
  Referer: 'https://music.youtube.com/',
};

function parseDurationSeconds(durStr: string): number {
  if (!durStr) return 0;
  const parts = durStr.trim().split(':').map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function parseResponsiveListItem(m: any): YtMusicCandidate | null {
  try {
    let vid = m?.playlistItemData?.videoId || '';
    let videoType = '';

    const navEp =
      m?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint;
    if (navEp?.watchEndpoint) {
      if (!vid) vid = navEp.watchEndpoint.videoId || '';
      videoType =
        navEp.watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType || '';
    }
    if (!vid) return null;

    const flexCols = m?.flexColumns || [];
    let title = '';
    if (flexCols.length > 0) {
      const runs = flexCols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
      if (runs.length > 0) title = String(runs[0].text || '').trim();
    }
    if (!title) return null;

    const artists: string[] = [];
    let album = '';
    let durText = '';
    let durSecs = 0;

    if (flexCols.length > 1) {
      const runs = flexCols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
      for (const r of runs) {
        const txt = String(r?.text || '').trim();
        if (!txt || ['•', ',', '&', 'Song', 'Video', 'Explicit', 'E'].includes(txt)) continue;
        if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(txt)) {
          durText = txt;
          durSecs = parseDurationSeconds(txt);
          continue;
        }
        const pageType =
          r?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
            ?.browseEndpointContextMusicConfig?.pageType || '';
        if (pageType.includes('ALBUM')) {
          album = txt;
        } else if (pageType.includes('ARTIST') || pageType.includes('USER_CHANNEL')) {
          artists.push(txt);
        } else if (artists.length === 0) {
          artists.push(txt);
        }
      }
    }

    const thumbs =
      m?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
    let thumbUrl = thumbs.length > 0 ? String(thumbs[thumbs.length - 1]?.url || '') : '';
    if (thumbUrl && thumbUrl.includes('=w') && thumbUrl.includes('-h')) {
      thumbUrl = thumbUrl.replace(/=w\d+-h\d+[^&"']*/, '=w544-h544-l90-rj');
    }
    if (!thumbUrl) {
      thumbUrl = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
    }

    const channel = artists[0] || '';
    const isOfficialStudio =
      videoType === 'MUSIC_VIDEO_TYPE_ATV' || channel.toLowerCase().includes('topic');

    return {
      id: vid,
      title,
      channel,
      artists,
      album,
      durationSeconds: durSecs,
      durationText: durText,
      thumbnail: thumbUrl,
      videoType,
      isOfficialStudio,
    };
  } catch {
    return null;
  }
}

/**
 * Searches YouTube Music's WEB_REMIX InnerTube endpoint for studio songs or videos.
 * When `filterSongs = true`, passes `EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D` to strictly return
 * official YouTube Music Songs (excluding random user videos).
 */
export async function searchYtMusicSongs(
  query: string,
  filterSongs = true,
  limit = 15
): Promise<YtMusicCandidate[]> {
  const q = (query || '').trim();
  if (!q) return [];

  const cacheKey = `ytm_search:${filterSongs ? 'songs' : 'all'}:${q.toLowerCase()}`;
  const cached = getApiCache<YtMusicCandidate[]>(cacheKey);
  if (cached && cached.length > 0) return cached.slice(0, limit);

  if (Date.now() < ytmCooldownUntil) return [];

  const payload: Record<string, any> = {
    ...YTM_CONTEXT,
    query: q,
  };
  if (filterSongs) {
    payload.params = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';
  }

  try {
    const resp = await fetch(YTM_SEARCH_URL, {
      method: 'POST',
      headers: YTM_HEADERS,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (resp.status === 429) { ytmCooldownUntil = Date.now() + 10000; return []; }
    if (!resp.ok) return [];
    const data: any = await resp.json();

    const tabs = data?.contents?.tabbedSearchResultsRenderer?.tabs || [];
    const results: YtMusicCandidate[] = [];

    for (const tab of tabs) {
      const sections = tab?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      for (const sec of sections) {
        const items = sec?.musicShelfRenderer?.contents || [];
        for (const item of items) {
          const m = item?.musicResponsiveListItemRenderer;
          if (!m) continue;
          const parsed = parseResponsiveListItem(m);
          if (parsed) results.push(parsed);
        }
      }
    }

    if (results.length > 0) {
      setApiCache(cacheKey, results, 3600, 'ytmusic');
    }
    return results.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Fetches YouTube Music's live algorithmic Up-Next / Radio queue for a seed videoId or query.
 */
export async function getYtMusicRelatedTracks(
  videoId = '',
  query = '',
  limit = 20
): Promise<YtMusicCandidate[]> {
  let seedVid = (videoId || '').replace(/^yt_/, '').trim();
  if (!seedVid && query) {
    const hits = await searchYtMusicSongs(query, true, 3);
    if (hits.length > 0) seedVid = hits[0].id;
  }
  if (!seedVid) return [];

  const cacheKey = `ytm_radio:${seedVid}`;
  const cached = getApiCache<YtMusicCandidate[]>(cacheKey);
  if (cached && cached.length > 0) return cached.slice(0, limit);
  if (Date.now() < ytmCooldownUntil) return [];

  try {
    const payload = {
      ...YTM_CONTEXT,
      videoId: seedVid,
      playlistId: `RDAMVM${seedVid}`,
      isAudioOnly: true,
    };
    const resp = await fetch(YTM_NEXT_URL, {
      method: 'POST',
      headers: YTM_HEADERS,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];
    const data: any = await resp.json();

    const contents =
      data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
        ?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content
        ?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents || [];

    const tracks: YtMusicCandidate[] = [];
    for (const item of contents.slice(1)) {
      const r = item?.playlistPanelVideoRenderer;
      if (!r?.videoId) continue;
      const vid = String(r.videoId);
      const title = String(r?.title?.runs?.[0]?.text || '').trim();
      const bylineRuns = r?.longBylineText?.runs || r?.shortBylineText?.runs || [];
      const artists: string[] = [];
      let album = '';
      for (const br of bylineRuns) {
        const txt = String(br?.text || '').trim();
        if (!txt || ['•', ',', '&'].includes(txt)) continue;
        const pType =
          br?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
            ?.browseEndpointContextMusicConfig?.pageType || '';
        if (pType.includes('ALBUM')) album = txt;
        else if (artists.length === 0 || pType.includes('ARTIST')) artists.push(txt);
      }
      const durText = String(r?.lengthText?.runs?.[0]?.text || '');
      const durSecs = parseDurationSeconds(durText);
      const thumbs = r?.thumbnail?.thumbnails || [];
      const thumb =
        thumbs.length > 0
          ? String(thumbs[thumbs.length - 1]?.url || '')
          : `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;

      if (title && artists.length > 0) {
        tracks.push({
          id: vid,
          title,
          channel: artists[0],
          artists,
          album,
          durationSeconds: durSecs,
          durationText: durText,
          thumbnail: thumb,
          videoType: 'MUSIC_VIDEO_TYPE_ATV',
          isOfficialStudio: true,
        });
      }
    }

    if (tracks.length > 0) {
      setApiCache(cacheKey, tracks, 1800, 'ytmusic_radio');
    }
    return tracks.slice(0, limit);
  } catch {
    return [];
  }
}
