#!/usr/bin/env python3
import json,re,pathlib,html,hashlib
P=pathlib.Path('research/expansion-20261106');ROOT=pathlib.Path('.')
records=json.loads((P/'candidates.json').read_text());cats=json.loads((P/'new-categories.json').read_text());coverage=json.loads((P/'coverage.json').read_text())
def q(v):return "'"+str(v or '').replace("'","''")+"'"
# No source snapshot, raw professional contact list or research scrape is required at runtime.
category_sql="ALTER TABLE directory_listings ADD COLUMN IF NOT EXISTS email_source_url TEXT NOT NULL DEFAULT '';\nALTER TABLE directory_listings ADD COLUMN IF NOT EXISTS contact_disabled BOOLEAN NOT NULL DEFAULT false;\n"
category_sql+='CREATE TABLE IF NOT EXISTS directory_listing_sources (listing_id BIGINT REFERENCES directory_listings(id) ON DELETE CASCADE,source_url TEXT NOT NULL,source_name TEXT NOT NULL DEFAULT \'\',checked_at TIMESTAMPTZ NOT NULL,PRIMARY KEY(listing_id,source_url));\n'
category_sql+='INSERT INTO directory_categories(slug,name,group_name,description,icon,verification_level,sort_order) VALUES\n'+',\n'.join('('+','.join(q(c[k]) for k in ['slug','name','group_name','description','icon','verification_level'])+','+str(c['sort_order'])+')' for c in cats)+'\nON CONFLICT(slug) DO NOTHING;\n'
(ROOT/'migrations/006_extended_categories.sql').write_text(category_sql)
items=[]
for r in records:
 if not r.get('categories') or not r.get('source_url','').startswith(('https://','http://')):raise ValueError('Source/category missing: '+r.get('name',''))
 # Keep descriptions original and factual; no copied biographies, photos or clinical promises.
 desc=r.get('description') or (r.get('evidence') or ('Nyilvános szakmai vagy szolgáltatói névsorban szereplő adatlap. Forrás: '+r['source_name']+'.'))
 if r['kind']=='provider' and 'par-es-csaladterapeutak' in r['categories'] and 'konzulens' in r.get('qualifications','').lower():desc='Pár- és családi konzultációs szakember a forrásjegyzékben feltüntetett képesítéssel. A „családkonzulens” megjelölés nem azonos a pszichoterapeuta képesítéssel. '+desc
 if any(c in r['categories'] for c in ['csaladallitas','agykontroll','asztrologusok','kineziologusok','termeszetgyogyaszat']):desc+=' Alternatív vagy önfejlesztő szolgáltatás; a megjelenés nem igazolja a módszer egészségügyi hatásosságát, és nem helyettesíti az orvosi vagy pszichológiai ellátást.'
 if r['kind']=='provider' and r.get('qualifications'):desc+=' A nyilvános forrás szerinti megjelölés: '+r['qualifications']+'.'
 desc+=' A jelenlegi elérhetőséget, a szolgáltatás körét és a fogadás feltételeit a forrásnál ellenőrizd.'
 items.append(dict(slug=r['slug'],name=r['name'],kind=r['kind'],short_description=desc[:260],description=desc,city=r.get('city',''),qualifications=r.get('qualifications',''),website_url=r.get('website_url',''),source_url=r['source_url'],source_name=r['source_name'],sources=r.get('sources',[r['source_url']]),categories=r['categories'],languages=r.get('languages','Magyar'),online_available=r.get('online_available',False),event_start=r.get('event_start'),event_end=r.get('event_end'),email=r.get('email',''),email_source_url=r.get('email_source_url','')))
