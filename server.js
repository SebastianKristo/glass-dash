// Glass Dash / Labdeck backend: statiske filer, config-lagring, secrets og proxy. Ingen avhengigheter.
const http=require('http'),fs=require('fs'),path=require('path');
const PORT=+process.env.PORT||7575,DATA=process.env.DATA_DIR||'/app/data',PUB=path.join(__dirname,'public');
const SEC_KEY='labdeck-secrets',KV_FILE=path.join(DATA,'config.json'),SEC_FILE=path.join(DATA,'secrets.json');
fs.mkdirSync(DATA,{recursive:true});
const rd=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){return d}};
const wr=(f,o)=>{fs.writeFileSync(f+'.tmp',JSON.stringify(o,null,2));fs.renameSync(f+'.tmp',f)};
let kv=rd(KV_FILE,{}),secrets=rd(SEC_FILE,{});
// Miljøvariabler (f.eks. fra Unraid-template) brukes som fallback, men kun for kjente secret-navn
const DEF=['PLEX_URL','PLEX_TOKEN','SONARR_URL','SONARR_KEY','RADARR_URL','RADARR_KEY','SPEEDTEST_URL','SPEEDTEST_TRACKER_API_TOKEN','CLOUDFLARE_API_TOKEN','CLOUDFLARE_ZONE_ID','IMMICH_URL','IMMICH_API_KEY','QBITTORRENT_IP','PROWLARR_URL','PROWLARR_API_URL','PROWLARR_KEY','PORTAINER_URL','PORTAINER_ENDPOINT_ID','PORTAINER_API_KEY','SONARR_API_URL','RADARR_API_URL','PROWLARR_COLLAPSE_AFTER','CLOUDFLARE_API_KEY','CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_TUNNEL_ID','ADGUARD_PASSWORD','DNS_URL','DNS_USER','DNS_PASSWORD','PIHOLE_URL','PIHOLE_PASSWORD','GLANCES_URL','PROXMOX_URL','PROXMOX_TOKEN','UNRAID_URL','UNRAID_API_KEY','DOCKER_HOST_IP','DOCKER_HOSTS','MINECRAFT_HOST','MINECRAFT_CONSOLE_URL'];
const known=n=>DEF.includes(n)||n in secrets;
const sec=n=>!known(n)?'':secrets[n]!=null&&secrets[n]!==''?secrets[n]:(process.env[n]||'');
const sub=s=>String(s).replace(/\$\{(\w+)\}/g,(_,n)=>sec(n));
// Pi-hole-adresser lagres ofte som http://ip/admin, men API-et ligger på /api
const target=u=>sub(u).replace(/\/admin\/+api\/(auth|stats|history)/,'/api/$1');
const masked=()=>{const o={};new Set([...DEF,...Object.keys(secrets)]).forEach(n=>o[n]=sec(n)?'${'+n+'}':'');return o};
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
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
  const r=await fetch(new URL(target(u)),{headers:fillHeaders(hd),signal:AbortSignal.timeout(15000),redirect:'follow'});
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
    try{const r=await fetch(new URL(target(u)),{method:req.method,headers:h,body:b,signal:AbortSignal.timeout(15000)});
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
// Statiske filer: gzip + cache i minnet. index.html får oppsettet bakt inn, så siden slipper et ekstra kall.
const zlib=require('zlib'),staticCache=new Map();
function loadStatic(f){const st=fs.statSync(f),c=staticCache.get(f);if(c&&c.m===st.mtimeMs)return c;
  const buf=fs.readFileSync(f),v={m:st.mtimeMs,buf,gz:/\.(html|js|css|svg|json|txt)$/.test(f)?zlib.gzipSync(buf):null};staticCache.set(f,v);return v}
function serveStatic(req,res,f){
  const ext=path.extname(f),type=MIME[ext]||'application/octet-stream',gz=/gzip/.test(req.headers['accept-encoding']||'');
  if(f===path.join(PUB,'index.html')){
    const kvj=JSON.stringify({...kv,[SEC_KEY]:JSON.stringify(masked())}).replace(/</g,'\\u003c');
    const pre=iconUrls().filter(u=>{const v=imgGet(u);return v&&!v.miss}).slice(0,120).map(u=>'<link rel="preload" as="image" href="/api/img?url='+encodeURIComponent(u).replace(/'/g,'%27')+'">').join('');
    const html=loadStatic(f).buf.toString().replace('<script src="./shim.js">',pre+'<script>window.__LABDECK_KV__='+kvj+'</script>\n<script src="./shim.js">');
    const out=gz?zlib.gzipSync(html):Buffer.from(html);
    res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store',...(gz?{'Content-Encoding':'gzip'}:{}),'Vary':'Accept-Encoding'});return res.end(out)}
  const v=loadStatic(f),long=/\/(vendor|fonts)\//.test(f);
  res.writeHead(200,{'Content-Type':type,'Cache-Control':long?'public, max-age=31536000, immutable':'no-cache',...(gz&&v.gz?{'Content-Encoding':'gzip'}:{}),'Vary':'Accept-Encoding'});
  res.end(gz&&v.gz?v.gz:v.buf)}
// Bildecache for ikoner (CDN) – lagres på disk i <data>/img-cache og holdes i minnet.
// Ikoner lastes ned så snart de legges inn i oppsettet, så dashbordet aldri venter på nettet.
const crypto=require('crypto'),IMG_DIR=path.join(DATA,'img-cache');fs.mkdirSync(IMG_DIR,{recursive:true});
const IMG_OK=/^https:\/\/(cdn\.jsdelivr\.net|raw\.githubusercontent\.com|avatars\.githubusercontent\.com|mc-heads\.net|developers\.cloudflare\.com)\//;
const IMG_AGE=7*864e5,MISS_AGE=864e5,imgBusy=new Map(),imgMem=new Map();
const imgHash=u=>crypto.createHash('sha1').update(u).digest('hex');
// Leses fra minnet, ellers disk. {buf,type,t} eller {miss:true,t}
function imgGet(u){const h=imgHash(u);if(imgMem.has(h))return imgMem.get(h);const f=path.join(IMG_DIR,h);
  try{if(fs.existsSync(f+'.miss')){const v={miss:true,t:fs.statSync(f+'.miss').mtimeMs};imgMem.set(h,v);return v}
    if(fs.existsSync(f)){const v={buf:fs.readFileSync(f),type:fs.readFileSync(f+'.type','utf8'),t:fs.statSync(f).mtimeMs};imgMem.set(h,v);return v}}catch(e){}
  return null}
// Alternativer når en adresse ikke finnes: svg→png (og omvendt) og samme navn i selfhst/icons.
function imgAlts(u){const out=[u],m=/^(https:\/\/cdn\.jsdelivr\.net\/gh\/)(homarr-labs\/dashboard-icons|selfhst\/icons)\/(svg|png|webp)\/([^/?#]+)\.(svg|png|webp)$/.exec(u);
  if(!m)return out;const[,cdn,repo,,name]=m,other=repo==='selfhst/icons'?'homarr-labs/dashboard-icons':'selfhst/icons';
  for(const r of[repo,other])for(const ext of['svg','png'])out.push(`${cdn}${r}/${ext}/${name}.${ext}`);
  return[...new Set(out)]}
function fetchImg(u){const h=imgHash(u);if(imgBusy.has(h))return imgBusy.get(h);
  const f=path.join(IMG_DIR,h);
  const p=(async()=>{let last=404;
    for(const alt of imgAlts(u)){let r;try{r=await fetch(alt,{signal:AbortSignal.timeout(10000)})}catch(e){last=502;break}
      if(r.status===404||r.status===403){last=r.status;continue}
      if(!r.ok){last=r.status;break}
      const buf=Buffer.from(await r.arrayBuffer()),type=r.headers.get('content-type')||'image/png';
      fs.writeFileSync(f+'.tmp',buf);fs.renameSync(f+'.tmp',f);fs.writeFileSync(f+'.type',type);try{fs.unlinkSync(f+'.miss')}catch(e){}
      const v={buf,type,t:Date.now()};imgMem.set(h,v);return v}
    if(last===404||last===403){fs.writeFileSync(f+'.miss','');const v={miss:true,t:Date.now()};imgMem.set(h,v);return v}
    const e=new Error('HTTP '+last);e.status=last;throw e})().finally(()=>imgBusy.delete(h));
  imgBusy.set(h,p);return p}
function sendImg(res,v){if(v.miss){res.writeHead(404,{'Cache-Control':'public, max-age=3600'});return res.end()}
  res.writeHead(200,{'Content-Type':v.type,'Content-Length':v.buf.length,'Cache-Control':'public, max-age=2592000, stale-while-revalidate=604800'});res.end(v.buf)}
async function image(res,u){
  if(!IMG_OK.test(u))return res.writeHead(400).end();
  const v=imgGet(u);
  if(v){sendImg(res,v);if(Date.now()-v.t>(v.miss?MISS_AGE:IMG_AGE))fetchImg(u).catch(()=>{});return}
  try{sendImg(res,await fetchImg(u))}
  catch(e){res.writeHead(e.status||502,{'Cache-Control':'no-store'});res.end()}
}
// Alle ikon-adresser i oppsettet (fliser, widgets osv.)
const iconUrls=()=>[...new Set((JSON.stringify(kv).match(/https:\/\/[^"'\s\\)]+/g)||[]).filter(u=>IMG_OK.test(u)&&/\.(svg|png|webp|jpe?g|gif|ico)(\?|$)|avatars\.githubusercontent\.com/.test(u)))];
// Last ned ikoner som mangler (ved oppstart og når oppsettet lagres)
let iconT=null;
function warmIcons(){clearTimeout(iconT);iconT=setTimeout(async()=>{for(const u of iconUrls()){const v=imgGet(u);if(!v||Date.now()-v.t>(v.miss?MISS_AGE:IMG_AGE))await fetchImg(u).catch(()=>{})}},1500)}
warmIcons();
// ── Oppdagelse: CT-er og VM-er fra Proxmox, containere fra Portainer ─────────
// GET /api/discover gir en liste med {key,name,url,icon,source,where,note}. Bare lesing.
// Proxmox-token trenger kun rollen PVEAuditor. Selvsignerte sertifikater godtas (LAN).
const https=require('https');
function getJSON(u,headers={},ms=8000){return new Promise((resolve,reject)=>{let url;try{url=new URL(u)}catch(e){return reject(e)}
  const mod=url.protocol==='https:'?https:http;
  const rq=mod.request(url,{headers,rejectUnauthorized:false,timeout:ms},r=>{const c=[];r.on('data',d=>c.push(d));r.on('end',()=>{
    if(r.statusCode>=400)return reject(new Error('HTTP '+r.statusCode));try{resolve(JSON.parse(Buffer.concat(c).toString()))}catch(e){reject(e)}})});
  rq.on('timeout',()=>rq.destroy(new Error('timeout')));rq.on('error',reject);rq.end()})}
function postJSON(u,body,headers={},ms=8000){return new Promise((resolve,reject)=>{let url;try{url=new URL(u)}catch(e){return reject(e)}
  const mod=url.protocol==='https:'?https:http,data=JSON.stringify(body);
  const rq=mod.request(url,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),...headers},rejectUnauthorized:false,timeout:ms},r=>{const c=[];r.on('data',d=>c.push(d));r.on('end',()=>{
    if(r.statusCode>=400)return reject(new Error('HTTP '+r.statusCode));try{resolve(JSON.parse(Buffer.concat(c).toString()))}catch(e){reject(e)}})});
  rq.on('timeout',()=>rq.destroy(new Error('timeout')));rq.on('error',reject);rq.end(data)})}
const DOCKER_SOCK=process.env.DOCKER_SOCK||'/var/run/docker.sock';
function sockJSON(p,ms=5000){return new Promise((resolve,reject)=>{const rq=http.request({socketPath:DOCKER_SOCK,path:p,timeout:ms},r=>{const c=[];r.on('data',d=>c.push(d));r.on('end',()=>{
    if(r.statusCode>=400)return reject(new Error('HTTP '+r.statusCode));try{resolve(JSON.parse(Buffer.concat(c).toString()))}catch(e){reject(e)}})});
  rq.on('timeout',()=>rq.destroy(new Error('timeout')));rq.on('error',reject);rq.end()})}
const portOpen=(host,port,ms=700)=>new Promise(r=>{const s=net.createConnection({host,port});const d=v=>{s.destroy();r(v)};s.setTimeout(ms,()=>d(false));s.on('connect',()=>d(true));s.on('error',()=>d(false))});
const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
// Kjente tjenester: navn, porter (første som svarer brukes), sti, ikon. hide = ingen web-side.
const S=(name,ports,o={})=>({name,ports,...o});
const KNOWN={
  homeassistant:S('Home Assistant',[8123],{icon:'home-assistant'}),haos:S('Home Assistant',[8123],{icon:'home-assistant'}),hass:S('Home Assistant',[8123],{icon:'home-assistant'}),
  adguard:S('AdGuard Home',[80,3000],{icon:'adguard-home'}),adguardhome:S('AdGuard Home',[80,3000],{icon:'adguard-home'}),
  pihole:S('Pi-hole',[80],{path:'/admin',icon:'pi-hole'}),homebridge:S('Homebridge',[8581]),
  jellyfin:S('Jellyfin',[8096]),emby:S('Emby',[8096]),plex:S('Plex',[32400],{path:'/web'}),plexmediaserver:S('Plex',[32400],{path:'/web',icon:'plex'}),
  portainer:S('Portainer',[9443,9000]),portainerce:S('Portainer',[9443,9000],{icon:'portainer'}),
  ollama:S('Ollama',[11434]),openwebui:S('Open WebUI',[8080,3000],{icon:'open-webui'}),
  frigate:S('Frigate',[8971,5000]),proxmoxbackupserver:S('Proxmox Backup',[8007],{icon:'proxmox'}),pbs:S('Proxmox Backup',[8007],{icon:'proxmox'}),
  sonarr:S('Sonarr',[8989]),radarr:S('Radarr',[7878]),prowlarr:S('Prowlarr',[9696]),lidarr:S('Lidarr',[8686]),readarr:S('Readarr',[8787]),bazarr:S('Bazarr',[6767]),
  qbittorrent:S('qBittorrent',[8080]),qbittorrentnox:S('qBittorrent',[8080],{icon:'qbittorrent'}),sabnzbd:S('SABnzbd',[8080]),nzbget:S('NZBGet',[6789]),
  transmission:S('Transmission',[9091]),deluge:S('Deluge',[8112]),overseerr:S('Overseerr',[5055]),jellyseerr:S('Jellyseerr',[5055]),tautulli:S('Tautulli',[8181]),
  flaresolverr:S('FlareSolverr',[8191],{hide:true}),
  uptimekuma:S('Uptime Kuma',[3001],{icon:'uptime-kuma'}),nginxproxymanager:S('Nginx Proxy Manager',[81],{icon:'nginx-proxy-manager'}),npm:S('Nginx Proxy Manager',[81],{icon:'nginx-proxy-manager'}),
  grafana:S('Grafana',[3000]),prometheus:S('Prometheus',[9090]),influxdb:S('InfluxDB',[8086]),nodered:S('Node-RED',[1880],{icon:'node-red'}),
  zigbee2mqtt:S('Zigbee2MQTT',[8080]),esphome:S('ESPHome',[6052]),unifi:S('UniFi',[8443]),immich:S('Immich',[2283]),immichserver:S('Immich',[2283],{icon:'immich'}),
  nextcloud:S('Nextcloud',[443,80]),vaultwarden:S('Vaultwarden',[80]),paperless:S('Paperless',[8000],{icon:'paperless-ngx'}),paperlessngx:S('Paperless',[8000],{icon:'paperless-ngx'}),
  syncthing:S('Syncthing',[8384]),homarr:S('Homarr',[7575]),homepage:S('Homepage',[3000]),dashy:S('Dashy',[4000]),labdeck:S('Labdeck',[80,7575],{icon:'',self:true}),
  glances:S('Glances',[61208]),speedtesttracker:S('Speedtest Tracker',[80,8080],{icon:'speedtest-tracker'}),musicassistant:S('Music Assistant',[8095],{icon:'music-assistant'}),
  lyrion:S('Lyrion',[9000],{icon:'lyrion-music-server'}),lms:S('Lyrion',[9000],{icon:'lyrion-music-server'}),scrypted:S('Scrypted',[10443]),go2rtc:S('go2rtc',[1984]),
  silo:S('Silo',[80,3000,8080]),navidrome:S('Navidrome',[4533]),subwave:S('SUB/WAVE',[3000,8080],{icon:'subwave'}),dispatcharr:S('Dispatcharr',[9191]),minio:S('MinIO',[9001]),n8n:S('n8n',[5678]),
  // Uten web-side: skjules
  postgres:S('',[],{hide:true}),postgresql:S('',[],{hide:true}),mariadb:S('',[],{hide:true}),mysql:S('',[],{hide:true}),redis:S('',[],{hide:true}),valkey:S('',[],{hide:true}),
  mongo:S('',[],{hide:true}),mongodb:S('',[],{hide:true}),watchtower:S('',[],{hide:true}),gluetun:S('',[],{hide:true}),portaineragent:S('',[],{hide:true}),agent:S('',[],{hide:true}),
  mosquitto:S('',[],{hide:true}),mqtt:S('',[],{hide:true}),tailscale:S('',[],{hide:true}),cloudflared:S('',[],{hide:true}),wireguard:S('',[],{hide:true}),
  whisper:S('',[],{hide:true}),piper:S('',[],{hide:true}),openwakeword:S('',[],{hide:true}),wyomingwhisper:S('',[],{hide:true}),wyomingpiper:S('',[],{hide:true}),
};
const HTTPS_PORTS=new Set([443,8443,9443,8006,8007,8971,10443]);
const PROBE=[80,443,8080,3000,8000,5000,9000,9443,8443,8096,8123,8081,5055,8888];
const lookup=(...names)=>{for(const n of names){const k=norm(n);if(KNOWN[k])return[k,KNOWN[k]]}
  for(const n of names){const k=norm(n);for(const key in KNOWN)if(key.length>3&&k.startsWith(key))return[key,KNOWN[key]]}return[null,null]};
const pretty=s=>String(s).replace(/[-_.]+/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
const mkUrl=(host,port,path='')=>(HTTPS_PORTS.has(port)?'https://':'http://')+host+((port===80&&!HTTPS_PORTS.has(port))||port===443?'':':'+port)+path;
// Ikoner: slå opp i homarr-labs/dashboard-icons sin indeks (caches et døgn), ellers gjett svg.
let iconIdx={t:0,svg:new Set(),png:new Set()};
async function iconIndex(){if(Date.now()-iconIdx.t<864e5)return iconIdx;
  try{const j=await getJSON('https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/tree.json',{},8000);
    iconIdx={t:Date.now(),svg:new Set((j.svg||[]).map(f=>f.replace(/\.svg$/,''))),png:new Set((j.png||[]).map(f=>f.replace(/\.png$/,'')))}}
  catch(e){iconIdx.t=Date.now()-864e5+3600e3}return iconIdx}
function iconFor(idx,...cands){const base='https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/';
  const list=cands.filter(Boolean).flatMap(c=>{const k=String(c).toLowerCase();return[k,k.replace(/[^a-z0-9]+/g,'-'),norm(k)]});
  if(idx.svg.size){for(const c of list){if(idx.svg.has(c))return base+'svg/'+c+'.svg';if(idx.png.has(c))return base+'png/'+c+'.png'}return ''}
  return list[0]?base+'svg/'+list[1]+'.svg':''}
async function pickPort(host,known,extra=[]){if(!host)return null;const cand=[...new Set([...(known?known.ports:[]),...extra,...(known&&known.ports.length?[]:PROBE)])];
  const res=await Promise.all(cand.map(p=>portOpen(host,p)));const i=res.indexOf(true);return i<0?null:cand[i]}
function tagPort(tags){const m=/(?:^|;)(?:port|web|https)-(\d+)(?:;|$)/.exec(tags||'');return m?{port:+m[1],https:/(?:^|;)https-/.test(tags)}:null}
async function discoverProxmox(idx){
  const base=sec('PROXMOX_URL').replace(/\/$/,''),tok=sec('PROXMOX_TOKEN');if(!base||!tok)return{items:[],error:null,skipped:true};
  const H={Authorization:'PVEAPIToken='+tok},pveHost=new URL(base).hostname;
  const list=(await getJSON(base+'/api2/json/cluster/resources?type=vm',H)).data||[];
  const items=await Promise.all(list.filter(v=>!v.template).map(async v=>{
    const kind=v.type==='lxc'?'CT':'VM',key='pve:'+v.vmid,where=kind+' '+v.vmid+(v.node?' · '+v.node:'');
    if((v.tags||'').split(/[;,]/).includes('nodash'))return null;
    const[,known]=lookup(v.name,...(v.tags||'').split(/[;,]/));if(known&&known.hide)return null;
    const name=known&&known.name||pretty(v.name||kind+' '+v.vmid);
    if(v.status!=='running')return{key,name,url:'',icon:iconFor(idx,known&&known.icon,v.name),source:'proxmox',where,note:'stoppet'};
    let ip='';
    try{if(v.type==='lxc'){const j=await getJSON(`${base}/api2/json/nodes/${v.node}/lxc/${v.vmid}/interfaces`,H);
        const a=(j.data||[]).filter(i=>i.name!=='lo').map(i=>(i.inet||'').split('/')[0]).find(x=>x&&x!=='127.0.0.1');ip=a||''}
      else{const j=await getJSON(`${base}/api2/json/nodes/${v.node}/qemu/${v.vmid}/agent/network-get-interfaces`,H);
        for(const i of (j.data&&j.data.result)||[]){if(i.name==='lo')continue;const a=(i['ip-addresses']||[]).find(x=>x['ip-address-type']==='ipv4'&&!x['ip-address'].startsWith('127.')&&!x['ip-address'].startsWith('172.17.'));if(a){ip=a['ip-address'];break}}}}
    catch(e){}
    if(!ip)return{key,name,url:'',icon:iconFor(idx,known&&known.icon,v.name),source:'proxmox',where,note:kind==='VM'?'fant ikke IP (installer qemu-guest-agent)':'fant ikke IP'};
    const tp=tagPort(v.tags);let port=tp?tp.port:await pickPort(ip,known);
    if(!port)return{key,name,url:'',icon:iconFor(idx,known&&known.icon,v.name),source:'proxmox',where:where+' · '+ip,note:'ingen web-port funnet (legg til tag port-XXXX)'};
    const url=tp&&tp.https?'https://'+ip+':'+port:mkUrl(ip,port,known&&known.path||'');
    return{key,name,url,icon:iconFor(idx,known&&known.icon,v.name),source:'proxmox',where:where+' · '+ip}}));
  // Selve Proxmox-noden(e)
  const nodes=[...new Set(list.map(v=>v.node))];
  if(!nodes.length)nodes.push('pve');
  const self=nodes.map(n=>({key:'pve-node:'+n,name:'Proxmox'+(nodes.length>1?' '+n:''),url:base.replace(/\/api2.*$/,''),icon:iconFor(idx,'proxmox'),source:'proxmox',where:'node '+n}));
  return{items:[...self,...items.filter(Boolean)],error:null}}
// Felles for Portainer, Unraid og lokal Docker-socket: gjør Docker-containere om til fliser.
// cs = Docker API-format (Names, Image, Labels, Ports, HostConfig.NetworkMode). c._ip = egen IP (f.eks. br0 på Unraid).
async function dockerItems(cs,host,idx,source,keyOf,whereOf,noHostNote){const out=[];
    const byId=new Map(cs.map(c=>[c.Id,c])),byName=new Map(cs.map(c=>[(c.Names[0]||'').replace(/^\//,''),c]));
    for(const c of cs){const cname=(c.Names[0]||'').replace(/^\//,''),L=c.Labels||{},img=(c.Image||'').split('@')[0].split(':')[0],ib=img.split('/').pop();
      if(/^(true|1)$/i.test(L['labdeck.hide']||''))continue;
      const k=keyOf(cname),where=whereOf(cname);
      const[,known]=lookup(L['labdeck.name'],cname,ib,L['com.docker.compose.service']);
      const name=L['labdeck.name']||L['homepage.name']||known&&known.name||pretty(cname);
      const icon=L['labdeck.icon']||iconFor(idx,known&&known.icon,ib,cname);
      const href=L['labdeck.url']||L['homepage.href'];
      if(href){out.push({key:k,name,url:href,icon,source,where});continue}
      if(known&&known.hide||known&&known.self)continue;
      if(c._stopped){out.push({key:k,name,url:'',icon,source,where,note:'stoppet'});continue}
      let ports=c.Ports||[],netMode=(c.HostConfig&&c.HostConfig.NetworkMode)||'';
      // Containere som deler nettverk med en annen (f.eks. Gluetun): portene ligger på den andre containeren
      if(netMode.startsWith('container:')){const ref=netMode.slice(10),p=byId.get(ref)||[...byId.values()].find(x=>x.Id.startsWith(ref))||byName.get(ref);ports=p?p.Ports||[]:[]}
      const pub=ports.filter(p=>p.PublicPort&&p.Type==='tcp');
      // Egen IP (macvlan/ipvlan, f.eks. br0 på Unraid): ingen publiserte porter, nås direkte
      if(c._ip&&!pub.length){const port=await pickPort(c._ip,known);if(!port)continue;
        out.push({key:k,name,url:mkUrl(c._ip,port,known&&known.path||''),icon,source,where:where+' · '+c._ip});continue}
      let port=null;
      if(netMode==='host'){port=known&&known.ports.length?(await pickPort(host,known))||known.ports[0]:null}
      else if(known&&known.ports.length){const hit=pub.find(p=>known.ports.includes(p.PrivatePort));port=hit?hit.PublicPort:null;
        if(!port&&!netMode.startsWith('container:')&&pub.length===1)port=pub[0].PublicPort}
      else{const web=pub.find(p=>[80,443,8080,3000,8000,5000,9000].includes(p.PrivatePort))||pub.find(p=>![22,53,25565,1883,8883,5432,3306,6379].includes(p.PrivatePort));port=web?web.PublicPort:null}
      if(!port)continue;   // ingen web-port: sannsynligvis ikke en side man vil åpne
      if(!host){out.push({key:k,name,url:'',icon,source,where,note:noHostNote});continue}
      const priv=(pub.find(p=>p.PublicPort===port)||{}).PrivatePort;
      const url=(HTTPS_PORTS.has(port)||HTTPS_PORTS.has(priv)?'https://':'http://')+host+(port===80?'':':'+port)+(known&&known.path||'');
      out.push({key:k,name,url,icon,source,where})}
  return out}
async function discoverPortainer(idx){
  const base=sec('PORTAINER_URL').replace(/\/$/,''),key=sec('PORTAINER_API_KEY');if(!base||!key)return{items:[],error:null,skipped:true};
  const H={'X-API-Key':key},pHost=new URL(base).hostname;
  const eps=await getJSON(base+'/api/endpoints',H),out=[];
  for(const ep of eps){const edge=ep.Type===4||ep.Type===7;if(!edge&&ep.Status!==1)continue;
    // Vertens adresse: «Public IP» i Portainer, ellers agent-adressen, ellers Portainer selv (lokal socket)
    const pub=(ep.PublicURL||'').replace(/^\w+:\/\//,'').split(/[:/]/)[0],agent=(/^(?:tcp|https?):\/\/([^:/]+)/.exec(ep.URL||'')||[])[1];
    const host=pub||agent||(edge?'':pHost);
    let cs;try{cs=await getJSON(`${base}/api/endpoints/${ep.Id}/docker/containers/json`,H)}catch(e){continue}
    out.push(...await dockerItems(cs,host,idx,'docker',c=>'docker:'+ep.Id+':'+c,c=>'Docker · '+ep.Name+' · '+c,'sett «Public IP» på miljøet i Portainer'))}
  return{items:out,error:null}}
// Unraid 7.2+: GraphQL-API (Innstillinger → Management Access → API Keys, rolle Viewer holder).
// Gir Docker-containere og VM-er. VM-er har ingen IP i API-et, så de får ikke URL automatisk.
const own=ns=>{if(!ns||typeof ns!=='object')return'';const n=ns.Networks||ns.networks||{};
  for(const k in n){if(/^(bridge|host|none)$/.test(k))continue;const ip=n[k]&&(n[k].IPAddress||n[k].ipAddress);if(ip)return ip}return''};
const jsonish=v=>{if(typeof v!=='string')return v||{};try{return JSON.parse(v)}catch(e){return{}}};
async function discoverUnraid(idx){
  const raw=sec('UNRAID_URL').replace(/\/$/,''),key=sec('UNRAID_API_KEY');if(!raw||!key)return{items:[],error:null,skipped:true};
  const base=raw.replace(/\/graphql$/,''),host=new URL(base).hostname,H={'x-api-key':key};
  const q=async query=>{const j=await postJSON(base+'/graphql',{query},H);if(j.errors&&!j.data)throw new Error(j.errors[0].message);return j.data||{}};
  const out=[{key:'unraid-node',name:'Unraid',url:base,icon:iconFor(idx,'unraid'),source:'unraid',where:'server '+host}],errs=[];
  try{const d=await q('{ docker { containers { id names image state ports { privatePort publicPort type } labels networkSettings } } }');
    const cs=((d.docker||{}).containers||[]).map(c=>{const L=jsonish(c.labels),ns=jsonish(c.networkSettings);
      return{Id:c.id,Names:c.names||[],Image:c.image,Labels:L,_stopped:!/running/i.test(c.state||''),_ip:own(ns),
        Ports:(c.ports||[]).map(p=>({PrivatePort:p.privatePort,PublicPort:p.publicPort,Type:String(p.type||'tcp').toLowerCase()})),
        HostConfig:{NetworkMode:(ns.Networks&&Object.keys(ns.Networks).length===1&&Object.keys(ns.Networks)[0]==='host')?'host':''}}});
    out.push(...await dockerItems(cs,host,idx,'unraid',c=>'unraid:'+c,c=>'Docker · Unraid · '+c,''))}
  catch(e){errs.push('Docker: '+e.message)}
  try{const d=await q('{ vms { domains { uuid name state } } }');
    for(const v of (d.vms||{}).domains||[]){if(!v.name)continue;const[,known]=lookup(v.name);if(known&&known.hide)continue;
      out.push({key:'unraid-vm:'+(v.uuid||v.name),name:known&&known.name||pretty(v.name),url:'',icon:iconFor(idx,known&&known.icon,v.name),source:'unraid',
        where:'VM · Unraid · '+v.name,note:/running/i.test(v.state||'')?'kjører – legg inn adressen selv':'stoppet'})}}
  catch(e){errs.push('VM: '+e.message)}
  if(out.length===1&&errs.length)throw new Error(errs.join(', '));
  return{items:out,error:errs.length?'Unraid: '+errs.join(', '):null}}
// Lokal Docker-socket (Labdeck kjører i Docker med /var/run/docker.sock montert, f.eks. på Unraid).
// Brukes når Unraid-API-et ikke er satt opp. Vertens IP: DOCKER_HOST_IP, ellers adressen dashbordet åpnes på.
async function discoverSocket(idx,reqHost){
  if(!fs.existsSync(DOCKER_SOCK))return{items:[],error:null,skipped:true};
  const cs=await sockJSON('/containers/json');
  const host=sec('DOCKER_HOST_IP')||(sec('UNRAID_URL')?new URL(sec('UNRAID_URL')).hostname:'')||reqHost||'';
  for(const c of cs){const n=(c.NetworkSettings||{}).Networks||{};for(const k in n){if(/^(bridge|host|none)$/.test(k))continue;if(n[k].IPAddress){c._ip=n[k].IPAddress;break}}}
  return{items:await dockerItems(cs,host,idx,'unraid',c=>'unraid:'+c,c=>'Docker · denne verten · '+c,'sett DOCKER_HOST_IP under Secrets'),error:null}}
// Docker-verter over nettverket (f.eks. Docker i en Proxmox-CT) via en skrivebeskyttet socket-proxy på port 2375.
// DOCKER_HOSTS = «10.69.1.50:2375, media=10.69.1.60:2375» (navn= er valgfritt).
async function discoverDockerHosts(idx){
  const list=sec('DOCKER_HOSTS').split(/[,\s]+/).filter(Boolean);if(!list.length)return{items:[],error:null,skipped:true};
  const out=[],errs=[];
  await Promise.all(list.map(async entry=>{let[label,addr]=entry.includes('=')?entry.split('='):['',entry];
    addr=addr.replace(/^\w+:\/\//,'').replace(/\/$/,'');if(!/:\d+$/.test(addr))addr+=':2375';const host=addr.split(':')[0];label=label||host;
    try{const cs=await getJSON('http://'+addr+'/containers/json',{},6000);
      for(const c of cs){const n=(c.NetworkSettings||{}).Networks||{};for(const k in n){if(/^(bridge|host|none)$/.test(k)||/_default$/.test(k))continue;if(n[k].IPAddress&&!n[k].IPAddress.startsWith('172.')){c._ip=n[k].IPAddress;break}}}
      out.push(...await dockerItems(cs,host,idx,'docker',c=>'dockerhost:'+host+':'+c,c=>'Docker · '+label+' · '+c,''))}
    catch(e){errs.push(label+' ('+e.message+')')}}));
  return{items:out,error:errs.length?'Docker-verter: '+errs.join(', '):null}}
let discCache=null;
async function discover(res,force,reqHost){
  if(!force&&discCache&&Date.now()-discCache.t<60000)return json(res,200,discCache.v);
  const idx=await iconIndex();
  const run=async(f,label)=>{try{return await f(idx,reqHost)}catch(e){return{items:[],error:label+': '+(e.cause&&e.cause.message||e.message)}}};
  const[p,d,u,h]=await Promise.all([run(discoverProxmox,'Proxmox'),run(discoverPortainer,'Portainer'),run(discoverUnraid,'Unraid'),run(discoverDockerHosts,'Docker-verter')]);
  // Socket bare hvis Unraid-API-et ikke ga containere (samme nøkler, unngår dobbelt)
  const sk=(!u.skipped&&!u.error)?{items:[],skipped:true}:await run(discoverSocket,'Docker-socket');
  const seen=new Set(),items=[...p.items,...d.items,...u.items,...h.items,...sk.items].filter(i=>!seen.has(i.key)&&seen.add(i.key));
  const v={t:Date.now(),items,errors:[p.error,d.error,u.error,h.error,sk.error].filter(Boolean),
    sources:{proxmox:!p.skipped,portainer:!d.skipped,unraid:!u.skipped||!sk.skipped,docker:!h.skipped}};
  discCache={t:Date.now(),v};json(res,200,v)}
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
        else{kv[k]=v;wr(KV_FILE,kv);warmIcons()}
        return json(res,200,{ok:true})}
    }
    if(p==='/api/proxy')return proxy(req,res,url.searchParams.get('url')||'');
    if(p==='/api/ping')return ping(res,url.searchParams.get('url')||'');
    if(p==='/api/widgets/minecraft')return minecraft(res,url.searchParams.get('host'));
    if(p==='/api/img')return image(res,url.searchParams.get('url')||'');
    if(p==='/api/discover')return discover(res,url.searchParams.has('fresh'),(req.headers.host||'').replace(/:\d+$/,'').replace(/^\[|\]$/g,''));
    if(p==='/api/health')return json(res,200,{ok:true});
    if(p.includes('{{'))return res.writeHead(404).end();   // mal-plassholdere fra før React har rendret
    let f=path.normalize(path.join(PUB,p==='/'?'index.html':decodeURIComponent(p)));
    if(!f.startsWith(PUB)||!fs.existsSync(f)||fs.statSync(f).isDirectory())f=path.join(PUB,'index.html');
    return serveStatic(req,res,f);
  }catch(e){json(res,500,{error:e.message})}
}).listen(PORT,()=>console.log('Labdeck kjører på port '+PORT+', data i '+DATA));
