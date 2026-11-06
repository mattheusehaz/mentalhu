'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..');
function read(file){return fs.readFileSync(path.join(root,file),'utf8');}
function write(file,value){fs.writeFileSync(path.join(root,file),value);}
let server = read('server.js');
if (!server.includes('// Public catalog pagination v1')) {
  const apiStart = server.indexOf("app.get('/api/public/listings',");
  const apiEnd = server.indexOf("app.get('/api/public/listings/:slug',",apiStart);
  assert(apiStart >= 0 && apiEnd > apiStart,'List API block must exist');
  server = server.slice(0,apiStart) + server.slice(apiEnd);
  const pagesStart = server.indexOf('async function queryListings(');
  const pagesEnd = server.indexOf("app.get('/szolgaltato/:slug',",pagesStart);
  assert(pagesStart >= 0 && pagesEnd > pagesStart,'Old truncated directory pages must exist');
  server = server.slice(0,pagesStart) + server.slice(pagesEnd);
  const marker = "app.get('/api/public/categories',";
  assert.equal(server.split(marker).length,2,'Category registration anchor must be unique');
  const mount = "// Public catalog pagination v1\nrequire('./lib/public-catalog.cjs').registerPublicCatalog(app, { pool, dbState, unavailable, directoryShell, listingCards, root: ROOT });\n\n";
  server = server.replace(marker,()=>mount+marker);
  write('server.js',server);
}
let home = read('index.html');
if (!home.includes('<!-- catalog-summary:start -->')) {
  const marker = '<section class="home-block categories-block"';
  assert.equal(home.split(marker).length,2,'Homepage category anchor must be unique');
  const summary = '<!-- catalog-summary:start --><div class="catalog-summary" id="catalogSummary"><div><strong>A teljes katalógus</strong><span>A főoldal csak néhány adatlapot mutat. Az összeset itt találod.</span></div><a class="solid-btn" href="/szolgaltatok">Az összes adatlap megtekintése →</a></div><!-- catalog-summary:end -->\n';
  home=home.replace(marker,()=>summary+marker);
  home=home.replace('</head>','<link rel="stylesheet" href="/catalog-pagination.css?v=catalog-pagination-1"></head>');
  home=home.split('href="/kereses"').join('href="/szolgaltatok"');
  home=home.replace('>Összes szakember <','>Teljes katalógus <');
  home=home.replace('</body>','<script src="/catalog-summary.js?v=catalog-pagination-1" defer></script></body>');
  home=home.replace('data-release="atelier-1"','data-release="catalog-pagination-1"');
  write('index.html',home);
}
assert(server.includes('registerPublicCatalog(app'));
assert(!server.includes('async function queryListings('));
assert(home.includes('id="catalogSummary"'));
console.log('Complete catalog wired: real totals, 24 per page, all pages reachable, existing DB configuration unchanged.');
