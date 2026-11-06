import requests,json,pathlib,re,concurrent.futures
from bs4 import BeautifulSoup
from urllib.parse import urljoin
P=pathlib.Path('research/expansion-20261106')
urls={
'books-list':'https://nyitottakademia.hu/webshop/kulcslyuk-kiado-konyvei',
'events-list':'https://nyitottakademia.hu/rendezvenyek',
'nature-joszaki':'https://joszaki.hu/szakemberek/termeszetgyogyasz',
'kinez-joszaki':'https://joszaki.hu/szakemberek/kineziologus',
'grief-groups':'https://www.gyaszportal.hu/gyaszoloknak/indulo-gyaszcsoportok',
'semmelweis-training':'https://semmelweis.hu/ekk/oktatas/szakiranyu-tovabbkepzes/',
'anon-groups':'https://csakamainap.info/hu/fooldal/egyeb-aa/anonim-kozossegek'}
def clean(t):return re.sub(r'\s+',' ',t or '').strip()
def get(kv):
 k,u=kv
 try:
  r=requests.get(u,timeout=25);r.raise_for_status();s=BeautifulSoup(r.content,'html.parser');main=s.find('main') or s
  links=[dict(text=clean(a.get_text(' ',strip=True)),url=urljoin(r.url,a['href']),attrs=a.attrs) for a in main.find_all('a',href=True)]
  heads=[dict(text=clean(h.get_text(' ',strip=True)),tag=h.name,attrs=h.attrs,parent=str(h.parent)[:2200]) for h in main.find_all(['h1','h2','h3','h4'])]
  cards=[str(x)[:5000] for x in main.select('.book-card,.event-card,article')[:4]]
  d=dict(url=r.url,title=clean(s.title.get_text()),links=links,headings=heads,cards=cards,text=clean(main.get_text(' ',strip=True))[:60000])
  (P/(k+'.json')).write_text(json.dumps(d,ensure_ascii=False,indent=2));print(k,len(heads),len(links),flush=True)
 except Exception as e:print(k,str(e)[:150],flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as p:list(p.map(get,urls.items()))
