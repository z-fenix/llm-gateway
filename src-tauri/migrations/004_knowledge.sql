CREATE TABLE IF NOT EXISTS knowledge_bases (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
  embedding_channel_id TEXT REFERENCES channels(id),
  embedding_model TEXT NOT NULL, dim INTEGER NOT NULL DEFAULT 0,
  doc_count INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kb_documents (
  id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  filename TEXT NOT NULL, file_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'indexed',
  error TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kb_chunks (
  id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, symbol TEXT, content TEXT NOT NULL,
  token_count INTEGER NOT NULL, embedding_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb ON kb_chunks(kb_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_emb ON kb_chunks(kb_id, embedding_id);
CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(content, content='kb_chunks', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(rowid, content) VALUES (new.rowid, new.content); END;
CREATE TRIGGER IF NOT EXISTS kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content); END;
CREATE TRIGGER IF NOT EXISTS kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO kb_chunks_fts(rowid, content) VALUES (new.rowid, new.content); END;
CREATE TABLE IF NOT EXISTS kb_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO kb_meta(key, value) VALUES ('next_embedding_id', 1);
