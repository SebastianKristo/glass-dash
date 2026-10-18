// Kobler prototypen til backend: localStorage -> /api/kv, eksterne fetch -> /api/proxy (secrets byttes server-side).
(function(){
  var x=new XMLHttpRequest();x.open('GET','/api/kv',false);x.send();
  var store={};try{store=JSON.parse(x.responseText)||{}}catch(e){}
  var put=function(k,v){fetch('/api/kv/'+encodeURIComponent(k),{method:'PUT',headers:{'Content-Type':'text/plain'},body:v==null?'':String(v)})};
  var ls={getItem:function(k){return k in store?store[k]:null},setItem:function(k,v){store[k]=String(v);put(k,v)},
    removeItem:function(k){delete store[k];fetch('/api/kv/'+encodeURIComponent(k),{method:'DELETE'})},clear:function(){},key:function(i){return Object.keys(store)[i]||null},get length(){return Object.keys(store).length}};
  try{Object.defineProperty(window,'localStorage',{value:ls,configurable:true})}catch(e){}
  var of=window.fetch.bind(window);
  var ext=function(u){try{var p=new URL(u,location.href);return /^https?:$/.test(p.protocol)&&p.origin!==location.origin}catch(e){return false}};
  var px=function(u){return '/api/proxy?url='+encodeURIComponent(u)};
  window.fetch=function(input,init){
    var u=typeof input==='string'?input:(input&&input.url)||String(input);init=init||{};
    if(!ext(u)&&u.indexOf('${')<0)return of(input,init);
    if(init.mode==='no-cors'){
      return of('/api/ping?url='+encodeURIComponent(u),{signal:init.signal,cache:'no-store'}).then(function(r){return r.json()}).then(function(j){if(!j.ok)throw new Error(j.error||'down');return new Promise(function(ok){setTimeout(function(){ok(new Response(''))},Math.min(j.ms||0,2000))})});
    }
    var h={};var hd=init.headers||{};
    if(hd instanceof Headers)hd.forEach(function(v,k){h[k]=v});else for(var k in hd)h[k]=hd[k];
    return of(px(u),{method:init.method||'GET',body:init.body,signal:init.signal,headers:{'X-Proxy-Headers':JSON.stringify(h),'Content-Type':h['Content-Type']||h['content-type']||'text/plain'}});
  };
  // Bilder med ${SECRET} i URL (plakater osv.) går via proxy
  var sa=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(n,v){if(n==='src'&&typeof v==='string'&&v.indexOf('${')>=0)v=px(v);return sa.call(this,n,v)};
  var d=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
  Object.defineProperty(HTMLImageElement.prototype,'src',{get:d.get,set:function(v){if(typeof v==='string'&&v.indexOf('${')>=0)v=px(v);d.set.call(this,v)},configurable:true});
})();
