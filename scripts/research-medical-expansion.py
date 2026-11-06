#!/usr/bin/env python3
import json,re,pathlib,concurrent.futures,unicodedata
from urllib.parse import urljoin,urlparse
import requests
from bs4 import BeautifulSoup
P=pathlib.Path('research/expansion-20261106');out=[];reports=[]
def clean(t):return re.sub(r'\s+',' ',t or '').strip()
SOURCES={
 'neurologia':'https://szakorvos.hu/szakorvos/neurologus/budapest',
 'ful-orr-gegeszek':'https://szakorvos.hu/szakorvos/ful-orr-gege-szakorvos/budapest',
 'szemeszek':'https://szakorvos.hu/szakorvos/szemeszet-szakorvos/budapest',
 'hipnoterapeutak':'https://hipnozis-mhe.hu/terapeutaink/',
 'agykontroll':'https://agykontroll.hu/gyerekoktatok/',
 'agykontroll-tanfolyam':'https://agykontroll.hu/tanfolyamok-gyerekeknek-3/',
 'gyermekkori-diagnosztika':'https://aosz.hu/hogyan-kaphatok-szakszeru-autizmus-diagnozist/',
 'gyermekkori-diagnosztika-mars':'https://marsalapitvany.hu/diagnoziskozpont-kereso/'
}
def get(pair):
 k,u=pair
 try:
  r=requests.get(u,timeout=(8,30),headers={'User-Agent':'MENTAL.hu catalog research (public professional listings)'});r.raise_for_status();s=BeautifulSoup(r.content,'html.parser')
  main=s.find('main') or s.find('article') or s
  heads=[]
  for h in main.find_all(['h1','h2','h3','h4','h5']):
   text=clean(h.get_text(' ',strip=True));parent=h.parent
   heads.append({'name':text,'tag':h.name,'attrs':h.attrs,'parent_class':parent.get('class'),'links':[{'text':clean(a.get_text(' ',strip=True)),'url':urljoin(r.url,a['href'])} for a in parent.find_all('a',href=True)][:6],'html':str(parent)[:1800]})
   if k in ['neurologia','ful-orr-gegeszek','szemeszek'] and h.name=='h3' and re.match(r'^(?:Dr\.|Prof\.|dr\.)\s',text):
    a=h.find('a',href=True) or h.find_parent('a',href=True) or parent.find('a',href=True)
    if a:out.append({'name':text,'categories':[k],'city':'Budapest','source_url':urljoin(r.url,a['href']),'source_name':'Szakorvos.hu – nyilvános szakorvosi adatlap','website_url':'','kind':'provider','evidence':'A szakirány nyilvános szakemberjegyzékében szerepel. Végzettség és aktuális rendelés a forrásoldalon.'})
  tables=[]
  for table in main.find_all('table'):
   rows=[]
   for tr in table.find_all('tr'):
    cells=[clean(t.get_text(' ',strip=True)) for t in tr.find_all(['td','th'],recursive=False)]
    if cells: rows.append({'cells':cells,'links':[{'text':clean(a.get_text(' ',strip=True)),'url':urljoin(r.url,a['href'])} for a in tr.find_all('a',href=True)]})
   if rows:tables.append(rows)
  members=[]
  for el in s.select('.um-member'):
   a=el.select_one('.um-member-name a') or el.select_one('a[href*="user/"]')
   if not a:continue
   text=clean(el.get_text(' ',strip=True));name=clean(a.get_text(' ',strip=True));
   if not name:continue
   members.append({'name':name,'url':urljoin(r.url,a['href']),'text':text[:1800]})
  d={'key':k,'url':r.url,'status':r.status_code,'title':clean(s.title.get_text()) if s.title else '', 'headings':heads,'tables':tables,'members':members,'name_links':[{'name':clean(a.get_text(' ',strip=True)),'url':urljoin(r.url,a['href'])} for a in main.find_all('a',href=True) if re.search(r'/user/|/orvos/|/szakember/',a['href'])]}
  (P/('medical-'+k+'.json')).write_text(json.dumps(d,ensure_ascii=False,indent=2));reports.append({'key':k,'headings':len(heads),'tables':[len(t) for t in tables],'members':len(members),'sample':heads[:5]});print(k,'headings',len(heads),'members',len(members),'tables',[len(t) for t in tables],flush=True)
 except Exception as e:reports.append({'key':k,'error':str(e)[:200]});print(k,str(e)[:150],flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as p:list(p.map(get,SOURCES.items()))
# Limit specialty directory batch to avoid disproportionate duplication before review.
selected=[]
for k in ['neurologia','ful-orr-gegeszek','szemeszek']:
 seen=set()
 for x in out:
  if k in x['categories'] and x['name'] not in seen and len(seen)<45:selected.append(x);seen.add(x['name'])
(P/'extra-candidates-medical.json').write_text(json.dumps(selected,ensure_ascii=False,indent=2))
(P/'medical-audit.json').write_text(json.dumps(reports,ensure_ascii=False,indent=2))
print('MEDICAL_CANDIDATES',len(selected))
