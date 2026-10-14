const fs=require('fs');const path=require('path');const {Pool}=require('pg');const slugify=require('slugify');
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSLMODE==='disable'?false:{rejectUnauthorized:false}});
const dir=path.join(__dirname,'..','cikkek');
const strip=s=>String(s||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
const pick=(html,re,def='')=>{const m=html.match(re);return m?strip(m[1]):def};
const body=(html)=>{const m=html.match(/<div class="article-body"[^>]*>([\s\S]*?)(?:<div class="author-card"|<\/div><aside class="article-aside")/i);return m?m[1].trim():''};
(async()=>{
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL hiányzik');
 const files=fs.readdirSync(dir).filter(x=>x.endsWith('.html'));
 for(const file of files){
   const html=fs.readFileSync(path.join(dir,file),'utf8');
   const title=pick(html,/<h1>([\s\S]*?)<\/h1>/i,path.basename(file,'.html'));
   const category=pick(html,/<div class="article-kicker">([\s\S]*?)<\/div>/i,'Önismeret');
   const excerpt=pick(html,/<p class="article-lead">([\s\S]*?)<\/p>/i,'');
   const content=body(html);
   const slug=slugify(path.basename(file,'.html'),{lower:true,strict:true,locale:'hu'});
   const words=strip(content).split(/\s+/).filter(Boolean).length;
   const mins=Math.max(1,Math.ceil(words/220));
   await pool.query(`INSERT INTO articles(slug,title,category,excerpt,content_html,author_name,status,reading_minutes,published_at)
     VALUES($1,$2,$3,$4,$5,'MENTÁL.hu','published',$6,now())
     ON CONFLICT(slug) DO UPDATE SET title=EXCLUDED.title,category=EXCLUDED.category,excerpt=EXCLUDED.excerpt,
     content_html=EXCLUDED.content_html,reading_minutes=EXCLUDED.reading_minutes,updated_at=now()`,
     [slug,title,category,excerpt,content,mins]);
   console.log('imported:',slug);
 }
 await pool.end();
})().catch(e=>{console.error(e);process.exit(1)});