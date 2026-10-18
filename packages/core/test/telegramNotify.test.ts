import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GOOGLE_SHEET_ID ||= 'notification-test';
const { sendTelegramMessage } = await import('../src/telegramNotify.js');

test('rejected Markdown in TEST_ADMIN falls back to exact plain text and retains report button', async t => {
  const requests: any[] = [];
  const text = '🆕 *Новий звіт на підтвердження*\n👤 Бригадир: TEST_ADMIN\n📍 Обʼєкти: [об’єкт]_*';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    return requests.length === 1
      ? new Response(JSON.stringify({ok:false,description:"Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 86"}), {status:400})
      : new Response('{"ok":true}');
  });
  await sendTelegramMessage(123, text, {buttons:[[{text:'📄 Відкрити звіт',webAppUrl:'https://example.com/?approveDate=2026-10-18'}]]});
  assert.equal(requests.length, 2);
  assert.equal(requests[0].parse_mode, 'Markdown');
  assert.equal('parse_mode' in requests[1], false);
  assert.equal(requests[1].text, text);
  assert.equal(requests[1].chat_id, 123);
  assert.deepEqual(requests[1].reply_markup,requests[0].reply_markup);
  assert.equal(requests[1].reply_markup.inline_keyboard[0][0].web_app.url,'https://example.com/?approveDate=2026-10-18');
});

test('successful formatted messages are sent only once', async t => {
  const send = t.mock.method(globalThis, 'fetch', async () => new Response('{"ok":true}'));
  await sendTelegramMessage(123, '✅ *День затверджено*');
  assert.equal(send.mock.callCount(), 1);
});

test('other API rejections and ambiguous network failures never trigger duplicate retries', async t => {
  t.mock.method(console, 'log', () => {});
  for (const failure of [new Response('Bad Request: chat not found',{status:400}),new Response('Forbidden: bot was blocked',{status:403}),new Response('Internal Server Error',{status:500}),new Error('network')]) {
    const send = t.mock.method(globalThis, 'fetch', async () => {if(failure instanceof Error)throw failure;return failure;});
    await sendTelegramMessage(123,'TEST_ADMIN');
    assert.equal(send.mock.callCount(),1);
    send.mock.restore();
  }
});

test('failed plain-text fallback is bounded and logged', async t => {
  const log = t.mock.method(console, 'log', () => {});
  const send = t.mock.method(globalThis, 'fetch', async () => new Response("Bad Request: can't parse entities",{status:400}));
  await sendTelegramMessage(123,'TEST_ADMIN');
  assert.equal(send.mock.callCount(),2);
  assert.equal(log.mock.callCount(),1);
  assert.match(String(log.mock.calls[0].arguments[0]),/sendMessage failed chatId=123 status=400/);
});
