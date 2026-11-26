'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');

const MEDIA_LIMITS = Object.freeze({ image: 12 * 1024 * 1024, video: 100 * 1024 * 1024, base64Image: 1024 * 1024 });
const OPENAI_FILE_SCHEMA = Object.freeze({
  type: 'object',
  properties: { download_url: { type: 'string' }, file_id: { type: 'string' }, mime_type: { type: 'string' }, file_name: { type: 'string' } },
  required: ['download_url', 'file_id'], additionalProperties: false
});
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'video/mp4': 'mp4' };
const CHUNK_SIZE = 4 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });
const html = value => String(value || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

const blocked4 = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked4.addSubnet(address,prefix,'ipv4');
const global6 = new net.BlockList(); global6.addSubnet('2000::',3,'ipv6');
const blocked6 = new net.BlockList();
for (const [address,prefix] of [['2001::',32],['2001:db8::',32],['2001:10::',28],['2001:20::',28],['2002::',16],['3fff::',20]]) blocked6.addSubnet(address,prefix,'ipv6');

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !blocked4.check(address,'ipv4');
  if (family === 6) return global6.check(address,'ipv6') && !blocked6.check(address,'ipv6');
  return false;
}

function checkedUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw fail('INVALID_MEDIA_URL');
  let url;
  try { url = new URL(value); } catch { throw fail('INVALID_MEDIA_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw fail('INVALID_MEDIA_URL');
  const host = url.hostname.replace(/^\[|\]$/g,'');
  if (!host || /(?:^|\.)(?:localhost|local|internal|test)$/.test(host) || (net.isIP(host) && !isPublicAddress(host))) throw fail('MEDIA_SOURCE_NOT_PUBLIC');
  return { url, host };
}

async function lookupPublic(host, lookup, remaining) {
  if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];
  let timer;
  try {
    const addresses = await Promise.race([
      lookup(host, { all:true, verbatim:true }),
      new Promise((_,reject) => { timer=setTimeout(()=>reject(fail('MEDIA_DOWNLOAD_TIMEOUT')),Math.min(8000,remaining)); timer.unref?.(); })
    ]);
    if (!Array.isArray(addresses) || !addresses.length || addresses.some(item=>!isPublicAddress(item.address))) throw fail('MEDIA_SOURCE_NOT_PUBLIC');
    return addresses;
  } catch (error) {
    if (['MEDIA_SOURCE_NOT_PUBLIC','MEDIA_DOWNLOAD_TIMEOUT'].includes(error.code)) throw error;
    throw fail('MEDIA_DOWNLOAD_FAILED');
  } finally { clearTimeout(timer); }
}

