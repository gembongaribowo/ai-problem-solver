import { env } from 'cloudflare:workers';

type D1RunResult = {
  success?: boolean;
  error?: string;
  meta?: { changes?: number };
};
type D1Statement = {
  bind(...values: Array<string | number | null>): {
    first<T = ArticleMutationRow>(): Promise<T | null>;
    run(): Promise<D1RunResult>;
  };
};
type D1DatabaseBinding = {
  prepare(sql: string): D1Statement;
};
type RuntimeEnv = {
  DB?: D1DatabaseBinding;
  ARTICLES_DATA_SOURCE?: string;
  ARTICLES_D1_READY?: string;
};
type ArticleMutationRow = {
  id: string;
  title: string | null;
  slug: string | null;
  review_status: string | null;
  status: string | null;
  published_at: string | null;
};
type MutationSuccess = {
  ok: true;
  article: ArticleMutationRow;
};
type MutationFailure = {
  ok: false;
  status: number;
  error: string;
};
export type MutationResult = MutationSuccess | MutationFailure;

const runtimeEnv = env as unknown as RuntimeEnv;

function d1Ready(): boolean {
  return Boolean(runtimeEnv.DB && runtimeEnv.ARTICLES_D1_READY === 'true');
}

function d1IsPrimary(): boolean {
  return runtimeEnv.ARTICLES_DATA_SOURCE === 'd1' && d1Ready();
}

function failure(status: number, error: string): MutationFailure {
  return { ok: false, status, error };
}

async function updateD1ReviewStatus(id: string, status: string): Promise<void> {
  if (!runtimeEnv.DB) throw new Error('D1 database binding is not configured.');
  const result = await runtimeEnv.DB
    .prepare(
      "UPDATE articles SET review_status = ?, updated_at = ? WHERE id = ? AND (review_status = 'pending' OR review_status = ?)"
    )
    .bind(status, new Date().toISOString(), id, status)
    .run();

  if (result.success === false) throw new Error(result.error || 'D1 review update failed.');
  if (result.meta?.changes === 0) {
    throw new Error('Article review status changed concurrently or article does not exist in D1.');
  }
}

export async function updateArticleReviewStatus(
  id: string,
  targetStatus: 'approved' | 'rejected'
): Promise<MutationResult> {
  if (!id) return failure(400, 'Missing article ID.');
  if (!d1IsPrimary()) {
    return failure(503, 'D1 is not configured and ready as the article data source.');
  }

  try {
    const current = await runtimeEnv.DB!
      .prepare('SELECT id, title, slug, review_status, status, published_at FROM articles WHERE id = ?')
      .bind(id)
      .first<ArticleMutationRow>();

    if (!current) return failure(404, 'Article not found in D1.');
    if (current.review_status !== 'pending' && current.review_status !== targetStatus) {
      return failure(409, 'Article has already been reviewed with a different decision.');
    }

    if (current.review_status !== targetStatus) {
      await updateD1ReviewStatus(id, targetStatus);
    }

    return {
      ok: true,
      article: { ...current, review_status: targetStatus },
    };
  } catch (error) {
    console.error('Article review update failed.', error);
    return failure(502, error instanceof Error ? error.message : 'Article review update failed.');
  }
}

function makeSlug(title: string | null): string {
  return String(title ?? 'untitled')
    .toLowerCase()
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function updateD1PublishedState(id: string, slug: string, publishedAt: string): Promise<void> {
  if (!runtimeEnv.DB) throw new Error('D1 database binding is not configured.');
  const result = await runtimeEnv.DB
    .prepare(
      "UPDATE articles SET status = 'published', slug = ?, published_at = ?, updated_at = ? WHERE id = ? AND review_status = 'approved' AND status IN ('draft', 'published')"
    )
    .bind(slug, publishedAt, publishedAt, id)
    .run();

  if (result.success === false) throw new Error(result.error || 'D1 publish update failed.');
  if (result.meta?.changes === 0) {
    throw new Error('Article publishing state changed or article does not exist in D1.');
  }
}

export async function publishArticle(id: string): Promise<MutationResult> {
  if (!id) return failure(400, 'Missing article ID.');
  if (!d1IsPrimary()) {
    return failure(503, 'D1 is not configured and ready as the article data source.');
  }

  try {
    const current = await runtimeEnv.DB!
      .prepare('SELECT id, title, slug, review_status, status, published_at FROM articles WHERE id = ?')
      .bind(id)
      .first<ArticleMutationRow>();

    if (!current) return failure(404, 'Article ID not found in D1.');
    if (current.review_status !== 'approved') {
      return failure(400, 'Article is not approved.');
    }
    if (current.status !== 'draft' && current.status !== 'published') {
      return failure(400, 'Article is not a draft.');
    }

    const slug = current.slug || makeSlug(current.title);
    const publishedAt = current.published_at || new Date().toISOString();

    if (current.status !== 'published' || current.slug !== slug || !current.published_at) {
      await updateD1PublishedState(id, slug, publishedAt);
    }

    return {
      ok: true,
      article: { ...current, status: 'published', slug, published_at: publishedAt },
    };
  } catch (error) {
    console.error('Article publish operation failed.', error);
    return failure(502, error instanceof Error ? error.message : 'Article publish operation failed.');
  }
}
