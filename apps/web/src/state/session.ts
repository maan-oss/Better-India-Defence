import { create } from 'zustand';
import type { UserRecord } from '@strata/domain';
import { get, post } from '../api/client';
import type { Me } from '../api/types';

interface SessionState {
  status: 'unknown' | 'anonymous' | 'authenticated';
  user: UserRecord | null;
  permissions: Set<string>;
  demo: { users: string[]; password: string | null } | null;
  refresh(): Promise<void>;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  can(p: string): boolean;
}

export const useSession = create<SessionState>((set, getState) => ({
  status: 'unknown',
  user: null,
  permissions: new Set(),
  demo: null,
  async refresh() {
    try {
      const me = await get<Me>('/api/auth/me');
      set({ status: 'authenticated', user: me.user, permissions: new Set(me.permissions) });
    } catch {
      const demo = await get<{ users: string[]; password: string | null }>('/api/auth/demo').catch(() => null);
      set({ status: 'anonymous', user: null, permissions: new Set(), demo });
    }
  },
  async login(username, password) {
    const me = await post<Me>('/api/auth/login', { username, password });
    set({ status: 'authenticated', user: me.user, permissions: new Set(me.permissions) });
  },
  async logout() {
    await post('/api/auth/logout').catch(() => undefined);
    set({ status: 'anonymous', user: null, permissions: new Set() });
  },
  can(p) {
    return getState().permissions.has(p);
  },
}));
