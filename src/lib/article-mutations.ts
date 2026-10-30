import { createClient } from '@supabase/supabase-js';
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
  ARTICLES_DUAL_WRITE?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
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

function dualWriteEnabled(): boolean {
  return runtimeEnv.ARTICLES_DUAL_WRITE === 'true';
}

function getSupabase() {
  // Prefer Worker runtime secrets. The build-time fallback preserves the
  // existing deployment until those secrets are moved into Worker settings.
  const url = runtimeEnv.SUPABASE_URL ?? import.meta.env.SUPABASE_URL;
  const key = runtimeEnv.SUPABASE_SERVICE_ROLE_KEY ?? import.meta.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase server credentials are not configured.');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function failure(status: number, error: string): MutationFailure {
  return { ok: false, status, error };
}

async function updateD1ReviewStatus(id: string, status: string): Promise<void> {
  if (!runtimeEnv.DB) throw new Error('D1 database binding is not configured.');
  const result = await runtimeEnv.DB
    .prepare('UPDATE articles SET review_status = ?, updated_at = ? WHERE id = ?')
    .bind(status, new Date().toISOString(), id)
    .run();

  if (result.success === false) throw new Error(result.error || 'D1 review update failed.');
  if (result.meta?.changes === 0) throw new Error('Article does not exist in D1.');
}

async function mirrorReviewStatusToSupabase(id: string, status: string): Promise<void> {
  const { data, error } = await getSupabase()
    .from('articles')
    .update({ review_status: status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error('Article does not exist in Supabase.');
}

export async function updateArticleReviewStatus(
  id: string,
  targetStatus: 'approved' | 'rejected'
): Promise<MutationResult> {
  if (!id) return failure(400, 'Missing article ID.');

  const useD1 = d1IsPrimary();
  if (runtimeEnv.ARTICLES_DATA_SOURCE === 'd1' && !useD1) {
    return failure(503, 'D1 is selected but ARTICLES_D1_READY is not true or the DB binding is missing.');
  }
  if (dualWriteEnabled() && !d1Ready()) {
    return failure(503, 'Dual-write is enabled but D1 has not been marked ready.');
  }

  try {
    if (useD1) {
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
      if (dualWriteEnabled()) await mirrorReviewStatusToSupabase(id, targetStatus);

      return {
        ok: true,
        article: { ...current, review_status: targetStatus },
      };
    }

    const supabase = getSupabase();
    const { data: current, error: fetchError } = await supabase
      .from('articles')
      .select('id, title, slug, review_status, status, published_at')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) return failure(500, fetchError.message);
    if (!current) return failure(404, 'Article not found in Supabase.');
    if (current.review_status !== 'pending' && current.review_status !== targetStatus) {
      return failure(409, 'Article has already been reviewed with a different decision.');
    }

    if (current.review_status !== targetStatus) {
      const { error: updateError } = await supabase
        .from('articles')
        .update({ review_status: targetStatus, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (updateError) return failure(500, updateError.message);
    }

    if (dualWriteEnabled()) await updateD1ReviewStatus(id, targetStatus);

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
      "UPDATE articles SET status = 'published', slug = ?, published_at = ?, updated_at = ? WHERE id = ?"
    )
    .bind(slug, publishedAt, publishedAt, id)
    .run();

  if (result.success === false) throw new Error(result.error || 'D1 publish update failed.');
  if (result.meta?.changes === 0) throw new Error('Article does not exist in D1.');
}

async function mirrorPublishedStateToSupabase(
  id: string,
  slug: string,
  publishedAt: string
): Promise<void> {
  const { data, error } = await getSupabase()
    .from('articles')
    .update({ status: 'published', slug, published_at: publishedAt, updated_at: publishedAt })
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error('Article does not exist in Supabase.');
}

export async function publishArticle(id: string): Promise<MutationResult> {
  if (!id) return failure(400, 'Missing article ID.');

  const useD1 = d1IsPrimary();
  if (runtimeEnv.ARTICLES_DATA_SOURCE === 'd1' && !useD1) {
    return failure(503, 'D1 is selected but ARTICLES_D1_READY is not true or the DB binding is missing.');
  }
  if (dualWriteEnabled() && !d1Ready()) {
    return failure(503, 'Dual-write is enabled but D1 has not been marked ready.');
  }

  try {
    if (useD1) {
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
      if (dualWriteEnabled()) await mirrorPublishedStateToSupabase(id, slug, publishedAt);

      return {
        ok: true,
        article: { ...current, status: 'published', slug, published_at: publishedAt },
      };
    }

    const supabase = getSupabase();
    const { data: current, error: fetchError } = await supabase
      .from('articles')
      .select('id, title, slug, review_status, status, published_at')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) return failure(500, fetchError.message);
    if (!current) return failure(404, 'Article ID not found in Supabase.');
    if (current.review_status !== 'approved') return failure(400, 'Article is not approved.');
    if (current.status !== 'draft' && current.status !== 'published') {
      return failure(400, 'Article is not a draft.');
    }

    const slug = current.slug || makeSlug(current.title);
    const publishedAt = current.published_at || new Date().toISOString();

    if (current.status !== 'published' || current.slug !== slug || !current.published_at) {
      const { error: updateError } = await supabase
        .from('articles')
        .update({
          status: 'published',
          slug,
          published_at: publishedAt,
          updated_at: publishedAt,
        })
        .eq('id', id)
        .eq('review_status', 'approved')
        .eq('status', 'draft');

      if (updateError) return failure(500, updateError.message);
    }

    if (dualWriteEnabled()) await updateD1PublishedState(id, slug, publishedAt);

    return {
      ok: true,
      article: { ...current, status: 'published', slug, published_at: publishedAt },
    };
  } catch (error) {
    console.error('Article publish operation failed.', error);
    return failure(502, error instanceof Error ? error.message : 'Article publish operation failed.');
  }
}