// Resolve and pin a public address for every hop. TLS still verifies the original
// hostname, and redirects cannot inherit credentials, cookies or custom headers.
async function downloadMedia(sourceUrl, { maxBytes, timeoutMs = 120000, lookup = dns.lookup.bind(dns), request = https.request } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>MEDIA_LIMITS.video) throw fail('INVALID_MEDIA_DOWNLOAD_LIMIT');
  const deadline = Date.now() + timeoutMs;
  let current = sourceUrl;
  for (let redirects=0; redirects<=3; redirects++) {
    const { url,host } = checkedUrl(current);
    const remaining = deadline-Date.now();
    if (remaining <= 0) throw fail('MEDIA_DOWNLOAD_TIMEOUT');
    const addresses = await lookupPublic(host,lookup,remaining);
    const pinned = addresses[0];
    const result = await new Promise((resolve,reject) => {
      let done=false, timer, req;
      const finish = (error,value) => {
        if (done) return;
        done=true; clearTimeout(timer);
        if (error) { req?.destroy(); reject(error); } else resolve(value);
      };
      try {
        req=request(url, {
          method:'GET',agent:false,
          headers:{Accept:'image/jpeg,image/png,image/webp,image/avif,video/mp4,application/octet-stream','Accept-Encoding':'identity','User-Agent':'MENTAL.hu editorial media importer'},
          lookup:(_hostname,options,callback) => options?.all ? callback(null,[pinned]) : callback(null,pinned.address,pinned.family)
        }, response => {
          const status = response.statusCode || 0;
          if ([301,302,303,307,308].includes(status)) {
            const location=response.headers.location;
            response.destroy();
            if (!location || redirects===3) return finish(fail('MEDIA_REDIRECT_LIMIT'));
            let next; try { next=new URL(location,url).href; } catch { return finish(fail('INVALID_MEDIA_URL')); }
            return finish(null,{redirect:next});
          }
          if (status !== 200) { response.destroy(); return finish(fail('MEDIA_DOWNLOAD_FAILED')); }
          const declared = response.headers['content-length'];
          if (declared && (!/^\d+$/.test(declared) || Number(declared)>maxBytes)) { response.destroy(); return finish(fail('MEDIA_TOO_LARGE')); }
          if (response.headers['content-encoding'] && response.headers['content-encoding']!=='identity') { response.destroy(); return finish(fail('MEDIA_ENCODING_UNSUPPORTED')); }
          const chunks=[]; let size=0;
          response.on('data',chunk => {
            if (done) return;
            size+=chunk.length;
            if (size>maxBytes) { response.destroy(); return finish(fail('MEDIA_TOO_LARGE')); }
            chunks.push(chunk);
          });
          response.on('end',() => {
            if (declared && Number(declared)!==size) return finish(fail('MEDIA_DOWNLOAD_INCOMPLETE'));
            if (!size) return finish(fail('MEDIA_EMPTY'));
            finish(null,{data:Buffer.concat(chunks,size)});
          });
          response.on('aborted',()=>finish(fail('MEDIA_DOWNLOAD_INCOMPLETE')));
          response.on('error',()=>finish(fail('MEDIA_DOWNLOAD_FAILED')));
        });
        timer=setTimeout(()=>finish(fail('MEDIA_DOWNLOAD_TIMEOUT')),Math.max(1,deadline-Date.now())); timer.unref?.();
        req.on('error',()=>finish(fail('MEDIA_DOWNLOAD_FAILED')));
        req.setTimeout(Math.min(15000,Math.max(1,deadline-Date.now())),()=>finish(fail('MEDIA_DOWNLOAD_TIMEOUT')));
        req.end();
      } catch { finish(fail('MEDIA_DOWNLOAD_FAILED')); }
    });
    if (result.data) return result.data;
    current=result.redirect;
  }
  throw fail('MEDIA_REDIRECT_LIMIT');
}

function dimensions(width,height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width<1 || height<1 || width>32768 || height>32768 || width*height>100000000) throw fail('INVALID_MEDIA_DIMENSIONS');
  return { width,height };
}

function boxes(data,start=0,end=data.length,depth=0,budget={count:0}) {
  if (depth>8) throw fail('INVALID_MEDIA_FILE');
  const result=[]; let offset=start;
  while (offset<end) {
    if (offset+8>end || ++budget.count>10000) throw fail('INVALID_MEDIA_FILE');
    let size=data.readUInt32BE(offset), header=8;
    const type=data.toString('ascii',offset+4,offset+8);
    if (size===1) {
      if (offset+16>end) throw fail('INVALID_MEDIA_FILE');
      const extended=data.readBigUInt64BE(offset+8);
      if (extended>BigInt(Number.MAX_SAFE_INTEGER)) throw fail('INVALID_MEDIA_FILE');
      size=Number(extended); header=16;
    } else if (size===0) size=end-offset;
    if (size<header || offset+size>end) throw fail('INVALID_MEDIA_FILE');
    const box={type,start:offset+header,end:offset+size};
    if (['meta','iprp','ipco','moov','trak','mdia','minf','stbl'].includes(type)) {
      const inner=box.start+(type==='meta'?4:0);
      if (inner>box.end) throw fail('INVALID_MEDIA_FILE');
      box.children=boxes(data,inner,box.end,depth+1,budget);
    }
    result.push(box); offset+=size;
  }
  return result;
}
function flattenBoxes(items) { return items.flatMap(item=>[item,...flattenBoxes(item.children||[])]); }

