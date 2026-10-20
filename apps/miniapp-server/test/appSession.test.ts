import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import express from 'express';
import {appSessionCodec, SESSION_COOKIE, SESSION_IDLE_SECONDS, SESSION_MAX_SECONDS} from '../src/lib/appSession.js';

test('session signatures reject tampering, expiry and another signing key; renewal has an absolute limit',()=>{
  const sessions=appSessionCodec('test-session-key'), now=1000000;
  const first=sessions.issue(7,now);
  assert.equal(sessions.read(first,now+25*3600)?.userId,7);
  assert.equal(sessions.read(first+'x',now),null);
  assert.equal(appSessionCodec('other-key').read(first,now),null);
  assert.equal(sessions.read(first,now+SESSION_IDLE_SECONDS),null);
  const renewed=sessions.issue(7,now+SESSION_MAX_SECONDS-60,now);
  assert.equal(sessions.read(renewed,now+SESSION_MAX_SECONDS-1)?.expiresAt,now+SESSION_MAX_SECONDS);
  assert.equal(sessions.read(renewed,now+SESSION_MAX_SECONDS),null);
});

test('real auth HTTP: expired Telegram data uses renewed session; roles and revocation stay live; cookie writes require same-origin custom header',async t=>{
  process.env.GOOGLE_SHEET_ID='test-only';process.env.DATABASE_URL='postgres://unused:unused@localhost:1/unused';process.env.BOT_TOKEN='test-auth-token';
  const {createTelegramAuth}=await import('../src/authMiddleware.js');
  const {validateInitData}=await import('../../../packages/core/src/telegramAuth.js');
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  let active=true,role='БРИГАДИР';
  const initData=(id:number,age=0)=>{
    const p=new URLSearchParams({auth_date:String(Math.floor(now/1000)-age),user:JSON.stringify({id,first_name:'Test'})});
    const text=[...p.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
    const key=createHmac('sha256','WebAppData').update('test-auth-token').digest();
    p.set('hash',createHmac('sha256',key).update(text).digest('hex'));return p.toString();
  };
  const app=express();app.use(createTelegramAuth({secret:'test-auth-token',validate:validateInitData,findUser:async id=>({tgId:BigInt(id),pib:'Test',role,active})}));
  app.all('/me',(req,res)=>res.json(req.user));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const host=`127.0.0.1:${(server.address() as any).port}`,url=`http://${host}/me`;
  try {
    const telegram=initData(7);
    const first=await fetch(url,{headers:{'x-telegram-init-data':telegram}});
    assert.equal(first.status,200);
    const setCookie=first.headers.get('set-cookie')!;
    for(const flag of ['HttpOnly','Secure','SameSite=None','Partitioned','Path=/'])assert.ok(setCookie.includes(flag));
    let cookie=setCookie.split(';')[0];assert.ok(cookie.startsWith(SESSION_COOKIE+'='));
    now+=25*3600*1000;
    assert.equal(validateInitData(telegram),null);
    const resumed=await fetch(url,{headers:{cookie,'x-telegram-init-data':telegram}});
    assert.equal(resumed.status,200);assert.equal((await resumed.json()).tgId,7);
    cookie=resumed.headers.get('set-cookie')!.split(';')[0];
    // A second tab uses the same server session, not the age of its own Telegram launch data.
    assert.equal((await fetch(url,{headers:{cookie}})).status,200);
    role='АДМІН';assert.equal((await (await fetch(url,{headers:{cookie}})).json()).role,'ADMIN');
    assert.equal((await fetch(url,{method:'POST',headers:{cookie}})).status,403);
    assert.equal((await fetch(url,{method:'POST',headers:{cookie,'x-greenhand-client':'miniapp',origin:'https://other.example'}})).status,403);
    assert.equal((await fetch(url,{method:'POST',headers:{cookie,'x-greenhand-client':'miniapp',origin:`https://${host}`}})).status,200);
    const switched=await fetch(url,{headers:{cookie,'x-telegram-init-data':initData(8)}});
    assert.equal((await switched.json()).tgId,8);
    active=false;assert.equal((await fetch(url,{headers:{cookie}})).status,403);
    active=true;
    assert.equal((await fetch(url,{headers:{cookie:cookie+'x'}})).status,401);
    now+=(SESSION_IDLE_SECONDS+1)*1000;
    assert.equal((await fetch(url,{headers:{cookie,'x-telegram-init-data':telegram}})).status,401);
    assert.equal((await fetch(url,{headers:{'x-telegram-init-data':initData(7,25*3600)}})).status,401);
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
