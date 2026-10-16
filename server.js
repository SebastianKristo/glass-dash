// Glass Dash / Labdeck backend: statiske filer, config-lagring, secrets og proxy. Ingen avhengigheter.
const http=require('http'),fs=require('fs'),path=require('path');
const PORT=+process.env.PORT||7575,DATA=process.env.DATA_DIR||'/app/data',PUB=path.join(__dirname,'public');
const SEC_KEY='labdeck-secrets',KV_FILE=path.join(DATA,'config.json'),SEC_FILE=path.join(DATA,'secrets.json');
fs.mkdirSync(DATA,{recursive:true});
const rd=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){return d}};
const wr=(f,o)=>{fs.writeFileSync(f+'.tmp',JSON.stringify(o,null,2));fs.renameSync(f+'.tmp',f)};
let kv=rd(KV_FILE,{}),secrets=rd(SEC_FILE,{});
// Miljøvariabler (f.eks. fra Unraid-template) brukes som fallback, men kun for kjente secret-navn
const DEF=['PLEX_URL','PLEX_TOKEN','SONARR_URL','SONARR_KEY','RADARR_URL','RADARR_KEY','SPEEDTEST_URL','SPEEDTEST_TRACKER_API_TOKEN','CLOUDFLARE_API_TOKEN','CLOUDFLARE_ZONE_ID','IMMICH_URL','IMMICH_API_KEY','QBITTORRENT_IP','PROWLARR_URL','PROWLARR_API_URL','PROWLARR_KEY','PORTAINER_URL','PORTAINER_ENDPOINT_ID','PORTAINER_API_KEY','SONARR_API_URL','RADARR_API_URL','PROWLARR_COLLAPSE_AFTER','CLOUDFLARE_API_KEY','CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_TUNNEL_ID','ADGUARD_PASSWORD','DNS_URL','DNS_USER','DNS_PASSWORD','GLANCES_URL','PROXMOX_URL','PROXMOX_TOKEN'];
const known=n=>DEF.includes(n)||n in secrets;
const sec=n=>!known(n)?'':secrets[n]!=null&&secrets[n]!==''?secrets[n]:(process.env[n]||'');
const sub=s=>String(s).replace(/\$\{(\w+)\}/g,(_,n)=>sec(n));
const masked=()=>{const o={};new Set([...DEF,...Object.keys(secrets)]).forEach(n=>o[n]=sec(n)?'${'+n+'}':'');return o};
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
const body=req=>new Promise(r=>{const c=[];req.on('data',d=>c.push(d));req.on('end',()=>r(Buffer.concat(c)))});
const json=(res,code,o)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(o))};
const cache=new Map();
async function proxy(req,res,u){
  let target;try{target=new URL(sub(u))}catch(e){return json(res,400,{error:'Ugyldig URL'})}
  let hd={};try{hd=JSON.parse(req.headers['x-proxy-headers']||'{}')}catch(e){}
  for(const k in hd){let v=String(hd[k]);
    // Basic auth bygget i nettleseren inneholder base64 av ${NAVN} – dekod, bytt inn secrets og kod på nytt
    const m=/^Basic\s+(.+)$/i.exec(v);if(m){const raw=Buffer.from(m[1],'base64').toString();if(raw.includes('${'))v='Basic '+Buffer.from(sub(raw)).toString('base64')}
    hd[k]=sub(v)}
  const method=req.method,b=method==='GET'||method==='HEAD'?undefined:sub((await body(req)).toString());
  if(b!==undefined&&!Object.keys(hd).some(k=>k.toLowerCase()==='content-type')&&req.headers['content-type'])hd['Content-Type']=req.headers['content-type'];
  const key=method==='GET'?target.href+JSON.stringify(hd):null;
  const c=key&&cache.get(key);if(c&&Date.now()-c.t<10000){res.writeHead(c.status,{'Content-Type':c.type});return res.end(c.buf)}
  try{
    const r=await fetch(target,{method,headers:hd,body:b,signal:AbortSignal.timeout(15000),redirect:'follow'});
    const buf=Buffer.from(await r.arrayBuffer()),type=r.headers.get('content-type')||'application/octet-stream';
    if(key&&r.ok){cache.set(key,{t:Date.now(),status:r.status,type,buf});if(cache.size>500)cache.delete(cache.keys().next().value)}
    res.writeHead(r.status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(buf);
  }catch(e){json(res,502,{error:String(e.cause&&e.cause.message||e.message)})}
}
async function ping(res,u){
  const t0=Date.now();
  try{const r=await fetch(new URL(sub(/^https?:\/\//.test(u)?u:'http://'+u)),{method:'GET',signal:AbortSignal.timeout(6000),redirect:'manual'});r.body&&r.body.cancel().catch(()=>{});
    json(res,200,{ok:r.status<500,status:r.status,ms:Date.now()-t0})}
  catch(e){json(res,200,{ok:false,error:e.name==='TimeoutError'?'timeout':'down'})}
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
    if(p==='/api/health')return json(res,200,{ok:true});
    let f=path.normalize(path.join(PUB,p==='/'?'index.html':p));
    if(!f.startsWith(PUB)||!fs.existsSync(f)||fs.statSync(f).isDirectory())f=path.join(PUB,'index.html');
    res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res);
  }catch(e){json(res,500,{error:e.message})}
}).listen(PORT,()=>console.log('Labdeck kjører på port '+PORT+', data i '+DATA));
