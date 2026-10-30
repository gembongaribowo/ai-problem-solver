# Supabase articles → Cloudflare D1 migration

This is a staged migration. Supabase remains the production read source until the D1 schema, import, article lifecycle writes, and website have been verified. Do not pause or delete the Supabase project during the migration or rollback window.

## Current configuration

The existing Cloudflare D1 database is already created:

- Database name: `articles`
- Database ID: `c49152f9-0560-442d-a64f-90a193e53fbf`
- Worker binding: `DB`
- Migration directory: `migrations/d1`

The binding is configured in the repository's root `wrangler.jsonc`.

The live Supabase baseline observed while preparing this migration was 581 rows: 578 published and 3 drafts. Re-check the live count at export time because n8n may have added or updated records since that inspection. All exported rows are included, not just published articles.

The live table has 17 columns. Supabase `score` is JSONB but all current values are numeric, so D1 stores it as REAL. `validation` is stored as JSON text. `content` remains text (object values received from an API are JSON-serialized).

There are two published records with the same slug. The D1 and Supabase fallback lookups now choose deterministically by newest `published_at`, then ID. The migration does not silently rewrite either article's existing slug.

## Runtime switches

Configure these as Cloudflare Worker variables (not `PUBLIC_*` variables):

| Variable | Initial value | Meaning |
|---|---|---|
| `ARTICLES_DATA_SOURCE` | `supabase` or unset | Which database serves website reads |
| `ARTICLES_D1_READY` | unset / `false` | Set to `true` only after import verification |
| `ARTICLES_DUAL_WRITE` | unset / `false` | Mirrors approval, rejection and publishing mutations to the other database |

The site only reads from D1 when both `ARTICLES_DATA_SOURCE=d1` and `ARTICLES_D1_READY=true`. Otherwise it keeps using Supabase. A D1 query error falls back to Supabase; a genuine D1 slug not-found result does not fall back to stale Supabase content.

The `POST /api/articles` endpoint always writes to D1 and requires the `ARTICLES_WRITE_TOKEN` Worker secret. It accepts one article or a batch of up to five articles. Every article must include its stable `id` and `source_url`. Upserts use `id`, not `source_url`.

The existing approval and rejection GET URLs are retained for compatibility with the current n8n/email flow. The publish endpoint remains POST. When `ARTICLES_DUAL_WRITE=true`, these lifecycle operations update both databases. When `ARTICLES_DATA_SOURCE=d1`, D1 becomes the primary database for those operations. The server-side Supabase mirror requires the Worker variable `SUPABASE_URL` and Worker secret `SUPABASE_SERVICE_ROLE_KEY`.

## Phase 1 — Apply the D1 schema

From the repository root, authenticate Wrangler to the Cloudflare account that owns the database:

```sh
npx wrangler d1 migrations list articles --remote
npx wrangler d1 migrations apply articles --remote
npx wrangler d1 migrations list articles --remote
```

Confirm that `0001_articles.sql` is shown as applied. This creates the `articles` table and indexes. It does not import article rows.

Do not run the schema file manually if Wrangler reports the migration as already applied. If you created an `articles` table manually in the dashboard, inspect its schema first: `CREATE TABLE IF NOT EXISTS` does not alter an existing table.

## Phase 2 — Configure Worker secrets and deploy

Set the D1 write token:

```sh
npx wrangler secret put ARTICLES_WRITE_TOKEN
```

Enter a long random token when prompted. Save the same value in your password manager and in n8n credentials. Do not commit it or put it in a `PUBLIC_*` variable.

The lifecycle mutation endpoints prefer server-side Worker credentials while Supabase is active or dual-write is enabled. For backward compatibility, they temporarily fall back to the existing build-time Supabase values; move these credentials into Worker settings before removing the old build variables:

