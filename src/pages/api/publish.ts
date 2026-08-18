import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';

export const POST: APIRoute = async ({ request }) => {
  try {
    // 1. Get article ID from n8n
    const body = await request.json();
    const articleId = body.id;

    if (!articleId) {
      return new Response(
        JSON.stringify({
          error: 'Missing article ID',
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
    }

    // 2. Connect to Supabase
    const supabase = createClient(
      import.meta.env.SUPABASE_URL,
      import.meta.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // 3. Find the article by ID FIRST
    //    We intentionally do NOT filter by status/review_status here.
    //    This allows us to diagnose exactly what is wrong.
    const { data: article, error: fetchError } = await supabase
      .from('articles')
      .select(
        'id, title, slug, review_status, status, published_at'
      )
      .eq('id', articleId)
      .single();

    // 4. Article ID does not exist
    if (fetchError || !article) {
      return new Response(
        JSON.stringify({
          error: 'Article ID not found',
          articleId,
          details: fetchError?.message || null,
        }),
        {
          status: 404,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
    }

    // 5. Article exists, but is not approved
    if (article.review_status !== 'approved') {
      return new Response(
        JSON.stringify({
          error: 'Article is not approved',
          articleId,
          review_status: article.review_status,
          status: article.status,
          published_at: article.published_at,
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
    }

    // 6. Article exists and is approved,
    //    but is not currently a draft
    if (article.status !== 'draft') {
      return new Response(
        JSON.stringify({
          error: 'Article is not a draft',
          articleId,
          review_status: article.review_status,
          status: article.status,
          published_at: article.published_at,
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
    }

    // 7. Generate slug if one doesn't exist
    const slug =
      article.slug ||
      article.title
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');

    // 8. Generate publication timestamp
    const publishedAt = new Date().toISOString();

    // 9. Publish the article
    const { data: updatedArticle, error: updateError } =
      await supabase
        .from('articles')
        .update({
          status: 'published',
          slug,
          published_at: publishedAt,
        })
        .eq('id', articleId)
        .eq('review_status', 'approved')
        .eq('status', 'draft')
        .select(
          'id, title, slug, status, review_status, published_at'
        )
        .single();

    // 10. Update failed
    if (updateError || !updatedArticle) {
      return new Response(
        JSON.stringify({
          error: 'Failed to publish article',
          articleId,
          details: updateError?.message || null,
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
    }

    // 11. Success
    return new Response(
      JSON.stringify({
        success: true,
        message: 'Article published successfully',
        article: {
          id: updatedArticle.id,
          title: updatedArticle.title,
          slug: updatedArticle.slug,
          status: updatedArticle.status,
          review_status: updatedArticle.review_status,
          published_at: updatedArticle.published_at,
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error) {
    // 12. Unexpected error
    return new Response(
      JSON.stringify({
        error: 'Invalid request',
        details:
          error instanceof Error
            ? error.message
            : String(error),
      }),
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  }
};