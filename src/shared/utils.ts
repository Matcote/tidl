export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type TidalLinkTarget = {
  kind: 'track' | 'artist';
  id: string;
};

const TIDAL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function openTidalLink(appUrl: string, webUrl: string): boolean {
  const appTarget = parseTidalAppUrl(appUrl);
  const webTarget = parseTidalWebUrl(webUrl);
  if (!appTarget || !webTarget) return false;
  if (appTarget.kind !== webTarget.kind || appTarget.id !== webTarget.id) return false;

  const safeAppUrl = `tidal://${appTarget.kind}/${encodeURIComponent(appTarget.id)}`;
  const safeWebUrl = `https://tidal.com/${webTarget.kind}/${encodeURIComponent(webTarget.id)}`;

  const timer = setTimeout(() => window.open(safeWebUrl, '_blank', 'noopener,noreferrer'), 600);
  window.addEventListener('blur', () => clearTimeout(timer), { once: true });
  const a = document.createElement('a');
  a.href = safeAppUrl;
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  return true;
}

function parseTidalAppUrl(url: string): TidalLinkTarget | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'tidal:') return null;
    return normalizeTidalTarget(parsed.hostname, parsed.pathname.slice(1));
  } catch {
    return null;
  }
}

function parseTidalWebUrl(url: string): TidalLinkTarget | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'tidal.com') return null;
    const [kind, id, ...extra] = parsed.pathname.split('/').filter(Boolean);
    if (extra.length) return null;
    return normalizeTidalTarget(kind, id);
  } catch {
    return null;
  }
}

function normalizeTidalTarget(kind: string | undefined, id: string | undefined): TidalLinkTarget | null {
  if (kind !== 'track' && kind !== 'artist') return null;
  if (!id) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    return null;
  }

  if (!TIDAL_ID_RE.test(decoded)) return null;
  return { kind, id: decoded };
}
