/**
 * Who is on watch: everyone with an open live connection (server presence), and — for administrators — the
 * other accounts, greyed. Monogram avatars with a small presence dot: no ring and no motion.
 */
import { useEffect, useMemo, useState } from 'react';
import { get } from '../../api/client';
import { useSession } from '../../state/session';

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

interface WatchUser {
  id: string;
  name: string;
  initials: string;
  online: boolean;
}

export function OnWatch({ className }: { className?: string }) {
  const online = useOnWatch();
  const can = useSession((s) => s.can);
  // The signed-in officer is already in the top-right menu; listing them here too read as a duplicate.
  const me = useSession((s) => s.user?.username);
  const [all, setAll] = useState<{ username: string; displayName: string; disabled: boolean }[]>([]);
  useEffect(() => {
    if (can('admin.users')) void get<typeof all>('/api/admin/users').then(setAll).catch(() => undefined);
  }, [can]);
  const users = useMemo<WatchUser[]>(() => {
    const on = new Set(online.map((o) => o.username));
    const list = [
      ...online.filter((o) => o.username !== me).map((o) => ({ username: o.username, displayName: o.displayName, online: true })),
      ...all.filter((u) => !u.disabled && !on.has(u.username)).map((u) => ({ username: u.username, displayName: u.displayName, online: false })),
    ];
    return list.slice(0, 12).map((u) => ({ id: u.username, name: `${u.displayName} (${u.username})`, initials: initials(u.displayName), online: u.online }));
  }, [online, all, me]);
  if (!users.length) return null;
  return (
    <div className={`on-watch ${className ?? ''}`} aria-label={`${online.length} on watch`}>
      <span className="on-watch-k">On watch</span>
      <ul className="ow-stack">
        {users.map((u) => (
          <li key={u.id} className="ow-av" data-online={u.online || undefined} title={u.name} aria-label={u.name}>
            {u.initials}
          </li>
        ))}
      </ul>
    </div>
  );
}
