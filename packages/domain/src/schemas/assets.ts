import { z } from 'zod';
import { ASSET_CATEGORIES, DEPENDENCY_KINDS, SETTABLE_STATUSES } from '../assets/model.ts';
import { CLASSIFICATIONS, ORGANISATION_PATTERN } from '../policy/access.ts';

/** Request bodies for the asset register. Every write is validated here before the service sees it. */
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullish();
const epoch = z.number().int().nonnegative().nullish();

/** Stable, human-readable asset tag, e.g. `UPS-1` or `GEN-2`. Fixed once an asset exists. */
export const ASSET_TAG = /^[A-Z0-9][A-Z0-9-]{1,23}$/;

export const AssetInput = z.object({
  tag: z.string().trim().regex(ASSET_TAG, 'upper-case letters, digits and hyphens; 2 to 24 characters'),
  name: text(120),
  category: z.enum(ASSET_CATEGORIES),
  criticality: z.number().int().min(1).max(5),
  zoneId: optionalText(60),
  manufacturer: optionalText(80),
  model: optionalText(80),
  serial: optionalText(80),
  commissionedAt: epoch,
  warrantyUntil: epoch,
  notes: optionalText(1000),
  /** Defaults to UNCLASSIFIED. The person creating or changing the record must hold this clearance. */
  classification: z.enum(CLASSIFICATIONS).optional(),
  /** The owning organisation. Only an administrator may name another organisation as owner. */
  owner: z.string().trim().regex(ORGANISATION_PATTERN, 'a lower-case organisation name').nullish(),
  /** Organisations that may view the record. Sharing never grants change. */
  sharedWith: z.array(z.string().trim().regex(ORGANISATION_PATTERN, 'a lower-case organisation name')).max(8).optional(),
  /** Stock on hand, for a supply item only: the quantity, the level at which to reorder, and the unit it is counted in. */
  stock: z
    .object({
      quantity: z.number().finite().min(0).max(1_000_000_000),
      reorderLevel: z.number().finite().min(0).max(1_000_000_000),
      unit: text(16),
    })
    .optional(),
});
export type AssetInput = z.infer<typeof AssetInput>;

/** A change to an existing asset. The tag is not part of the patch; a patch that names it is refused, not ignored. */
export const AssetPatch = AssetInput.omit({ tag: true }).partial().strict();
export type AssetPatch = z.infer<typeof AssetPatch>;

export const StatusInput = z.object({
  status: z.enum(SETTABLE_STATUSES),
  reason: text(300),
});

export const DependencyInput = z.object({
  dependsOn: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        kind: z.enum(DEPENDENCY_KINDS),
      }),
    )
    .max(50),
});

export const PlanInput = z.object({
  title: text(120),
  intervalDays: z.number().int().min(1).max(3650),
});

export const CompleteInput = z.object({
  note: optionalText(500),
});

export const RetireInput = z.object({
  reason: text(300),
});

export const ImpactQuery = z.object({
  status: z.enum(['degraded', 'out_of_service']).default('out_of_service'),
});

/** A receipt (positive) or an issue (negative) of stock. Zero is not a change. */
export const StockChangeInput = z.object({
  change: z.number().finite().min(-1_000_000_000).max(1_000_000_000).refine((v) => v !== 0, 'a stock change cannot be zero'),
  reason: text(200),
});
export type StockChangeInput = z.infer<typeof StockChangeInput>;

/** A request to reorder a supply item. It takes effect only when a different person approves it. */
export const ReorderInput = z.object({
  quantity: z.number().finite().positive().max(1_000_000_000),
  reason: text(300),
});
export type ReorderInput = z.infer<typeof ReorderInput>;

export const ReorderDecisionInput = z.object({
  decision: z.enum(['approve', 'reject']),
  note: optionalText(300),
});
export type ReorderDecisionInput = z.infer<typeof ReorderDecisionInput>;