function inspectMedia(data,kind) {
  if (!Buffer.isBuffer(data) || !data.length) throw fail('MEDIA_EMPTY');
  let result;
  if (data.length>=33 && data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    if (data.readUInt32BE(8)!==13 || data.toString('ascii',12,16)!=='IHDR') throw fail('INVALID_MEDIA_FILE');
    let offset=8, hasData=false, ended=false;
    while (offset+12<=data.length) {
      const size=data.readUInt32BE(offset), type=data.toString('ascii',offset+4,offset+8);
      if (offset+12+size>data.length) throw fail('INVALID_MEDIA_FILE');
      if (type==='IDAT' && size) hasData=true;
      offset+=12+size;
      if (type==='IEND') { ended=size===0 && offset===data.length; break; }
    }
    if (!hasData || !ended) throw fail('INVALID_MEDIA_FILE');
    result={mime_type:'image/png',...dimensions(data.readUInt32BE(16),data.readUInt32BE(20))};
  } else if (data.length>=20 && data[0]===255 && data[1]===216 && data[2]===255) {
    let offset=2, size=null, hasScan=false;
    while (offset+3<data.length) {
      if (data[offset++]!==255) throw fail('INVALID_MEDIA_FILE');
      while (data[offset]===255) offset++;
      const marker=data[offset++];
      if (marker===218) { hasScan=true; break; }
      if (marker===217) break;
      if (marker===1 || (marker>=208 && marker<=215)) continue;
      if (offset+2>data.length) throw fail('INVALID_MEDIA_FILE');
      const length=data.readUInt16BE(offset);
      if (length<2 || offset+length>data.length) throw fail('INVALID_MEDIA_FILE');
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        if (length<8) throw fail('INVALID_MEDIA_FILE');
        size=dimensions(data.readUInt16BE(offset+5),data.readUInt16BE(offset+3));
      }
      offset+=length;
    }
    if (!size || !hasScan || data[data.length-2]!==255 || data[data.length-1]!==217) throw fail('INVALID_MEDIA_FILE');
    result={mime_type:'image/jpeg',...size};
  } else if (data.length>=20 && data.toString('ascii',0,4)==='RIFF' && data.toString('ascii',8,12)==='WEBP') {
    if (data.readUInt32LE(4)+8!==data.length) throw fail('INVALID_MEDIA_FILE');
    let offset=12, size, hasFrame=false;
    while (offset+8<=data.length) {
      const type=data.toString('ascii',offset,offset+4), length=data.readUInt32LE(offset+4), start=offset+8;
      if (start+length>data.length) throw fail('INVALID_MEDIA_FILE');
      if (type==='VP8X' && length>=10) size=dimensions(data.readUIntLE(start+4,3)+1,data.readUIntLE(start+7,3)+1);
      if (type==='VP8L' && length>=5 && data[start]===47) { const bits=data.readUInt32LE(start+1); size ||= dimensions((bits&16383)+1,((bits>>>14)&16383)+1); hasFrame=true; }
      if (type==='VP8 ' && length>=10 && data.toString('hex',start+3,start+6)==='9d012a') { size ||= dimensions(data.readUInt16LE(start+6)&16383,data.readUInt16LE(start+8)&16383); hasFrame=true; }
      if (type==='ANMF' && length>=16) hasFrame=true;
      offset=start+length+(length%2);
    }
    if (!size || !hasFrame || offset!==data.length) throw fail('INVALID_MEDIA_FILE');
    result={mime_type:'image/webp',...size};
  } else if (data.length>=24 && data.toString('ascii',4,8)==='ftyp') {
    const top=boxes(data), all=flattenBoxes(top), ftyp=top[0];
    if (ftyp.end-ftyp.start<8) throw fail('INVALID_MEDIA_FILE');
    const brands=[data.toString('ascii',ftyp.start,ftyp.start+4)];
    for (let offset=ftyp.start+8; offset+4<=ftyp.end; offset+=4) brands.push(data.toString('ascii',offset,offset+4));
    if (brands.some(brand=>brand==='avif'||brand==='avis')) {
      const ispe=all.find(box=>box.type==='ispe' && box.end-box.start>=12);
      if (!ispe || !top.some(box=>box.type==='meta') || !top.some(box=>box.type==='mdat')) throw fail('INVALID_MEDIA_FILE');
      result={mime_type:'image/avif',...dimensions(data.readUInt32BE(ispe.start+4),data.readUInt32BE(ispe.start+8))};
    } else if (brands.some(brand=>/^(?:isom|iso[2-9]|mp4[12]|avc1|dash|M4V |MSNV)$/.test(brand))) {
      if (!top.some(box=>box.type==='moov') || !top.some(box=>box.type==='mdat' && box.end>box.start)) throw fail('INVALID_MEDIA_FILE');
      if (!all.some(box=>box.type==='hdlr' && box.end-box.start>=12 && data.toString('ascii',box.start+8,box.start+12)==='vide')) throw fail('MEDIA_VIDEO_TRACK_REQUIRED');
      let size={width:null,height:null};
      for (const box of all.filter(box=>box.type==='tkhd')) {
        const minimum=data[box.start]===1?96:84;
        if (box.end-box.start<minimum) continue;
        const width=data.readUInt32BE(box.end-8)>>>16, height=data.readUInt32BE(box.end-4)>>>16;
        if (width && height) { size=dimensions(width,height); break; }
      }
      result={mime_type:'video/mp4',...size};
    }
  }
  if (!result || (kind==='image' && !result.mime_type.startsWith('image/')) || (kind==='video' && result.mime_type!=='video/mp4')) throw fail('MEDIA_TYPE_UNSUPPORTED');
  return result;
}

