'use strict';
// One-time repair, run from the application Console. Never stores administrator credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const ident = value => '"' + String(value).replace(/"/g, '""') + '"';

function readAdminPassword() {
  // Password goes only from the terminal to this process, never into shell history or a file.
  const r = spawnSync('bash', ['-c', 'IFS= read -r -s -p "doadmin jelszo (nem lathato, utana Enter): " p < /dev/tty; rc=$?; printf "\\n" > /dev/tty; [ "$rc" -eq 0 ] || exit "$rc"; printf "%s" "$p"; unset p'], {
    stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8', timeout: 180000, maxBuffer: 32768
  });
  if (r.error || r.status !== 0 || !r.stdout) throw Object.assign(new Error('A doadmin jelszava nem lett megadva; nem tortent jogosultsagmodositas.'), { code: 'ADMIN_PASSWORD_REQUIRED' });
  return r.stdout;
}

async function repairDatabase({ root = process.cwd(), env = process.env, getAdminPassword = readAdminPassword, adminUser = 'doadmin', log = console.log, verifyHttp = true, readinessTimeout = 45000 } = {}) {
  const appRequire = createRequire(path.join(root, 'package.json'));
  const { Client } = appRequire('pg');
  const { buildDatabaseConfig } = appRequire('./lib/database-config.cjs');
  const config = buildDatabaseConfig(env);
  if (!config.connectionString) throw new Error('A DATABASE_URL hianyzik. A mentalhu2 alkalmazas Console-jaban futtasd.');
  const app = new Client(config);
  let locked = false, transaction = false, stage = 'kapcsolodas';
  try {
    await app.connect();
    const identity = (await app.query("SELECT current_user AS db_user, current_database() AS db_name, has_schema_privilege(current_user,'public','USAGE') AS public_usage, has_schema_privilege(current_user,'public','CREATE') AS public_create")).rows[0];
    log('Kapcsolat rendben: ' + identity.db_user + ' / ' + identity.db_name);
    if (!identity.public_usage || !identity.public_create) {
      stage = 'schema-jogosultsag';
      log('Hianyzo engedely: a public semaban tabla letrehozasa. Csak ezt az engedelyt javitjuk.');
      const url = new URL(config.connectionString);
      let password = await getAdminPassword();
      const adminConfig = { ...config, host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 5432), database: identity.db_name, user: adminUser, password };
      delete adminConfig.connectionString;
      const admin = new Client(adminConfig);
      try {
        await admin.connect();
        await admin.query('BEGIN');
        await admin.query("SET LOCAL lock_timeout = '5s'");
        await admin.query('GRANT USAGE, CREATE ON SCHEMA public TO ' + ident(identity.db_user));
        const grants = (await admin.query("SELECT has_schema_privilege($1,'public','CREATE') AS can_create, has_schema_privilege($1,'public','USAGE') AS can_use", [identity.db_user])).rows[0];
        if (!grants.can_create || !grants.can_use) throw new Error('Az adminfelhasznalo nem tudta megadni az engedelyt.');
        await admin.query('COMMIT');
      } catch (err) {
        await admin.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        await admin.end().catch(() => {});
        password = ''; adminConfig.password = '';
      }
      const check = (await app.query("SELECT has_schema_privilege(current_user,'public','CREATE') AS can_create")).rows[0];
      if (!check.can_create) throw new Error('A jog ellenorzese nem sikerult az alkalmazas sajat felhasznalojaval.');
      log('JAVITVA: az alkalmazas sajat felhasznaloja most mar letrehozhat tablakat.');
    } else {
      log('A schema-jogosultsag mar rendben van; adminjelszo nem szukseges.');
    }
    stage = 'migraciok';
    const steps = ['001_init.sql','002_directory.sql','003_public_seed.sql'].map(name => ({ name, sql: fs.readFileSync(path.join(root, 'migrations', name), 'utf8') }));
    const parts = [0,1,2,3].map(i => fs.readFileSync(path.join(root, 'migrations', '004_directory_expansion.sql.gz.b64.part' + i), 'utf8').trim());
    steps.push({ name: '004_directory_expansion', sql: zlib.gunzipSync(Buffer.from(parts.join(''), 'base64'), { maxOutputLength: 5 * 1024 * 1024 }).toString('utf8') });
    await app.query('SELECT pg_advisory_lock($1)', [6938035]); locked = true;
    await app.query('SET search_path TO public');
    await app.query('CREATE TABLE IF NOT EXISTS cms_schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    for (const step of steps) {
      stage = step.name;
      if ((await app.query('SELECT name FROM cms_schema_migrations WHERE name=$1', [step.name])).rowCount) continue;
      await app.query('BEGIN'); transaction = true;
      await app.query(step.sql);
      await app.query('INSERT INTO cms_schema_migrations(name,checksum) VALUES($1,$2)', [step.name, crypto.createHash('sha256').update(step.sql).digest('hex')]);
      await app.query('COMMIT'); transaction = false;
      log('Betoltve: ' + step.name);
    }
    await app.query('SELECT pg_advisory_unlock($1)', [6938035]); locked = false;
    const counts = (await app.query("SELECT (SELECT count(*)::int FROM directory_categories WHERE active=true) AS categories, (SELECT count(*)::int FROM directory_listings WHERE status='published') AS listings")).rows[0];
    if (!counts.categories || !counts.listings) throw Object.assign(new Error('Az import lefutott, de nincs publikalt katalogusadat. Meglevo szerkesztoi valtoztatasokat nem irok felul.'), { code: 'DIRECTORY_EMPTY' });
    log('ADATBAZIS KESZ: ' + counts.categories + ' kategoria, ' + counts.listings + ' rekord.');
    if (verifyHttp) {
      stage = 'alkalmazas-ellenorzes';
      const base = 'http://127.0.0.1:' + (env.PORT || 8080);
      const deadline = Date.now() + readinessTimeout;
      let ready = false, last = 'Nincs valasz';
      log('A futo alkalmazas es a kategoriaoldal ellenorzese...');
      while (Date.now() < deadline) {
        try {
          const res = await fetch(base + '/health/ready', { signal: AbortSignal.timeout(5000) });
          const data = await res.json();
          if (res.status === 200 && data.database && data.migrations) { ready = true; break; }
          last = data.code || data.phase || String(res.status);
        } catch (err) { last = err.cause?.code || err.name; }
        await wait(1000);
      }
      if (!ready) throw Object.assign(new Error('Az adatbazis mar kesz, de a futo alkalmazas meg nem kesz: ' + last + '. Az adatokat es a jogokat nem kell ujra beallitani.'), { code: 'APPLICATION_NOT_READY' });
      for (const route of ['/api/public/categories','/api/public/listings?limit=1','/kategoria/pszichologusok']) {
        const res = await fetch(base + route, { signal: AbortSignal.timeout(10000) });
        if (res.status !== 200) throw new Error(route + ': HTTP ' + res.status);
        if (route.startsWith('/api/')) {
          const data = await res.json();
          if (!Array.isArray(data) || !data.length) throw new Error(route + ': nincs adat');
        } else {
          const html = await res.text();
          if (!/<!doctype html>/i.test(html) || !html.includes('listing-card')) throw new Error('A kategoriaoldal valasza nem a vart HTML.');
        }
        log('OK 200: ' + route);
      }
      log('KESZ: az adatbazis, az adatbetoltes es a belso kategoriaoldal mukodik.');
    }
    return counts;
  } catch (err) {
    if (transaction) await app.query('ROLLBACK').catch(() => {});
    const safe = new Error('Lepes: ' + stage + ' | ' + (err.code || 'ERROR') + ' | ' + String(err.message || '').replace(/postgres(?:ql)?:\/\/\S+/gi, '[connection redacted]'));
    safe.code = err.code || 'REPAIR_FAILED';
    throw safe;
  } finally {
    if (locked) await app.query('SELECT pg_advisory_unlock($1)', [6938035]).catch(() => {});
    await app.end().catch(() => {});
  }
}
if (require.main === module) {
  repairDatabase().catch(err => { console.error(err.message); process.exitCode = 1; });
}
module.exports = { repairDatabase };
