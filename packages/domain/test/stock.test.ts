import { describe, expect, it } from 'vitest';
import { availabilityOf, effectiveStatus, isLowStock, isStockOut } from '../src/assets/model.ts';

describe('stock on the dependency graph', () => {
  it('reports low stock at or below the reorder level, and not when the level is unknown or the stock is out', () => {
    expect(isLowStock(3, 5)).toBe(true);
    expect(isLowStock(5, 5)).toBe(true);
    expect(isLowStock(6, 5)).toBe(false);
    expect(isLowStock(0, 5)).toBe(false);
    expect(isLowStock(null, 5)).toBe(false);
  });

  it('counts a supply item with nothing left as out, and only supply items', () => {
    expect(isStockOut('supply', 0)).toBe(true);
    expect(isStockOut('supply', 2)).toBe(false);
    expect(isStockOut('power', 0)).toBe(false);
    expect(isStockOut('supply', null)).toBe(false);
  });

  it('treats a stock-out as out of service for the rules, and leaves a retired record retired', () => {
    expect(effectiveStatus('in_service', 'supply', 0)).toBe('out_of_service');
    expect(effectiveStatus('degraded', 'supply', 0)).toBe('out_of_service');
    expect(effectiveStatus('retired', 'supply', 0)).toBe('retired');
    expect(effectiveStatus('in_service', 'supply', 4)).toBe('in_service');
  });

  it('impairs a dependent while the supply item is out, and restores it when stock returns', () => {
    const edges = [{ assetId: 'ups', dependsOnId: 'diesel', kind: 'fuel' as const }];
    const nodes = (quantity: number) => [
      { id: 'ups', status: 'in_service' as const, criticality: 4 },
      { id: 'diesel', status: effectiveStatus('in_service', 'supply', quantity), criticality: 3 },
    ];
    expect(availabilityOf(nodes(0), edges).get('ups')).toEqual({ id: 'ups', state: 'impaired', causes: ['diesel'] });
    expect(availabilityOf(nodes(0), edges).get('diesel')?.state).toBe('down');
    expect(availabilityOf(nodes(6), edges).get('ups')).toEqual({ id: 'ups', state: 'available', causes: [] });
  });
});
