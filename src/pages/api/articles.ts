import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

type ArticleInput = Record<string, unknown>;
type SqlValue = string | number | null;
type D1BoundStatement = object;
type D1PreparedStatement = {
  bind(...values: SqlValue[]): D1BoundStatement;
};
type D1DatabaseBinding = {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1BoundStatement[]): Promise<unknown[]>;
};
type RuntimeEnv = {
  DB?: D1DatabaseBinding;
  ARTICLES_WRITE_TOKEN?: string;
};

const MAX_BATCH_SIZE = 5;
const MAX_BODY_CHARS = 8_000_000;

const UPSERT_SQL = `
  INSERT INTO articles (
    id, status, source_name, source_url, source_title, source_published_at,
    score, validation, review_status, slug, published_at, updated_at,
    category, content, title, summary, why_it_matters
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    status = excluded.status,
    source_name = excluded.source_name,
    source_url = excluded.source_url,
    source_title = excluded.source_title,
    source_published_at = excluded.source_published_at,
    score = excluded.score,
    validation = excluded.validation,
    review_status = excluded.review_status,
    slug = excluded.slug,
    published_at = excluded.published_at,
    updated_at = excluded.updated_at,
    category = excluded.category,
    content = excluded.content,
    title = excluded.title,
    summary = excluded.summary,
    why_it_matters = excluded.why_it_matters
`;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function jsonText(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function toStatement(db: D1DatabaseBinding, article: ArticleInput): D1BoundStatement | Response {
  const id = nullableText(article.id);
  if (!id) {
    return jsonResponse({ ok: false, error: 'Each article must include its stable id.' }, 400);
  }

  const sourceUrl = nullableText(article.source_url);
  if (!sourceUrl) {
    return jsonResponse({ ok: false, error: 'Each article must include source_url.' }, 400);
  }

  try {
    const parsedUrl = new URL(sourceUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return jsonResponse({ ok: false, error: 'source_url must use HTTP or HTTPS.' }, 400);
    }
  } catch {
    return jsonResponse({ ok: false, error: 'source_url must be a valid URL.' }, 400);
  }

  const rawScore = article.score;
  const score =
    rawScore === null || rawScore === undefined || rawScore === ''
      ? null
      : Number(rawScore);

  if (score !== null && !Number.isFinite(score)) {
    return jsonResponse({ ok: false, error: 'score must be a finite number or null.' }, 400);
  }

  return db.prepare(UPSERT_SQL).bind(
    id,
    nullableText(article.status) ?? 'draft',
    nullableText(article.source_name),
    sourceUrl,
    nullableText(article.source_title),
    nullableText(article.source_published_at),
    score,
    jsonText(article.validation),
    nullableText(article.review_status) ?? 'pending',
    nullableText(article.slug),
    nullableText(article.published_at),
    nullableText(article.updated_at) ?? new Date().toISOString(),
    nullableText(article.category),
    jsonText(article.content),
    nullableText(article.title),
    nullableText(article.summary),
    nullableText(article.why_it_matters)
  );
}

export const POST: APIRoute = async ({ request }) => {
  const runtimeEnv = env as unknown as RuntimeEnv;
  const expectedToken = runtimeEnv.ARTICLES_WRITE_TOKEN;

  if (!expectedToken) {
    return jsonResponse({ ok: false, error: 'Article write endpoint is not configured.' }, 503);
  }

  if (request.headers.get('authorization') !== `Bearer ${expectedToken}`) {
    return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401);
  }

  if (!runtimeEnv.DB) {
    return jsonResponse({ ok: false, error: 'D1 database binding is not configured.' }, 503);
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_CHARS) {
    return jsonResponse({ ok: false, error: 'Request body is too large.' }, 413);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ ok: false, error: 'Request body must be valid JSON.' }, 400);
  }

  const candidate = payload as { articles?: unknown; article?: unknown } | ArticleInput | null;
  const rawArticles = candidate && Array.isArray((candidate as { articles?: unknown }).articles)
    ? (candidate as { articles: unknown[] }).articles
    : candidate && typeof candidate === 'object' && 'article' in candidate
      ? [(candidate as { article: unknown }).article]
      : candidate && typeof candidate === 'object'
        ? [candidate]
        : [];

  if (rawArticles.length === 0 || rawArticles.length > MAX_BATCH_SIZE) {
    return jsonResponse(
      { ok: false, error: `Send between 1 and ${MAX_BATCH_SIZE} articles per request.` },
      400
    );
  }

  const statements: D1BoundStatement[] = [];
  const articleIds: string[] = [];
  for (const rawArticle of rawArticles) {
    if (!rawArticle || typeof rawArticle !== 'object' || Array.isArray(rawArticle)) {
      return jsonResponse({ ok: false, error: 'Each article must be a JSON object.' }, 400);
    }

    const statement = toStatement(runtimeEnv.DB, rawArticle as ArticleInput);
    if (statement instanceof Response) return statement;
    const articleId = nullableText((rawArticle as ArticleInput).id);
    if (!articleId) {
      return jsonResponse({ ok: false, error: 'Each article must include its stable id.' }, 400);
    }
    articleIds.push(articleId);
    statements.push(statement);
  }

  try {
    await runtimeEnv.DB.batch(statements);
    const response: Record<string, unknown> = {
      ok: true,
      upserted: statements.length,
      article_ids: articleIds,
    };
    if (articleIds.length === 1) response.id = articleIds[0];
    return jsonResponse(response);
  } catch (error) {
    console.error('Failed to upsert articles into D1.', error);
    return jsonResponse({ ok: false, error: 'Unable to save articles.' }, 500);
  }
};
