/**
 * Content Security Policy for every response. The client loads its own scripts, styles, fonts and images, a WebSocket
 * to the same host, and the tiles of the configured basemap if there is one. Nothing else is fetched, so nothing else
 * is allowed. Inline scripts are refused; inline styles are allowed because the layout code applies them at run time.
 */

/** The origin of a basemap tile template (for example `https://tiles.example`), or null if there is no usable template. */
export function tileOrigin(template: string | null | undefined): string | null {
  if (!template) return null;
  try {
    // Braces are not valid in a URL host, so the placeholders are replaced before parsing; only the origin is kept.
    const origin = new URL(template.replace(/\{[xyzs]\}/g, '0')).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

export function contentSecurityPolicy(basemapTemplate: string | null | undefined): string {
  const tiles = tileOrigin(basemapTemplate);
  const images = ["'self'", 'data:', 'blob:', ...(tiles ? [tiles] : [])];
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${images.join(' ')}`,
    "font-src 'self'",
    "media-src 'self' blob:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