payload=json.dumps(items,ensure_ascii=False,separators=(',',':'))
assert '$mental_data$' not in payload
sql="""-- Source-backed directory expansion. Existing editorial fields/status are preserved.
-- Separate statements intentionally avoid the data-modifying CTE visibility bug.
CREATE TEMP TABLE mental_import_20261106(data JSONB NOT NULL) ON COMMIT DROP;
INSERT INTO mental_import_20261106(data) SELECT value FROM jsonb_array_elements($mental_data$"""+payload+"""$mental_data$::jsonb);
INSERT INTO directory_listings(slug,name,kind,short_description,description,city,qualifications,website_url,source_url,languages,online_available,event_start,event_end,email,email_source_url,verified,featured,status,admin_notes,published_at)
SELECT data->>'slug',data->>'name',data->>'kind',data->>'short_description',data->>'description',data->>'city',data->>'qualifications',data->>'website_url',data->>'source_url',data->>'languages',COALESCE((data->>'online_available')::boolean,false),NULLIF(data->>'event_start','')::timestamptz,NULLIF(data->>'event_end','')::timestamptz,data->>'email',data->>'email_source_url',false,false,'published','Nyilvános források alapján importálva 2026-11-06. A megjelenés nem szakmai minősítés. A képesítést/licencet nem ellenőriztük önállóan.',now()
FROM mental_import_20261106 ON CONFLICT(slug) DO NOTHING;
INSERT INTO directory_listing_categories(listing_id,category_id)
SELECT l.id,c.id FROM mental_import_20261106 i CROSS JOIN LATERAL jsonb_array_elements_text(i.data->'categories') cs(slug)
JOIN directory_listings l ON l.slug=i.data->>'slug' JOIN directory_categories c ON c.slug=cs.slug ON CONFLICT DO NOTHING;
INSERT INTO directory_listing_sources(listing_id,source_url,source_name,checked_at)
SELECT l.id,s.url,i.data->>'source_name','2026-11-06T00:00:00Z' FROM mental_import_20261106 i CROSS JOIN LATERAL jsonb_array_elements_text(i.data->'sources') s(url)
JOIN directory_listings l ON l.slug=i.data->>'slug' ON CONFLICT DO NOTHING;
-- Fill only empty public business-contact fields with explicitly sourced addresses.
UPDATE directory_listings l SET email=i.data->>'email',email_source_url=i.data->>'email_source_url'
FROM mental_import_20261106 i WHERE l.slug=i.data->>'slug' AND l.email='' AND COALESCE(i.data->>'email','')<>'' AND COALESCE(i.data->>'email_source_url','')<>'';
"""
(ROOT/'migrations/007_sourced_catalog_expansion.sql').write_text(sql)
# Public-safe manifest: aggregate statistics only, never requestor data or secrets.
manifest={'version':'catalog-expanded-31-v1','minimum_total':1000,'minimum_per_category':20,'categories':len(coverage['categories']),'projected_total':coverage['projected_unique_total'],'expected_counts':coverage['categories'],'research_date':'2026-11-06','new_candidate_entities':coverage['new_entities'],'source_domains':len({__import__('urllib.parse',fromlist=['urlparse']).urlparse(r['source_url']).hostname for r in records}),'imported_professional_emails':sum(bool(r.get('email')) for r in records)}
(ROOT/'catalog-release.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
p=ROOT/'server.js';s=p.read_text()
if '008_contact_inquiries.sql' not in s:
 marker="  const client = await pool.connect();\n  let locked = false;"
 assert marker in s
 s=s.replace(marker,"  for (const name of ['006_extended_categories.sql','007_sourced_catalog_expansion.sql','008_contact_inquiries.sql']) steps.push({name,sql:fs.readFileSync(path.join(ROOT,'migrations',name),'utf8')});\n"+marker,1)
if 'const contactService =' not in s:
 marker="app.post('/api/admin/login'"
 assert marker in s
 s=s.replace(marker,"const contactService = require('./lib/contact-inquiries.cjs').createContactService({pool,auth,dbState,audit});\ncontactService.register(app);\ncontactService.start();\n\n"+marker,1)
 s=s.replace("const prefixes = ['/api/public/',", "const prefixes = ['/api/contact/', '/api/admin/contact/', '/api/public/',")
 s=s.replace("  res.type('html').send(directoryShell(x.name,body));", "  const sourceLink=x.source_url?'<p><a href=\"'+escapeHtml(x.source_url)+'\" target=\"_blank\" rel=\"noopener noreferrer\">Nyilvános forrás és elérhetőség ↗</a></p>':'';\n  const eventInfo=x.event_start?'<p>Meghirdetett időpont: '+escapeHtml(new Date(x.event_start).toLocaleString('hu-HU',{timeZone:'Europe/Budapest'}))+'</p>':'';\n  const profile=body.replace('<h3>Kapcsolat</h3>','<h3>Kapcsolat</h3>'+sourceLink+eventInfo+'<p><a class=\"solid-btn\" href=\"#kapcsolat\">Kapcsolatfelvételi űrlap</a></p>');\n  res.type('html').send(directoryShell(x.name,profile.replace('</main>',contactService.markup(x)+'</main>')));")
 s=s.replace("res.json({...x,profile_image_url:x.profile_image_id?'/media/'+x.profile_image_id:null,logo_image_url:x.logo_image_id?'/media/'+x.logo_image_id:null});", "const {admin_notes,email_source_url,contact_disabled,...publicListing}=x;\n  res.json({...publicListing,profile_image_url:x.profile_image_id?'/media/'+x.profile_image_id:null,logo_image_url:x.logo_image_id?'/media/'+x.logo_image_id:null});")
 s=s.replace("app.use('/admin', express.static", "// Do not expose application code, migrations or research snapshots as static pages.\napp.use((req,res,next)=>{const p=req.path.toLowerCase();if(/^\\/(?:research|scripts|lib|migrations|node_modules|\\.git|\\.github|test|tests)(?:\\/|$)/.test(p)||/^\\/(?:server\\.js|package(?:-lock)?\\.json|procfile|dockerfile|readme(?:\\.md)?|\\.env.*)$/.test(p))return res.status(404).end();next();});\napp.use('/admin', express.static",1)
 s=s.replace("req.user = jwt.verify(token, JWT_SECRET);\n    next();", "req.user = jwt.verify(token, JWT_SECRET);\n    if(req.user.role!=='admin')return res.status(403).json({error:'Adminisztrátori jogosultság szükséges.'});\n    next();")
p.write_text(s)
# Preserve the existing frontend; add categories to the correct groups and both selects.
p=ROOT/'index.html';s=p.read_text()
def option(c):return '<option value="'+html.escape(c['slug'])+'">'+html.escape(c['name'])+'</option>'
def link(c):return '<a href="/kategoria/'+html.escape(c['slug'])+'"><span>'+html.escape(c['name'])+'</span><small data-count="'+html.escape(c['slug'])+'" hidden></small><svg class="icon" viewBox="0 0 48 48" aria-hidden="true"><use href="#i-arrow"/></svg></a>'
if 'data-count="csaladallitas"' not in s:
 for group in ['Szakmai segítség','Alternatív és spirituális']:
  additions=[c for c in cats if c['group_name']==group]
  pattern=r'(<section class="category-group"><h3>'+re.escape(group)+r'</h3>[\s\S]*?)(</div></section>)'
  s,n=re.subn(pattern,lambda m:m[1]+''.join(link(c) for c in additions)+m[2],s,count=1);assert n==1,group
 newgroups=''.join('<section class="category-group"><h3>'+group+'</h3><div class="category-link-list">'+''.join(link(c) for c in cats if c['group_name']==group)+'</div></section>' for group in ['Szakorvosi ellátás','Vizsgálatok és diagnosztika'])
 marker='</div></section>\n<section class="about-band"';assert marker in s
 s=s.replace(marker,newgroups+marker,1)
 def extend_select(m):
  block=m[0]
  for group in ['Szakmai segítség','Alternatív és spirituális']:
   block=re.sub(r'(<optgroup label="'+re.escape(group)+r'">[\s\S]*?)(</optgroup>)',lambda x:x[1]+''.join(option(c) for c in cats if c['group_name']==group)+x[2],block)
  addgroups=''.join('<optgroup label="'+group+'">'+''.join(option(c) for c in cats if c['group_name']==group)+'</optgroup>' for group in ['Szakorvosi ellátás','Vizsgálatok és diagnosztika'])
  return block.replace('</select>',addgroups+'</select>')
 s=re.sub(r'<select\b[^>]*id="(?:cat|submitCategory)"[^>]*>[\s\S]*?</select>',extend_select,s)
s=s.replace('data-release="atelier-1"','data-release="catalog-expanded-31-v1"').replace('/directory.js?v=atelier-1','/directory.js?v=expanded-31-1')
p.write_text(s)
p=ROOT/'lib/public-catalog.cjs';s=p.read_text();s=re.sub(r"const RELEASE = '[^']+';","const RELEASE = 'catalog-expanded-31-v1';",s);p.write_text(s)
p=ROOT/'admin/index.html';s=p.read_text()
if '/admin/kapcsolatfelvetelek.html' not in s:s=s.replace('</nav>','<a href="/admin/kapcsolatfelvetelek.html" class="contact-admin-link">Kapcsolatfelvételek</a></nav>',1)
p.write_text(s)
p=ROOT/'admin/kapcsolatfelvetelek.html';s=p.read_text().replace('</option value="needs_mail">','</option><option value="needs_mail">');p.write_text(s)
# Tighten idempotency scope and concurrent rate limiting.
p=ROOT/'lib/contact-inquiries.cjs';s=p.read_text()
s=s.replace("SELECT id,requester_hash,delivery_status FROM directory_contact_inquiries WHERE request_key=$1", "SELECT id,listing_id,requester_hash,delivery_status FROM directory_contact_inquiries WHERE request_key=$1")
s=s.replace("if(exists.requester_hash!==eh)","if(exists.requester_hash!==eh||String(exists.listing_id)!==String(x.id))")
s=s.replace("['contact:'+eh]);", "['contact:'+eh]);await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['contact-ip:'+ip]);")
s=s.replace("code=/^[A-Z0-9_]{2,60}$/.test(e.code||'')?e.code:'MAIL_RESULT_UNCERTAIN';", "code=['ETIMEDOUT','ESOCKET','ECONNRESET','ECONNECTION','EPIPE'].includes(e.code)?'MAIL_RESULT_UNCERTAIN':/^[A-Z0-9_]{2,60}$/.test(e.code||'')?e.code:'MAIL_RESULT_UNCERTAIN';")
p.write_text(s)
print(json.dumps(manifest,ensure_ascii=False,indent=2))
