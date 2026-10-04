/** Fixed epoch for cyclic (background) motion so truth is a pure function of absolute time. */
export const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const iso = (t: number): string => new Date(t).toISOString();
export const hms = (t: number): string => new Date(t).toISOString().slice(11, 19);
