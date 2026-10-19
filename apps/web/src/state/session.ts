import { create } from 'zustand';
import type { UserRecord } from '@strata/domain/client';
import { get, post } from '../api/client';
import type { Me } from '../api/types';

/** A sign-in either opens a session, or (for an account with a second factor) waits for the code. */
type SignInReply = { user: UserRecord; permissions: string[]; mfa: 'ok' | 'enrol' } | { mfa: 'required'; challenge: string; expiresAt: number };

interface SessionState {
  status: 'unknown' | 'anonymous' | 'authenticated';
  user: UserRecord | null;
  permissions: Set<string>;
  /** Set between the password and the code: the sign-in is waiting for the authenticator's code. */
  challenge: string | null;
  /** A privileged account that has not yet set up its second factor: the console shows only the set-up. */
  mustEnrol: boolean;
  refresh(): Promise<void>;
  login(username: string, password: string): Promise<void>;
  verifyCode(code: string): Promise<void>;
  cancelChallenge(): void;
  completeEnrolment(): Promise<void>;
  logout(): Promise<void>;
  can(p: string): boolean;
}

export const useSession = create<SessionState>((set, getState) => ({
  status: 'unknown',
  user: null,
  permissions: new Set(),
  challenge: null,
  mustEnrol: false,
  async refresh() {
    try {
      const me = await get<Me>('/api/auth/me');
      set({ status: 'authenticated', user: me.user, permissions: new Set(me.permissions), mustEnrol: Boolean(me.user.mfaPending), challenge: null });
    } catch {
      set({ status: 'anonymous', user: null, permissions: new Set(), challenge: null, mustEnrol: false });
    }
  },
  async login(username, password) {
    const r = await post<SignInReply>('/api/auth/login', { username, password });
    if ('challenge' in r) set({ challenge: r.challenge });
    else set({ status: 'authenticated', user: r.user, permissions: new Set(r.permissions), challenge: null, mustEnrol: r.mfa === 'enrol' });
  },
  async verifyCode(code) {
    const challenge = getState().challenge;
    if (!challenge) throw new Error('sign in again');
    const r = await post<SignInReply>('/api/auth/mfa/verify', { challenge, code });
    if ('challenge' in r) throw new Error('sign in again');
    set({ status: 'authenticated', user: r.user, permissions: new Set(r.permissions), challenge: null, mustEnrol: r.mfa === 'enrol' });
  },
  cancelChallenge() {
    set({ challenge: null });
  },
  async completeEnrolment() {
    await getState().refresh();
  },
  async logout() {
    await post('/api/auth/logout').catch(() => undefined);
    set({ status: 'anonymous', user: null, permissions: new Set(), challenge: null, mustEnrol: false });
  },
  can(p) {
    return getState().permissions.has(p);
  },
}));
