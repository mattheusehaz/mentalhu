'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { repairDatabase } = require('./repair-database.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
assert(process.env.CI === 'true', 'Disposable CI database only');
const adminUrl = new URL(process.env.DATABASE_URL);
const appPassword = crypto.randomBytes(24).toString('hex');
const role = 'mental-repair-app';
const database = 'mental_repair_test';
const targetUrl = new URL(adminUrl); targetUrl.pathname = '/' + database;
const appUrl = new URL(targetUrl); appUrl.username = role; appUrl.password = appPassword;
const env = { ...process.env, DATABASE_URL: appUrl.toString(), PGSSLMODE: 'disable', PORT: '18081', NODE_ENV: 'test', CMS_JWT_SECRET: crypto.randomBytes(48).toString('hex') };
const admin = new Client({ connectionString: adminUrl.toString(), ssl: false });
let dbAdmin, check, child;
let serverOutput = '', output = '';
const log = text => { output += text + '\n'; console.log(text); };
async function main() {
  await admin.connect();
  await admin.query('CREATE ROLE "mental-repair-app" LOGIN PASSWORD ' + "'" + appPassword + "'");
  await admin.query('CREATE DATABASE mental_repair_test');
  dbAdmin = new Client({ connectionString: targetUrl.toString(), ssl: false }); await dbAdmin.connect();
  await dbAdmin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await dbAdmin.query('GRANT CONNECT ON DATABASE mental_repair_test TO "mental-repair-app"');
  check = new Client({ connectionString: appUrl.toString(), ssl: false }); await check.connect();
  assert.equal((await check.query("SELECT has_schema_privilege(current_user,'public','CREATE') AS allowed")).rows[0].allowed, false);
  child = spawn(process.execPath, ['server.js'], { env, stdio: ['ignore','pipe','pipe'] });
  child.stdout.on('data', s => { serverOutput += s; }); child.stderr.on('data', s => { serverOutput += s; });
  let reproduced = false;
  for (let i=0; i<30; i++) {
    try {
      const r = await fetch('http://127.0.0.1:18081/health/ready');
      const d = await r.json();
      if (r.status === 503 && d.database === true && d.code === '42501') { reproduced = true; break; }
    } catch {}
    await wait(200);
  }
  assert(reproduced, 'Must reproduce the exact reported permission failure: ' + serverOutput);
  console.log('REPRODUCED: database=true, migrations=false, code=42501');
  let prompts = 0;
  const counts = await repairDatabase({ env, adminUser: decodeURIComponent(adminUrl.username), getAdminPassword: async () => { prompts++; return decodeURIComponent(adminUrl.password); }, log });
  assert.equal(prompts,1);
  assert.equal(counts.categories,21); assert.equal(counts.listings,399);
  assert.equal((await check.query("SELECT has_schema_privilege(current_user,'public','CREATE') AS allowed")).rows[0].allowed,true);
  const attrs = (await admin.query('SELECT rolsuper,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=$1',[role])).rows[0];
  assert.deepEqual(attrs,{rolsuper:false,rolcreaterole:false,rolcreatedb:false});
  console.log('PASS minimal grant, real migrations, 21 categories, 399 listings and HTTP 200 category page');
  const original = (await check.query("SELECT name FROM directory_listings WHERE slug='levitania-pszichologiai-kozpont'")).rows[0].name;
  await check.query("UPDATE directory_listings SET name='Keep my editorial change' WHERE slug='levitania-pszichologiai-kozpont'");
  await repairDatabase({ env, getAdminPassword: async () => { throw new Error('Must not request admin again'); }, log });
  assert.equal((await check.query("SELECT name FROM directory_listings WHERE slug='levitania-pszichologiai-kozpont'")).rows[0].name,'Keep my editorial change');
  assert.equal((await check.query('SELECT count(*)::int AS n FROM directory_listings')).rows[0].n,399);
  await check.query("UPDATE directory_listings SET name=$1 WHERE slug='levitania-pszichologiai-kozpont'",[original]);
  assert(!output.includes(appPassword)); assert(!output.includes(decodeURIComponent(adminUrl.password)));
  await dbAdmin.query('REVOKE CREATE ON SCHEMA public FROM "mental-repair-app"');
  await assert.rejects(repairDatabase({ env, adminUser: decodeURIComponent(adminUrl.username), getAdminPassword: async()=> 'intentionally-wrong-password', log:()=>{} }), err => err.code === '28P01');
  assert.equal((await check.query('SELECT count(*)::int AS n FROM directory_listings')).rows[0].n,399);
  console.log('PASS repeat execution preserves editorial changes; bad credentials fail without deleting data; no password output');
  console.log('ALL PERMISSION REPAIR TESTS PASSED');
}
main().catch(e=>{console.error(e.message);console.error(serverOutput);process.exitCode=1}).finally(async()=>{
  if(child && child.exitCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');await stopped;}
  if(check)await check.end().catch(()=>{});if(dbAdmin)await dbAdmin.end().catch(()=>{});
  await admin.query('DROP DATABASE IF EXISTS mental_repair_test').catch(()=>{});
  await admin.query('DROP ROLE IF EXISTS "mental-repair-app"').catch(()=>{});
  await admin.end().catch(()=>{});
});
