'use strict';

const rateLimit = require('express-rate-limit');
const fail = (code,message,httpStatus=400) => Object.assign(new Error(message),{code,httpStatus});
const accountOf = req => req.accountUser || req.providerUser;
function ratingScore(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key=>key!=='score') ||
      !Number.isInteger(body.score) || body.score < 1 || body.score > 5) {
    throw fail('INVALID_RATING','Válassz 1 és 5 közötti egész csillagértéket.');
  }
  return body.score;
}
function createProviderRatingService({pool,dbState,accounts,audit=()=>{}}) {
  const headers=(_req,res,next)=>{
    res.set({'Cache-Control':'private, no-store','Pragma':'no-cache','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'same-origin'});
    res.vary('Cookie');next();
  };
  const wrap=handler=>async(req,res)=>{
    if(!dbState.ready)return res.status(503).json({code:'RATINGS_UNAVAILABLE',error:'Az értékelések átmenetileg nem érhetők el.'});
    try {await handler(req,res);}
    catch(error){
      const known=Number.isInteger(error.httpStatus)&&error.httpStatus>=400&&error.httpStatus<500;
      if(!known)console.error('[provider-ratings]',/^[A-Z0-9_]{2,50}$/.test(error.code||'')?error.code:'RATINGS_UNAVAILABLE');
      res.status(known?error.httpStatus:503).json({code:known?error.code:'RATINGS_UNAVAILABLE',error:known?(error.message===error.code?'A kérés nem ellenőrizhető. Frissítsd az oldalt.':error.message):'Az értékelések átmenetileg nem érhetők el. Próbáld újra később.'});
    }
  };
  async function transaction(callback){
    const client=await pool.connect();
    try{await client.query('BEGIN');const result=await callback(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
    finally{client.release();}
  }
  async function listingFor(client,slug,lock=false){
    if(typeof slug!=='string'||!slug||slug.length>250||/[\u0000-\u001f\u007f]/.test(slug))throw fail('LISTING_NOT_FOUND','A szolgáltató nem található.',404);
    const row=(await client.query("SELECT id,slug,name FROM directory_listings WHERE slug=$1 AND status='published'"+(lock?' FOR SHARE':''),[slug])).rows[0];
    if(!row)throw fail('LISTING_NOT_FOUND','A szolgáltató nem található.',404);
    return row;
  }
  async function summary(client,listing,accountId){
    // A transaction client executes one query at a time. Do not queue concurrent
    // queries on it; modern pg versions deprecate that implicit serialization.
    const buckets=await client.query(`SELECT r.score,count(*)::int AS count FROM provider_ratings r
        JOIN provider_accounts a ON a.id=r.account_id
        WHERE r.listing_id=$1 AND a.email_verified_at IS NOT NULL AND a.disabled_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM provider_listing_owners o WHERE o.listing_id=r.listing_id AND o.account_id=r.account_id)
        GROUP BY r.score ORDER BY r.score`,[listing.id]);
    const mine=await client.query('SELECT score,created_at,updated_at FROM provider_ratings WHERE listing_id=$1 AND account_id=$2',[listing.id,accountId]);
    const ownership=await client.query('SELECT 1 FROM provider_listing_owners WHERE listing_id=$1 AND account_id=$2',[listing.id,accountId]);
    const counts=new Map(buckets.rows.map(row=>[Number(row.score),Number(row.count)]));
    const distribution=[1,2,3,4,5].map(score=>({score,count:counts.get(score)||0}));
    const count=distribution.reduce((n,row)=>n+row.count,0),total=distribution.reduce((n,row)=>n+row.score*row.count,0);
    return {listing,average:count?Math.round(total/count*10)/10:null,count,distribution,my_rating:mine.rows[0]||null,can_rate:ownership.rowCount===0};
  }
  async function save(slug,accountId,score){
    return transaction(async client=>{
      // Account lock serializes ratings with account suspension and simultaneous
      // writes by the same reader. The unique key prevents duplicate votes.
      const user=(await client.query('SELECT id FROM provider_accounts WHERE id=$1 AND disabled_at IS NULL AND email_verified_at IS NOT NULL FOR UPDATE',[accountId])).rows[0];
      if(!user)throw fail('LOGIN_REQUIRED','Jelentkezz be újra a fiókodba.',401);
      const listing=await listingFor(client,slug,true);
      if((await client.query('SELECT 1 FROM provider_listing_owners WHERE account_id=$1 AND listing_id=$2',[accountId,listing.id])).rowCount)throw fail('OWN_PROVIDER_RATING','A saját szolgáltatói adatlapodat nem értékelheted.',403);
      await client.query(`INSERT INTO provider_ratings(account_id,listing_id,score) VALUES($1,$2,$3)
        ON CONFLICT(account_id,listing_id) DO UPDATE SET score=EXCLUDED.score,updated_at=now()`,[accountId,listing.id,score]);
      return summary(client,listing,accountId);
    });
  }
  async function remove(slug,accountId){
    return transaction(async client=>{
      const user=(await client.query('SELECT id FROM provider_accounts WHERE id=$1 AND disabled_at IS NULL AND email_verified_at IS NOT NULL FOR UPDATE',[accountId])).rows[0];
      if(!user)throw fail('LOGIN_REQUIRED','Jelentkezz be újra a fiókodba.',401);
      const listing=await listingFor(client,slug,true);
      await client.query('DELETE FROM provider_ratings WHERE account_id=$1 AND listing_id=$2',[accountId,listing.id]);
      return summary(client,listing,accountId);
    });
  }
  function log(action,listing,req){try{Promise.resolve(audit(action,'provider_rating',listing.id,accountOf(req).email,{})).catch(()=>{});}catch{}}
  function register(app){
    const mutationLimiter=rateLimit({windowMs:60000,limit:30,keyGenerator:req=>'rating:'+accountOf(req).id,standardHeaders:true,legacyHeaders:false,
      handler:(_req,res)=>res.status(429).json({code:'RATE_LIMITED',error:'Túl sok módosítás érkezett. Egy perc múlva újra próbálhatod.'})});
    app.get('/api/ratings/:slug',headers,accounts.requireAccount,wrap(async(req,res)=>{
      const listing=await listingFor(pool,req.params.slug);
      res.json({...await summary(pool,listing,accountOf(req).id),csrf_token:accounts.csrfFor(req,res)});
    }));
    app.put('/api/ratings/:slug',headers,accounts.requireAccount,mutationLimiter,wrap(async(req,res)=>{
      accounts.protect(req);const result=await save(req.params.slug,accountOf(req).id,ratingScore(req.body));
      log('rating_saved',result.listing,req);res.json({...result,csrf_token:accounts.csrfFor(req,res),message:'Az értékelésedet elmentettük. Bármikor módosíthatod vagy törölheted.'});
    }));
    app.delete('/api/ratings/:slug',headers,accounts.requireAccount,mutationLimiter,wrap(async(req,res)=>{
      accounts.protect(req);const result=await remove(req.params.slug,accountOf(req).id);
      log('rating_removed',result.listing,req);res.json({...result,csrf_token:accounts.csrfFor(req,res),message:'Az értékelésedet töröltük.'});
    }));
  }
  return {register};
}

module.exports={createProviderRatingService,ratingScore};
