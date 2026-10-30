import { supabase } from './supabase';

export type ArticleRecord = {
  id?: string;
  slug?: string | null;
  status?: string;
  published_at?: string | null;
  [key: string]: any;
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
  ARTICLES_D1_READY?: string;
};

type ArticleListResult = {
  data: ArticleRecord[];
  error: unknown | null;
};

type ArticleResult = {
  data: ArticleRecord | null;
  error: unknown | null;
};

function isD1Ready(runtimeEnv: ArticleRuntimeEnv): boolean {
  return Boolean(
    runtimeEnv.DB &&
    runtimeEnv.ARTICLES_DATA_SOURCE === 'd1' &&
    runtimeEnv.ARTICLES_D1_READY === 'true'
  );
}

/**
 * D1 is selected only after an operator has verified the imported dataset
 * and explicitly enabled ARTICLES_D1_READY=true. Supabase remains the
 * default source and rollback path until then.
 */
export async function listPublishedArticles(
  runtimeEnv: ArticleRuntimeEnv
): Promise<ArticleListResult> {
  if (isD1Ready(runtimeEnv)) {
    try {
      const result = await runtimeEnv.DB!
        .prepare('SELECT * FROM articles WHERE status = ? ORDER BY published_at DESC, id ASC')
        .bind('published')
        .all<ArticleRecord>();

      if (result.success === false) {
        throw new Error(result.error || 'D1 query failed.');
      }

      return { data: result.results ?? [], error: null };
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
  runtimeEnv: ArticleRuntimeEnv,
  slug: string
): Promise<ArticleResult> {
  if (isD1Ready(runtimeEnv)) {
    try {
      const article = await runtimeEnv.DB!
        .prepare(
          'SELECT * FROM articles WHERE slug = ? AND status = ? ORDER BY published_at DESC, id ASC LIMIT 1'
        )
        .bind(slug, 'published')
        .first<ArticleRecord>();

      // A genuine not-found result must not fall back to stale Supabase data.
      return { data: article, error: null };
    } catch (error) {
      console.error('D1 article lookup failed; falling back to Supabase.', error);
    }
  }

  const { data, error } = await supabase
    .from('articles')
    .select('*')
    .eq('slug', slug)
    .eq('status', 'published')
    .order('published_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();

  return { data: (data ?? null) as ArticleRecord | null, error };
}
