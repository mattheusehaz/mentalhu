#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { prepareArticle, articleRevision, validateApprovedPackage, legacyArticle, APPROVED_DIRECTORY } = require('../lib/editorial-import.cjs');
const root = path.join(__dirname, '..');

try {
  const [mode, filename, destination] = process.argv.slice(2);
  if (mode === '--prepare') {
    if (!filename || !destination) throw new Error('Usage: --prepare input.json prepared.json');
    const prepared = prepareArticle(JSON.parse(fs.readFileSync(filename, 'utf8')));
    fs.writeFileSync(destination, JSON.stringify(prepared, null, 2) + '\n', { flag:'wx' });
    console.log(JSON.stringify({ prepared_file:destination, revision_sha256:articleRevision(prepared), published:false }));
  } else if (mode === '--hash') {
    if (!filename) throw new Error('Usage: --hash prepared-article.json');
    console.log(articleRevision(JSON.parse(fs.readFileSync(filename, 'utf8'))));
  } else if (mode === '--package') {
    if (!filename) throw new Error('Usage: --package approved-package.json');
    const result = validateApprovedPackage(JSON.parse(fs.readFileSync(filename, 'utf8')));
    console.log(JSON.stringify({ valid:true, external_id:result.article.external_id, revision_sha256:result.revision }));
  } else if (mode) {
    throw new Error('Unknown argument. Use no arguments, --prepare, --hash or --package.');
  } else {
    const legacy = fs.readdirSync(path.join(root, 'cikkek')).filter(file => file.endsWith('.html'));
    for (const file of legacy) legacyArticle(fs.readFileSync(path.join(root, 'cikkek', file), 'utf8'), file);
    const directory = path.join(root, APPROVED_DIRECTORY);
    const approved = fs.existsSync(directory) ? fs.readdirSync(directory).filter(file => file.endsWith('.json')) : [];
    for (const file of approved) {
      const result = validateApprovedPackage(JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')));
      if (file !== result.article.external_id + '.json') throw new Error('PACKAGE_FILENAME_MISMATCH: ' + file);
    }
    console.log(JSON.stringify({ valid:true, legacy_articles:legacy.length, approved_packages:approved.length, published:false }));
  }
} catch (error) {
  console.error(error.code || error.message);
  process.exitCode = 1;
}
