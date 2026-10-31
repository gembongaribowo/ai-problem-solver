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

/**
 * Public article fields used by the homepage and article detail pages.
 * Keep editorial/internal fields (validation, review_status, updated_at)
 * out of the D1 read paths.
 */
const PUBLIC_ARTICLE_COLUMNS = [
  'id',
  'status',
  'source_name',
  'source_url',
  'source_title',
  'source_published_at',
  'score',
  'slug',
  'published_at',
  'category',
  'content',
  'title',
  'summary',
  'why_it_matters',
].join(', ');

function isD1Ready(runtimeEnv: ArticleRuntimeEnv): boolean {
  return Boolean(
    runtimeEnv.DB &&
    runtimeEnv.ARTICLES_DATA_SOURCE === 'd1' &&
    runtimeEnv.ARTICLES_D1_READY === 'true'
  );
}

function d1UnavailableError(runtimeEnv: ArticleRuntimeEnv): Error {
  if (!runtimeEnv.DB) {
    return new Error('D1 database binding is not configured.');
  }
  if (runtimeEnv.ARTICLES_DATA_SOURCE !== 'd1') {
    return new Error('D1 is not configured as the article data source.');
  }
  return new Error('D1 is selected but ARTICLES_D1_READY is not true.');
}

/**
 * D1 is the only article read source. Fail explicitly when it is unavailable
 * so an outage cannot silently serve stale data from another database.
 */
export async function listPublishedArticles(
  runtimeEnv: ArticleRuntimeEnv
): Promise<ArticleListResult> {
  if (!isD1Ready(runtimeEnv)) {
    return { data: [], error: d1UnavailableError(runtimeEnv) };
  }

  try {
    const result = await runtimeEnv.DB!
      .prepare(
        `SELECT ${PUBLIC_ARTICLE_COLUMNS} FROM articles WHERE status = ? ORDER BY published_at DESC, id ASC`
      )
      .bind('published')
      .all<ArticleRecord>();

    if (result.success === false) {
      throw new Error(result.error || 'D1 query failed.');
    }

    return { data: result.results ?? [], error: null };
  } catch (error) {
    console.error('D1 article query failed.', error);
    return { data: [], error };
  }
}

export async function getPublishedArticleBySlug(
  runtimeEnv: ArticleRuntimeEnv,
  slug: string
): Promise<ArticleResult> {
  if (!isD1Ready(runtimeEnv)) {
    return { data: null, error: d1UnavailableError(runtimeEnv) };
  }

  try {
    const article = await runtimeEnv.DB!
      .prepare(
        `SELECT ${PUBLIC_ARTICLE_COLUMNS} FROM articles WHERE slug = ? AND status = ? ORDER BY published_at DESC, id ASC LIMIT 1`
      )
      .bind(slug, 'published')
      .first<ArticleRecord>();

    return { data: article, error: null };
  } catch (error) {
    console.error('D1 article lookup failed.', error);
    return { data: null, error };
  }
}
