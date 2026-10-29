# Supabase `articles` → Cloudflare D1 migration

This migration is deliberately staged. The app continues to use Supabase by default until the D1 schema and data are verified. Keep the existing Supabase project available as a rollback source until the final cutover is confirmed.

## What this PR changes

- Adds D1 read support for the homepage and article detail route.
- Keeps Supabase as the default source and automatic fallback.
- Adds an authenticated `POST /api/articles` endpoint for n8n and bulk imports.
- Adds a D1 schema and scripts to export/import articles without committing article data or secrets.
- Changes the dynamic article route to resolve the slug at request time, which matches the existing Astro Cloudflare server-rendered configuration.

## 1. Create and bind D1

From the repository root, with Wrangler authenticated to the correct Cloudflare account:

```sh
npx wrangler d1 create ai-publication-news
```

Copy the returned database ID. Add the binding to the root `wrangler.jsonc` (do not commit a placeholder ID):

```json
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "ai-publication-news",
    "database_id": "PASTE_THE_REAL_DATABASE_ID_HERE"
  }
]
```

Place `d1_databases` alongside `name`, `compatibility_date`, and `assets` at the root of the JSONC config. Keep the real database ID in configuration, but never commit API tokens or secret values.

Create the schema:

```sh
npx wrangler d1 execute ai-publication-news --remote --file=migrations/d1/0001_articles.sql
```

## 2. Configure the write token

Generate a long random token and configure it as a Worker secret:

```sh
npx wrangler secret put ARTICLES_WRITE_TOKEN
```

Use the same token as the `D1_WRITE_TOKEN` environment variable for the import script and as a protected n8n credential. Never put it in browser code, source control, or a public `PUBLIC_*` variable.

The API accepts one article or up to five articles per request. Each article must contain a valid `source_url`. The endpoint upserts by `source_url`, so retrying an interrupted import is safe.

## 3. Export the current Supabase data

Run this locally, using environment variables rather than putting secrets in source control:

```sh
# Use a service-role key only in your local terminal for this export.
# The script also accepts PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_KEY.
node scripts/export-articles-from-supabase.mjs
```

The default output is `.migration-data/articles.json`, which is ignored by Git. Check the exported count against the source database before importing. The current source was inspected during preparation and had 577 published articles.

## 4. Deploy the endpoint, then import

Deploy this branch through the existing Cloudflare Worker pipeline only after the real D1 binding and secret have been configured. Until `ARTICLES_DATA_SOURCE=d1` is set, the website continues to read from Supabase.

Then run:

```sh
D1_IMPORT_URL=https://YOUR_SITE_DOMAIN/api/articles D1_WRITE_TOKEN=YOUR_SECRET node scripts/import-articles-to-d1.mjs
```

On Windows PowerShell, set the two environment variables with `$env:D1_IMPORT_URL=...` and `$env:D1_WRITE_TOKEN=...` before running the Node script. Use the actual public site URL.

Verify the remote row counts:

```sh
npx wrangler d1 execute ai-publication-news --remote --command="SELECT status, COUNT(*) AS count FROM articles GROUP BY status"
npx wrangler d1 execute ai-publication-news --remote --command="SELECT COUNT(*) AS count, COUNT(DISTINCT source_url) AS unique_sources FROM articles"
```

Confirm the imported published count is at least the expected count before switching the read source. The application defaults `D1_MIN_ARTICLE_COUNT` to 577 as a safety guard; set it explicitly if the expected baseline changes.

## 5. Dual-write from n8n, then cut over

Before switching reads, update the n8n publication workflow to send each fully prepared article to `POST /api/articles` with:

- Header: `Authorization: Bearer <ARTICLES_WRITE_TOKEN>`
- Header: `Content-Type: application/json`
- JSON body: the same article fields currently written to Supabase (or `{ "article": { ... } }`).

For a safe transition, keep the existing Supabase write in place while testing the D1 HTTP Request node. Confirm new and updated articles appear in both databases, and confirm article detail URLs still render.

Only after the import and dual-write checks pass, set the Worker variable `ARTICLES_DATA_SOURCE=d1`. The code will use D1 only when the published row count meets the safety threshold; otherwise it logs a warning and falls back to Supabase. Keep Supabase available during this observation period.

## 6. Validation and rollback

- Open the homepage and several older article URLs.
- Confirm structured articles and standard articles render correctly.
- Publish one test article through n8n and confirm it appears on the homepage and its slug URL.
- Check Worker logs for D1 query errors.
- To roll back reads, change `ARTICLES_DATA_SOURCE` to `supabase`; no data is deleted.
- Do not pause or delete the old Supabase project until the D1 read path and n8n writes have been verified in production.

## Known limits

- D1 stores `score` as a numeric `REAL` and `validation` as JSON text. The website only needs the numeric score for display; preserve JSON serialization for `validation`.
- The n8n workflow is external to this GitHub repository, so this PR cannot update it automatically. The dual-write step above is required before cutover.
- Supabase client code remains intentionally in place for fallback. Removing the dependency and pausing the old project should be a separate cleanup after the migration is stable.
