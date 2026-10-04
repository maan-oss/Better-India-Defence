export const hms = (t: number | null | undefined): string => (t ? new Date(t).toISOString().slice(11, 19) : '—');
export const hm = (t: number | null | undefined): string => (t ? new Date(t).toISOString().slice(11, 16) : '—');
export const dateTime = (t: number | null | undefined): string => (t ? `${new Date(t).toISOString().slice(0, 10)} ${hms(t)}Z` : '—');
export const pct = (v: number | null | undefined, dp = 0): string => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(dp)}%`);
export const ago = (t: number | null | undefined, now: number): string => {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${(s / 3600).toFixed(1)} h ago`;
};
export const dur = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim();
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
};
export const bytes = (n: number): string => (n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${(n / 1e3).toFixed(0)} kB` : `${n} B`);
export const enu = (x: number, y: number): string => `E ${x.toFixed(1)} · N ${y.toFixed(1)} m`;
export const titleCase = (s: string): string => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
