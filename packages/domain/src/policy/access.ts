import type { Role } from '../provenance.ts';

/**
 * Who may see or change a record. Two checks, and both must pass:
 *  - clearance: the person's clearance is at least the record's classification;
 *  - organisation: the person belongs to the organisation that owns the record, or the owner has shared the record with it.
 * Sharing grants view only. Changing a record needs the owning organisation, and changing a record's owner needs an
 * administrator. Roles give the verbs (see rbac.ts); this function decides which records those verbs reach.
 */
export const CLASSIFICATIONS = ['UNCLASSIFIED', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const classificationRank = (c: Classification): number => CLASSIFICATIONS.indexOf(c);

/** Organisation names are short lower-case slugs, so they can be compared, stored and shown without surprises. */
export const ORGANISATION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export interface Subject {
  clearance: Classification;
  organisation: string;
  role: Role;
}

export interface Resource {
  classification: Classification;
  owner: string;
  sharedWith: readonly string[];
}

export type Action = 'view' | 'change' | 'reclassify' | 'transfer';
export type Refusal = 'clearance' | 'organisation' | 'owner-only' | 'administrator-only';
export type Decision = { allowed: true } | { allowed: false; reason: Refusal };

/** The one place the rule is written. Every route that reads or changes a record calls this. */
export function access(subject: Subject, resource: Resource, action: Action): Decision {
  if (classificationRank(subject.clearance) < classificationRank(resource.classification)) return { allowed: false, reason: 'clearance' };
  const owns = subject.organisation === resource.owner;
  if (action === 'view') {
    return owns || resource.sharedWith.includes(subject.organisation) ? { allowed: true } : { allowed: false, reason: 'organisation' };
  }
  if (action === 'change' || action === 'reclassify') {
    return owns ? { allowed: true } : { allowed: false, reason: 'organisation' };
  }
  // Transferring ownership is an administrator's act.
  return subject.role === 'administrator' && (owns || resource.sharedWith.includes(subject.organisation)) ? { allowed: true } : { allowed: false, reason: 'administrator-only' };
}

/** A new record may be created at or below the creator's clearance. */
export const mayCreateAt = (subject: Subject, classification: Classification): boolean => classificationRank(subject.clearance) >= classificationRank(classification);
