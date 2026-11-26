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
 * Lightweight homepage read path. The homepage only needs card metadata;
 * avoid transferring the potentially large structured article body.
 */
const HOMEPAGE_ARTICLE_COLUMNS = [
  'slug',
  'published_at',
  'category',
  'title',
  'source_title',
  'source_name',
  'score',
].join(', ');

export async function listHomepageArticles(
  runtimeEnv: ArticleRuntimeEnv
): Promise<ArticleListResult> {
  if (!isD1Ready(runtimeEnv)) {
    return { data: [], error: d1UnavailableError(runtimeEnv) };
  }

  try {
    const result = await runtimeEnv.DB!
      .prepare(
        `SELECT ${HOMEPAGE_ARTICLE_COLUMNS},
                COALESCE(
                  summary,
                  CASE
                    WHEN json_valid(content)
                    THEN json_extract(content, '$.problem_statement.what_wasnt_working')
                  END
                ) AS summary
         FROM articles
         WHERE status = ?
         ORDER BY published_at DESC, id ASC`
      )
      .bind('published')
      .all<ArticleRecord>();

    if (result.success === false) {
      throw new Error(result.error || 'D1 homepage query failed.');
    }

    return { data: result.results ?? [], error: null };
  } catch (error) {
    console.error('D1 homepage article query failed.', error);
    return { data: [], error };
  }
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


export type HomepageArchiveCursor = {
  published_at: string;
  id: string;
};

export type HomepageArchivePage = {
  data: ArticleRecord[];
  hasMore: boolean;
  nextCursor: HomepageArchiveCursor | null;
};

const HOMEPAGE_CARD_COLUMNS = `
  slug,
  published_at,
  category,
  title,
  source_title,
  source_name,
  score,
  COALESCE(
    summary,
    CASE
      WHEN json_valid(content)
      THEN json_extract(content, '$.problem_statement.what_wasnt_working')
    END
  ) AS summary
`;

export async function listHomepageRecentArticles(
  runtimeEnv: ArticleRuntimeEnv,
  since: string,
  limit = 30
): Promise<ArticleListResult> {
  if (!isD1Ready(runtimeEnv)) {
    return { data: [], error: d1UnavailableError(runtimeEnv) };
  }

  // Bound homepage SSR work even when an unusually large number of articles
  // are published in the recent window.
  const safeLimit = Math.min(50, Math.max(1, Math.floor(limit) || 30));

  try {
    const result = await runtimeEnv.DB!
      .prepare(
        `SELECT ${HOMEPAGE_CARD_COLUMNS}
         FROM articles
         WHERE status = ? AND published_at >= ?
         ORDER BY published_at DESC, id ASC
         LIMIT ?`
      )
      .bind('published', since, safeLimit)
      .all<ArticleRecord>();

    if (result.success === false) {
      throw new Error(result.error || 'D1 recent homepage query failed.');
    }

    return { data: result.results ?? [], error: null };
  } catch (error) {
    console.error('D1 recent homepage article query failed.', error);
    return { data: [], error };
  }
}

export async function listHomepageArchiveArticles(
  runtimeEnv: ArticleRuntimeEnv,
  before: string,
  limit = 10,
  cursor?: HomepageArchiveCursor | null,
  category?: string,
  search?: string
): Promise<HomepageArchivePage & { error: unknown | null }> {
  if (!isD1Ready(runtimeEnv)) {
    return { data: [], hasMore: false, nextCursor: null, error: d1UnavailableError(runtimeEnv) };
  }

  const safeLimit = Math.min(30, Math.max(1, Math.floor(limit) || 10));
  const conditions = ['status = ?', 'published_at < ?'];
  const values: Array<string | number | null> = ['published', before];

  if (category) {
    conditions.push('LOWER(COALESCE(category, \'Other\')) = ?');
    values.push(category.trim().toLowerCase());
  }

  if (search) {
    const term = `%${search.trim().slice(0, 100)}%`;
    conditions.push(`(
      COALESCE(title, source_title, '') LIKE ? COLLATE NOCASE OR
      COALESCE(source_title, '') LIKE ? COLLATE NOCASE OR
      COALESCE(source_name, '') LIKE ? COLLATE NOCASE OR
      COALESCE(category, '') LIKE ? COLLATE NOCASE OR
      COALESCE(summary, CASE
        WHEN json_valid(content)
        THEN json_extract(content, '$.problem_statement.what_wasnt_working')
      END, '') LIKE ? COLLATE NOCASE
    )`);
    values.push(term, term, term, term, term);
  }

  if (cursor?.published_at && cursor?.id) {
    conditions.push('(published_at < ? OR (published_at = ? AND id > ?))');
    values.push(cursor.published_at, cursor.published_at, cursor.id);
  }

  try {
    const result = await runtimeEnv.DB!
      .prepare(
        `SELECT ${HOMEPAGE_CARD_COLUMNS}
         FROM articles
         WHERE ${conditions.join(' AND ')}
         ORDER BY published_at DESC, id ASC
         LIMIT ?`
      )
      .bind(...values, safeLimit + 1)
      .all<ArticleRecord>();

    if (result.success === false) {
      throw new Error(result.error || 'D1 archive query failed.');
    }

    const rows = result.results ?? [];
    const hasMore = rows.length > safeLimit;
    const data = hasMore ? rows.slice(0, safeLimit) : rows;
    const last = data[data.length - 1];

    return {
      data,
      hasMore,
      nextCursor: hasMore && last?.published_at && last?.id
        ? { published_at: String(last.published_at), id: String(last.id) }
        : null,
      error: null,
    };
  } catch (error) {
    console.error('D1 homepage archive query failed.', error);
    return { data: [], hasMore: false, nextCursor: null, error };
  }
}

export async function listHomepageCategories(
  runtimeEnv: ArticleRuntimeEnv
): Promise<{ data: string[]; error: unknown | null }> {
  if (!isD1Ready(runtimeEnv)) {
    return { data: [], error: d1UnavailableError(runtimeEnv) };
  }

  try {
    const result = await runtimeEnv.DB!
      .prepare(
        `SELECT DISTINCT TRIM(category) AS category
         FROM articles
         WHERE status = ? AND category IS NOT NULL AND TRIM(category) <> ''
         ORDER BY category COLLATE NOCASE`
      )
      .bind('published')
      .all<{ category: string }>();

    if (result.success === false) {
      throw new Error(result.error || 'D1 category query failed.');
    }

    return { data: (result.results ?? []).map((row) => row.category), error: null };
  } catch (error) {
    console.error('D1 homepage category query failed.', error);
    return { data: [], error };
  }
}

export async function getHomepageArticleCounts(
  runtimeEnv: ArticleRuntimeEnv,
  todayStart: string,
  weekStart: string,
  archiveBefore: string
): Promise<{ today: number; week: number; archive: number; error: unknown | null }> {
  if (!isD1Ready(runtimeEnv)) {
    return { today: 0, week: 0, archive: 0, error: d1UnavailableError(runtimeEnv) };
  }

  try {
    const result = await runtimeEnv.DB!
      .prepare(
        `SELECT
           SUM(CASE WHEN published_at >= ? THEN 1 ELSE 0 END) AS today_count,
           SUM(CASE WHEN published_at >= ? THEN 1 ELSE 0 END) AS week_count,
           SUM(CASE WHEN published_at < ? THEN 1 ELSE 0 END) AS archive_count
         FROM articles
         WHERE status = ?`
      )
      .bind(todayStart, weekStart, archiveBefore, 'published')
      .first<{ today_count: number; week_count: number; archive_count: number }>();

    return {
      today: Number(result?.today_count ?? 0),
      week: Number(result?.week_count ?? 0),
      archive: Number(result?.archive_count ?? 0),
      error: null,
    };
  } catch (error) {
    console.error('D1 homepage count query failed.', error);
    return { today: 0, week: 0, archive: 0, error };
  }
}
