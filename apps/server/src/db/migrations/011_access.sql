-- Clearance and organisation. A person has one clearance and one organisation; a record has a classification, the
-- organisation that owns it and the organisations it is shared with (view only). The rule is in packages/domain/src/policy.
ALTER TABLE users ADD COLUMN clearance text NOT NULL DEFAULT 'UNCLASSIFIED' CHECK (clearance IN ('UNCLASSIFIED', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET'));
ALTER TABLE users ADD COLUMN organisation text NOT NULL DEFAULT 'site' CHECK (organisation ~ '^[a-z0-9][a-z0-9._-]{0,39}$');
ALTER TABLE assets ADD COLUMN classification text NOT NULL DEFAULT 'UNCLASSIFIED' CHECK (classification IN ('UNCLASSIFIED', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET'));
ALTER TABLE assets ADD COLUMN owner text NOT NULL DEFAULT 'site' CHECK (owner ~ '^[a-z0-9][a-z0-9._-]{0,39}$');
ALTER TABLE assets ADD COLUMN shared_with text[] NOT NULL DEFAULT '{}';