```sh
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

Set `SUPABASE_URL` as a Worker variable (it is not a secret). Existing public Supabase read fallback also needs the existing `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_KEY` build variables if the site is still using Supabase for reads.

The repository's GitHub Actions workflow runs build and local D1 migration validation; it does not deploy the Worker. If Cloudflare is connected to deploy from `master`, wait for that deployment. Otherwise build and deploy using your existing Cloudflare Workers deployment process. Do not enable the D1 read switch yet.

## Phase 3 — Pause n8n briefly, export Supabase, and import D1

To avoid a snapshot race, temporarily pause the AI Publication News n8n workflow while taking the final export and importing it. Resume it after the import and dual-write configuration are ready.

Install dependencies and export using a Supabase service-role key:

```sh
npm ci
```

macOS/Linux:

```sh
export SUPABASE_URL="YOUR_SUPABASE_URL"
export SUPABASE_SERVICE_ROLE_KEY="YOUR_SUPABASE_SERVICE_ROLE_KEY"
node scripts/export-articles-from-supabase.mjs
```

Windows PowerShell:

```powershell
$env:SUPABASE_URL="YOUR_SUPABASE_URL"
$env:SUPABASE_SERVICE_ROLE_KEY="YOUR_SUPABASE_SERVICE_ROLE_KEY"
node scripts/export-articles-from-supabase.mjs
```

The export is written to `.migration-data/articles.json`, which is excluded from Git. The script requires the service-role key, checks IDs and source URLs for duplicates, reports status counts, and warns about duplicate slugs. Keep this file private.

Set the import endpoint and token, then run the import:

macOS/Linux:

```sh
export D1_IMPORT_URL="https://YOUR_PRODUCTION_DOMAIN/api/articles"
export D1_WRITE_TOKEN="YOUR_ARTICLES_WRITE_TOKEN"
node scripts/import-articles-to-d1.mjs
```

Windows PowerShell:

```powershell
$env:D1_IMPORT_URL="https://YOUR_PRODUCTION_DOMAIN/api/articles"
$env:D1_WRITE_TOKEN="YOUR_ARTICLES_WRITE_TOKEN"
node scripts/import-articles-to-d1.mjs
```

The importer sends five records per request. It is repeatable: rows are upserted by stable article ID. If it stops partway through, correct the issue and rerun it with the same export.

## Phase 4 — Verify the remote D1 data

Run these against the remote database:

```sh
npx wrangler d1 execute articles --remote --command="SELECT status, COUNT(*) AS count FROM articles GROUP BY status ORDER BY status"
```

```sh
npx wrangler d1 execute articles --remote --command="SELECT COUNT(*) AS total, COUNT(DISTINCT id) AS unique_ids, COUNT(DISTINCT source_url) AS unique_source_urls FROM articles"
```

```sh
npx wrangler d1 execute articles --remote --command="SELECT COUNT(*) AS missing_ids FROM articles WHERE id IS NULL OR id = '';"
```

```sh
npx wrangler d1 execute articles --remote --command="SELECT slug, COUNT(*) AS records FROM articles WHERE status = 'published' AND slug IS NOT NULL GROUP BY slug HAVING COUNT(*) > 1"
```

Expected totals should match the export file, not blindly the historical baseline. The previous baseline was 581 total / 578 published / 3 drafts. Unique IDs and unique source URLs should equal total rows. The duplicate-slug query is expected to report the known duplicate unless it has been resolved separately.

Compare a few rows by ID between the private export and D1, including one long-content article and one draft. Check that timestamps, `validation`, and `content` were preserved.

Only after these checks pass, set:

- `ARTICLES_D1_READY=true`
- `ARTICLES_DUAL_WRITE=true`
- Keep `ARTICLES_DATA_SOURCE=supabase` for now.

These flags can be set in the Cloudflare Worker settings or via Wrangler variables and a new deployment. Do not put secrets in `wrangler.jsonc`.

## Phase 5 — Configure n8n dual-write and test the full lifecycle

Keep the existing Supabase write node. After it successfully creates or updates an article, add an HTTP Request node to:

`POST https://YOUR_PRODUCTION_DOMAIN/api/articles`

Headers:

- `Authorization: Bearer YOUR_ARTICLES_WRITE_TOKEN`
- `Content-Type: application/json`

Body (the article object must contain the same Supabase-generated `id`):

```json
{
  "article": {
    "id": "THE_SUPABASE_ARTICLE_UUID",
    "source_url": "https://example.com/original-article",
    "status": "draft",
    "review_status": "pending"
  }
}
```

That is a minimal illustration only. In production, send every field from the complete Supabase row, including `source_name`, `source_title`, `score`, `validation`, `category`, `content`, `title`, `summary`, and `why_it_matters`.

The n8n HTTP Request node must run after the Supabase insert/update so that the generated article ID is available. Configure it to fail the workflow or retry on non-2xx responses; do not silently ignore a D1 write failure.

The existing approve/reject/publish routes now mirror lifecycle changes to D1 when dual-write is enabled. Test:

1. Create a new draft and confirm the same ID exists in both databases.
2. Approve it using the normal review flow; confirm both rows say `approved`.
3. Publish it using the normal n8n flow; confirm both rows have the same `status`, `slug`, and `published_at`.
4. Reject a separate test draft; confirm both rows say `rejected`.
5. Retry an approval or publish action; it should be idempotent and not create a duplicate.

Resume the n8n workflow after the D1 write node has been tested. Keep dual-write enabled during the observation period.

## Phase 6 — Cut over website reads to D1

After the import, n8n dual-write, and article lifecycle tests pass, set:

- `ARTICLES_DATA_SOURCE=d1`
- `ARTICLES_D1_READY=true`
- `ARTICLES_DUAL_WRITE=true` (keep mirroring to Supabase during rollback window)

Deploy the Worker or wait for the Cloudflare Git deployment. Then verify:

- Homepage shows the expected published article count and recent articles.
- Several existing article URLs load.
- The known duplicate slug resolves consistently.
- Search and category filters work.
- A newly published article appears on the homepage and detail page.
- Worker logs show no D1 errors or fallback warnings.

Rollback: set `ARTICLES_DATA_SOURCE=supabase` and redeploy. Keep `ARTICLES_DUAL_WRITE=true` during the rollback window so both databases continue to receive lifecycle changes.

After D1 has been stable for an observation period and a fresh export/backup is stored safely, set `ARTICLES_DUAL_WRITE=false`. Only then pause the old AI Publication News Supabase project to free the project slot. Do not delete it until you are confident you no longer need it.

## Operational notes

- The existing approval/rejection routes are GET endpoints because the current n8n/email integration may depend on those links. Their HTTP method and authentication should be revisited after inspecting the actual workflow; do not change those URLs blindly.
- The n8n workflow is external to this repository. Its article-creation dual-write node must be configured manually.
- Supabase remains available as a read fallback while configured. If the old project is paused, that fallback will no longer work; D1 must be healthy before pausing it.
- D1 is a SQLite database. PostgreSQL-specific JSONB and UUID types are represented as JSON text and TEXT respectively.