function parseRange(value,size) {
  if (!value) return null;
  const match=/^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1]&&!match[2])) throw fail('INVALID_MEDIA_RANGE');
  const first=match[1]?Number(match[1]):null, last=match[2]?Number(match[2]):null;
  if ((first!==null&&!Number.isSafeInteger(first)) || (last!==null&&!Number.isSafeInteger(last)) || size<1) throw fail('INVALID_MEDIA_RANGE');
  if (first===null) {
    if (!last) throw fail('INVALID_MEDIA_RANGE');
    return {start:Math.max(0,size-last),end:size-1};
  }
  if (first>=size || (last!==null && last<first)) throw fail('INVALID_MEDIA_RANGE');
  return {start:first,end:Math.min(last===null?size-1:last,size-1)};
}

const PUBLIC_MEDIA = `(NOT m.mcp_managed OR EXISTS (
  SELECT 1 FROM articles a WHERE a.status='published' AND (a.published_at IS NULL OR a.published_at<=now())
  AND (a.hero_image_id=m.id OR a.hero_image_path='/media/'||m.id::text
    OR a.content_html ~ ('(?:src|poster)="/media/'||m.id::text||'"'))))`;
const MEDIA_METADATA = `SELECT m.id,m.filename,m.mime_type,m.width,m.height,m.alt_text,m.sha256,m.mcp_managed,
  octet_length(m.data) AS bytes,${PUBLIC_MEDIA} AS is_public FROM media m`;

