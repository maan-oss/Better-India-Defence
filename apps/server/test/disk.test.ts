import { describe, expect, it, vi } from 'vitest';

/**
 * The data-volume figure shows what is used and what this process can still write. Blocks reserved for root (or
 * otherwise unusable) are not part of the volume's usable capacity, so they must not read as "used".
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, statfs: vi.fn(async () => ({ blocks: 1000, bfree: 100, bavail: 60, bsize: 4096 })) };
});

describe('data volume capacity', () => {
  it('counts used plus available as the total, so reserved blocks are not shown as used', async () => {
    const { diskOf } = await import('../src/routes/core.ts');
    const d = await diskOf('/anywhere');
    expect(d).toEqual({ totalBytes: (900 + 60) * 4096, freeBytes: 60 * 4096 });
    // Used space is what df reports as used: 900 blocks, not the 940 left after the 60 available.
    expect((d!.totalBytes - d!.freeBytes) / 4096).toBe(900);
  });
});
