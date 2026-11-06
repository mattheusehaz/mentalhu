#!/usr/bin/env python3
import json,pathlib,re,sys
P=pathlib.Path('research/expansion-20261106')
if sys.argv[1]=='data':
 records=json.loads((P/'candidates.json').read_text());base=json.loads((P/'existing.json').read_text())
 aliases={x['old_candidate_slug']:x for x in json.loads((P/'identity-review.json').read_text())['exact_website_aliases']}
 reviewed=[];omitted=[]
 for r in records:
  if r['name'] in ['Pósfai Natasa','SzilAsztro'] and not r.get('existing_slug'):
   omitted.append({'name':r['name'],'reason':'Source page returned 404 or could not be resolved; not published in this batch.'});continue
  a=aliases.get(r['slug'])
  if a:r['slug']=a['existing_slug'];r['name']=a['existing_name'];r['existing_slug']=a['existing_slug']
  # Never attach a contact address from a differently sourced, same-name practitioner.
  if r.get('email'):
   from urllib.parse import urlparse
   primary=urlparse(r['source_url']).hostname
   contact=urlparse(r.get('email_source_url','')).hostname
   website=urlparse(r.get('website_url','')).hostname
   if contact and contact not in [primary,website]:
    r['email']='';r['email_source_url']=''
  if r.get('kind')=='media' and not r.get('city'):r['city']='Online'
  reviewed.append(r)
 merged={}
 for r in reviewed:
  if r['slug'] in merged:
   old=merged[r['slug']];old['categories']=sorted(set(old['categories']+r['categories']));old['sources']=sorted(set(old['sources']+r['sources']))
  else:merged[r['slug']]=r
 records=list(merged.values());assert len({r['slug'] for r in records})==len(records)
 target={r['slug']:{c['slug'] for c in r['categories']} for r in base}
 for r in records:target.setdefault(r['slug'],set()).update(r['categories'])
 coverage=json.loads((P/'coverage.json').read_text());coverage['categories']={c:sum(c in v for v in target.values()) for c in coverage['categories']}
 coverage.update(candidate_entities=len(records),new_entities=sum(not r.get('existing_slug') for r in records),projected_unique_total=len(target),below_minimum={c:n for c,n in coverage['categories'].items() if n<20})
 (P/'candidates.json').write_text(json.dumps(records,ensure_ascii=False,indent=2));(P/'coverage.json').write_text(json.dumps(coverage,ensure_ascii=False,indent=2));(P/'publication-review.json').write_text(json.dumps({'excluded':omitted,'canonical_aliases':list(aliases.values()),'email_policy':'Only the published contact channel of the same source/provider; no guessed addresses.'},ensure_ascii=False,indent=2))
 assert not coverage['below_minimum'],coverage['below_minimum'];assert len(target)>=1000
 print('PUBLICATION_REVIEW',json.dumps({'total':len(target),'categories':len(coverage['categories']),'minimum':min(coverage['categories'].values()),'excluded':len(omitted),'canonical_aliases':len(aliases)},ensure_ascii=False))
else:
 p=pathlib.Path('server.js');s=p.read_text()
 s=s.replace("const p=req.path.toLowerCase();if(/^", "let p;try{p=path.posix.normalize(decodeURIComponent(req.path)).toLowerCase();}catch{return res.status(404).end();}if(/^")
 s=s.replace("secure: process.env.NODE_ENV === 'production', sameSite", "secure: process.env.NODE_ENV === 'production' || req.secure, sameSite")
 s=s.replace('<span>Profil →</span>','<span>Adatlap és kapcsolat →</span>');p.write_text(s)
 p=pathlib.Path('lib/contact-inquiries.cjs');s=p.read_text().replace("secure:env.NODE_ENV==='production',sameSite", "secure:env.NODE_ENV==='production'||req.secure,sameSite");p.write_text(s)
 p=pathlib.Path('admin/index.html');s=p.read_text().replace('class="contact-admin-link"','class="contact-admin-link" style="display:block;padding:12px 14px;color:inherit;text-decoration:none;border:1px solid currentColor;margin-top:12px;border-radius:4px"');p.write_text(s)
 p=pathlib.Path('scripts/test-expanded-catalog.cjs');s=p.read_text().replace("'/server.js','/lib/contact-inquiries.cjs'", "'/server.js','/%6cib/contact-inquiries.cjs','/lib%2fcontact-inquiries.cjs','/lib/contact-inquiries.cjs'")
 marker="assert.equal((await req('/api/admin/contact/inquiries')).status,401);"
 replacement=marker+"\n const login=await req('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@example.test',password:adminPassword})});assert.equal(login.status,200);const session=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');assert.equal((await req('/api/admin/contact/settings',{headers:{Cookie:session}})).status,200);assert.equal((await req('/api/admin/directory/listings',{headers:{Cookie:session}})).status,200);"
 if 'const session=login.headers' not in s:s=s.replace(marker,replacement)
 p.write_text(s)
 print('Security and routing review applied; database connection configuration unchanged.')
