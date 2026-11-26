-- Remove only the obsolete legacy import that conflicts with the explicitly approved
-- AI workplace identity-loss article. The approved package is imported immediately
-- after migrations during the same application startup.
DELETE FROM article_import_ledger
WHERE import_key = 'legacy:hogyan-dolgozzuk-fel-az-ai-okozta-munkahelyi-identitasveszteseget.html';

DELETE FROM articles
WHERE slug = 'hogyan-dolgozzuk-fel-az-ai-okozta-munkahelyi-identitasveszteseget'
  AND publication_origin = 'legacy'
  AND external_id IS NULL;
