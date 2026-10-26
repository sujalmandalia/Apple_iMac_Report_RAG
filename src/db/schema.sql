CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id              serial PRIMARY KEY,
  source          text NOT NULL UNIQUE,
  file_hash       text NOT NULL,
  title           text,
  product         text,
  report_date     date,
  page_count      int NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Phase 6: what keyword search and answers need besides the chunks.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS glossary        jsonb NOT NULL DEFAULT '{}';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS chunk_options   jsonb NOT NULL DEFAULT '{}';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedding_model text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedding_dims  int;

-- Larger units sent to the model with a matching chunk: a whole section, table or chart with its page text.
CREATE TABLE IF NOT EXISTS parents (
  id           bigserial PRIMARY KEY,
  document_id  int NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  key          text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('section', 'table', 'chart')),
  section_path text[] NOT NULL,
  pdf_pages    int[] NOT NULL,
  text         text NOT NULL,
  tokens       int NOT NULL,
  UNIQUE (document_id, key)
);

CREATE TABLE IF NOT EXISTS chunks (
  id           bigserial PRIMARY KEY,
  document_id  int NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  key          text NOT NULL,
  ordinal      int NOT NULL,
  parent_id    bigint REFERENCES parents(id) ON DELETE SET NULL,
  type         text NOT NULL CHECK (type IN ('text', 'highlight', 'definition', 'table', 'table_row', 'chart', 'endnote')),
  section_path text[] NOT NULL,
  exhibit      text,
  endnotes     int[] NOT NULL DEFAULT '{}',
  variants     text[] NOT NULL DEFAULT '{}',
  pdf_pages    int[] NOT NULL,
  context      text NOT NULL,
  text         text NOT NULL,
  tokens       int NOT NULL,
  embedding    vector(768),
  embedded_at  timestamptz,
  UNIQUE (document_id, content_hash)
);

CREATE INDEX IF NOT EXISTS chunks_document_ordinal_idx ON chunks (document_id, ordinal);
CREATE INDEX IF NOT EXISTS chunks_pending_idx ON chunks (document_id, ordinal) WHERE embedding IS NULL;
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunks_endnotes_idx ON chunks USING gin (endnotes);

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', context), 'A') || setweight(to_tsvector('english', text), 'B')
) STORED;

CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin (tsv);

-- Endnotes are stored whole; chunks only carry their first sentence, the answer step adds the full text.
CREATE TABLE IF NOT EXISTS endnotes (
  document_id  int NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  num          int NOT NULL,
  pdf_page     int NOT NULL,
  text         text NOT NULL,
  used_by      jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (document_id, num)
);

-- Parsed tables and the measured chart: exact values for answers and for the exhibit preview in the UI.
CREATE TABLE IF NOT EXISTS exhibits (
  document_id  int NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  key          text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('table', 'chart')),
  title        text NOT NULL,
  pdf_page     int NOT NULL,
  verified     boolean NOT NULL,
  data         jsonb NOT NULL,
  PRIMARY KEY (document_id, key)
);

-- Phase 9: conversation memory.
CREATE TABLE IF NOT EXISTS conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id                  bigserial PRIMARY KEY,
  conversation_id     uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role                text NOT NULL CHECK (role IN ('user', 'assistant')),
  content             text NOT NULL,
  standalone_question text,
  route               jsonb,
  sources             jsonb,
  model               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, id);
