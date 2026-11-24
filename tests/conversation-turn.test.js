const assert = require('node:assert/strict');
const { readTurn, keepTurnLocal, turnReplyGuide } = require('./build/assistant/conversationTurn.js');
const { lifeRuntime } = require('./build/assistant/lifeRuntime.js');
const { builtinConversationExamples, findBuiltinPersona } = require('./build/assistant/builtinPersonas.js');
const { rankMemories } = require('./build/assistant/memoryRank.js');
const now = Date.now();
const earlier = (role, content, ms = 1000) => ({ role, content, ts: now - ms });
const line = '这接口又炸了';
assert.equal(readTurn(line, [earlier('assistant', '饭还没吃完呢')], false, now).intent, 'open');
assert.equal(readTurn(line, [earlier('assistant', '贴一下报错日志')], false, now).intent, 'help');
assert.equal(readTurn(line, [earlier('assistant', '贴一下报错日志', 86_400_000)], false, now).intent, 'open');
assert.equal(readTurn(line, [], true, now).intent, 'help');
assert.equal(readTurn('哎，这个接口烦死了').intent, 'vent');
assert.equal(readTurn('这接口烦死了，怎么修？').intent, 'help');
assert.equal(readTurn('我只是吐槽，这报错真离谱').intent, 'vent');
assert.equal(readTurn('哈哈哈').intent, 'banter');
assert.equal(readTurn('行，先这样吧。').intent, 'close');
assert.notEqual(readTurn('行，先这样。对了，帮我看看日志').intent, 'close');
assert.notEqual(readTurn('行，先这样', [], true).intent, 'close');
assert.notEqual(readTurn('他说「行，先这样」').intent, 'close');
assert.match(turnReplyGuide('close'), /不追问/);
assert.match(turnReplyGuide('repair'), /没误会就别认/);
assert.equal(keepTurnLocal('repair'), true);
assert.equal(keepTurnLocal('help'), false);
const misunderstanding = '真是离谱';
const correction = '不是嫌你烦，我是在骂这个接口垃圾。';
const recent = [earlier('user', misunderstanding, 2000), earlier('assistant', '还以为你嫌我吵')];
const turn = readTurn(correction, recent, false, now);
assert.deepEqual(turn, { intent: 'repair', repairReason: misunderstanding });
assert.deepEqual(readTurn('你理解错了，我说的是另一个接口', recent, false, now), { intent: 'repair' });
assert.deepEqual(readTurn(correction, [earlier('user', misunderstanding)], false, now), { intent: 'repair' });
lifeRuntime.noteUserMessage('别的旧事很离谱', now - 60_000);
lifeRuntime.noteUserMessage(misunderstanding, now - 2000);
assert.equal(lifeRuntime.load(now).affect.length, 2);
lifeRuntime.noteUserMessage(correction, now, turn);
assert.deepEqual(lifeRuntime.load(now).affect.map(e => e.reason), ['别的旧事很离谱']);
assert.doesNotMatch(lifeRuntime.promptBlock(now, correction, 'repair'), /【话头】|【你今天在做的事】/);
lifeRuntime.noteUserMessage('你太蠢了，真笨', now);
assert.match(lifeRuntime.promptBlock(now, '为什么会这样？', 'help'), /值得说透/);
const fish = findBuiltinPersona('dafeiyu');
assert.match(builtinConversationExamples(fish.fields, fish.free), /收尾/);
assert.equal(builtinConversationExamples({...fish.fields, speech: '用我自己的口吻说'}, fish.free), '');
assert.equal(builtinConversationExamples(fish.fields, '我有自己的设定'), '');
assert.equal(builtinConversationExamples(findBuiltinPersona('blank').fields, ''), '');
const facts = [
  { id: 'cat', content: '用户养了一只橘猫', category: 'identity', importance: 1, lastUsedAt: now, createdAt: now },
  { id: 'api', content: '支付接口曾经返回错误码', category: 'event', importance: 2, lastUsedAt: now, createdAt: now },
];
assert.deepEqual(rankMemories(facts, { userText: '支付接口为什么失败', now }, { requireMatch: true }).map(m => m.entry.id), ['api']);
const greeted = [earlier('assistant', '【问候】改图链路盘清楚了，打算啥时候动真格的？')];
const progress = readTurn('这不是正在给你动刀子嘛', greeted, false, now);
assert.equal(progress.intent, 'progress');
assert.match(progress.replyToGreeting, /啥时候动真格/);
assert.match(turnReplyGuide(progress.intent, progress.replyToGreeting), /用户自己正在做的事/);
assert.match(turnReplyGuide(progress.intent, progress.replyToGreeting), /不能说是你动的手/);
assert.equal(lifeRuntime.promptBlock(now, '这不是正在给你动刀子嘛', progress.intent), '');
assert.equal(keepTurnLocal(progress.intent), true);
assert.notEqual(readTurn('这不是正在给你动刀子嘛', [], false, now).intent, 'progress');
assert.notEqual(readTurn('这不是正在给你动刀子嘛', [earlier('assistant', greeted[0].content, 86_400_000)], false, now).intent, 'progress');
console.log('conversation-turn: pass');

{
  const { advanceRegister, conversationReplyReminder } = require('./build/assistant/conversationRegister.js');
  let state = 'default';
  const send = (text, closing = false) => {
    const turn = advanceRegister(state, text, closing);
    state = turn.next;
    return turn.forReply;
  };
  for (const line of ['你可以用文言文跟我讲话吗', '甚乖，吾欣慰哉', '重赏', '嗯？', '句式呢', '赏红烧肉之', '', '帮我查一下天气']) {
    assert.equal(send(line), 'classical', line);
    assert.match(conversationReplyReminder('', state), /整段都按文言句式/);
  }
  assert.equal(send('用白话翻译这一段'), 'classical');
  assert.equal(send('说白话吧'), 'plain');
  assert.equal(send('还有呢'), 'plain');
  assert.equal(send('换回文言文'), 'classical');
  assert.equal(send('别再用文言文了'), 'plain');
  assert.equal(send('接下来用文言和我聊天'), 'classical');
  assert.equal(send('拜拜', true), 'classical');
  assert.equal(state, 'default');
  for (const line of ['用文言文翻译这段', '文言文是什么？', '他说“用文言文跟我讲话”', '能用文言文写段自我介绍吗']) {
    assert.equal(send(line), 'default', line);
  }
  assert.match(conversationReplyReminder('ja', 'classical'), /必须用日语/);
  assert.doesNotMatch(conversationReplyReminder('ja', 'classical'), /文体约定/);
  assert.match(conversationReplyReminder('zh-cn', 'plain'), /现代汉语白话/);
  assert.equal(conversationReplyReminder('', 'default'), '');
}
