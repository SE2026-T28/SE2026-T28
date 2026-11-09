// Run after build. Model-issued tokens exercise real verification; OAuth login is measured separately by integration tests.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {cpus,totalmem,platform,release} from 'node:os';
import {writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {createApp} from '../dist/src/app.js';
import {getPrisma,disconnectPrisma} from '../dist/src/db/prisma.js';
assert.equal(process.env.VT113_ISOLATED_TEST_DB,'confirmed');
const db=new URL(process.env.DATABASE_URL);assert.equal(db.hostname,'127.0.0.1');assert.equal(db.port,'55432');assert.equal(db.pathname,'/vt113_user_search_test');assert.equal(db.username,'vt113_test');
const prisma=getPrisma();
const probe=await prisma.$queryRaw`SELECT current_database() AS db, current_user AS role, inet_server_port() AS port`;
assert.equal(probe[0].db,'vt113_user_search_test');assert.equal(probe[0].role,'vt113_test');assert.equal(probe[0].port,55432);
const run=randomUUID(),prefix=`vt113-perf-${run}-`,ids=[];
const server=createServer().listen(0);await once(server,'listening');const issuer=`http://localhost:${server.address().port}`,clientId='app04-react-demo';
let app;
try{
 for(let batch=0;batch<10;batch++){
  const rows=Array.from({length:1000},(_,j)=>{const i=batch*1000+j,id=randomUUID();ids.push(id);return {id,email:`${prefix}${String(i).padStart(5,'0')}${i%2?'MiXeD':'plain'}@example.test`,passwordHash:'performance-fixture-not-login',createdAt:new Date(Date.UTC(2026,0,1)+Math.floor(i/5)*1000)};});
  await prisma.user.createMany({data:rows});
 }
 app=createApp({port:server.address().port,issuer,clientId,redirectUri:'http://localhost:5173/callback',postLogoutRedirectUri:'http://localhost:5173/',corsOrigin:'http://localhost:5173',scopes:['openid','profile','email'],searchAccountIds:[ids[0]]});server.on('request',app);
 const provider=app.locals.oidcProvider,client=await provider.Client.find(clientId);
 const tokens=await Promise.all(Array.from({length:80},()=>new provider.AccessToken({client,accountId:ids[0],grantId:randomUUID(),gty:'authorization_code',scope:'users:read',aud:issuer+'/api/users',expiresIn:300}).save()));
 const queries=['?limit=10','?limit=50&page=100','?email='+encodeURIComponent(prefix.toUpperCase()+'000'),'?email='+encodeURIComponent('absent-'+run)];
 async function load(iterations){let errors=0;const durations=[];const begin=performance.now();await Promise.all(tokens.map(async(token,worker)=>{for(let j=0;j<iterations;j++){const start=performance.now();try{const response=await fetch(issuer+'/api/users/search'+queries[(worker+j)%4],{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(30000)});const body=await response.json();if(response.status!==200||!Array.isArray(body.data)||!body.pagination)errors++;}catch{errors++;}durations.push(performance.now()-start);}}));const seconds=(performance.now()-begin)/1000;durations.sort((a,b)=>a-b);const percentile=q=>durations[Math.ceil(q*durations.length)-1];return {requests:durations.length,seconds,p50_ms:percentile(.50),p95_ms:percentile(.95),p99_ms:percentile(.99),throughput_rps:durations.length/seconds,errors,errorRate:errors/durations.length};}
 const warmup=await load(5),runs=[];for(let i=0;i<3;i++){const result=await load(25);runs.push(result);console.log(JSON.stringify({run:i+1,...result}));}
 const report={machine:{os:platform()+' '+release(),cpu:cpus()[0].model,logicalCpus:cpus().length,memoryGiB:totalmem()/2**30,node:process.version},dataset:{rows:10000,timestampTies:5,email:'unique, mixed case, prefix searchable',indexes:'existing primary ID and unique email only'},protocol:{concurrency:80,model:'80 closed-loop async workers, one outstanding request each; local HTTP server+DB+load generator',queryMix:'25% unfiltered first page,25% unfiltered page100 limit50,25% selective case-insensitive substring,25% no match',warmupRequests:400,measuredRuns:3,requestsPerRun:2000,latency:'performance.now through complete JSON read; includes failures',tokens:'80 real provider-model opaque tokens, not hardcoded; full OAuth flow independently tested'},warmup,runs,pass:runs.every(r=>r.p95_ms<=2500&&r.errors===0)};
 await writeFile('../docs/vt113-part4/performance.json',JSON.stringify(report,null,2));console.log('PERFORMANCE_PASS='+report.pass);
 if(!report.pass)process.exitCode=1;
}finally{
 server.close();await once(server,'close');
 try{await prisma.user.deleteMany({where:{id:{in:ids},email:{startsWith:prefix}}});}finally{await disconnectPrisma();}
}
