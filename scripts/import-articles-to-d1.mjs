import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const importUrl = process.env.D1_IMPORT_URL;
const writeToken = process.env.D1_WRITE_TOKEN;
const inputPath = resolve(process.argv[2] ?? '.migration-data/articles.json');

if (!importUrl || !writeToken) {
  throw new Error('Set D1_IMPORT_URL and D1_WRITE_TOKEN before importing.');
}

const articles = JSON.parse(await readFile(inputPath, 'utf8'));
if (!Array.isArray(articles)) {
  throw new Error('The import file must contain a JSON array of articles.');
}

const batchSize = 5;

for (let offset = 0; offset < articles.length; offset += batchSize) {
  const batch = articles.slice(offset, offset + batchSize);
  const response = await fetch(importUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${writeToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ articles: batch }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `D1 import failed for rows ${offset + 1}-${offset + batch.length} (HTTP ${response.status}): ${responseText.slice(0, 500)}`
    );
  }

  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error('D1 import endpoint returned an invalid JSON response.');
  }

  if (result.ok !== true || result.upserted !== batch.length) {
    throw new Error(`Unexpected D1 import response: ${responseText.slice(0, 500)}`);
  }

  console.log(`Imported ${Math.min(offset + batch.length, articles.length)} / ${articles.length}`);
}

console.log('Import complete. Re-running is safe because rows are upserted by source_url.');
