import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {asyncRouter} from '../src/asyncRouter.js';
import {ReservationConflictError,reservationConflictHandler,activeTripConflictMessage} from '../src/lib/reservationErrors.js';

test('old trip message contains its date and a short recovery instruction',()=>{
 const message=activeTripConflictMessage('2026-10-23','2026-10-27');
 assert.match(message,/23\.10\.2026/);assert.match(message,/адміністратора архівувати/);
 assert.doesNotMatch(activeTripConflictMessage(undefined,'2026-10-27'),/undefined|Invalid/);
 assert.match(activeTripConflictMessage('2026-10-27','2026-10-27'),/Відкрийте її/);
});
test('async reservation conflicts reach the client as 409, unknown errors stay generic',async()=>{
 const app=express(),router=asyncRouter();
 router.post('/conflict',async()=>{throw new ReservationConflictError(activeTripConflictMessage('2026-10-23','2026-10-27'));});
 router.post('/unknown',async()=>{throw new Error('private database details');});
 router.use(reservationConflictHandler);app.use(router);
 app.use(((_err:any,_req:any,res:any,_next:any)=>res.status(500).json({error:'Внутрішня помилка сервера'})));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 try {
 const url=`http://127.0.0.1:${(server.address() as any).port}`;
 const conflict=await fetch(url+'/conflict',{method:'POST'});assert.equal(conflict.status,409);assert.match((await conflict.json() as any).error,/23\.10\.2026/);
 const unknown=await fetch(url+'/unknown',{method:'POST'});assert.equal(unknown.status,500);assert.doesNotMatch(JSON.stringify(await unknown.json()),/private database/);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
