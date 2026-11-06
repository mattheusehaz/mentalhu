#!/usr/bin/env python3
import json,re,pathlib,concurrent.futures,hashlib,unicodedata,xml.etree.ElementTree as ET
from urllib.parse import urljoin,urlparse
import requests
from bs4 import BeautifulSoup
P=pathlib.Path('research/expansion-20261106');extra=[];report={}
def clean(t):return re.sub(r'\s+',' ',t or '').strip()
def norm(t):return unicodedata.normalize('NFKD',t).encode('ascii','ignore').decode().lower()
def read(url):
 r=requests.get(url,timeout=(8,22),headers={'User-Agent':'MENTAL.hu public directory research'});r.raise_for_status();return r,BeautifulSoup(r.content,'html.parser')
def add(name,cats,url,label,qual='',city='',website='',evidence=''):
 extra.append(dict(name=clean(name),categories=cats,source_url=url,source_name=label,qualifications=qual,city=city,website_url=website,evidence=evidence))
# Explicit names were selected from the association's public practitioner section.
url='https://relaxacio.hu/szakembereink.html'
try:
 r,soup=read(url);text=clean(soup.get_text(' ',strip=True))
 names=['Dr. Németh Marietta','Nagy Ildikó','Szoláry Adrienn','Dr. Kövesdi Andrea','Stiblár Erika','Dr. Szombathelyi Éva','Lipárdy Krisztina','dr. Pető Csilla','Németh Piroska','Martényi Almási Erzsébet','Gubucz Ágnes','Hazai Melinda','Petró Viktória','Dr. Girgás Gabriella','Dr. Györgyiné Dr. Harsányi Judit','Tóth Levente Péter','Jenser Márta','Palasicsné Szövényi Piroska','Hadas Katalin','Kaplonyi Csilla','Uzonyi Adél','Czimmermann Éva','Bagó György','Dr. Gerencsérné Széles Zsuzsanna','Dobiné Samu Gabriella','Dr. Dombi Edina','Dr. Márton Éva','Dr. Nagy Mária','Dr. Szentmiklóssy Margit','Hartung István','Dr. Hegedüs Katalin','Láng Györgyi','Paksa Éva','Orbán Zsuzsanna','Tanító-Konkoly Gabriella','Koplányi Csilla','Pozbai Viola','Gyarmati Zsuzsa']
 for name in names:
  if norm(name) in norm(text):add(name,['alvas-es-relaxacio'],url,'Magyar Relaxációs és Szimbólumterápiás Egyesület',evidence='A relaxációs szakemberek nyilvános jegyzékében szerepel.')
 report['relaxation_names_found']=len(extra)
except Exception as e:report['relaxation_error']=str(e)[:200]
# Public WordPress sitemaps identify individual profile pages, not invented URL slugs.
base='https://www.kineziologuskereso.hu';urls=set();sitemaps=[]
for path in ['/sitemap_index.xml','/wp-sitemap.xml','/sitemap.xml']:
 try:
  r=requests.get(base+path,timeout=15);root=ET.fromstring(r.content)
  locs=[x.text for x in root.iter() if x.tag.endswith('loc') and x.text]
  urls.update(u for u in locs if '/kineziologusok/' in u and not u.endswith('.xml'))
  sitemaps += [u for u in locs if '.xml' in u and any(k in u for k in ['post','kineziolog','page'])]
  if sitemaps or urls:break
 except Exception:pass
for url in sitemaps[:8]:
 try:
  r=requests.get(url,timeout=15);root=ET.fromstring(r.content)
  urls.update(x.text for x in root.iter() if x.tag.endswith('loc') and x.text and '/kineziologusok/' in x.text)
 except Exception:pass
if not urls:
 try:
  r=requests.get(base+'/wp-json/wp/v2/types',timeout=15);types=r.json()
  for key,v in types.items():
   if 'kineziolog' in key:
    response=requests.get(base+'/wp-json/'+v.get('rest_namespace','wp/v2')+'/'+v['rest_base'],params={'per_page':100},timeout=20)
    if response.ok:urls.update(x['link'] for x in response.json())
 except Exception:pass
report['kinesiology_profile_urls']=len(urls)
def kine(url):
 try:
  r,soup=read(url);h=soup.find('h1');name=clean(h.get_text(' ',strip=True)) if h else clean(soup.title.get_text()).split('–')[0].strip()
  if not 2<=len(name.split())<=6 or re.search('kereső|kereso|archív|archiv',name,re.I):return None
  return dict(name=name,categories=['kineziologusok'],source_url=r.url,source_name='Magyarországi Kineziológiai Alapítvány – Kineziológuskereső',evidence='Nyilvános szakemberprofil',website_url='',city='')
 except Exception:return None
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:extra += [r for r in pool.map(kine,sorted(urls)[:45]) if r]
report['kinesiology_imported']=sum('kineziologusok' in x['categories'] for x in extra)
# Inspect explicit career-service descriptions on ICF member profiles. Keep excerpts for review.
icf=json.loads((P/'icf.json').read_text())
profiles=[a for a in icf['links'] if 'coach-card' in a['attrs'].get('class',[])]
def career(a):
 try:
  r,soup=read(a['url']);main=soup.find('main') or soup
  for node in main.select('nav,header,footer,script,style'):node.decompose()
  text=clean(main.get_text(' ',strip=True));n=norm(text)
  match=re.search(r'karrier[- ]?coach\w*|karriertanacs\w*|palyaorient\w*|karriervalt\w*|palyavalt\w*',n)
  if not match:return None
  return {'name':clean(re.sub(r'\b(?:ACC|PCC|MCC|ACTC)\b','',a['text'])),'url':r.url,'excerpt':text[max(0,match.start()-100):match.end()+200]}
 except Exception:return None
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:career_rows=[r for r in pool.map(career,profiles[:120]) if r]
report['career_candidates']=career_rows
# Audits for additional well-defined public source collections (parsed in next research pass).
extra_urls={
 'nature':'https://onlineorvoskereso.hu/index.php/cimlap/kereses-tipus/kereszszavak/term%C3%A9szetgy%C3%B3gy%C3%A1szat.html',
 'books':'https://kulcslyukkiado.hu/konyveink/',
 'kulkonyv':'https://kulcslyukkiado.hu/',
 'mentaltraining':'https://semmelweis.hu/mental/kepzesek/',
 'careerorient':'https://orientify.hu/tanacsadok',
 'yoga':'https://www.yogayogi.hu/hu/studios/'
}
def audit_source(pair):
 key,url=pair
 try:
  r,soup=read(url);main=soup.find('main') or soup
  headings=[{'tag':h.name,'text':clean(h.get_text(' ',strip=True)),'attrs':h.attrs} for h in main.find_all(['h1','h2','h3','h4'])]
  links=[{'name':clean(a.get_text(' ',strip=True))[:200],'url':urljoin(r.url,a['href']),'attrs':a.attrs} for a in main.find_all('a',href=True) if clean(a.get_text(' ',strip=True))]
  result={'url':r.url,'title':clean(soup.title.get_text()) if soup.title else '', 'headings':headings,'links':links}
  (P/(key+'-extra.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2));return {'source':key,'headings':headings[:12],'links':len(links)}
 except Exception as e:return {'source':key,'error':str(e)[:150]}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:report['additional_sources']=list(pool.map(audit_source,extra_urls.items()))
(P/'extra-candidates.json').write_text(json.dumps(extra,ensure_ascii=False,indent=2))
(P/'extra-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
