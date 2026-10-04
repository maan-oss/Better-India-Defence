/**
 * Who is on watch: everyone with an open live connection (server presence), and — for administrators — the
 * other accounts, greyed. Space UI presence avatars, adapted to be read-only.
 */
import { useEffect, useMemo, useState } from 'react';
import { get } from '../../api/client';
import { useSession } from '../../state/session';
import { UserPresenceAvatar, type PresenceUser } from '../vendor/spaceui/components/spaceui/user-presence-avatar';

interface Online {
  username: string;
  displayName: string;
  role: string;
  since: number;
}

const initials = (n: string) =>
  n
    .replace(/^(maj|capt|lt|col|sgt|cpl|hav|nb sub|sub)\.?\s+/i, '')
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

/** Monogram avatar as an SVG data URL in the console palette (no external images). */
function monogram(name: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#383838"/><text x="32" y="40" text-anchor="middle" font-family="Geist, sans-serif" font-size="24" font-weight="600" fill="#f0eee6">${initials(name)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function useOnWatch() {
  const [online, setOnline] = useState<Online[]>([]);
  useEffect(() => {
    const load = () => void get<Online[]>('/api/presence').then(setOnline).catch(() => undefined);
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);
  return online;
}

export function OnWatch({ className }: { className?: string }) {
  const online = useOnWatch();
  const can = useSession((s) => s.can);
  const [all, setAll] = useState<{ username: string; displayName: string; disabled: boolean }[]>([]);
  useEffect(() => {
    if (can('admin.users')) void get<typeof all>('/api/admin/users').then(setAll).catch(() => undefined);
  }, [can]);
  const users = useMemo<PresenceUser[]>(() => {
    const on = new Set(online.map((o) => o.username));
    const list = [...online.map((o) => ({ username: o.username, displayName: o.displayName, online: true })), ...all.filter((u) => !u.disabled && !on.has(u.username)).map((u) => ({ username: u.username, displayName: u.displayName, online: false }))];
    return list.slice(0, 12).map((u, i) => ({ id: i + 1, name: `${u.displayName} (${u.username})`, src: monogram(u.displayName), fallback: initials(u.displayName), online: u.online }));
  }, [online, all]);
  if (!users.length) return null;
  return (
    <div className={`on-watch ${className ?? ''}`} aria-label={`${online.length} on watch`}>
      <span className="on-watch-k">On watch</span>
      <UserPresenceAvatar users={users} readOnly />
    </div>
  );
}
