'use strict';
// Maintenance-time patch only. The application does NOT modify its own source at runtime.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const filename = path.resolve(__dirname, '..', 'server.js');
let source = fs.readFileSync(filename, 'utf8');
const oldBlock = `const pool = new Pool({
  connectionString: DATABASE_URL,
  connectionTimeoutMillis: 7000,
  idleTimeoutMillis: 30000,
  query_timeout: 15000,
  statement_timeout: 15000,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
});`;
const newBlock = `const { buildDatabaseConfig } = require('./lib/database-config.cjs');
const pool = new Pool(buildDatabaseConfig());`;
if (source.includes(newBlock)) {
  console.log('Database CA configuration already applied.');
} else {
  assert.equal(source.split(oldBlock).length, 2, 'Expected exactly one original Pool configuration');
  source = source.replace(oldBlock, () => newBlock);
  fs.writeFileSync(filename, source);
  console.log('Database CA configuration applied; certificate verification stays enabled.');
}
