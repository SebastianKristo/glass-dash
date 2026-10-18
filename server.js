// Glass Dash / Labdeck backend: statiske filer, config-lagring, secrets og proxy. Ingen avhengigheter.
const http=require('http'),fs=require('fs'),path=require('path');
const PORT=+process.env.PORT||7575,DATA=process.env.DATA_DIR||'/app/data',PUB=path.join(__dirname,'public');
const SEC_KEY='labdeck-secrets',KV_FILE=path.join(DATA,'config.json'),SEC_FILE=path.join(DATA,'secrets.json');
fs.mkdirSync(DATA,{recursive:true});
const rd=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){return d}};
const wr=(f,o)=>{fs.writeFileSync(f+'.tmp',JSON.stringify(o,null,2));fs.renameSync(f+'.tmp',f)};
let kv=rd(KV_FILE,{}),secrets=rd(SEC_FILE,{});
// Miljøvariabler (f.eks. fra Unraid-template) brukes som fallback, men kun for kjente secret-navn
const DEF=['PLEX_URL','PLEX_TOKEN','SONARR_URL','SONARR_KEY','RADARR_URL','RADARR_KEY','SPEEDTEST_URL','SPEEDTEST_TRACKER_API_TOKEN','CLOUDFLARE_API_TOKEN','CLOUDFLARE_ZONE_ID','IMMICH_URL','IMMICH_API_KEY','QBITTORRENT_IP','PROWLARR_URL','PROWLARR_API_URL','PROWLARR_KEY','PORTAINER_URL','PORTAINER_ENDPOINT_ID','PORTAINER_API_KEY','SONARR_API_URL','RADARR_API_URL','PROWLARR_COLLAPSE_AFTER','CLOUDFLARE_API_KEY','CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_TUNNEL_ID','ADGUARD_PASSWORD','DNS_URL','DNS_USER','DNS_PASSWORD','GLANCES_URL','PROXMOX_URL','PROXMOX_TOKEN','MINECRAFT_HOST','MINECRAFT_CONSOLE_URL'];
const known=n=>DEF.includes(n)||n in secrets;
const sec=n=>!known(n)?'':secrets[n]!=null&&secrets[n]!==''?secrets[n]:(process.env[n]||'');
const sub=s=>String(s).replace(/\$\{(\w+)\}/g,(_,n)=>sec(n));
const masked=()=>{const o={};new Set([...DEF,...Object.keys(secrets)]).forEach(n=>o[n]=sec(n)?'${'+n+'}':'');return o};
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
const body=req=>new Promise(r=>{const c=[];req.on('data',d=>c.push(d));req.on('end',()=>r(Buffer.concat(c)))});
const json=(res,code,o)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(o))};
// ── Forhåndslasting ──────────────────────────────────────────────────────────
// Alle GET-kall via proxyen og alle status-pinger huskes (uten secrets, med ${NAVN})
// og hentes på nytt i bakgrunnen. Nettleseren får alltid siste svar umiddelbart.
const WARM_FILE=path.join(DATA,'warm.json');
const TTL=+process.env.CACHE_TTL||30000;          // svar eldre enn dette fornyes i bakgrunnen
const PING_TTL=+process.env.PING_TTL||60000;
const IDLE=24*3600e3;                              // slutt å varme det som ikke er brukt på et døgn
const cache=new Map(),pings=new Map(),inflight=new Map();
function fillHeaders(hd){const o={};for(const k in hd){let v=String(hd[k]);
  // Basic auth bygget i nettleseren inneholder base64 av ${NAVN} – dekod, bytt inn secrets og kod på nytt
  const m=/^Basic\s+(.+)$/i.exec(v);if(m){const raw=Buffer.from(m[1],'base64').toString();if(raw.includes('${'))v='Basic '+Buffer.from(sub(raw)).toString('base64')}
  o[k]=sub(v)}return o}
async function upstream(u,hd){
  const r=await fetch(new URL(sub(u)),{headers:fillHeaders(hd),signal:AbortSignal.timeout(15000),redirect:'follow'});
  return{t:Date.now(),status:r.status,type:r.headers.get('content-type')||'application/octet-stream',buf:Buffer.from(await r.arrayBuffer())}}
function refresh(key,e){if(inflight.has(key))return inflight.get(key);
  const p=upstream(e.u,e.hd).then(v=>{if(v.status<400||!e.v)e.v=v;else e.v.t=Date.now();return e.v})
    .catch(err=>{if(!e.v)throw err;e.v.t=Date.now();return e.v}).finally(()=>inflight.delete(key));
  inflight.set(key,p);return p}
