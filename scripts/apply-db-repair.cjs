'use strict';
// Idempotent repair of the initial scaffold. No production credentials are used.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const serverFile = path.join(root, 'server.js');
const seedFile = path.join(root, 'migrations/003_public_seed.sql');
let server = fs.readFileSync(serverFile, 'utf8');
let seed = fs.readFileSync(seedFile, 'utf8');

function sqlFields(row) {
  const out = []; let start = 0, quoted = false, depth = 0;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === "'") {
      if (quoted && row[i + 1] === "'") { i++; continue; }
      quoted = !quoted;
    } else if (!quoted) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(row.slice(start, i)); start = i + 1; }
    }
  }
  out.push(row.slice(start)); return out;
}
let repairedRows = 0, seedRows = 0;
const conflictAt = seed.indexOf('ON CONFLICT (slug)');
assert(conflictAt > 0, 'Seed must contain the expected INSERT');
let head = seed.slice(0, conflictAt);
head = head.split('\n').map(line => {
  if (!line.startsWith("('")) return line;
  const match = line.match(/^\((.*)\)(,?)$/);
  assert(match, 'Unexpected seed row');
  const fields = sqlFields(match[1]);
  if (fields.length === 19) {
    assert.equal(fields[9], "''", 'Only the known extra empty field may be removed');
    fields.splice(9, 1); repairedRows++;
  }
  assert.equal(fields.length, 18, 'Seed row must match its 18 declared columns');
  seedRows++;
  return '(' + fields.join(',') + ')' + match[2];
}).join('\n');
assert.equal(seedRows, 51, 'Unexpected initial seed size');
seed = head + seed.slice(conflictAt);
seed = seed.replace(/ON CONFLICT \(slug\) DO UPDATE SET[\s\S]*?updated_at=now\(\);/, 'ON CONFLICT (slug) DO NOTHING;');
fs.writeFileSync(seedFile, seed);
console.log('Initial seed checked:', seedRows, 'rows; corrected:', repairedRows);

