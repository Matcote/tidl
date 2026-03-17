import type { Track, TidalJsonApiResource, SearchResponse } from './types';

interface ArtworkFile { href: string; meta?: { width?: number } }

export function extractTracks(data: SearchResponse): Track[] {
  const included = data.included ?? [];
  const searchResult = Array.isArray(data.data) ? data.data[0] : data.data;
  const orderedIds = searchResult?.relationships?.['tracks']?.data?.map(t => t.id) ?? [];
  const tracks = orderedIds.length
    ? orderedIds
        .map(id => included.find(r => r.type === 'tracks' && r.id === id))
        .filter((t): t is TidalJsonApiResource => t !== undefined)
    : included.filter(r => r.type === 'tracks');

  return tracks.map(track => {
    const attrs = track.attributes ?? {};
    const artistRel = track.relationships?.['artists']?.data ?? [];

    const artists = artistRel
      .map(a => {
        const ar = included.find(r => r.type === 'artists' && r.id === a.id);
        const name = ar?.attributes?.['name'] as string | undefined;
        return name ? { id: a.id, name } : null;
      })
      .filter((a): a is { id: string; name: string } => a !== null);

    const albumRel = track.relationships?.['albums']?.data?.[0];
    const albumResource = albumRel
      ? included.find(r => r.type === 'albums' && r.id === albumRel.id)
      : null;
    const coverArtId = albumResource?.relationships?.['coverArt']?.data?.[0]?.id;
    const artworkResource = coverArtId
      ? included.find(r => r.type === 'artworks' && r.id === coverArtId)
      : null;
    const files = artworkResource?.attributes?.['files'] as ArtworkFile[] | undefined;
    const artUrl =
      files?.find(f => f.meta?.width === 160)?.href ?? files?.[0]?.href ?? null;

    return {
      id: track.id,
      title: (attrs['title'] as string | undefined) ?? 'Unknown Track',
      artists,
      duration: formatDuration(attrs['duration'] as string | undefined),
      artUrl,
    };
  });
}

export function formatDuration(iso: string | undefined): string {
  if (!iso) return '';
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return '';
  const h = parseInt(match[1] ?? '0');
  const m = parseInt(match[2] ?? '0') + h * 60;
  const s = String(parseInt(match[3] ?? '0')).padStart(2, '0');
  return `${m}:${s}`;
}
