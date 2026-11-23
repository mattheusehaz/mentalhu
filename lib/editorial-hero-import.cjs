'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const LOCK_ID = 6938036;

function validateAssignment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_HERO_ASSIGNMENT');
  const keys = ['external_id','article_revision','image_path','image_sha256','alt_text','approval_reference'];
  if (Object.keys(value).some(x=>!keys.includes(x))) throw new Error('INVALID_HERO_ASSIGNMENT');
  if (typeof value.external_id !== 'string' || !/^mental-research-[0-9]{5,12}$/.test(value.external_id)) throw new Error('INVALID_HERO_ID');
  if (typeof value.article_revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.article_revision)) throw new Error('INVALID_HERO_REVISION');
  if (typeof value.image_path !== 'string' || !/^\/assets\/mental-research-[0-9]{5,12}-hero\.jpg$/.test(value.image_path) || !value.image_path.includes(value.external_id)) throw new Error('INVALID_HERO_PATH');
  if (typeof value.image_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.image_sha256)) throw new Error('INVALID_HERO_SHA');
  if (typeof value.alt_text !== 'string' || value.alt_text.length > 300) throw new Error('INVALID_HERO_ALT');
  if (typeof value.approval_reference !== 'string' || !/^chat(?:-message|-approval)?:\S.{0,480}$/.test(value.approval_reference)) throw new Error('INVALID_HERO_APPROVAL_REFERENCE');
  return value;
}

async function importApprovedHeroAssignments({pool,root,logger=console}) {
  const file = path.join(root,'content/approved-hero-assignments.json');
  const stats = {updated:0,skipped:0,errors:[]};
  if (!fs.existsSync(file)) return stats;
  let assignments;
  try {
    if (fs.statSync(file).size > 20000) throw new Error('HERO_MANIFEST_TOO_LARGE');
    assignments=JSON.parse(fs.readFileSync(file,'utf8'));
    if (!Array.isArray(assignments) || assignments.length>100) throw new Error('INVALID_HERO_MANIFEST');
    const ids=new Set();
    for(const item of assignments){validateAssignment(item);if(ids.has(item.external_id))throw new Error('DUPLICATE_HERO_ASSIGNMENT');ids.add(item.external_id);}
  } catch(err) {logger.error('[editorial-heroes] invalid manifest',err.message); stats.errors.push('INVALID_HERO_MANIFEST');return stats;}
  for(const item of assignments){
    const diskPath=path.join(root,item.image_path.slice(1));
    try{
      if(!fs.existsSync(diskPath))throw new Error('HERO_IMAGE_MISSING');
      const hash=crypto.createHash('sha256').update(fs.readFileSync(diskPath)).digest('hex');
      if(hash!==item.image_sha256)throw new Error('HERO_IMAGE_HASH_MISMATCH');
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)',[LOCK_ID]);
        const previous=await client.query('SELECT 1 FROM article_hero_assignment_ledger WHERE external_id=$1',[item.external_id]);
        if(previous.rowCount){await client.query('COMMIT');stats.skipped++;continue;}
        const article=await client.query(`SELECT id,status,hero_image_path,hero_image_id,content_revision
          FROM articles WHERE external_id=$1 FOR UPDATE`,[item.external_id]);
        if (!article.rowCount || article.rows[0].status!=='published' || article.rows[0].content_revision!==item.article_revision || article.rows[0].hero_image_path || article.rows[0].hero_image_id) {
          await client.query('ROLLBACK');stats.skipped++;continue;
        }
        const id=article.rows[0].id;
        await client.query('UPDATE articles SET hero_image_path=$1,hero_image_alt=$2,updated_at=now() WHERE id=$3',[item.image_path,item.alt_text,id]);
        await client.query(`INSERT INTO article_hero_assignment_ledger(external_id,article_revision,image_path,image_sha256,article_id)
          VALUES($1,$2,$3,$4,$5)`,[item.external_id,item.article_revision,item.image_path,item.image_sha256,id]);
        await client.query(`INSERT INTO cms_audit_log(action,entity_type,entity_id,actor_email,details)
          VALUES('attach_approved_hero','article',$1,NULL,$2)`,[String(id),JSON.stringify({image_path:item.image_path,image_sha256:item.image_sha256,approval_reference:item.approval_reference,article_revision:item.article_revision})]);
        await client.query('COMMIT');stats.updated++;
      }catch(err){await client.query('ROLLBACK').catch(()=>{});throw err;}finally{client.release();}
    }catch(err){logger.error('[editorial-heroes] skipped',item.external_id,err.message);stats.errors.push({external_id:item.external_id,code:err.message});}
  }
  return stats;
}
module.exports={importApprovedHeroAssignments,validateAssignment};
