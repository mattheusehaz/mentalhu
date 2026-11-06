#!/usr/bin/env python3
import json,re,pathlib,unicodedata,concurrent.futures
from urllib.parse import urljoin,urlparse,unquote
import requests
from bs4 import BeautifulSoup
P=pathlib.Path('research/expansion-20261106'); rows=[]; report={}
def clean(t):return re.sub(r'\s+',' ',t or '').strip()
def norm(t):return re.sub('[^a-z0-9]+',' ',unicodedata.normalize('NFKD',t).encode('ascii','ignore').decode().lower()).strip()
def email(t):
 matches=re.findall(r'[A-Za-z0-9.!#$%&\x27*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}',t)
 return next((m.lower().rstrip('.') for m in matches if not any(x in m.lower() for x in ['example','noreply','webmaster','adatved','dpo@','sentry','@2x'])), '')
def add(name,cats,source,label,city='',website='',mail='',evidence='',qual=''):
 rows.append({'name':clean(name),'categories':cats,'source_url':source,'source_name':label,'kind':'organization' if cats==['gyermekkori-diagnosztika'] else 'provider','city':city,'website_url':website,'email':mail,'email_source_url':source if mail else '', 'evidence':evidence,'qualifications':qual})
# The association explicitly lists these qualified hypnotherapy practitioners.
mhe=json.loads((P/'medical-hipnoterapeutak.json').read_text())
allowed=['Beszterci Felícia','Biró Gyula','Borzsák Enikő','Császár Zsuzsanna','Császár-Nagy Noémi','Dávid Tamás','Fa Ágnes','Fadgyas Ildikó','Fekete Olivia','Gáti Ágnes','Jakubovits Edit','Kelemen-Szilágyi Adrienn','Kemény Katalin','Koplányi Katalin','Kovács Zoltán Ambrus','Molnár Judit Eszter','Pálinkás Imre','Papp Zoltán','Seres Gabriella','Somogyi Erika','Sőti Csaba','Sümegi Szilvia','Sümeg Szilvia','Menyhárt Marianna','Dr. Med. Menyhárt Marianna']
def namekey(s):return re.sub(r'\b(?:dr|med|prof|phd)\b','',norm(s)).strip()
allow={namekey(x) for x in allowed}
for m in mhe['members']:
 if namekey(m['name']) not in allow:continue
 txt=m['text'];cats=['hipnoterapeutak'];n=norm(txt)
 if 'pszichologus' in n and 'szakpszichologus jelolt' not in n:cats.append('pszichologusok')
 if 'pszichiater' in n:cats.append('pszichiaterek')
 if 'neurologus' in n:cats.append('neurologia')
 add(m['name'],cats,m['url'],'Magyar Hipnózis Egyesület',mail=email(txt),evidence='Az egyesület terapeutajegyzékében hipnoterápiás képzettséggel szerepel. A pontos alapvégzettség és az ellátás feltételei a szakember profilján ellenőrizhetők.',qual='Hipnoterápiás képzettség az MHE nyilvános jegyzéke szerint; a pontos alapvégzettség a forrásoldalon.')
report['hypnosis']=[x['name'] for x in rows]
# Only the actual named instructors, not accordion headings or promotional prose.
a=json.loads((P/'medical-agykontroll.json').read_text());current=None
for h in a['headings']:
 if 'heading-line' in (h.get('parent_class') or []) and 2<=len(h['name'].split())<=6 and '?' not in h['name']:
  add(h['name'],['agykontroll'],a['url'],'Agykontroll Kft. – gyermekoktatói névsor',evidence='A szervező nyilvános gyermekagykontroll-oktatói névsorában szerepel. Önismereti és tanulási program, nem egészségügyi szolgáltatás.');current=rows[-1]
 elif current and h['name'].startswith('Elérhetőség'):
  for link in h.get('links',[]):
   if link['url'].startswith('mailto:'):current['email']=email(unquote(link['url']));current['email_source_url']=a['url']
   elif link['url'].startswith(('https://','http://')) and urlparse(link['url']).hostname!='agykontroll.hu':current['website_url']=link['url']
report['agykontroll']=[x['name'] for x in rows if 'agykontroll' in x['categories']]
# NGO-maintained map contains named diagnostic centers with local contact details.
mars=json.loads((P/'medical-gyermekkori-diagnosztika-mars.json').read_text())
for h in mars['headings']:
 if h['tag']!='h3' or 'marker' not in (h.get('parent_class') or []):continue
 txt=clean(BeautifulSoup(h['html'],'html.parser').get_text(' ',strip=True));n=norm(txt)
 if any(term in n for term in ['nem vegez autizmus','nem diagnoszti','nem autizmus']):continue
 name=h['name'];mail=next((email(unquote(l['url'])) for l in h['links'] if l['url'].startswith('mailto:')),'')
 site=next((l['url'] for l in h['links'] if l['url'].startswith(('http://','https://')) and urlparse(l['url']).hostname not in ['marsalapitvany.hu','www.google.com','maps.google.com']),'')
 cities=['Budapest','Veszprém','Debrecen','Szeged','Pécs','Győr','Miskolc','Nyíregyháza','Szolnok','Kecskemét','Gyula','Sopron','Szombathely','Eger','Székesfehérvár','Kaposvár','Tatabánya','Zalaegerszeg','Szekszárd','Békéscsaba','Esztergom','Mosonmagyaróvár','Szentendre']
 city=next((c for c in cities if c in txt),'')
 add(name,['gyermekkori-diagnosztika'],mars['url'],'MARS Alapítvány – diagnózisközpont-kereső',city=city,website=site,mail=mail,evidence='A MARS Alapítvány diagnózisközpont-keresőjében szereplő ellátóhely. Az életkori határ, vizsgálati kör, beutaló és aktuális fogadás a szolgáltatónál ellenőrizendő.')
report['child_centers']=[x['name'] for x in rows if 'gyermekkori-diagnosztika' in x['categories']]
# All 27 ophthalmologists are individually named on the clinic's current staff page.
u='https://www.budaiszemeszet.hu/orvosok'
try:
 r=requests.get(u,timeout=30);r.raise_for_status();s=BeautifulSoup(r.content,'html.parser')
 doctors=['Nagymihály Attila','Papp András','Resch Miklós','Szabó Antal','Antus Zsuzsanna','Barcsay György','Barcsay-Veres Amarilla','Bíró Bettina','Bodrogi Petra','Cserháti Zoltán','Erdei Zsuzsa','Füst Ágnes','Gaál Zsuzsanna','Jaros Katarina','Lendvai Zsanett','Megyesi Mária','Török Mátyás','Nagy Angéla','Nagy Éva','Pálya Fanni','Somodi Dóra','Szalai Irén','Tóth Emília','Tóth Flóra','Úr László','Vajda Szilvia','Volek Éva']
 for name in doctors:
  a=next((x for x in s.find_all('a',href=True) if namekey(x.get_text(' ',strip=True))==namekey(name)),None)
  if a:add('Dr. '+name,['szemeszek'],urljoin(r.url,a['href']),'Budai Szemészeti Központ',website=urljoin(r.url,a['href']),qual='Szemész szakorvos a rendelő nyilvános munkatársi bemutatkozása szerint.',evidence='A klinika saját szakorvosi bemutatkozása; időpont és rendelési hely egyeztetendő.')
except Exception as e:report['ophthalmology_error']=str(e)[:180]
report['ophthalmologists']=[x['name'] for x in rows if 'szemeszek' in x['categories']]
(P/'extra-candidates-medical-reviewed.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2))
(P/'medical-reviewed-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
