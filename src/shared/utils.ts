export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function openTidalLink(appUrl: string, webUrl: string): void {
  const timer = setTimeout(() => window.open(webUrl, '_blank'), 600);
  window.addEventListener('blur', () => clearTimeout(timer), { once: true });
  const a = document.createElement('a');
  a.href = appUrl;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
