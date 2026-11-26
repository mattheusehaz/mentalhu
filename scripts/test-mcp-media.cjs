'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createMcpMediaService, inspectMedia, parseRange, isPublicAddress, checkedUrl, downloadMedia, OPENAI_FILE_SCHEMA } = require('../lib/mcp-media.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5CYAAAAASUVORK5CYII=','base64');
// A 1641-byte, 16x16 synthetic black H.264 clip; no user content is used.
const MP4 = Buffer.from('AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAANcbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAHgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAod0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAB4AAAEAAABAAAAAAH/bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAABgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABqm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAWpzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAMg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAL7iAAAAAAAAABhzdHRzAAAAAAAAAAEAAAADAAACAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAKGN0dHMAAAAAAAAAAwAAAAEAAAQAAAAAAQAABgAAAAABAAACAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAwAAAAEAAAAgc3RzegAAAAAAAAAAAAAAAwAAAsUAAAAMAAAADAAAABRzdGNvAAAAAAAAAAEAAAOMAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2MS43LjEwMwAAAAhmcmVlAAAC5W1kYXQAAAKuBgX//6rcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MjUgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAPZYiEADP//vbsvgU2FMjBAAAACEGaImxCv/7AAAAACAGeQXkK/8SB','base64');

test('ChatGPT file params declare every supported property with the exact required pair',()=>{
  assert.deepEqual(Object.keys(OPENAI_FILE_SCHEMA.properties),['download_url','file_id','mime_type','file_name']);
  assert.deepEqual(OPENAI_FILE_SCHEMA.required,['download_url','file_id']);
});

