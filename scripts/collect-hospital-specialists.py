import requests,json,re,pathlib,unicodedata
from bs4 import BeautifulSoup
from urllib.parse import urljoin
P=pathlib.Path('research/expansion-20261106');out=[];report=[]
def clean(t):return re.sub(r'\s+',' ',t or '').strip()
def n(t):return unicodedata.normalize('NFKD',t).encode('ascii','ignore').decode().lower()
def add(name,cat,url,label,qual='',website=''):
 out.append({'name':clean(name),'categories':[cat],'source_url':url,'source_name':label,'kind':'provider','city':'Budapest','website_url':website,'qualifications':qual,'evidence':'A szolgáltató saját intézményi munkatársi névsorában szerepel; az egyéni betegfogadás és beutalás feltételei külön ellenőrizendők.'})
url='https://www.szentimrekorhaz.hu/index.php/orvosaink-2/'
try:
 r=requests.get(url,timeout=30);r.raise_for_status();s=BeautifulSoup(r.content,'html.parser')
 for tr in s.find_all('tr'):
  cells=[clean(x.get_text(' ',strip=True)) for x in tr.find_all(['td','th'])]
  if len(cells)<3 or not re.match(r'^(?:Dr\.|Prof\.)',cells[0],re.I):continue
  name,qualification,department=cells[:3];q=n(qualification);d=n(department)
  if any(x in q for x in ['rezidens','jelolt','altalanos orvos']):continue
  if not any(x in q for x in ['szakorvos','foorvos','adjunktus','egyetemi']):continue
  cat='neurologia' if 'neurolog' in d else 'ful-orr-gegeszek' if 'ful' in d and 'gege' in d else 'szemeszek' if 'szemeszet' in d else None
  if cat:add(name,cat,url,'Dél-budai Centrumkórház – Szent Imre Egyetemi Oktatókórház',qualification+'; '+department)
 report.append({'source':url,'records':len(out)})
except Exception as e:report.append({'source':url,'error':str(e)[:160]})
url='https://semmelweis.hu/neurologia/munkatarsak/'
try:
 r=requests.get(url,timeout=30);r.raise_for_status();s=BeautifulSoup(r.content,'html.parser');text=clean(s.get_text(' ',strip=True))
 # Named senior/clinical doctors, not residents, psychologists or currently absent staff.
 names=['Arányi Zsuzsanna','Bereczki Dániel','Bozsik György','Debreczeni Róbert','Farkas Zsuzsanna','Gulyás Szilvia','Gunda Bence','Kovács Tibor','Simó Magdolna','Sipos Ildikó','Takáts Annamária','Tamás Gertrúd','Vastagh Ildikó','Kamondi Anita','Csillik Anita','Iljicsov Anna','Mezei Zsolt','Farsang Marianna','Hornyák Csilla','Kelemen Andrea','Szatmári Szabolcs','Szőke Kristóf','Tóth Adrián','Soós Krisztina','Tegze Nárcis Klaudia','Dabasi Loránd Endre','Demeter Ildikó','Dobronyi Levente','Fritz-Ruenes Pablo Antonio','Ilniczky Sándor','Kollai Sarolta','Milanovich Dániel','Palotai Marcell László','Sisak Dominika','Takács Tímea Tünde']
 before=len(out)
 for name in names:
  if n(name) not in n(text):continue
  link=next((a for a in s.find_all('a',href=True) if n(name) in n(a.get_text(' ',strip=True))),None)
  target=urljoin(r.url,link['href']) if link else url
  add('Dr. '+name,'neurologia',target,'Semmelweis Egyetem Neurológiai Klinika','Neurológiai klinikai szakorvos / oktató a klinika munkatársi névsora szerint.',target if link else '')
 report.append({'source':url,'records':len(out)-before})
except Exception as e:report.append({'source':url,'error':str(e)[:160]})
url='https://www.fulorrgegekozpont.hu/ful-orr-gegeszeti-maganrendeles'
try:
 r=requests.get(url,timeout=30);r.raise_for_status();s=BeautifulSoup(r.content,'html.parser');text=clean(s.get_text(' ',strip=True));before=len(out)
 for name in ['Csóka János','Holpert Valéria','Fülöp Györgyi','Augusztinovicz Monika','Balogh Katalin','Moric Krisztina','Lukács Anita','Viszoki Mónika']:
  a=next((a for a in s.find_all('a',href=True) if n(name) in n(a.get_text(' ',strip=True))),None)
  if a:add('Dr. '+name,'ful-orr-gegeszek',urljoin(r.url,a['href']),'Fül-orr-gége Központ','Fül-orr-gégész szakorvos a rendelő bemutatkozása szerint.',urljoin(r.url,a['href']))
 report.append({'source':url,'records':len(out)-before})
except Exception as e:report.append({'source':url,'error':str(e)[:160]})
(P/'extra-candidates-hospital.json').write_text(json.dumps(out,ensure_ascii=False,indent=2))
(P/'hospital-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False))
