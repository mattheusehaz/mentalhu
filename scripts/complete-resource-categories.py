#!/usr/bin/env python3
import json,re,pathlib,concurrent.futures,hashlib
from urllib.parse import urljoin,urlparse
import requests
from bs4 import BeautifulSoup
P=pathlib.Path('research/expansion-20261106');rows=[];audit=[]
def clean(v):return re.sub(r'\s+',' ',v or '').strip()
def add(name,url,cat,kind='media',lang='Magyar',description='',**extra):
 rows.append(dict(name=name,url=url,categories=[cat],kind=kind,languages=lang,description=description,source_name=urlparse(url).hostname,source_verified_via='primary publisher or institution page',**extra))
# Original titles and bibliographic facts only; publisher descriptions are not reproduced.
B='https://nyitottakademia.hu/webshop/konyv/'
books=[
('Terri Cole – Apaseb','terri-cole_apaseb-7808'),
('Szigethi Zsófia – Láthatatlan akadályok','szigethi-zsofia_lathatatlan-akadalyok-6996'),
('Unoka Zsolt – Élettörténeted térképe','unoka-zsolt_elettorteneted-terkepe-7801'),
('John Bradshaw – Hazatérés önmagadhoz','john-bradshaw_hazateres-onmagadhoz-6055'),
('Jagi Dzsimpei – Dzsikorikai','jagi-dzsimpei_dzsikorikai-7997'),
('Szigethi Zsófia – A Kifli család meséi','szigethi-zsofia_a-kifli-csalad-mesei-7824'),
('John Bradshaw – Értsd meg a családodat, hogy megértsd önmagad!','john-bradshaw_ertsd-meg-a-csaladodat-hogy-megertsd-onmagad-7520'),
('Szabó-Bartha Anett – Elfáradtunk','szabobartha-anett_elfaradtunk-7588'),
('Katia Fredriksen és Yael Rothman – Másképp gondolkodók: Autizmus','valogatott-irasok_maskepp-gondolkodok-autizmus-7741'),
('Mogyorósy-Révész Zsuzsanna és Vaskor Gréta – A félelemtől a biztonságig','valogatott-irasok_a-felelemtol-a-biztonsagig-7730'),
('John W. James és Russell Friedman – Gyászfeldolgozás Módszer kézikönyv','valogatott-irasok_gyaszfeldolgozas-modszer%C2%AE-kezikonyv-7587'),
('Katia Fredriksen és Yael Rothman – Másképp gondolkodók: ADHD','valogatott-irasok_maskepp-gondolkodok-adhd-7582'),
('Popper Péter – Egy illúzió halála','popper-peter_egy-illuzio-halala-7522'),
('Fejes Dóra – Futóterápia','fejes-dora_futoterapia-7028'),
('Thuróczy Bertalan – Amit egykori önmagamnak mesélnék','thuroczy-bertalan_amit-egykori-onmagamnak-meselnek-7426'),
('Almási Kitti – Elárult bizalom','almasi-kitti_elarult-bizalom-7089'),
('Bagdy Emőke – Pszichológiai rejtelmek a művészetekben és életünkben','bagdy-emoke_pszichologiai-rejtelmek-a-muveszetekben-es-eletunkben-7088')]
for name,path in books:add(name,B+path,'podcastok-es-konyvek',description='Magyar nyelvű könyv. Bibliográfiai adatok, tartalomismertető és beszerzési lehetőség a kiadó oldalán. Ismeretterjesztő forrás, nem személyre szabott diagnózis vagy kezelés.')
# These distinct works are explicitly linked from the publisher's related-books section.
for name,parent in [('Szabó-Bartha Anett – Sémakémia','szabobartha-anett_elfaradtunk-7588'),('Szabó-Bartha Anett – Elménk csapdájában','szabobartha-anett_elfaradtunk-7588'),('Szabó-Bartha Anett és Szondy Máté – Démonaink','szabobartha-anett_elfaradtunk-7588'),('Peg Dawson és Richard Guare – Okos, de szétszórt','valogatott-irasok_maskepp-gondolkodok-adhd-7582'),('Pál Kata Dorottya és Sas Eszter Krisztina – Mentális elsősegély napló','fejes-dora_futoterapia-7028')]:
 add(name,B+parent,'podcastok-es-konyvek',description='Magyar nyelvű pszichológiai könyv. A hivatkozott kiadói oldal kapcsolódó könyvei között található; a külön adatlap onnan nyitható meg.')