test('media downloads reject local, private, mapped, reserved and non-HTTPS destinations',()=>{
  for (const address of ['0.0.0.0','10.0.0.1','127.0.0.1','100.64.0.1','169.254.169.254','172.31.255.255','192.168.1.1','198.18.1.1','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::']) assert.equal(isPublicAddress(address),false,address);
  for (const address of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111']) assert.equal(isPublicAddress(address),true,address);
  for (const url of ['http://example.com/image.png','https://localhost/a','https://127.0.0.1/a','https://[::ffff:127.0.0.1]/a','https://x.internal/a','https://user:secret@example.com/a','https://example.com:8080/a','file:///etc/passwd','data:image/png;base64,abc']) assert.throws(()=>checkedUrl(url));
  assert.equal(checkedUrl('https://files.example.com/a.png?signature=opaque').host,'files.example.com');
});

function mockRequest(replies,observed=[]) {
  return (url,options,callback) => {
    const req=new EventEmitter(); req.setTimeout=()=>req; req.destroy=()=>{req.destroyed=true;};
    req.end=()=>setImmediate(()=>{
      if(req.destroyed)return;
      const reply=replies.shift();
      observed.push({url:url.href,options});
      if(!reply)return req.emit('error',new Error('No test response'));
      const response=Readable.from(reply.chunks||[]);
      response.statusCode=reply.status||200; response.headers=reply.headers||{};
      callback(response);
    });
    return req;
  };
}
const publicLookup=async()=>[{address:'1.1.1.1',family:4}];

test('DNS answers are checked then pinned into the HTTPS connection',async()=>{
  const seen=[];
  const data=await downloadMedia('https://files.example.com/a',{maxBytes:100,lookup:publicLookup,request:mockRequest([{chunks:[PNG]}],seen)});
  assert.deepEqual(data,PNG);
  let pinned;
  seen[0].options.lookup('files.example.com',{},(_err,address,family)=>{pinned={address,family};});
  assert.deepEqual(pinned,{address:'1.1.1.1',family:4});
  assert.equal(seen[0].options.agent,false);
  await assert.rejects(downloadMedia('https://files.example.com/a',{maxBytes:100,lookup:async()=>[{address:'1.1.1.1',family:4},{address:'10.0.0.1',family:4}],request:mockRequest([])}),{code:'MEDIA_SOURCE_NOT_PUBLIC'});
});

test('redirects cannot reach private addresses or carry headers, and downloads obey streamed caps',async()=>{
  await assert.rejects(downloadMedia('https://files.example.com/a',{maxBytes:100,lookup:publicLookup,request:mockRequest([{status:302,headers:{location:'https://127.0.0.1/private'}}])}),{code:'MEDIA_SOURCE_NOT_PUBLIC'});
  await assert.rejects(downloadMedia('https://files.example.com/a',{maxBytes:10,lookup:publicLookup,request:mockRequest([{chunks:[Buffer.alloc(6),Buffer.alloc(6)]}])}),{code:'MEDIA_TOO_LARGE'});
  await assert.rejects(downloadMedia('https://files.example.com/a',{maxBytes:100,lookup:publicLookup,request:mockRequest([{headers:{'content-length':'90'},chunks:[PNG]}])}),{code:'MEDIA_DOWNLOAD_INCOMPLETE'});
  const seen=[];
  await downloadMedia('https://files.example.com/a?secret=not-forwarded',{maxBytes:100,lookup:publicLookup,request:mockRequest([{status:302,headers:{location:'https://cdn.example.com/a'}},{chunks:[PNG]}],seen)});
  assert.equal(seen[1].url,'https://cdn.example.com/a');
  assert.equal(seen[1].options.headers.Authorization,undefined);
  assert.equal(seen[1].options.headers.Cookie,undefined);
  assert.equal(seen[1].options.headers.Referer,undefined);
});

test('content signatures and dimensions determine media types; mislabeled HTML and truncated files fail',()=>{
  assert.deepEqual(inspectMedia(PNG,'image'),{mime_type:'image/png',width:1,height:1});
  assert.deepEqual(inspectMedia(MP4,'video'),{mime_type:'video/mp4',width:16,height:16});
  const jpeg=fs.readFileSync(path.join(__dirname,'../assets/hero-hq.jpg'));
  assert.equal(inspectMedia(jpeg,'image').mime_type,'image/jpeg');
  for (const data of [Buffer.from('<svg onload="alert(1)"/>'),Buffer.from('<html>not an image</html>'),PNG.subarray(0,40),jpeg.subarray(0,100),MP4.subarray(0,50)]) assert.throws(()=>inspectMedia(data,'image'));
  assert.throws(()=>inspectMedia(MP4,'image'),{code:'MEDIA_TYPE_UNSUPPORTED'});
  assert.throws(()=>inspectMedia(PNG,'video'),{code:'MEDIA_TYPE_UNSUPPORTED'});
});

test('single HTTP ranges handle prefixes, suffixes, clipping and unsatisfiable ranges',()=>{
  assert.deepEqual(parseRange('bytes=0-9',20),{start:0,end:9});
  assert.deepEqual(parseRange('bytes=10-',20),{start:10,end:19});
  assert.deepEqual(parseRange('bytes=-5',20),{start:15,end:19});
  assert.deepEqual(parseRange('bytes=-200',20),{start:0,end:19});
  assert.deepEqual(parseRange('bytes=10-200',20),{start:10,end:19});
  for (const value of ['bytes=-0','bytes=20-','bytes=2-1','bytes=0-1,3-4','bytes=-','bytes=999999999999999999999-','items=0-1']) assert.throws(()=>parseRange(value,20),{code:'INVALID_MEDIA_RANGE'});
});

test('durable uploads, deduplication, private drafts and streamed video HTTP ranges',{skip:!process.env.DATABASE_URL},async t=>{
  // Only self-contained fixtures in a disposable loopback test database may be mutated.
  const database=new URL(process.env.DATABASE_URL);
  assert(['postgres:','postgresql:'].includes(database.protocol)&&['localhost','127.0.0.1','[::1]'].includes(database.hostname)&&/^\/[a-zA-Z0-9_]*test[a-zA-Z0-9_]*$/.test(database.pathname),'Disposable local test database required');
  const { Pool }=require('pg');
  const express=require('express');
  const { buildDatabaseConfig }=require('../lib/database-config.cjs');
  const config=buildDatabaseConfig(), schema='mcp_media_test_'+require('node:crypto').randomBytes(6).toString('hex');
  const adminPool=new Pool(config);
  await adminPool.query('CREATE SCHEMA '+schema);
  const pool=new Pool({...config,options:'-c search_path='+schema,max:2});
  let server;
  t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await pool.end();await adminPool.query('DROP SCHEMA '+schema+' CASCADE');await adminPool.end();});
  for(const migration of ['001_init.sql','009_articles_editorial.sql','014_mcp_media.sql']) await pool.query(fs.readFileSync(path.join(__dirname,'../migrations',migration),'utf8'));
  let byteQueries=0;
  const observedPool={connect:()=>pool.connect(),query:(sql,values)=>{if(sql.startsWith('SELECT substring('))byteQueries++;return pool.query(sql,values);}};
  const media=createMcpMediaService({pool:observedPool,download:async url=>url.endsWith('.mp4')?MP4:PNG});
  const actor={email:'isolated-test@example.test',clientId:'isolated-test'};
  await assert.rejects(media.uploadImage({base64:PNG.toString('base64')},actor),{code:'MEDIA_APPROVAL_REQUIRED'});
  const image=await media.uploadImage({approved:true,base64:PNG.toString('base64'),filename:'test.html',alt:'Test image'},actor);
  assert.equal(image.private,true);assert.equal(image.filename,'test.png');assert.equal(image.width,1);
  const repeat=await media.uploadImage({approved:true,file:{download_url:'https://files.example.com/test.png',file_id:'file_test'}},actor);
  assert.equal(repeat.media_id,image.media_id);assert.equal(repeat.deduplicated,true);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM cms_audit_log WHERE action='mcp_upload_media'")).rows[0].count,1);
  const video=await media.uploadVideo({approved:true,file:{download_url:'https://files.example.com/test.mp4',file_id:'file_video'},alt:'Original MP4'},actor);
  assert.equal(video.bytes,MP4.length);assert.equal(video.mime_type,'video/mp4');assert.match(video.embed_html,/preload="metadata"/);
  assert.equal((await pool.query('SELECT data FROM media WHERE id=$1',[video.media_id])).rows[0].data.equals(MP4),true,'Original video bytes are preserved');
  const app=express();
  media.register(app,{getAdminUser:req=>req.get('x-test-admin')==='yes'?{role:'admin',email:actor.email}:null});
  app.use((error,_req,res,_next)=>res.status(500).json({error:error.code||'TEST_ERROR'}));
  server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  const base='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(base+image.url)).status,404);
  assert.equal((await fetch(base+video.url,{headers:{range:'bytes=0-10'}})).status,404);
  let response=await fetch(base+image.url,{headers:{'x-test-admin':'yes'}});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.deepEqual(Buffer.from(await response.arrayBuffer()),PNG);
  const article=(await pool.query("INSERT INTO articles(slug,title,category,status,published_at,hero_image_id,content_html) VALUES('media-test','Media test','Test','draft',now(),$1,$2) RETURNING id",[image.media_id,video.embed_html])).rows[0];
  assert.equal((await fetch(base+image.url)).status,404);
  await pool.query("UPDATE articles SET status='published',published_at=now()+interval '1 hour' WHERE id=$1",[article.id]);
  assert.equal((await fetch(base+video.url)).status,404);
  await pool.query('UPDATE articles SET published_at=now() WHERE id=$1',[article.id]);
  response=await fetch(base+video.url,{headers:{range:'bytes=4-15'}});
  assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),'bytes 4-15/'+MP4.length);assert.equal(response.headers.get('content-length'),'12');assert.equal(response.headers.get('content-type'),'video/mp4');assert.deepEqual(Buffer.from(await response.arrayBuffer()),MP4.subarray(4,16));
  const beforeHead=byteQueries;
  response=await fetch(base+video.url,{method:'HEAD'});
  assert.equal(response.status,200);assert.equal(response.headers.get('accept-ranges'),'bytes');assert.equal(response.headers.get('content-length'),String(MP4.length));assert.equal(byteQueries,beforeHead,'HEAD never retrieves blob data');
  response=await fetch(base+video.url,{headers:{range:'bytes=-11'}});assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),MP4.subarray(-11));
  response=await fetch(base+video.url,{headers:{range:'bytes='+MP4.length+'-'}});assert.equal(response.status,416);assert.equal(response.headers.get('content-range'),'bytes */'+MP4.length);
  response=await fetch(base+video.url,{headers:{range:'bytes=0-9','if-range':'"different-version"'}});assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),MP4);
  response=await fetch(base+video.url,{headers:{'if-none-match':'"'+video.sha256+'"'}});assert.equal(response.status,304);
  await pool.query("UPDATE articles SET status='draft' WHERE id=$1",[article.id]);
  assert.equal((await fetch(base+video.url)).status,404,'Unpublishing withdraws new media access');
  const legacy=(await pool.query("INSERT INTO media(filename,mime_type,data) VALUES('legacy.png','image/png',$1) RETURNING id",[PNG])).rows[0];
  assert.equal((await fetch(base+'/media/'+legacy.id)).status,200,'Legacy media keeps its public behavior');
});
