import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSearchQuery, searchUsers } from '../src/users/search.js';

test('defaults, trimming and literal email', () => {
  assert.deepEqual(parseSearchQuery(new URLSearchParams('email=%20Ab_%25%20')), { page: 1, limit: 10, email: 'Ab_%' });
  assert.deepEqual(parseSearchQuery(new URLSearchParams('email=  ')), { page: 1, limit: 10 });
});
for (const [key, values] of Object.entries({page:['0','-1','1.5','abc','1e2','','01','+1',' 1','2147483649'],limit:['0','-1','1.5','abc','1e2','','51','01']})) {
  for (const value of values) test(`reject ${key}=${value}`, () => {
    assert.throws(() => parseSearchQuery(new URLSearchParams([[key,value]])), (e: any) => e.status === 400);
  });
}
for (const key of ['email','page','limit']) test(`reject duplicate ${key}`, () => {
  assert.throws(() => parseSearchQuery(new URLSearchParams([[key,'1'],[key,'1']])), (e:any) => e.status === 400);
});
test('unknown key rejected', () => assert.throws(() => parseSearchQuery(new URLSearchParams('other=1')), (e:any) => e.status === 400));
for (const limit of [1,2,49,50]) test(`valid limit ${limit}`, () => assert.equal(parseSearchQuery(new URLSearchParams(`limit=${limit}`)).limit,limit));
for (const page of [1,2]) test(`valid page ${page}`, () => assert.equal(parseSearchQuery(new URLSearchParams(`page=${page}`)).page,page));
test('offset boundary and unsafe integers', () => {
  assert.equal(parseSearchQuery(new URLSearchParams('page=2147483648&limit=1')).page,2147483648);
  for (const q of ['page=2147483649&limit=1','page=9007199254740993','page=42949674&limit=50']) assert.throws(() => parseSearchQuery(new URLSearchParams(q)), (e:any) => e.status === 400);
});
test('service query contract, pagination and projection', async () => {
  const calls:any[]=[];
  const row={id:'fixed-id',email:'Ab_%@example.test',createdAt:new Date('2026-01-01Z'),passwordHash:'SECRET'};
  const repository={ count:async(args:any)=>{calls.push(['count',args]);return 11;},findMany:async(args:any)=>{calls.push(['findMany',args]);return [row];} };
  const result=await searchUsers({page:2,limit:10,email:'Ab_%'},repository);
  const where={email:{contains:'Ab\\_\\%',mode:'insensitive'}};
  assert.deepEqual(calls.find(c=>c[0]==='count')[1],{where});
  assert.deepEqual(calls.find(c=>c[0]==='findMany')[1],{where,skip:10,take:10,orderBy:[{createdAt:'desc'},{id:'asc'}],select:{id:true,email:true,createdAt:true}});
  assert.deepEqual(result,{data:[{id:row.id,email:row.email,createdAt:row.createdAt}],pagination:{page:2,limit:10,total:11,totalPages:2}});
});
test('empty and beyond-last pages',async()=>{
  for(const total of [0,11]) {
    const result=await searchUsers({page:3,limit:10},{count:async()=>total,findMany:async()=>[]});
    assert.deepEqual(result,{data:[],pagination:{page:3,limit:10,total,totalPages:Math.ceil(total/10)}});
  }
});
test('database failures propagate for future HTTP boundary',async()=>{
  for(const failing of ['count','findMany']) {
    const failure=new Error('database sentinel');
    await assert.rejects(searchUsers({page:1,limit:10},{count:async()=>{if(failing==='count')throw failure;return 0;},findMany:async()=>{if(failing==='findMany')throw failure;return [];}}), e=>e===failure);
  }
});

test('no filter, backslash literal and direct service validation', async () => {
  for (const email of [undefined, ' ', 'a\\b']) {
    let observed: unknown;
    await searchUsers({page:1,limit:10,email}, {count:async args=>{observed=args.where;return 0;},findMany:async()=>[]});
    assert.deepEqual(observed, email?.trim() ? {email:{contains:'a\\\\b',mode:'insensitive'}} : {});
  }
  await assert.rejects(searchUsers({page:0,limit:10},{count:async()=>{throw new Error('must not call');},findMany:async()=>[]}), (e:any)=>e.status===400);
});

test('concurrent identical counts are coalesced only while in flight',async()=>{
  let calls=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const repository={count:async()=>{calls++;await gate;return calls;},findMany:async()=>[]};
  const pending=Array.from({length:8},()=>searchUsers({page:1,limit:10,email:'same'},repository));
  release();const results=await Promise.all(pending);
  assert.equal(calls,1,'one DB count per overlapping identical filter');
  assert.ok(results.every(r=>r.pagination.total===1));
  const next=await searchUsers({page:1,limit:10,email:'same'},repository);
  assert.equal(calls,2,'no completed count cache across requests');assert.equal(next.pagination.total,2);
});
test('count coalescing isolates repositories, filters and rejected promises',async()=>{
  let calls=0;const repository={count:async()=>{calls++;if(calls===1)throw new Error('retry');return calls;},findMany:async()=>[]};
  await assert.rejects(searchUsers({page:1,limit:10},repository));
  assert.equal((await searchUsers({page:1,limit:10},repository)).pagination.total,2);
  const other={count:async()=>99,findMany:async()=>[]};
  assert.equal((await searchUsers({page:1,limit:10},other)).pagination.total,99);
  await Promise.all(['a','b'].map(email=>searchUsers({page:1,limit:10,email},repository)));
  assert.equal(calls,4);
});
