import { create } from 'zustand';

/** Per-console display preferences (kept in this browser only). */
export type Theme = 'dark' | 'night';

interface UiState {
  theme: Theme;
  railOpen: boolean;
  setTheme(t: Theme): void;
  toggleRail(): void;
}

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage unavailable: preference lasts for this session only */
  }
}

export function applyTheme(t: Theme): void {
  if (t === 'dark') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

export const useUi = create<UiState>((set, get) => ({
  theme: read('strata.theme', ['dark', 'night'] as const, 'dark'),
  railOpen: read('strata.rail', ['open', 'closed'] as const, 'closed') === 'open',
  setTheme(t) {
    write('strata.theme', t);
    applyTheme(t);
    set({ theme: t });
  },
  toggleRail() {
    const open = !get().railOpen;
    write('strata.rail', open ? 'open' : 'closed');
    set({ railOpen: open });
  },
}));

applyTheme(useUi.getState().theme);
