import { describe, expect, it } from 'vitest';
import { dtg, fromMgrs, toMgrs, toUtm } from '../src/geo/mgrs.ts';

// Reference values from the independent `mgrs` library (GeoTrans-derived).
const VECTORS: [number, number, string][] = [
  [28.6129, 77.2295, '43RGM1798767131'], // New Delhi
  [34.1526, 77.5771, '43SGT3759382077'], // Leh
  [8.0883, 77.5385, '43PGJ7976894931'], // Kanyakumari
  [26.9124, 70.9122, '42RXQ8988778167'], // Jaisalmer
  [0, 0, '31NAA6602100000'],
  [-33.8568, 151.2153, '56HLH3490052288'],
  [64.1466, -21.9426, '27WVM5413813689'],
  [51.5, 0, '31UBT9178309696'],
  [60, 5, '32VKM7697958157'], // Norway exception
  [72, 10, '33XUV2772496086'], // Svalbard exception
];

describe('MGRS / UTM', () => {
  it.each(VECTORS)('%f, %f → %s', (lat, lon, ref) => {
    // Allow ±1 m in the last digits (truncation vs rounding at exact boundaries).
    const got = toMgrs(lat, lon);
    expect(got.slice(0, 5)).toBe(ref.slice(0, 5));
    expect(Math.abs(Number(got.slice(5, 10)) - Number(ref.slice(5, 10)))).toBeLessThanOrEqual(1);
    expect(Math.abs(Number(got.slice(10)) - Number(ref.slice(10)))).toBeLessThanOrEqual(1);
  });

  it('round-trips MGRS → lat/lon to within the reference precision', () => {
    for (const [lat, lon] of VECTORS) {
      const back = fromMgrs(toMgrs(lat, lon));
      expect(Math.abs(back.lat - lat) * 111_000).toBeLessThan(1.5);
      expect(Math.abs(back.lon - lon) * 111_000 * Math.cos((lat * Math.PI) / 180)).toBeLessThan(1.5);
    }
    expect(fromMgrs('43R GM 17987 67131').precisionM).toBe(1);
    expect(fromMgrs('43RGM1767').precisionM).toBe(1000);
  });

  it('formats a date-time group in Zulu', () => {
    expect(dtg(Date.UTC(2026, 9, 4, 19, 32))).toBe('041932Z OCT 26');
    expect(toUtm(28.6129, 77.2295).zone).toBe(43);
  });
});