function createMcpMediaService({pool,root,baseUrl='https://mental.hu',download=downloadMedia}) {
  const origin=new URL(baseUrl).origin;
  let uploading=false;
  async function upload(args,actor,kind) {
    if (args?.approved!==true) throw fail('MEDIA_APPROVAL_REQUIRED');
    if (!actor || typeof actor.email!=='string' || !actor.email) throw fail('MCP_AUTH_REQUIRED');
    if (uploading) throw fail('MEDIA_UPLOAD_BUSY');
    const sources=[args.file!==undefined,args.source_url!==undefined,args.base64!==undefined].filter(Boolean).length;
    if (sources!==1) throw fail('ONE_MEDIA_SOURCE_REQUIRED');
    if (args.file && (typeof args.file!=='object' || typeof args.file.download_url!=='string' || typeof args.file.file_id!=='string' || !args.file.file_id || args.file.file_id.length>300)) throw fail('INVALID_MEDIA_FILE_INPUT');
    if (args.alt!==undefined && (typeof args.alt!=='string'||args.alt.length>300)) throw fail('INVALID_MEDIA_ALT');
    if (args.filename!==undefined && (typeof args.filename!=='string'||args.filename.length>300)) throw fail('INVALID_MEDIA_FILENAME');
    uploading=true;
    try {
      let data;
      if (args.base64!==undefined) {
        if (kind!=='image' || typeof args.base64!=='string' || args.base64.length>Math.ceil(MEDIA_LIMITS.base64Image/3)*4 || args.base64.length%4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(args.base64)) throw fail('INVALID_MEDIA_BASE64');
        data=Buffer.from(args.base64,'base64');
        if (data.toString('base64')!==args.base64) throw fail('INVALID_MEDIA_BASE64');
        if (data.length>MEDIA_LIMITS.base64Image) throw fail('MEDIA_TOO_LARGE');
      } else data=await download(args.file?.download_url||args.source_url,{maxBytes:MEDIA_LIMITS[kind]});
      if (data.length>MEDIA_LIMITS[kind]) throw fail('MEDIA_TOO_LARGE');
      const media=inspectMedia(data,kind);
      const sha256=crypto.createHash('sha256').update(data).digest('hex');
      const rawName=args.filename||args.file?.file_name||'mental-upload';
      if (typeof rawName!=='string' || rawName.length>300) throw fail('INVALID_MEDIA_FILENAME');
      const filename=(rawName.split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g,'').replace(/\.[^.]*$/,'').slice(0,180)||'mental-upload')+'.'+TYPES[media.mime_type];
      const client=await pool.connect(); let id,inserted=false;
      try {
        await client.query('BEGIN');
        const result=await client.query(`INSERT INTO media(filename,mime_type,data,width,height,alt_text,sha256,mcp_managed)
          VALUES($1,$2,$3,$4,$5,$6,$7,true)
          ON CONFLICT(sha256) WHERE mcp_managed AND sha256 IS NOT NULL DO NOTHING RETURNING id`,
        [filename,media.mime_type,data,media.width,media.height,(args.alt||'').trim(),sha256]);
        id=result.rows[0]?.id; inserted=Boolean(id);
        if (!id) id=(await client.query('SELECT id FROM media WHERE mcp_managed AND sha256=$1',[sha256])).rows[0]?.id;
        if (!id) throw fail('MEDIA_SAVE_FAILED');
        if (inserted) await client.query(`INSERT INTO cms_audit_log(action,entity_type,entity_id,actor_email,details)
          VALUES('mcp_upload_media','media',$1,$2,$3)`,[String(id),actor.email,JSON.stringify({client_id:actor.clientId||null,mime_type:media.mime_type,sha256,bytes:data.length,approved:true})]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; } finally { client.release(); }
      const row=(await pool.query(MEDIA_METADATA+' WHERE m.id=$1',[id])).rows[0];
      const url='/media/'+id;
      const embed_html=kind==='video'
        ? '<video controls preload="metadata" playsinline aria-label="'+html(args.alt||filename)+'"><source src="'+url+'" type="video/mp4"></video>'
        : '<img src="'+url+'" alt="'+html(args.alt||'')+'" width="'+media.width+'" height="'+media.height+'" loading="lazy">';
      return {media_id:Number(id),url,absolute_url:origin+url,mime_type:row.mime_type,sha256:row.sha256,width:row.width,height:row.height,bytes:row.bytes,filename:row.filename,private:!row.is_public,deduplicated:!inserted,embed_html};
    } finally { uploading=false; }
  }

  function register(app,{getAdminUser=()=>null}={}) {
    const serve=async(req,res,next) => {
      try {
        if (!/^[1-9]\d{0,18}$/.test(req.params.id) || BigInt(req.params.id)>9223372036854775807n) return res.status(404).end();
        const row=(await pool.query(MEDIA_METADATA+' WHERE m.id=$1',[req.params.id])).rows[0];
        if (!row) return res.status(404).end();
        if (!row.is_public) {
          const user=await getAdminUser(req);
          if (!user || user.role!=='admin') return res.status(404).set('Cache-Control','private, no-store').end();
        }
        const size=Number(row.bytes), etag=row.sha256?'"'+row.sha256+'"':null;
        res.set({'Content-Type':Object.hasOwn(TYPES,row.mime_type)?row.mime_type:'application/octet-stream','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes','Cache-Control':row.is_public?(row.mcp_managed?'public, max-age=3600':'public, max-age=31536000, immutable'):'private, no-store'});
        if (etag) res.set('ETag',etag);
        if (etag && req.get('if-none-match')?.split(',').map(x=>x.trim()).some(x=>x===etag||x==='*')) return res.status(304).end();
        let range=null;
        if (req.method!=='HEAD' && req.get('range') && (!req.get('if-range') || req.get('if-range')===etag)) {
          try { range=parseRange(req.get('range'),size); } catch { return res.status(416).set('Content-Range','bytes */'+size).end(); }
        }
        const start=range?.start||0, end=range?.end??size-1;
        res.status(range?206:200).set('Content-Length',String(Math.max(0,end-start+1)));
        if (range) res.set('Content-Range','bytes '+start+'-'+end+'/'+size);
        if (req.method==='HEAD' || !size) return res.end();
        // Read only the requested bytes. Large MP4 responses never materialize
        // the entire database blob in Node memory, including normal 200 reads.
        for (let position=start; position<=end && !res.destroyed; position+=CHUNK_SIZE) {
          const length=Math.min(CHUNK_SIZE,end-position+1);
          const part=(await pool.query('SELECT substring(data FROM $2::int FOR $3::int) AS data FROM media WHERE id=$1',[row.id,position+1,length])).rows[0]?.data;
          if (!part || part.length!==length) throw fail('MEDIA_READ_FAILED');
          if (!res.write(part)) await new Promise(resolve => {
            const ready=()=>{res.off('drain',ready);res.off('close',ready);resolve();};
            res.once('drain',ready);res.once('close',ready);
          });
        }
        res.end();
      } catch (error) { if (res.headersSent) res.destroy(); else next(error); }
    };
    app.route('/media/:id').head(serve).get(serve);
  }
  return {uploadImage:(args,actor)=>upload(args,actor,'image'),uploadVideo:(args,actor)=>upload(args,actor,'video'),register};
}

module.exports={createMcpMediaService,MEDIA_LIMITS,OPENAI_FILE_SCHEMA,inspectMedia,parseRange,isPublicAddress,checkedUrl,downloadMedia};
