-- Cloudflare D1 schema for the existing Supabase public.articles table.
-- Keep column names aligned with the Astro site and the n8n publication workflow.

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  source_name TEXT,
  source_url TEXT UNIQUE,
  source_title TEXT,
  source_published_at TEXT,
  score REAL,
  validation TEXT,
  review_status TEXT DEFAULT 'pending',
  slug TEXT,
  published_at TEXT,
  updated_at TEXT,
  category TEXT,
  content TEXT,
  title TEXT,
  summary TEXT,
  why_it_matters TEXT
);

CREATE INDEX IF NOT EXISTS idx_articles_status_published_at
  ON articles (status, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_articles_slug_status
  ON articles (slug, status);
