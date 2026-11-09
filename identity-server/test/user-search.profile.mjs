import pg from 'pg';
import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';
const als=new AsyncLocalStorage(),samples=[],queries=[];let maxPool;
function observe(proto,key,field){const original=proto[key];proto[key]=function(...args){const store=als.getStore(),start=performance.now();if(key==='connect')maxPool=this.options?.max;let done=false;const finish=()=>{if(!done){done=true;if(store)store[field]=(store[field]??0)+performance.now()-start;}};const cb=args.at(-1);if(typeof cb==='function'){args[args.length-1]=function(...values){finish();return als.run(store,()=>cb.apply(this,values));};return original.apply(this,args);}const result=original.apply(this,args);if(result?.then)return result.finally(finish);finish();return result;};}
observe(pg.Pool.prototype,'connect','poolWaitMs');observe(pg.Client.prototype,'query','driverQueryMs');
export const profiler={
 attach(req,res,app){const store={};const start=performance.now();als.run(store,()=>{res.once('finish',()=>samples.push({...store,httpMs:performance.now()-start}));return app(req,res);});},
 repository(prisma){return Object.fromEntries(['count','findMany'].map(key=>[key,async args=>{const start=performance.now(),store=als.getStore();try{return await prisma.user[key](args);}finally{if(store)store[key+'Ms']=(store[key+'Ms']??0)+performance.now()-start;}}]));},
 provider(provider){const original=provider.AccessToken.find;provider.AccessToken.find=async function(...args){const start=performance.now(),store=als.getStore();try{return await original.apply(this,args);}finally{if(store)store.authMs=performance.now()-start;}};},
 response(app){const original=app.response.json;app.response.json=function(...args){const start=performance.now(),store=als.getStore();try{return original.apply(this,args);}finally{if(store)store.serializationMs=performance.now()-start;}};},
 report(){const keys=['httpMs','authMs','poolWaitMs','driverQueryMs','countMs','findManyMs','serializationMs'];return {sampleCount:samples.length,poolMax:maxPool,metrics:Object.fromEntries(keys.map(key=>{const a=samples.map(s=>s[key]??0).sort((a,b)=>a-b);return [key,{mean:a.reduce((x,y)=>x+y,0)/a.length,p50:a[Math.ceil(a.length*.5)-1],p95:a[Math.ceil(a.length*.95)-1],p99:a[Math.ceil(a.length*.99)-1]}];})),notes:'poolWait measures pg pool acquisition callbacks; driverQuery includes DB wire/execute/row decode; count/findMany include pool+Prisma overhead. Metrics overlap and must not be summed; response.json is synchronous serialization/write, not client delivery.'};}
};
