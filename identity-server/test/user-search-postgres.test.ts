import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { searchUsers } from '../src/users/search.js';

// Opt-in requires an independently provisioned, exclusive test database/schema.
// This suite never creates databases, migrates, or deletes rows outside its IDs.
test('PostgreSQL literal filter, stable ordering, pagination and projection', {
  skip: process.env.VT113_ISOLATED_TEST_DB !== 'confirmed',
}, async () => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.match(decodeURIComponent(url.pathname), /_test$/i);
  const { getPrisma, disconnectPrisma } = await import('../src/db/prisma.js');
  const prisma = getPrisma();
  const run = randomUUID();
  const ids = Array.from({length:11},()=>randomUUID()).sort();
  const stamp = new Date('2026-01-01T00:00:00.000Z');
  const marker = `vt113-${run}`;
  try {
    await prisma.user.createMany({data:ids.map((id,index)=>({
      id, email:`${marker}-${index}-MiX_%\\@example.test`, passwordHash:'not-a-real-password-hash',
      createdAt:index===10 ? new Date('2026-01-02T00:00:00.000Z') : stamp,
    })).reverse()});
    const expected = [ids[10],...ids.slice(0,10)];
    const pages = [];
    for (const page of [1,2,3]) {
      const result = await searchUsers({page,limit:10,email:`  ${marker.toUpperCase()}  `},prisma.user);
      assert.deepEqual(result.pagination,{page,limit:10,total:11,totalPages:2});
      assert.deepEqual(result.data.map(row=>row.id),expected.slice((page-1)*10,page*10));
      for(const row of result.data) assert.deepEqual(Object.keys(row).sort(),['createdAt','email','id']);
      pages.push(result.data.length);
    }
    assert.deepEqual(pages,[10,1,0]);
    const literal = await searchUsers({page:1,limit:50,email:`${marker}-0-mix_%\\`},prisma.user);
    assert.equal(literal.pagination.total,1);
    assert.equal(literal.data[0].id,ids[0]);
    const empty = await searchUsers({page:1,limit:10,email:`absent-${run}`},prisma.user);
    assert.deepEqual(empty.pagination,{page:1,limit:10,total:0,totalPages:0});
    assert.deepEqual(empty.data,[]);
  } finally {
    try { await prisma.user.deleteMany({where:{id:{in:ids},email:{startsWith:marker}}}); }
    finally { await disconnectPrisma(); }
  }
});
