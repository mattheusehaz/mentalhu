#!/usr/bin/env python3
import json,re,pathlib,concurrent.futures,unicodedata,collections
from urllib.parse import urlparse
import requests
from bs4 import BeautifulSoup
P=pathlib.Path('research/expansion-20261106')
# Correct a transcription error; keep the verified institutional URL, not a guessed path.
p=P/'curated-medical-services.json';rows=json.loads(p.read_text())
for r in rows:
 r['url']=r['url'].replace('altalanos-neurolologia-es-stroke-ellatas','altalanos-neurologia-es-stroke-ellatas')
 if r['name']=='Dr. Füzesséry Judit':r['url']='https://www.neurologiaikozpont.hu/munkatarsak/neurologia/dr-fuzessery-judit';r['website_url']=r['url']
p.write_text(json.dumps(rows,ensure_ascii=False,indent=2))
# Check curated source links without bypassing blocked pages or harvesting third-party contacts.
allrows=[r for p in sorted(P.glob('curated*.json')) for r in json.loads(p.read_text())]
urls=sorted(set(r['url'] for r in allrows));byurl=collections.defaultdict(list)
for r in allrows:byurl[r['url']].append(r['name'])
cachepath=P/'final-url-audit.json';old={x['url']:x for x in json.loads(cachepath.read_text())} if cachepath.exists() else {}
def check(url):
 if url in old:return old[url]
 try:
  r=requests.get(url,timeout=(7,18),headers={'User-Agent':'MENTAL.hu public directory source verification'},allow_redirects=True)
  title=''
  if r.ok:
   soup=BeautifulSoup(r.content,'html.parser');title=re.sub(r'\s+',' ',soup.title.get_text(' ',strip=True))[:180] if soup.title else ''
  return {'url':url,'status':r.status_code,'final_url':r.url,'title':title,'records':byurl[url]}
 except Exception as e:return {'url':url,'status':None,'error':type(e).__name__,'records':byurl[url]}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:report=list(pool.map(check,urls))
cachepath.write_text(json.dumps(report,ensure_ascii=False,indent=2))
issues=[x for x in report if x['status'] not in [200]]
(P/'source-issues.json').write_text(json.dumps(issues,ensure_ascii=False,indent=2))
print('SOURCE_AUDIT',json.dumps({'total':len(report),'http_ok':sum(x['status']==200 for x in report),'blocked_or_unavailable':len(issues),'not_found':[x for x in issues if x['status'] in [404,410]],'other':[{'url':x['url'],'status':x['status'],'error':x.get('error')} for x in issues if x['status'] not in [404,410]]},ensure_ascii=False))
# Exact public website aliases for the same resource are merged, not counted twice.
existing=json.loads((P/'existing.json').read_text());cand=json.loads((P/'candidates.json').read_text())
def canonical(url):
 try:
  u=urlparse(url);return ((u.hostname or '').lower().removeprefix('www.'),u.path.rstrip('/') or '/')
 except:return ('','')
base_by_url={canonical(x.get('website_url','')):x for x in existing if x.get('website_url') and x.get('kind') in ['organization','media','training']}
aliases=[]
for r in cand:
 if r.get('kind') not in ['organization','media','training'] or not r.get('website_url'):continue
 key=canonical(r['website_url']);old=base_by_url.get(key)
 if old and r['slug']!=old['slug'] and key[0]:
  aliases.append({'old_candidate_slug':r['slug'],'existing_slug':old['slug'],'name':r['name'],'existing_name':old['name'],'website':r['website_url']})
(P/'identity-review.json').write_text(json.dumps({'exact_website_aliases':aliases},ensure_ascii=False,indent=2))
print('IDENTITY_REVIEW',json.dumps(aliases,ensure_ascii=False))
