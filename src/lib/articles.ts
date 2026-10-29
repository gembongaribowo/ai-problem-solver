import { supabase } from './supabase';

export type ArticleRecord = {
  id?: string;
  slug?: string | null;
  status?: string;
  published_at?: string | null;
  [key: string]: unknown;
};

type D1Result<T> = {
  results?: T[];
  success?: boolean;
  error?: string;
};

type D1BoundStatement = {
  all<T = ArticleRecord>(): Promise<D1Result<T>>;
  first<T = ArticleRecord>(): Promise<T | null>;
};

type D1Statement = {
  bind(...values: Array<string | number | null>): D1BoundStatement;
};

type D1DatabaseBinding = {
  prepare(sql: string): D1Statement;
};

export type ArticleRuntimeEnv = {
  DB?: D1DatabaseBinding;
  ARTICLES_DATA_SOURCE?: string;
  D1_MIN_ARTICLE_COUNT?: string;
};

type ArticleListResult = {
  data: ArticleRecord[];
  error: unknown | null;
};

type ArticleResult = {
  data: ArticleRecord | null;
  error: unknown | null;
};

const getMinimumPublishedCount = (env: ArticleRuntimeEnv): number => {
  const configured = Number.parseInt(env.D1_MIN_ARTICLE_COUNT ?? '577', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 577;
};

async function isD1MigrationReady(env: ArticleRuntimeEnv): Promise<boolean> {
  if (!env.DB || env.ARTICLES_DATA_SOURCE !== 'd1') return false;

  try {
    const result = await env.DB
      .prepare("SELECT COUNT(*) AS count FROM articles WHERE status = ?")
      .bind('published')
      .first<{ count: number | string }>();

    const count = Number(result?.count ?? 0);
    return Number.isFinite(count) && count >= getMinimumPublishedCount(env);
  } catch (error) {
    console.error('D1 readiness check failed; falling back to Supabase.', error);
    return false;
  }
}

/**
 * Keep Supabase as the default source and rollback path until D1 has been
 * imported and explicitly enabled with ARTICLES_DATA_SOURCE=d1.
 */
export async function listPublishedArticles(
  env: ArticleRuntimeEnv
): Promise<ArticleListResult> {
  if (await isD1MigrationReady(env)) {
    try {
      const result = await env.DB!
        .prepare('SELECT * FROM articles WHERE status = ? ORDER BY published_at DESC')
        .bind('published')
        .all<ArticleRecord>();

      if (result.success !== false && Array.isArray(result.results) && result.results.length > 0) {
        return { data: result.results, error: null };
      }

      console.warn('D1 returned no published articles; falling back to Supabase.');
    } catch (error) {
      console.error('D1 article query failed; falling back to Supabase.', error);
    }
  }

  const { data, error } = await supabase
    .from('articles')
    .select('*')
    .eq('status', 'published')
    .order('published_at', { ascending: false });

  return { data: (data ?? []) as ArticleRecord[], error };
}

export async function getPublishedArticleBySlug(
  env: ArticleRuntimeEnv,
  slug: string
): Promise<ArticleResult> {
  if (slug && (await isD1MigrationReady(env))) {
    try {
      const article = await env.DB!
        .prepare('SELECT * FROM articles WHERE slug = ? AND status = ? LIMIT 1')
        .bind(slug, 'published')
        .first<ArticleRecord>();

      if (article) return { data: article, error: null };
      console.warn('Article slug was not found in D1; falling back to Supabase.');
    } catch (error) {
      console.error('D1 article lookup failed; falling back to Supabase.', error);
    }
  }

  const { data, error } = await supabase
    .from('articles')
    .select('*')
    .eq('slug', slug)
    .eq('status', 'published')
    .single();

  return { data: (data ?? null) as ArticleRecord | null, error };
}
