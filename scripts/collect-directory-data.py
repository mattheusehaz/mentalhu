#!/usr/bin/env python3
"""Compile factual public directory records; no production access or contact harvesting."""
import json,re,pathlib,unicodedata
from urllib.parse import urlparse
P=pathlib.Path('research/expansion-20261106')
CATS=[x['slug'] for x in json.loads((P/'categories.json').read_text())]+[x['slug'] for x in json.loads((P/'new-categories.json').read_text())]
existing=json.loads((P/'existing.json').read_text()); records={}; audit=[]
def clean(t):return re.sub(r'\s+',' ',t or '').strip()
def norm(t):
 t=unicodedata.normalize('NFKD',t).encode('ascii','ignore').decode().lower()
 t=re.sub(r'\([^)]*\)','',t);t=re.sub(r'\b(dr|prof|phd|habil|ifj|id)\.?\b','',t)
 return re.sub(r'[^a-z0-9]+','-',t).strip('-')
existing_index={norm(x['name']):x for x in existing}
def load(k):return json.loads((P/(k+'.json')).read_text())
def role_categories(q):
 n=norm(q);c=[]
 if 'pszichologus' in n and not any(x in n for x in ['hallgato','jelolt','kepzesben']):c.append('pszichologusok')
 if 'pszichiater' in n and 'jelolt' not in n:c.append('pszichiaterek')
 if 'pszichoterapeuta' in n and not any(x in n for x in ['jelolt','kepzesben']):c.append('pszichoterapeutak')
 if 'mentalhigien' in n and not any(x in n for x in ['kepzodo','kepzesben']):c.append('mentalhigienes-szakemberek')
 if 'coach' in n and 'jelolt' not in n:c.append('coachok')
 return c
def add(name,cat,source,source_name,city='',qual='',website='',kind='provider',evidence=''):
 name=clean(name);cats=list(dict.fromkeys(cat));key=norm(name)
 if len(name)<5 or len(name)>170 or not key or not cats or any(x not in CATS for x in cats):return None
 if any(x in name.lower() for x in ['elhunyt','†','névjegyzék','szaknévsor','adatvédel']):return None
 if key not in records:
  old=existing_index.get(key);slug=old['slug'] if old else key[:150]
  records[key]={'slug':slug,'name':old['name'] if old else name,'kind':kind,'city':clean(city),'qualifications':clean(qual)[:350],'website_url':website,'source_url':source,'source_name':source_name,'categories':[],'sources':[],'existing_slug':old['slug'] if old else None,'evidence':clean(evidence or qual or source_name)[:350],'retrieved_at':'2026-11-06','verified':False}
 r=records[key];r['categories']=sorted(set(r['categories']+cats))
 if source not in r['sources']:r['sources'].append(source)
 if not r['website_url'] and website:r['website_url']=website
 if not r['city'] and city:r['city']=clean(city)
 if not r['qualifications'] and qual:r['qualifications']=clean(qual)[:350]
 return r
for key,label,nc,cc,qc,base in [
 ('csalad','Magyar Családterápiás Egyesület',0,1,2,['par-es-csaladterapeutak']),
 ('csaladmental','Magyar Családterápiás Egyesület – mentálhigiénés szaknévsor',0,1,2,['mentalhigienes-szakemberek','par-es-csaladterapeutak']),
 ('integrativ','Integratív Pszichoterápiás Egyesület',0,2,1,[]),
 ('metamese','Metamorphoses Meseterápiás Egyesület',0,2,1,[])]:
 d=load(key);before=len(records)
 for table in d['tables']:
  for row in table['rows']:
   v=row['cells']
   if len(v)<=max(nc,cc,qc) or norm(v[nc]) in ['nev','name']:continue
   q=v[qc];cat=base+role_categories(q)
   if key=='csalad' and not re.search('család|csalad',q,re.I):continue
   website=next((a['url'] for a in row['links'] if urlparse(a['url']).hostname!=urlparse(d['url']).hostname),'')
   add(v[nc],cat,d['url'],label,city=v[cc],qual=q,website=website)
 audit.append({'source':key,'new_candidates':len(records)-before})
d=load('icf');before=len(records)
for a in d['links']:
 if 'coach-card' not in a['attrs'].get('class',[]):continue
 name=clean(re.sub(r'\b(?:ACC|PCC|MCC|ACTC)\b','',a['text']))
 add(name,['coachok'],a['url'],'ICF Magyar Tagozat',qual='ICF Magyar Tagozat nyilvános coach-adatlapja',evidence=a['text'])
audit.append({'source':'icf','new_candidates':len(records)-before})
for key,tag,cat,label in [('icon','h2','csaladallitas','ICON Integrál Családállítás'),('winwin','h3','mediatorok','Win-Win Mediátorok Egyesülete')]:
 d=load(key);before=len(records)
 for h in d['headings']:
  if h['tag']==tag and 2<=len(h['text'].split())<=6:add(h['text'],[cat],d['url'],label,evidence='Nyilvános szakembernévsor')
 audit.append({'source':key,'new_candidates':len(records)-before})
d=load('astrologus')
for name in ['Körmöczi Júlia','Juhász Nóra','Szabó Zsuzsanna','Molnárné Gyürki Erika','Liszkay Judit','Pernyei Gábor','Gál Judit','Zentai Anna','Sóvári Melinda','Jakab Zoltán Csaba','Bánhidi Viktória']:
 if norm(name) in norm(d['text']):add(name,['asztrologusok'],d['url'],'Asztrológusok Magyarországi Egyesülete')
for manual in sorted(P.glob('curated*.json')):
 for row in json.loads(manual.read_text()):
  r=add(row['name'],row['categories'],row['url'],row.get('source_name',urlparse(row['url']).hostname),row.get('city',''),row.get('qualifications',''),row.get('website_url',row['url']),row.get('kind','organization'),row.get('evidence',''))
  if r:
   for field in ['description','event_start','event_end','online_available','source_verified_via','languages','email','email_source_url']:
    if field in row:r[field]=row[field]
for extra in sorted(P.glob('extra-candidates*.json')):
 for row in json.loads(extra.read_text()):
  r=add(row['name'],row['categories'],row['source_url'],row['source_name'],row.get('city',''),row.get('qualifications',''),row.get('website_url',''),row.get('kind','provider'),row.get('evidence',''))
  if r:
   for field in ['description','event_start','event_end','online_available','languages','email','email_source_url']:
    if field in row:r[field]=row[field]
merged={x['slug']:{c['slug'] for c in x['categories']} for x in existing}
for r in records.values():merged.setdefault(r['slug'],set()).update(r['categories'])
counts={k:sum(k in c for c in merged.values()) for k in CATS}
report={'existing':len(existing),'candidate_entities':len(records),'new_entities':sum(not r['existing_slug'] for r in records.values()),'projected_unique_total':len(merged),'categories':counts,'below_minimum':{k:n for k,n in counts.items() if n<20},'sources':audit}
(P/'candidates.json').write_text(json.dumps(list(records.values()),ensure_ascii=False,indent=2))
(P/'coverage.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