# Screening and assessment resources: external official pages only. No questionnaires, scoring, responses or health data are copied/stored here.
tests=[
('ASRS – felnőtt ADHD önbeszámolós skálák','https://www.hcp.med.harvard.edu/ncs/asrs_2025.php','Harvard Medical School; a felhasználási feltételeket és fordításokat a hivatalos oldalon ellenőrizd.'),
('WHO-5 – jólléti kérdőív','https://www.who.int/publications/m/item/who-ucn-msd-mhe-2024.01','WHO; magyar nyelvű változat is elérhető a hivatalos nyelvi listában.'),
('SDQ – Képességek és Nehézségek Kérdőív','https://www.sdqinfo.org/py/sdqinfo/b3.py?language=Hungarian','A kérdőív hivatalos magyar nyelvű változatainak oldala; életkor és kitöltő szerinti változatok.'),
('PHQ-9 – depressziós tünetek szűrőkérdőíve','https://www.hiv.uw.edu/page/mental-health-screening/phq-9','University of Washington; angol nyelvű szakmai szűrőeszköz.'),
('GAD-7 – szorongásos tünetek szűrőkérdőíve','https://www.hiv.uw.edu/page/mental-health-screening/gad-7','University of Washington; angol nyelvű szakmai szűrőeszköz.'),
('K6 és K10 – pszichés distressz skálák','https://www.hcp.med.harvard.edu/ncs/k6_scales.php','Harvard Medical School; kérdőívváltozatok és használati információ.'),
('AUDIT – alkoholfogyasztási szűrőkérdőív','https://sbi.euro.who.int/tools/audit','WHO európai szakmai eszköztár.'),
('ASSIST – szerhasználati szűrés','https://www.who.int/activities/screening-and-brief-interventions-for-substance-use-problems','WHO; elsősorban egészségügyi szakemberek által alkalmazott szűrési eszköztár.'),
('Epworth Álmossági Skála – ESS','https://site.thoracic.org/assemblies/srn/sleep-related-questionnaires/ess','American Thoracic Society; a nappali álmosság felmérésére szolgáló kérdőív adatlapja.'),
('STOP-Bang – alvási apnoe kockázatának szűrése','https://site.thoracic.org/assemblies/srn/sleep-related-questionnaires/stop-bang','American Thoracic Society; szűrőeszköz, nem alvásvizsgálat vagy diagnózis.'),
('ISI – Insomnia Severity Index','https://site.thoracic.org/assemblies/srn/sleep-related-questionnaires/isi','American Thoracic Society; alvási nehézségek kérdőíves felmérésének szakmai adatlapja.'),
('PSQI – Pittsburgh Sleep Quality Index','https://www.sleep.pitt.edu/psqi','University of Pittsburgh; a felhasználási és engedélyezési feltételek a fejlesztő oldalán.'),
('AQ – felnőtt autizmus-spektrum kérdőív','https://www.autismresearchcentre.com/tests/autism-spectrum-quotient-aq-adult/','Autism Research Centre; angol nyelvű kutatási és szűrési forrás.'),
('M-CHAT-R/F – kisgyermekkori autizmusszűrő eszköz','https://www.mchatscreen.com/','A fejlesztők hivatalos oldala; életkorhoz kötött szűrés, szükség esetén szakmai követéssel.'),
('MoCA – Montreal Cognitive Assessment','https://www.mocacognition.com/the-moca-test/','Szakember által alkalmazandó kognitív vizsgálati eszköz. Nem önkitöltős internetes demenciadiagnózis.'),
('WHOQOL-BREF – életminőség-kérdőív','https://www.who.int/tools/whoqol/whoqol-bref','WHO; nyelvi változatok és a használat feltételei a hivatalos oldalon.')]
for name,url,note in tests:add(name,url,'tesztek',lang='Angol / elérhető fordítások a forrásnál',description=note+' A MENTÁL.hu csak a forráshoz irányít: nem végez kiértékelést és nem ment tesztválaszokat. A szűrőeredmény önmagában nem diagnózis.')
# Select exact published assessment hyperlinks from the US National Center for PTSD, not guessed paths.
va='https://www.ptsd.va.gov/professional/assessment/list_measures.asp'
try:
 r=requests.get(va,timeout=25);r.raise_for_status();s=BeautifulSoup(r.content,'html.parser')
 choices=[('PTSD Checklist for DSM-5','PCL-5 – PTSD tüneti kérdőív'),('Primary Care PTSD Screen for DSM-5','PC-PTSD-5 – PTSD szűrőkérdőív'),('Dissociative Subtype of PTSD Scale','DSPS – disszociatív tünetek skálája'),('Dissociative Symptoms Scale','DSS – disszociatív tünetek kérdőíve'),('Life Events Checklist for DSM-5','LEC-5 – életesemények kérdőív'),('International Trauma Questionnaire','ITQ – nemzetközi trauma kérdőív'),('Posttraumatic Diagnostic Scale','PDS-5 – poszttraumás tünetek skálája'),('SPRINT','SPRINT – poszttraumás tüneti szűrő')]
 for label,name in choices:
  a=next((a for a in s.find_all('a',href=True) if label in clean(a.get_text(' ',strip=True)) and '/professional/assessment/' in urljoin(va,a['href'])),None)
  if a:add(name,urljoin(va,a['href']),'tesztek',lang='Angol / fordítások a forrásnál',description='A National Center for PTSD szakmai eszközismertetője. Nem minden eszköz önkitöltős vagy szabadon felhasználható; a hozzáférést és a megfelelő alkalmazást a forrásoldalon kell ellenőrizni. A szűrés nem diagnózis, válaszokat nem tárolunk.')
 audit.append({'source':va,'selected':sum(x['categories']==['tesztek'] for x in rows)})