if (!server.includes('// Database readiness repair v1')) {
  function replaceOnce(from, to) {
    assert.equal(server.split(from).length, 2, 'Patch anchor must occur exactly once: ' + from.slice(0, 70));
    server = server.replace(from, () => to);
  }
  replaceOnce("  connectionString: DATABASE_URL,\n", "  connectionString: DATABASE_URL,\n  connectionTimeoutMillis: 7000,\n  idleTimeoutMillis: 30000,\n  query_timeout: 15000,\n  statement_timeout: 15000,\n");
  replaceOnce("app.set('trust proxy', 1);", String.raw`// Database readiness repair v1
const dbState = { phase: 'initializing', ready: false, error: null };
pool.on('error', err => console.error('[db] idle connection error:', err.code || 'CONNECTION_ERROR'));
function safeDbCode(err) {
  if (typeof err?.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(err.code)) return err.code;
  return /timeout|timed out/i.test(err?.message || '') ? 'DB_CONNECTION_TIMEOUT' : 'DATABASE_ERROR';
}
function unavailable(req, res) {
  res.set('Cache-Control', 'no-store');
  res.set('Retry-After', '15');
  res.status(503);
  if (req.path.startsWith('/api/') || req.path.startsWith('/health/')) {
    return res.json({ ok: false, error: 'A katalógus adatbázisa átmenetileg nem elérhető.', code: 'DATABASE_UNAVAILABLE' });
  }
  return res.type('html').send(directoryShell('A katalógus átmenetileg nem elérhető', '<main class="section"><h1>A katalógus átmenetileg nem elérhető</h1><p>Az adatbázis-kapcsolat jelenleg nem működik. Kérjük, próbáld újra később.</p><p><a href="/">Vissza a főoldalra</a></p></main>'));
}
app.set('trust proxy', 1);`);

  const migrationStart = server.indexOf('async function migrate() {');
  const migrationEnd = server.indexOf("\napp.get('/health',", migrationStart);
  assert(migrationStart >= 0 && migrationEnd > migrationStart, 'Migration block not found');
  server = server.slice(0, migrationStart) + String.raw`async function migrate() {
  const fs = require('fs');
  const zlib = require('zlib');
  const steps = ['001_init.sql', '002_directory.sql', '003_public_seed.sql'].map(name => ({
    name, sql: fs.readFileSync(path.join(ROOT, 'migrations', name), 'utf8')
  }));
  const parts = [0,1,2,3].map(i => fs.readFileSync(path.join(ROOT, 'migrations', '004_directory_expansion.sql.gz.b64.part' + i), 'utf8').trim());
  steps.push({ name: '004_directory_expansion', sql: zlib.gunzipSync(Buffer.from(parts.join(''), 'base64'), { maxOutputLength: 5 * 1024 * 1024 }).toString('utf8') });
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [6938035]);
    locked = true;
    await client.query('CREATE TABLE IF NOT EXISTS cms_schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    for (const step of steps) {
      const applied = await client.query('SELECT name FROM cms_schema_migrations WHERE name=$1', [step.name]);
      if (applied.rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(step.sql);
        await client.query('INSERT INTO cms_schema_migrations(name,checksum) VALUES($1,$2)', [step.name, crypto.createHash('sha256').update(step.sql).digest('hex')]);
        await client.query('COMMIT');
        console.log('[migration] applied:', step.name);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[migration] failed:', step.name, safeDbCode(err));
        throw err;
      }
    }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [6938035]).catch(() => {});
    client.release();
  }
}
` + server.slice(migrationEnd);

  const healthStart = server.indexOf("app.get('/health/db',");
  const healthEnd = server.indexOf("\napp.post('/api/admin/login',", healthStart);
  assert(healthStart >= 0 && healthEnd > healthStart, 'DB health block not found');
  server = server.slice(0, healthStart) + String.raw`app.get(['/health/db', '/health/ready'], async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await pool.query('SELECT 1');
    if (!dbState.ready) return res.status(503).json({ ok: false, database: true, migrations: false, phase: dbState.phase, code: dbState.error });
    const { rows } = await pool.query("SELECT (SELECT count(*)::int FROM directory_categories WHERE active=true) AS categories, (SELECT count(*)::int FROM directory_listings WHERE status='published') AS listings");
    res.status(200).json({ ok: true, database: true, migrations: true, ...rows[0] });
  } catch (err) {
    res.status(503).json({ ok: false, database: false, migrations: dbState.ready, phase: dbState.phase, code: safeDbCode(err) });
  }
});

// A fallback menu is not evidence that the database is ready.
app.use((req, res, next) => {
  const prefixes = ['/api/public/', '/api/directory/', '/api/newsletter/', '/api/admin/articles', '/api/admin/media', '/api/admin/subscribers', '/api/admin/directory/', '/kereses', '/kategoria/', '/szolgaltato/', '/cikk/', '/media/', '/leiratkozas/'];
  if (!dbState.ready && prefixes.some(prefix => req.path.startsWith(prefix))) return unavailable(req, res);
  next();
});
` + server.slice(healthEnd);

  const fallbackStart = server.indexOf("    console.error('categories API fallback:', err.message);");
  const fallbackEnd = server.indexOf("\n  }\n});", fallbackStart);
  assert(fallbackStart >= 0 && fallbackEnd > fallbackStart, 'Category fallback block not found');
  server = server.slice(0, fallbackStart) + "    console.error('[categories]', safeDbCode(err));\n    return unavailable(_req, res);" + server.slice(fallbackEnd);

  replaceOnce(`app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Szerverhiba.' });
});`, String.raw`app.use((err, req, res, _next) => {
  const code = safeDbCode(err);
  console.error('[request]', req.path, code);
  if (res.headersSent) return _next(err);
  if (/^(?:ECONN|ETIMEDOUT|ENOTFOUND|EHOST|ENET|DB_CONNECTION|DATABASE_ERROR|08|57P)/.test(code)) return unavailable(req, res);
  res.status(500).json({ error: 'A kérés feldolgozása nem sikerült.', code: 'REQUEST_FAILED' });
});`);

  const listenStart = server.indexOf("app.listen(PORT, '0.0.0.0', () => {");
  assert(listenStart >= 0, 'Listen block not found');
  server = server.slice(0, listenStart) + String.raw`async function initializeDatabase() {
  dbState.phase = 'migrating';
  try {
    if (!DATABASE_URL) throw Object.assign(new Error('Missing database configuration'), { code: 'DATABASE_URL_MISSING' });
    await migrate();
    dbState.ready = true;
    dbState.phase = 'ready';
    dbState.error = null;
    console.log('Database migrations completed');
  } catch (err) {
    dbState.ready = false;
    dbState.phase = 'failed';
    dbState.error = safeDbCode(err);
    console.error('[db] initialization failed:', dbState.error, 'Check DATABASE_URL, VPC routing and database trusted sources.');
    setTimeout(initializeDatabase, 15000).unref();
  }
}
app.listen(PORT, '0.0.0.0', () => {
  console.log('MENTÁL.hu CMS listening on 0.0.0.0:' + PORT);
  initializeDatabase();
});
`;
  fs.writeFileSync(serverFile, server);
  console.log('Database connection and readiness repair applied.');
} else {
  console.log('Database readiness repair already applied.');
}
