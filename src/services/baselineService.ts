/**
 * @file baselineService.ts
 * @description Manages VEXO's foundational "Station DNA" / Baseline Taste Profile.
 * Provides a low-weight seed scaffold (artists & genres) used when room preferences are empty or sparse.
 * Over time, user interactions (/play requests, likes, dislikes) naturally steer and overwrite this baseline.
 */

import dynamicSettings from './dynamicSettings.js';

export interface BaselineConfig {
  artists: string[];
  genres: string[];
  weight: number;
}

export const DEFAULT_BASELINE_ARTISTS = [
  'Queen',
  'Fleetwood Mac',
  'ABBA',
  'Michael Jackson',
  'Toto',
  'Phil Collins',
  'Elton John',
  'David Bowie',
];

export const DEFAULT_BASELINE_GENRES = [
  'classic rock',
  'pop rock',
  '80s pop',
  'disco',
  'synthpop',
];

export const DEFAULT_BASELINE_WEIGHT = 0.5;

export class BaselineService {
  /**
   * Retrieves current baseline configuration.
   */
  public getBaseline(): BaselineConfig {
    const rawArtists = dynamicSettings.getString('curation_baseline_artists', DEFAULT_BASELINE_ARTISTS.join(', '));
    const rawGenres = dynamicSettings.getString('curation_baseline_genres', DEFAULT_BASELINE_GENRES.join(', '));
    const weight = dynamicSettings.getNumber('curation_baseline_weight', DEFAULT_BASELINE_WEIGHT);

    const artists = rawArtists
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);

    const genres = rawGenres
      .split(',')
      .map((g) => g.trim().toLowerCase())
      .filter(Boolean);

    return {
      artists: artists.length > 0 ? artists : [...DEFAULT_BASELINE_ARTISTS],
      genres: genres.length > 0 ? genres : [...DEFAULT_BASELINE_GENRES],
      weight,
    };
  }

  /**
   * Updates full baseline configuration.
   */
  public setBaseline(artists: string[], genres: string[], weight?: number): BaselineConfig {
    const cleanArtists = Array.from(new Set(artists.map((a) => a.trim()).filter(Boolean)));
    const cleanGenres = Array.from(new Set(genres.map((g) => g.trim().toLowerCase()).filter(Boolean)));

    dynamicSettings.set('curation_baseline_artists', cleanArtists.join(', '));
    dynamicSettings.set('curation_baseline_genres', cleanGenres.join(', '));
    if (typeof weight === 'number' && !isNaN(weight)) {
      dynamicSettings.set('curation_baseline_weight', Math.max(0.1, Math.min(2.0, weight)));
    }

    return this.getBaseline();
  }

  /**
   * Add a single artist to baseline.
   */
  public addArtist(artistName: string): BaselineConfig {
    const trimmed = artistName.trim();
    if (!trimmed) return this.getBaseline();
    const current = this.getBaseline();
    if (!current.artists.some((a) => a.toLowerCase() === trimmed.toLowerCase())) {
      current.artists.push(trimmed);
      this.setBaseline(current.artists, current.genres);
    }
    return this.getBaseline();
  }

  /**
   * Remove an artist from baseline.
   */
  public removeArtist(artistName: string): BaselineConfig {
    const trimmed = artistName.trim().toLowerCase();
    const current = this.getBaseline();
    const updated = current.artists.filter((a) => a.toLowerCase() !== trimmed);
    return this.setBaseline(updated, current.genres);
  }

  /**
   * Add a single genre to baseline.
   */
  public addGenre(genre: string): BaselineConfig {
    const trimmed = genre.trim().toLowerCase();
    if (!trimmed) return this.getBaseline();
    const current = this.getBaseline();
    if (!current.genres.includes(trimmed)) {
      current.genres.push(trimmed);
      this.setBaseline(current.artists, current.genres);
    }
    return this.getBaseline();
  }

  /**
   * Remove a genre from baseline.
   */
  public removeGenre(genre: string): BaselineConfig {
    const trimmed = genre.trim().toLowerCase();
    const current = this.getBaseline();
    const updated = current.genres.filter((g) => g.toLowerCase() !== trimmed);
    return this.setBaseline(current.artists, updated);
  }

  /**
   * Check if a given artist is in baseline.
   */
  public isBaselineArtist(artistName: string): boolean {
    const trimmed = artistName.trim().toLowerCase();
    return this.getBaseline().artists.some((a) => a.toLowerCase() === trimmed);
  }
}

export const baselineService = new BaselineService();
export default baselineService;
