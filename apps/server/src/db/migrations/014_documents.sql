-- Documents: plain text, Markdown and CSV, with where they came from, who uploaded them and when, the classification and
-- owner that govern who may see them, and an analyst's assessment of the content. Full-text search reads the generated
-- tsvector; title and source weigh more than the body.
CREATE TABLE documents (
  id text PRIMARY KEY,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('text', 'markdown', 'csv')),
  body text NOT NULL,
  rows integer,
  classification text NOT NULL DEFAULT 'UNCLASSIFIED' CHECK (classification IN ('UNCLASSIFIED', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET')),
  owner text NOT NULL CHECK (owner ~ '^[a-z0-9][a-z0-9._-]{0,39}$'),
  shared_with text[] NOT NULL DEFAULT '{}',
  document_date bigint,
  uploaded_by text NOT NULL,
  uploaded_at bigint NOT NULL,
  confidence text NOT NULL DEFAULT 'unreviewed' CHECK (confidence IN ('unreviewed', 'probable', 'confirmed', 'disputed')),
  confidence_note text,
  confidence_by text,
  confidence_at bigint,
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(source, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'C')
  ) STORED
);
CREATE INDEX documents_search ON documents USING GIN (search);
CREATE INDEX documents_uploaded ON documents (uploaded_at DESC);