async function proxy(req,res,u){
  try{new URL(sub(u))}catch(e){return json(res,400,{error:'Ugyldig URL'})}
  let hd={};try{hd=JSON.parse(req.headers['x-proxy-headers']||'{}')}catch(e){}
  if(req.method!=='GET'){ // POST o.l. (Pi-hole login) går rett gjennom
    const h=fillHeaders(hd),b=sub((await body(req)).toString());
    if(!Object.keys(h).some(k=>k.toLowerCase()==='content-type')&&req.headers['content-type'])h['Content-Type']=req.headers['content-type'];
    try{const r=await fetch(new URL(sub(u)),{method:req.method,headers:h,body:b,signal:AbortSignal.timeout(15000)});
      res.writeHead(r.status,{'Content-Type':r.headers.get('content-type')||'application/json'});return res.end(Buffer.from(await r.arrayBuffer()))}
    catch(e){return json(res,502,{error:String(e.cause&&e.cause.message||e.message)})}}
  const key=u+'\n'+JSON.stringify(hd);
  let e=cache.get(key);if(!e){e={u,hd,v:null,used:0};cache.set(key,e);saveWarm()}
  e.used=Date.now();
  try{
    if(!e.v)await refresh(key,e);else if(Date.now()-e.v.t>TTL)refresh(key,e).catch(()=>{});
    const v=e.v;res.writeHead(v.status,{'Content-Type':v.type,'Cache-Control':'no-store'});res.end(v.buf);
  }catch(err){cache.delete(key);json(res,502,{error:String(err.cause&&err.cause.message||err.message)})}
  if(cache.size>600){const old=[...cache.entries()].sort((a,b)=>a[1].used-b[1].used)[0];cache.delete(old[0])}
}
async function doPing(u){const t0=Date.now();
  try{const r=await fetch(new URL(sub(/^https?:\/\//.test(u)?u:'http://'+u)),{method:'GET',signal:AbortSignal.timeout(6000),redirect:'manual'});r.body&&r.body.cancel().catch(()=>{});
    return{ok:r.status<500,status:r.status,ms:Date.now()-t0,t:Date.now()}}
  catch(e){return{ok:false,error:e.name==='TimeoutError'?'timeout':'down',t:Date.now()}}}
async function ping(res,u){
  let e=pings.get(u);if(!e){e={v:null,used:0,p:null};pings.set(u,e);saveWarm()}
  e.used=Date.now();
  const run=()=>e.p||(e.p=doPing(u).then(v=>(e.v=v)).finally(()=>{e.p=null}));
  if(!e.v)await run();else if(Date.now()-e.v.t>PING_TTL)run();
  json(res,200,e.v)}
// Husk hva som brukes, så cachen kan varmes opp igjen etter omstart
let warmT=null;
function saveWarm(){clearTimeout(warmT);warmT=setTimeout(()=>{try{wr(WARM_FILE,{proxy:[...cache.values()].filter(e=>/json|text/.test(e.v?.type||'json')).map(e=>({u:e.u,hd:e.hd})),ping:[...pings.keys()]})}catch(e){}},2000)}
function warmTick(){const now=Date.now();
  for(const[k,e]of cache){if(now-e.used>IDLE){cache.delete(k);continue}if(!e.v||(now-e.v.t>TTL&&/json|text/.test(e.v.type)))refresh(k,e).catch(()=>{})}
  for(const[u,e]of pings){if(now-e.used>IDLE){pings.delete(u);continue}if(!e.v||now-e.v.t>PING_TTL)e.p||(e.p=doPing(u).then(v=>(e.v=v)).finally(()=>{e.p=null}))}}
{const w=rd(WARM_FILE,{proxy:[],ping:[]}),now=Date.now();
  (w.proxy||[]).forEach(x=>cache.set(x.u+'\n'+JSON.stringify(x.hd),{u:x.u,hd:x.hd,v:null,used:now}));
  (w.ping||[]).forEach(u=>pings.set(u,{v:null,used:now,p:null}));
  setTimeout(warmTick,500);setInterval(warmTick,10000)}

// Minecraft Java Server List Ping (protokoll -1), med SRV-oppslag og 30 s cache
const net=require('net'),dns=require('dns').promises;
const varint=n=>{const b=[];do{let x=n&0x7f;n>>>=7;if(n)x|=0x80;b.push(x)}while(n);return Buffer.from(b)};
const pkt=(id,...parts)=>{const body=Buffer.concat([varint(id),...parts]);return Buffer.concat([varint(body.length),body])};
const mcStr=s=>{const b=Buffer.from(s,'utf8');return Buffer.concat([varint(b.length),b])};
function readVarint(buf,o){let n=0,shift=0,b;do{if(o>=buf.length)return null;b=buf[o++];n|=(b&0x7f)<<shift;shift+=7}while(b&0x80);return[n,o]}
function slp(host,port){return new Promise((resolve,reject)=>{
  const sock=net.createConnection({host,port});let buf=Buffer.alloc(0);const done=(e,v)=>{sock.destroy();e?reject(e):resolve(v)};
  sock.setTimeout(5000,()=>done(new Error('timeout')));sock.on('error',done);
  sock.on('connect',()=>{const p=Buffer.alloc(2);p.writeUInt16BE(port);sock.write(pkt(0,Buffer.from([0xff,0xff,0xff,0xff,0x0f]),mcStr(host),p,varint(1)));sock.write(pkt(0))});
  sock.on('data',d=>{buf=Buffer.concat([buf,d]);const a=readVarint(buf,0);if(!a)return;const[len,o]=a;if(buf.length<o+len)return;
    const b=readVarint(buf,o),c=readVarint(buf,b[1]);const json=buf.slice(c[1],c[1]+c[0]).toString('utf8');try{done(null,JSON.parse(json))}catch(e){done(e)}});
})}
const flat=c=>typeof c==='string'?c:c?(c.text||'')+(c.extra||[]).map(flat).join(''):'';
const mcCache=new Map();
async function minecraft(res,raw){
  raw=sub(raw||'${MINECRAFT_HOST}').replace(/^\w+:\/\//,'').replace(/\/.*$/,'');
  if(!raw)return json(res,400,{error:'MINECRAFT_HOST mangler'});
  const hit=mcCache.get(raw);if(hit){json(res,200,hit.v);if(Date.now()-hit.t<30000||hit.busy)return;hit.busy=true;res={writeHead(){},end(){}}}
  let[host,p]=raw.split(':'),port=+p||25565,v;
  if(!p){try{const r=await dns.resolveSrv('_minecraft._tcp.'+host);if(r[0]){host=r[0].name;port=r[0].port}}catch(e){}}
  try{const s=await slp(host,port);
    v={host:raw,online:true,now:s.players?.online||0,max:s.players?.max||0,version:s.version?.name||'—',motd:flat(s.description).replace(/§./g,'').replace(/\n/g,' · ').trim(),icon:s.favicon||'',list:(s.players?.sample||[]).map(x=>x.name)}}
  catch(e){v={host:raw,online:false,now:0,max:0,version:'—',motd:'',icon:'',list:[]}}
  mcCache.set(raw,{t:Date.now(),v});json(res,200,v);
}
http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://x'),p=url.pathname;
  try{
    if(p==='/api/kv'&&req.method==='GET')return json(res,200,{...kv,[SEC_KEY]:JSON.stringify(masked())});
    if(p.startsWith('/api/kv/')){
      const k=decodeURIComponent(p.slice(8));
      if(req.method==='DELETE'){if(k===SEC_KEY)secrets={},wr(SEC_FILE,secrets);else delete kv[k],wr(KV_FILE,kv);return json(res,200,{ok:true})}
      if(req.method==='PUT'){const v=(await body(req)).toString();
        if(k===SEC_KEY){let o={};try{o=JSON.parse(v)||{}}catch(e){}const n={};
          for(const name in o){if(!/^[A-Z0-9_]+$/.test(name))continue;n[name]=o[name]==='${'+name+'}'?(secrets[name]||process.env[name]||''):String(o[name])}
          secrets=n;wr(SEC_FILE,secrets)}
        else{kv[k]=v;wr(KV_FILE,kv)}
        return json(res,200,{ok:true})}
    }
    if(p==='/api/proxy')return proxy(req,res,url.searchParams.get('url')||'');
    if(p==='/api/ping')return ping(res,url.searchParams.get('url')||'');
    if(p==='/api/widgets/minecraft')return minecraft(res,url.searchParams.get('host'));
    if(p==='/api/health')return json(res,200,{ok:true});
    let f=path.normalize(path.join(PUB,p==='/'?'index.html':p));
    if(!f.startsWith(PUB)||!fs.existsSync(f)||fs.statSync(f).isDirectory())f=path.join(PUB,'index.html');
    res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res);
  }catch(e){json(res,500,{error:e.message})}
}).listen(PORT,()=>console.log('Labdeck kjører på port '+PORT+', data i '+DATA));
