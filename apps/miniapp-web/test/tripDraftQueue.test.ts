import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TripDraftQueue} from '../src/lib/tripDraftQueue';
test('late save responses and failures belong only to their own record',async()=>{
 const q=new TripDraftQueue();q.remember('A',3);q.remember('B',8);
 let resolveA!:(r:{revision:number})=>void;
 const a=q.enqueue('A',async base=>{assert.equal(base,3);return new Promise<{revision:number}>(r=>{resolveA=r;});});
 await Promise.resolve();
 await q.enqueue('B',async base=>{assert.equal(base,8);return {revision:9};});
 resolveA({revision:4});await a;
 assert.equal(q.revision('A'),4);assert.equal(q.revision('B'),9);
 await assert.rejects(q.enqueue('A',async()=>{throw new Error('conflict');}));
 await q.flush('B');await assert.rejects(q.flush('A'));
});
test('same-record queued writes wait for acknowledgement; a failed save blocks only that record',async()=>{
 const q=new TripDraftQueue();let called=0;
 await Promise.all(Array.from({length:15},()=>q.enqueue('A',async base=>{called++;return {revision:base+1};})));
 assert.equal(called,15);assert.equal(q.revision('A'),15);
 await assert.rejects(q.enqueue('A',async()=>{throw new Error('network');}));
 await assert.rejects(q.enqueue('A',async()=>{assert.fail('must not overwrite after conflict');}));
 q.retry('A');await q.enqueue('A',async base=>({revision:base+1}));
 assert.equal(q.revision('A'),16);
});
