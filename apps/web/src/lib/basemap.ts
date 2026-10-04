/**
 * Ground imagery from a web-map tile service (XYZ / slippy-map template). Tiles covering the site extent are
 * fetched by this browser, stitched into one texture (≤ 4096 px) and handed to the 3-D view exactly like an
 * uploaded orthophoto. Over a site of a few kilometres, Web-Mercator's latitude scaling is linear to well under
 * a pixel, so the mosaic is placed by its tile-edge bounds.
 */
export interface Basemap {
  url: string;
  attribution: string;
  maxZoom: number;
}

const MAX_TILES_ACROSS = 16;

function tileX(lon: number, z: number) {
  return ((lon + 180) / 360) * 2 ** z;
}
function tileY(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}
const lonOf = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const latOf = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

function loadTile(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export async function buildBasemap(
  origin: { lat: number; lon: number },
  halfExtentM: number,
  map: Basemap,
): Promise<{ url: string; bounds: { west: number; south: number; east: number; north: number }; loaded: number; total: number } | null> {
  const dLat = halfExtentM / 111_320;
  const dLon = halfExtentM / (111_320 * Math.cos((origin.lat * Math.PI) / 180));
  const west = origin.lon - dLon;
  const east = origin.lon + dLon;
  const south = origin.lat - dLat;
  const north = origin.lat + dLat;
  let z = Math.min(map.maxZoom, 19);
  while (z > 1 && Math.ceil(tileX(east, z)) - Math.floor(tileX(west, z)) > MAX_TILES_ACROSS) z--;
  const x0 = Math.floor(tileX(west, z));
  const x1 = Math.ceil(tileX(east, z));
  const y0 = Math.floor(tileY(north, z));
  const y1 = Math.ceil(tileY(south, z));
  const canvas = document.createElement('canvas');
  canvas.width = (x1 - x0) * 256;
  canvas.height = (y1 - y0) * 256;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#1e1e1e';
  g.fillRect(0, 0, canvas.width, canvas.height);
  const jobs: { x: number; y: number }[] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) jobs.push({ x, y });
  let loaded = 0;
  // A few requests at a time: tile servers rate-limit bursts.
  const workers = Array.from({ length: 6 }, async () => {
    for (let j = jobs.shift(); j; j = jobs.shift()) {
      const src = map.url.replace('{z}', String(z)).replace('{x}', String(j.x)).replace('{y}', String(j.y)).replace('{s}', 'abc'[(j.x + j.y) % 3]!);
      const img = await loadTile(src);
      if (img) {
        g.drawImage(img, (j.x - x0) * 256, (j.y - y0) * 256, 256, 256);
        loaded++;
      }
    }
  });
  const total = (x1 - x0) * (y1 - y0);
  await Promise.all(workers);
  if (!loaded) return null;
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  if (!blob) return null;
  return { url: URL.createObjectURL(blob), bounds: { west: lonOf(x0, z), east: lonOf(x1, z), north: latOf(y0, z), south: latOf(y1, z) }, loaded, total };
}