except Exception as e:audit.append({'source':va,'error':str(e)[:150]})
# Named schools on the ICF Hungary list, once per provider (not once per accreditation level).
u='https://coachingfederation.hu/coaching-kompetenciak-minositesek-kepzesek/kepzesek-tovabbkepzesek/akkreditalt-kepzok/'
try:
 r=requests.get(u,timeout=25);r.raise_for_status();s=BeautifulSoup(r.content,'html.parser');seen=set()
 for h in s.find_all('h3'):
  a=h.find('a',href=True)
  if not a:continue
  name=clean(a.get_text(' ',strip=True));site=urljoin(r.url,a['href']);host=urlparse(site).hostname or ''
  if not name or len(name)>100 or host in seen or 'coachingfederation.hu' in host:continue
  seen.add(host);add(name+' – coachképzések',u,'kepzesek',kind='organization',website_url=site,description='Az ICF Magyar Tagozat képzőhely-listáján szereplő szervezet. A pontos programot, belépési feltételeket, indulást és az akkreditáció aktuális érvényességét a képzőnél ellenőrizd.')
 audit.append({'source':u,'schools':len(seen)})
except Exception as e:audit.append({'source':u,'error':str(e)[:150]})
# Independent mental-health information publishers. English sources are explicitly labelled.
media=[
('Mindennapi Pszichológia','https://mipszi.hu/','Magyar'),
('Pszichoterápia – MentalPort','https://www.mentalport.hu/','Magyar'),
('Szorongók magazin','https://szorongok.hu/rolunk/','Magyar'),
('Magyar Coachszemle','https://coachszemle.hu/','Magyar'),
('Egészségvonal – lelki egészség','https://egeszsegvonal.gov.hu/maradj-egeszseges/lelki-egeszseg/lelkisegely/lelki-egeszseg.html','Magyar'),
('WEBBeteg – pszichés betegségek','https://www.webbeteg.hu/cikkek/psziches','Magyar'),
('Házipatika','https://www.hazipatika.com/','Magyar'),
('WMN','https://wmn.hu/','Magyar'),
('Képmás','https://kepmas.hu/','Magyar'),
('Nők Lapja – pszichológia','https://www.noklapja.hu/','Magyar'),
('Dívány – lélek és pszichológia','https://divany.hu/','Magyar'),
('RIROSZ – mentális egészség','https://www.rirosz.hu/mentalis-egeszseg/','Magyar'),
('National Institute of Mental Health – Health Information','https://www.nimh.nih.gov/health','Angol'),
('American Psychological Association – Psychology Topics','https://www.apa.org/topics','Angol'),
('Mind – Information and Support','https://www.mind.org.uk/information-support/','Angol'),
('Mental Health Foundation – mental health information','https://www.mentalhealth.org.uk/explore-mental-health','Angol'),
('NHS – Mental Health','https://www.nhs.uk/mental-health/','Angol'),
('Greater Good Magazine – UC Berkeley','https://greatergood.berkeley.edu/','Angol'),
('Psychology Today','https://www.psychologytoday.com/','Angol'),
('Verywell Mind','https://www.verywellmind.com/','Angol'),
('WHO – Mental Health','https://www.who.int/health-topics/mental-health','Angol'),
('Child Mind Institute','https://childmind.org/','Angol'),
('YoungMinds – mental health information','https://www.youngminds.org.uk/','Angol'),
('Royal College of Psychiatrists – Mental Health','https://www.rcpsych.ac.uk/mental-health','Angol')]
for name,url,lang in media:add(name,url,'magazinok-es-portalok',lang=lang,description=('Magyar' if lang=='Magyar' else 'Angol')+' nyelvű tájékoztató portál vagy szerkesztőségi kiadvány, mentális egészséggel, pszichológiával vagy jólléttel kapcsolatos tartalmakkal. A hivatkozás a kiadó vagy intézmény saját felületére vezet; nem személyre szabott ellátás.')
# Event calendars and recurring professional programmes are labelled as such, not fabricated upcoming dates.
events=[
('Magyar Pszichológiai Társaság – rendezvények','https://mpt.hu/rendezvenyek/'),
('Magyar Pszichiátriai Társaság – szakmai rendezvények','https://www.mptpszichiatria.hu/'),
('Magyar Individuálpszichológiai Egyesület – eseménynaptár','https://mipe.hu/esemenynaptar/'),
('Mindset – pszichológiai események','https://mindsetpszichologia.hu/esemenyek'),
('Jog és Pszichológia – előadások és tréningek','https://jogespszichologia.hu/event'),
('ICF Magyar Tagozat – események','https://coachingfederation.hu/esemenyek/'),
('Képmás-estek','https://kepmas.hu/hu/kepmas-estek'),
('Nyitott Akadémia – pszichológiai előadások','https://nyitottakademia.hu/rendezvenyek'),
('Pszichoterápia folyóirat – konferenciák','https://www.mentalport.hu/pszichoterapia-konferencia/'),
('Magyar Pszichodráma Egyesület – szakmai programok','https://www.pszichodrama.hu/'),
('Semmelweis Mentálhigiéné Intézet – konferenciák','https://semmelweis.hu/mental/konferenciak/'),
('Semmelweis Egyetem – tudományos programnaptár','https://semmelweis.hu/hirek/events/cat/tudomanyos-eloadasok-konferenciak-programok/'),
('Magyar Mentalizációs Egyesület – konferencia','https://mbthungary.eu/konferencia/'),
('Magyar Pszichoanalitikus Egyesület – konferenciák','https://psychoanalysis.hu/konferencia'),
('Magyar Gyermek- és Ifjúságpszichiátria és Társszakmák Társasága – rendezvények','https://www.magyipett.hu/'),
('Magyar Családterápiás Egyesület – szakmai rendezvények','https://csaladterapia.hu/'),
('Integratív Pszichoterápiás Egyesület – konferenciák','https://integrativ.hu/'),
('Magyar Hipnózis Egyesület – szakmai találkozók','https://hipnozis-mhe.hu/'),
('Magyar Relaxációs és Szimbólumterápiás Egyesület – szakmai programok','https://relaxacio.hu/'),
('Magyar Viselkedés-, Kognitív és Sématerápiás Egyesület – programok','https://vikote.hu/'),
('Magyar Lelki Elsősegély Telefonszolgálatok Szövetsége – szakmai rendezvények','https://sos116-123.hu/'),
('BBTE Alkalmazott Pszichológia Intézet – események','https://pszichologia.psiedu.ubbcluj.ro/hu/hirek-es-esemenyek/esemenyek/')]
for name,url in events:add(name,url,'konferenciak-es-esemenyek',kind='organization',description='Rendezvényszervező, szakmai programsorozat vagy eseménynaptár. Ez az adatlap nem egy újonnan meghirdetett alkalom dátumát jelöli: az aktuális időpontokat, jelentkezést és esetleges korábbi archívumot a szervező oldalán ellenőrizd.')
add('Kapcsolódás Napja – 2026. november 20.','https://kapcsolodasnapja.hu/','konferenciak-es-esemenyek',kind='event',city='Budapest',event_start='2026-11-20T09:00:00+01:00',event_end='2026-11-20T16:00:00+01:00',email='kapcsolodasnapja@proptechdigital.com',email_source_url='https://kapcsolodasnapja.hu/',description='Mentálhigiénés konferencia a kapcsolódásról és jóllétről. Helyszín: Sugár Event rendezvényközpont. A program és a jegyinformáció a szervező saját oldalán található.')
(P/'curated-resources.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2))
(P/'resources-report.json').write_text(json.dumps({'records':len(rows),'by_category':{c:sum(c in x['categories'] for x in rows) for c in ['kepzesek','tesztek','magazinok-es-portalok','konferenciak-es-esemenyek','podcastok-es-konyvek']},'sources':audit},ensure_ascii=False,indent=2))
print((P/'resources-report.json').read_text())
