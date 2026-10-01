const CACHE_NAME='sonora-shell-v1';
const cacheTargets=()=>{
  const base=self.registration.scope;
  return [new URL('./',base).href,new URL('./index.html',base).href];
};
self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache=>cache.addAll(cacheTargets()))
      .then(()=>self.skipWaiting())
  );
});
self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k.startsWith('sonora-shell-')&&k!==CACHE_NAME).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin)return;
  if(req.mode==='navigate'){
    event.respondWith(
      caches.match(new URL('./index.html',self.registration.scope).href)
        .then(cached=>cached || fetch(req).then(res=>{
          const copy=res.clone();
          caches.open(CACHE_NAME).then(cache=>cache.put(new URL('./index.html',self.registration.scope).href,copy));
          return res;
        }).catch(()=>cached))
    );
    return;
  }
  event.respondWith(
    caches.match(req)
      .then(cached=>cached || fetch(req).then(res=>{
        const copy=res.clone();
        caches.open(CACHE_NAME).then(cache=>cache.put(req,copy));
        return res;
      }))
  );
});
