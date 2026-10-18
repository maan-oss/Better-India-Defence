import { z } from 'zod';
import { ASSET_CATEGORIES, DEPENDENCY_KINDS, SETTABLE_STATUSES } from '../assets/model.ts';

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
