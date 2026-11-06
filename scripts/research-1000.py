#!/usr/bin/env python3
"""Public-source research only. Does not access or write production credentials/data."""
import json, re, time, hashlib, pathlib, concurrent.futures, unicodedata
from urllib.parse import urljoin, urlparse
import requests
from bs4 import BeautifulSoup
OUT=pathlib.Path('research/expansion-20261106'); OUT.mkdir(parents=True,exist_ok=True)
SOURCES={
'integrativ':'https://integrativ.hu/integrativ-terapeutak',
'emdr':'https://emdr.hu/az-egyesuletrol/emdr-practitionerek/',
'csalad':'https://csaladterapia.hu/csaladterapeutat-keres',
'csaladmental':'https://csaladterapia.hu/content/okleveles-mentalhigienes-csaladtudomanyi-es-csaladterapias-szakemberek-nevsora-semmelweis',
'metamese':'https://metamese.hu/szaknevsor/szaknevsor.php',
'mentalport':'https://www.mentalport.hu/pszichoterapias-szaknevsor/magyarorszagi-pszichoterapeutak-szaknevsora/',
'icf':'https://coachingfederation.hu/tagjaink/',
'coachalap':'https://alapvonal.coachszovetseg.hu/szaknevsor',
'icon':'https://integralcsaladallitas.com/allitoink/',
'kineziologus':'https://www.kineziologuskereso.hu/kineziologus-kereso/',
'astrologus':'https://asztrologusok.hu/asztrologusok/',
'mediator':'https://www.mediacio.hu/budapesti-mediatorok/',
'winwin':'https://win-win-mediacio.hu/tagok/',
'pszichologuskereso':'https://pszichologuskereso.hu/pszichologus-kereso',
'pszichologin':'https://www.pszichologin.hu/pszichologusok',
'komjadi':'https://komjadikavics.com/szakembereink/',
'pontjol':'https://pontjolvagyok.hu/szakertok/',
'napfenyes':'https://www.napfenyesgyogykozpont.hu/szakembereink/'
}
def clean(s): return re.sub(r'\s+',' ',s or '').strip()
def fetch(pair):
 key,url=pair
 try:
  r=requests.get(url,timeout=(10,35),headers={'User-Agent':'MENTAL.hu directory research; public source attribution; no contact harvesting'})
  r.raise_for_status(); r.encoding=r.apparent_encoding
  raw=r.text; soup=BeautifulSoup(raw,'html.parser')
  scripts=[{'src':urljoin(r.url,x.get('src','')),'hint':clean(x.get_text())[:450]} for x in soup.find_all('script') if x.get('src') or re.search(r'ajax|dataTable|szaknev|coach|user|json',x.get_text(),re.I)]
  tables=[]
  for table in soup.find_all('table'):
   rows=[]
   for tr in table.find_all('tr'):
    cells=[clean(x.get_text(' ',strip=True)) for x in tr.find_all(['td','th'],recursive=False)]
    if cells: rows.append({'cells':cells,'links':[{'text':clean(a.get_text(' ',strip=True)),'url':urljoin(r.url,a.get('href',''))} for a in tr.find_all('a',href=True) if a['href'].startswith(('http','/','?'))]})
   if rows:tables.append({'attrs':table.attrs,'rows':rows})
  main=soup.select_one('main') or soup.select_one('article') or soup.select_one('#content') or soup
  headings=[{'tag':h.name,'attrs':h.attrs,'text':clean(h.get_text(' ',strip=True))[:180],'parent':h.parent.name,'parent_attrs':h.parent.attrs} for h in main.find_all(['h1','h2','h3','h4','h5'])]
  links=[{'text':clean(a.get_text(' ',strip=True))[:180],'url':urljoin(r.url,a['href']),'attrs':a.attrs} for a in main.find_all('a',href=True) if a['href'].startswith(('http','/','?')) and clean(a.get_text(' ',strip=True))]
  for x in soup(['script','style','header','footer','nav']): x.decompose()
  report={'url':url,'final_url':r.url,'status':r.status_code,'sha256':hashlib.sha256(raw.encode()).hexdigest(),'title':clean(soup.title.get_text()) if soup.title else '', 'tables':tables,'headings':headings,'links':links,'scripts':scripts,'iframes':[x.attrs for x in soup.find_all('iframe')],'text':clean(soup.get_text(' ',strip=True))[:35000]}
  (OUT/(key+'.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2))
  print(key,r.status_code,'table rows',sum(len(t['rows']) for t in tables),'headings',len(headings),'links',len(links),flush=True)
  return {'key':key,'status':r.status_code,'url':r.url,'tables':[(len(t['rows']),[x['cells'][:3] for x in t['rows'][:3]]) for t in tables],'heading_samples':headings[:18],'links_sample':links[:15],'scripts':scripts}
 except Exception as e:
  print(key,'ERROR',str(e)[:160],flush=True);return {'key':key,'error':str(e)[:200]}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:reports=list(pool.map(fetch,SOURCES.items()))
(OUT/'audit.json').write_text(json.dumps(reports,ensure_ascii=False,indent=2))
all_items=[]
for p in range(1,5):
 r=requests.get('https://mental.hu/api/public/listings',params={'paginated':'true','limit':100,'page':p},timeout=20);r.raise_for_status();all_items+=r.json()['items']
(OUT/'existing.json').write_text(json.dumps(all_items,ensure_ascii=False,indent=2))
r=requests.get('https://mental.hu/api/public/categories',timeout=20);r.raise_for_status();(OUT/'categories.json').write_text(json.dumps(r.json(),ensure_ascii=False,indent=2))
print('BASELINE',len(all_items),'sources',len(reports),flush=True)
