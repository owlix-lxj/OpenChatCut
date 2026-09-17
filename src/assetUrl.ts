// Resolve a bundled public/ asset path against the app's base URL.
//
// Vite does NOT rewrite the base for absolute runtime string paths like
// "/thumbnails/x.jpg" — only for assets it imports/processes. Under the platform
// deployment the app is served from base "/openchatcut/", so an absolute
// "/thumbnails/x.jpg" resolves to "https://host/thumbnails/x.jpg" (404) instead
// of "https://host/openchatcut/thumbnails/x.jpg" (200). Run such paths through
// this helper so they honor import.meta.env.BASE_URL in every deployment.
export function assetUrl(path: string): string {
  if (!path) return path;
  // Already absolute (remote), a data/blob URI, or a base-relative path: leave it.
  if (/^(https?:)?\/\//.test(path) || path.startsWith('data:') || path.startsWith('blob:')) {
    return path;
  }
  const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
  return `${base}/${path.replace(/^\/+/, '')}`;
}
