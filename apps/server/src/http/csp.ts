/**
 * Content Security Policy for every response. The client loads its own scripts, styles, fonts and images, a WebSocket
 * to the same host, and the tiles of the configured basemap if there is one. Nothing else is fetched, so nothing else
 * is allowed. Inline scripts and inline styles are both refused: the client applies its layout through stylesheets and
 * the CSS object model, never through style attributes in markup.
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

/**
 * The policy for one response. The application shell carries a per-response nonce, which admits the one style element
 * the animation library writes at run time (the exit of a popLayout transition). The nonce is in the shell's meta tag,
 * so only that page can use it; every other response is served without one.
 */
export function contentSecurityPolicy(basemapTemplate: string | null | undefined, nonce?: string): string {
  const tiles = tileOrigin(basemapTemplate);
  const images = ["'self'", 'data:', 'blob:', ...(tiles ? [tiles] : [])];
  const styles = ["'self'", ...(nonce ? [`'nonce-${nonce}'`] : [])];
  return [
    "default-src 'self'",
    "script-src 'self'",
    `style-src ${styles.join(' ')}`,
    `img-src ${images.join(' ')}`,
    "font-src 'self'",
    "media-src 'self' blob:",
    "connect-src 'self' ws: wss: blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
