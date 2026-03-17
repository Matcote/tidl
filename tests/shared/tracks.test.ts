import { describe, it, expect } from 'vitest';
import { formatDuration, extractTracks } from '../../src/shared/tracks';
import type { SearchResponse, TidalJsonApiResource } from '../../src/shared/types';

// ─── formatDuration ───────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('returns empty string for undefined', () => {
    expect(formatDuration(undefined)).toBe('');
  });

  it('handles seconds only', () => {
    expect(formatDuration('PT45S')).toBe('0:45');
  });

  it('handles minutes and seconds', () => {
    expect(formatDuration('PT3M45S')).toBe('3:45');
  });

  it('handles minutes with no seconds', () => {
    expect(formatDuration('PT4M')).toBe('4:00');
  });

  it('pads single-digit seconds', () => {
    expect(formatDuration('PT1M9S')).toBe('1:09');
  });

  it('rolls hours into minutes', () => {
    expect(formatDuration('PT1H2M3S')).toBe('62:03');
  });

  it('returns empty string for non-duration string', () => {
    expect(formatDuration('not-a-duration')).toBe('');
  });
});

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeTrack(id: string, overrides: Partial<TidalJsonApiResource> = {}): TidalJsonApiResource {
  return {
    id,
    type: 'tracks',
    attributes: { title: `Track ${id}`, duration: 'PT3M0S' },
    relationships: {},
    ...overrides,
  };
}

function makeArtist(id: string, name: string): TidalJsonApiResource {
  return { id, type: 'artists', attributes: { name } };
}

function makeAlbum(id: string, coverArtId?: string): TidalJsonApiResource {
  return {
    id,
    type: 'albums',
    attributes: {},
    relationships: coverArtId
      ? { coverArt: { data: [{ id: coverArtId, type: 'artworks' }] } }
      : {},
  };
}

function makeArtwork(id: string, files: Array<{ href: string; meta?: { width?: number } }>): TidalJsonApiResource {
  return { id, type: 'artworks', attributes: { files } };
}

function makeSearchResponse(
  trackIds: string[],
  included: TidalJsonApiResource[],
): SearchResponse {
  return {
    data: [
      {
        id: 'sr1',
        type: 'searchResults',
        relationships: {
          tracks: { data: trackIds.map(id => ({ id, type: 'tracks' })) },
        },
      },
    ],
    included,
  };
}

// ─── extractTracks ────────────────────────────────────────────────────────────

describe('extractTracks', () => {
  it('returns empty array for empty data', () => {
    expect(extractTracks({ data: [], included: [] })).toEqual([]);
  });

  it('returns empty array when data is undefined', () => {
    expect(extractTracks({})).toEqual([]);
  });

  it('follows relationship ID order', () => {
    const t1 = makeTrack('1');
    const t2 = makeTrack('2');
    const response = makeSearchResponse(['2', '1'], [t1, t2]);
    const tracks = extractTracks(response);
    expect(tracks.map(t => t.id)).toEqual(['2', '1']);
  });

  it('skips track IDs not in included', () => {
    const t1 = makeTrack('1');
    const response = makeSearchResponse(['1', 'missing'], [t1]);
    const tracks = extractTracks(response);
    expect(tracks.map(t => t.id)).toEqual(['1']);
  });

  it('falls back to "Unknown Track" when title absent', () => {
    const t = makeTrack('1');
    delete t.attributes!['title'];
    const response = makeSearchResponse(['1'], [t]);
    const tracks = extractTracks(response);
    expect(tracks[0]!.title).toBe('Unknown Track');
  });

  it('resolves artist names from included', () => {
    const artist = makeArtist('a1', 'Some Artist');
    const track = makeTrack('t1', {
      relationships: { artists: { data: [{ id: 'a1', type: 'artists' }] } },
    });
    const response = makeSearchResponse(['t1'], [track, artist]);
    const tracks = extractTracks(response);
    expect(tracks[0]!.artists).toEqual([{ id: 'a1', name: 'Some Artist' }]);
  });

  it('filters artists missing from included', () => {
    const track = makeTrack('t1', {
      relationships: { artists: { data: [{ id: 'missing-artist', type: 'artists' }] } },
    });
    const response = makeSearchResponse(['t1'], [track]);
    const tracks = extractTracks(response);
    expect(tracks[0]!.artists).toEqual([]);
  });

  it('selects 160px artwork when available', () => {
    const artwork = makeArtwork('aw1', [
      { href: 'https://img/80.jpg', meta: { width: 80 } },
      { href: 'https://img/160.jpg', meta: { width: 160 } },
    ]);
    const album = makeAlbum('al1', 'aw1');
    const track = makeTrack('t1', {
      relationships: {
        albums: { data: [{ id: 'al1', type: 'albums' }] },
      },
    });
    const response = makeSearchResponse(['t1'], [track, album, artwork]);
    const tracks = extractTracks(response);
    expect(tracks[0]!.artUrl).toBe('https://img/160.jpg');
  });

  it('falls back to first artwork file when no 160px', () => {
    const artwork = makeArtwork('aw1', [
      { href: 'https://img/80.jpg', meta: { width: 80 } },
    ]);
    const album = makeAlbum('al1', 'aw1');
    const track = makeTrack('t1', {
      relationships: {
        albums: { data: [{ id: 'al1', type: 'albums' }] },
      },
    });
    const response = makeSearchResponse(['t1'], [track, album, artwork]);
    const tracks = extractTracks(response);
    expect(tracks[0]!.artUrl).toBe('https://img/80.jpg');
  });

  it('sets artUrl to null when no album relationship', () => {
    const track = makeTrack('t1');
    const response = makeSearchResponse(['t1'], [track]);
    const tracks = extractTracks(response);
    expect(tracks[0]!.artUrl).toBeNull();
  });

  it('passes duration through formatDuration', () => {
    const track = makeTrack('t1', { attributes: { title: 'T', duration: 'PT2M30S' } });
    const response = makeSearchResponse(['t1'], [track]);
    const tracks = extractTracks(response);
    expect(tracks[0]!.duration).toBe('2:30');
  });

  it('falls back to all tracks in included when no searchResult relationships', () => {
    const t1 = makeTrack('1');
    const t2 = makeTrack('2');
    const response: SearchResponse = {
      data: [{ id: 'sr1', type: 'searchResults', relationships: {} }],
      included: [t1, t2],
    };
    const tracks = extractTracks(response);
    expect(tracks.map(t => t.id)).toEqual(['1', '2']);
  });
});
