'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const path=require('node:path');
const {once}=require('node:events');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {InMemoryTransport}=require('@modelcontextprotocol/sdk/inMemory.js');
const {LATEST_PROTOCOL_VERSION}=require('@modelcontextprotocol/sdk/types.js');
const {createEditorialMcpServer,registerMcpConnector}=require('../lib/mcp-server.cjs');

const revision='a'.repeat(64);
const actor={email:'mcp-test@example.test',clientId:'isolated-client',scopes:['mental:read','mental:write','mental:publish']};
const article={id:1,title:'Izolált tesztcikk',slug:'isolated-test',category:'Alvás',excerpt:'Teszt',content_html:'<p>Teszt</p>',status:'draft',live_status:'draft',revision,has_pending_changes:true,preview_url:'https://mental.hu/api/admin/mcp/articles/isolated-test/preview',url:null};
const articleResult={ok:true,article};
const mediaResult={media_id:1,url:'/media/1',absolute_url:'https://mental.hu/media/1',mime_type:'image/png',sha256:revision,width:1,height:1,bytes:68,filename:'test.png',private:true,deduplicated:false,embed_html:'<img src="/media/1" alt="">'};

async function memoryClient(t,permissions=actor.scopes){
  const calls=[];
  const record=(method,result)=>async(args,who)=>{calls.push({method,args,who});return result;};
  const articles={
    listArticles:record('list',{ok:true,items:[{...article,needs_readback:true}],total:1,limit:20,offset:0,next_offset:null}),
    getArticle:record('get',articleResult),getTopics:record('topics',{ok:true,topics:[{name:'Alvás',published_count:1}]}),
    saveDraft:record('save',articleResult),updateArticle:record('update',articleResult),
    publishArticle:record('publish',articleResult),setFeatured:record('featured',articleResult)
  };
  const media={uploadImage:record('image',mediaResult),uploadVideo:record('video',{...mediaResult,mime_type:'video/mp4',width:null,height:null})};
  const server=createEditorialMcpServer({articles,media,actor:{...actor,scopes:permissions}});
  const client=new Client({name:'isolated-test',version:'1.0.0'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);
  t.after(async()=>{await client.close();await server.close();});
  return {client,calls};
}

test('MCP tool discovery and every structured result work through the official SDK',async t=>{
  const {client,calls}=await memoryClient(t);
  const {tools}=await client.listTools();assert.equal(tools.length,10);
  for(const tool of tools){assert(tool.outputSchema,tool.name);assert(tool._meta.securitySchemes[0].scopes.length);}
  for(const name of ['mental_upload_image','mental_upload_video']){
    const tool=tools.find(item=>item.name===name);
    assert.deepEqual(tool._meta['openai/fileParams'],['file']);
    assert.deepEqual(Object.keys(tool.inputSchema.properties.file.properties).sort(),['download_url','file_id','file_name','mime_type']);
    assert.deepEqual(tool.inputSchema.properties.file.required,['download_url','file_id']);
  }
  assert(tools.find(item=>item.name==='mental_publish_article').annotations.destructiveHint);
  const args={external_id:'isolated-test',approved:true,expected_revision:revision};
  const operations=[
    ['mental_get_site_info',{}],['mental_list_articles',{}],['mental_get_article',{external_id:'isolated-test'}],['mental_get_topics',{}],
    ['mental_save_draft',args],['mental_update_article',args],
    ['mental_upload_image',{approved:true,base64:'dGVzdA=='}],['mental_upload_video',{approved:true,file:{download_url:'https://example.test/original.mp4',file_id:'isolated-file'}}],
    ['mental_publish_article',{external_id:'isolated-test',expected_revision:revision,confirm_publish:true}],
    ['mental_set_featured',{external_id:'isolated-test',expected_revision:revision,featured:true}]
  ];
  for(const [name,arguments_] of operations){const result=await client.callTool({name,arguments:arguments_});assert(!result.isError,JSON.stringify(result));assert(result.structuredContent,name);}
  assert.equal(calls.length,9);assert(calls.every(call=>call.who.email===actor.email));
});

test('MCP denies write scopes and missing approval before the service can mutate data',async t=>{
  const {client,calls}=await memoryClient(t,['mental:read']);
  const denied=await client.callTool({name:'mental_save_draft',arguments:{external_id:'isolated-test',approved:true}});
  assert(denied.isError);assert.equal(calls.length,0);
  const challenge=denied._meta['mcp/www_authenticate'][0];
  assert(challenge.includes('error="insufficient_scope"'));assert(challenge.includes('error_description='));assert(challenge.includes('mental:write'));
  const full=await memoryClient(t);
  const missing=await full.client.callTool({name:'mental_publish_article',arguments:{external_id:'isolated-test',expected_revision:revision}});
  assert(missing.isError);assert.equal(full.calls.length,0);
});

const databaseValue=process.env.DATABASE_URL;
if(databaseValue){
  const db=new URL(databaseValue);
  assert(['postgres:','postgresql:'].includes(db.protocol)&&['127.0.0.1','localhost','[::1]'].includes(db.hostname)&&/^\/[a-zA-Z0-9_]*test[a-zA-Z0-9_]*$/.test(db.pathname),'MCP integration requires a disposable loopback test database');
}

test('OAuth to Streamable HTTP to private draft to public article works end to end',{skip:!databaseValue,timeout:60000},async()=>{
  const express=require('express');const cookieParser=require('cookie-parser');const {Pool}=require('pg');
  const {challengeFor}=require('../lib/mcp-oauth.cjs');
  const {createArticleService}=require('../lib/public-articles.cjs');
  const {cleanMcpArticleHtml}=require('../lib/mcp-articles.cjs');
  const pool=new Pool({connectionString:databaseValue,ssl:false});
  const app=express();app.use(express.json({limit:'2mb'}));app.use(express.urlencoded({extended:false,limit:'2mb'}));app.use(cookieParser());
  const http=app.listen(0,'127.0.0.1');await once(http,'listening');
  const baseUrl='http://127.0.0.1:'+http.address().port;
  const runId='mcp-http-'+crypto.randomBytes(8).toString('hex');
  const email=runId+'@example.test',password=crypto.randomBytes(24).toString('base64url');
  const adminCookie='admin_fixture='+crypto.randomBytes(24).toString('base64url');
  const getAdminUser=req=>req.get('Cookie')===adminCookie?{email,role:'admin'}:null;
  const auth=(req,res,next)=>{const user=getAdminUser(req);if(!user)return res.status(401).end();req.user=user;next();};
  registerMcpConnector(app,{pool,dbState:{ready:true},root:path.resolve(__dirname,'..'),baseUrl,auth,getAdminUser,
    verifyAdminCredentials:async(e,p)=>e===email&&p===password?{email,role:'admin'}:null});
  createArticleService({pool,dbState:{ready:true},cleanHtml:cleanMcpArticleHtml}).register(app);
  app.use((err,_req,res,_next)=>res.status(err.status||500).json({error:err.code||'TEST_FAILURE'}));
  const request=(url,options={})=>fetch(baseUrl+url,{...options,redirect:'manual'});
  const json=(url,data,headers={})=>request(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(data)});
  let clientId,articleId,mediaId,token,rpcId=0;
  const rpc=async(method,params)=>{
    const response=await json('/mcp',{jsonrpc:'2.0',id:++rpcId,method,params},{authorization:'Bearer '+token,accept:'application/json, text/event-stream','mcp-protocol-version':LATEST_PROTOCOL_VERSION});
    assert.equal(response.status,200);const body=await response.json();assert(!body.error,JSON.stringify(body));return body.result;
  };
  const call=async(name,args={})=>{const result=await rpc('tools/call',{name,arguments:args});assert(!result.isError,JSON.stringify(result));return result.structuredContent;};
  try{
    const anonymous=await json('/mcp',{});assert.equal(anonymous.status,401);assert(anonymous.headers.get('www-authenticate').includes('/.well-known/oauth-protected-resource/mcp'));
    assert.equal((await json('/mcp',{}, {origin:'https://evil.example'})).status,403);
    const redirectUri='https://chatgpt.com/connector_platform_oauth_redirect';
    const registered=await json('/mcp/oauth/register',{client_name:'Isolated MCP integration',redirect_uris:[redirectUri],token_endpoint_auth_method:'none'});
    assert.equal(registered.status,201);const client=await registered.json();clientId=client.client_id;
    const verifier=crypto.randomBytes(32).toString('base64url');
    const authorization=await request('/mcp/oauth/authorize?'+new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:redirectUri,resource:baseUrl+'/mcp',state:runId,code_challenge:challengeFor(verifier),code_challenge_method:'S256'}));
    assert.equal(authorization.status,200);const html=await authorization.text();
    const requestId=html.match(/name="request_id" value="([^"]+)"/)[1],csrf=html.match(/name="csrf_token" value="([^"]+)"/)[1];
    const consent=await request('/mcp/oauth/authorize',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:baseUrl,cookie:authorization.headers.get('set-cookie').split(';')[0]},body:new URLSearchParams({request_id:requestId,csrf_token:csrf,email,password,decision:'allow'}).toString()});
    assert.equal(consent.status,303);const callback=new URL(consent.headers.get('location'));assert.equal(callback.searchParams.get('state'),runId);
    const exchanged=await request('/mcp/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,redirect_uri:redirectUri,resource:baseUrl+'/mcp',code:callback.searchParams.get('code'),code_verifier:verifier}).toString()});
    assert.equal(exchanged.status,200);token=(await exchanged.json()).access_token;
    const initialized=await rpc('initialize',{protocolVersion:LATEST_PROTOCOL_VERSION,capabilities:{},clientInfo:{name:'Isolated CI',version:'1.0.0'}});assert.equal(initialized.serverInfo.name,'mentalhu-editorial');
    assert.equal((await rpc('tools/list',{})).tools.length,10);
    assert.equal((await call('mental_get_site_info')).mcp_url,baseUrl+'/mcp');
    const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5CYAAAAASUVORK5CYII=','base64');
    const uploaded=await call('mental_upload_image',{approved:true,base64:image.toString('base64'),filename:runId+'.png',alt:'Izolált kép'});mediaId=uploaded.media_id;assert(uploaded.private);
    assert.equal((await request(uploaded.url)).status,404);
    const content='<p>'+('Kizárólag izolált adatbázisban futó, törlendő tesztcikk. '.repeat(6))+'</p>';
    const draft=await call('mental_save_draft',{external_id:runId,approved:true,title:'Alvás – '+runId,slug:runId,category:'Alvás',excerpt:'Izolált teszt',content_html:content,hero_image_id:mediaId,hero_image_alt:'Izolált kép'});articleId=draft.article.id;
    assert.equal(draft.article.status,'draft');assert.equal(draft.article.url,null);
    assert.equal((await request('/cikk/'+runId)).status,404);
    assert.equal((await request(new URL(draft.article.preview_url).pathname)).status,401);
    const preview=await request(new URL(draft.article.preview_url).pathname,{headers:{cookie:adminCookie}});assert.equal(preview.status,200);assert((await preview.text()).includes(runId));
    const read=await call('mental_get_article',{external_id:runId});assert.equal(read.article.revision,draft.article.revision);
    const list=await call('mental_list_articles',{q:runId});assert.equal(list.total,1);
    const wrongRevision=await rpc('tools/call',{name:'mental_publish_article',arguments:{external_id:runId,expected_revision:'0'.repeat(64),confirm_publish:true}});assert(wrongRevision.isError);assert.equal((await request('/cikk/'+runId)).status,404);
    const published=await call('mental_publish_article',{external_id:runId,expected_revision:read.article.revision,confirm_publish:true});assert.equal(published.article.url,baseUrl+'/cikk/'+runId);
    const page=await request('/cikk/'+runId);assert.equal(page.status,200);assert((await page.text()).includes(runId));
    const publicMedia=await request(uploaded.url);assert.equal(publicMedia.status,200);assert.deepEqual(Buffer.from(await publicMedia.arrayBuffer()),image);
    const retry=await call('mental_publish_article',{external_id:runId,expected_revision:read.article.revision,confirm_publish:true});assert(retry.idempotent);
    const staged=await call('mental_update_article',{external_id:runId,approved:true,expected_revision:published.article.revision,title:'Privát módosítás – '+runId});assert(staged.article.has_pending_changes);
    assert(!(await (await request('/cikk/'+runId)).text()).includes('Privát módosítás'));
    const publishedList=await (await request('/api/public/articles?q='+encodeURIComponent(runId))).json();assert.equal(publishedList.length,1);assert.equal(publishedList[0].title,'Alvás – '+runId);
  }finally{
    await new Promise(resolve=>http.close(resolve));
    if(articleId){await pool.query('DELETE FROM mcp_article_drafts WHERE article_id=$1',[articleId]);await pool.query('DELETE FROM articles WHERE id=$1',[articleId]);}
    if(mediaId)await pool.query('DELETE FROM media WHERE id=$1',[mediaId]);
    if(clientId)await pool.query('DELETE FROM mcp_oauth_clients WHERE client_id=$1',[clientId]);
    await pool.query('DELETE FROM cms_audit_log WHERE actor_email=$1',[email]);
    await pool.end();
  }
});
