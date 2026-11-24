const assert = require('node:assert/strict');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const { applyReflection, consolidateMemories, explicitMemory, legacyMemories, parseReflection, recallLongMemory, safeEvidence } = require('./build/assistant/longTermMemory.js');
const entries = legacyMemories([{ id: 'current', content: '平时开发迭代运行 npm run tauri dev，不用打包', category: 'preference', source: 'user_said', importance: 1 }], ['去年交了一篇论文'], 10);
assert.equal(entries.length, 2);
assert.equal(entries.find(e => e.id === 'current').status, 'active');
assert.equal(recallLongMemory(entries, '').length, 0);
assert.equal(recallLongMemory(entries, '', true)[0].id, 'current');
assert.equal(recallLongMemory(entries, '论文', false).length, 0);
assert.equal(recallLongMemory(entries, '论文', false, true).length, 1);
assert.deepEqual(explicitMemory('记住这个'), { intent: 'remember', content: '', rule: false });
assert.equal(explicitMemory('以后都用开发实例验证').rule, true);
assert.equal(explicitMemory('他问能不能记住这件事'), null);
assert.equal(safeEvidence('验证码：123456'), false);

const correction = { id: 2, body: { text: '刚才那个不对，改成使用 npm run dev:alt 验证', intent: 'correction', at: 40 } };
const change = { op: 'update', id: 'current', content: '开发迭代使用 npm run dev:alt 验证', evidenceId: 2, quote: '使用 npm run dev:alt 验证' };
const rows = applyReflection(entries, entries, [correction], [change], 50, () => 'new');
assert.equal(rows[0].status, 'superseded');
assert.equal(rows[1].supersedes, 'current');
assert.equal(rows[1].corrected, true);
assert.equal(recallLongMemory(rows, '开发迭代验证', true)[0].id, 'new');
assert.ok(recallLongMemory(rows, 'tauri dev', true, true).every(e => e.id !== 'current'));
assert.deepEqual(applyReflection(entries, entries, [correction], [{ ...change, quote: '助手猜的' }], 50, () => 'new'), []);
assert.deepEqual(applyReflection(entries, entries, [{ ...correction, body: { ...correction.body, intent: 'normal' } }], [change], 50, () => 'new'), []);
assert.deepEqual(applyReflection([], [], [{ id: 1, body: { text: '用文言文和我聊天', intent: 'normal', at: 45 } }], [{ op: 'add', evidenceId: 1, quote: '文言文', content: '偏好用文言文' }], 50, () => 'x'), []);
assert.equal(parseReflection('坏响应'), null);
assert.deepEqual(parseReflection('{"ops":[]}'), []);
assert.deepEqual(consolidateMemories([rows[1], { ...rows[1], id: 'duplicate', corrected: false, source: 'ai_inferred' }], 60).map(e => e.id), ['duplicate']);

(async () => {
  // 模拟 IPC 持久层：验证失败不消费、成功与写入一次提交、重载后可见。
  let store = { revision: 1, dreamRevision: 0, entries: [] };
  let jobs = [{ id: 1, body: { text: '记住，平时迭代不用打包', intent: 'remember', at: 10 } }];
  const original = Module._load;
  global.localStorage = { getItem: () => null };
  if (!global.crypto) global.crypto = { randomUUID };
  Module._load = function (name, ...args) {
    if (name !== '@tauri-apps/api/core') return original.call(this, name, ...args);
    return { invoke: async (cmd, args) => {
      if (cmd === 'debug_mark') return;
      if (cmd === 'memory_load') return structuredClone(store);
      if (cmd === 'memory_pending_corrections') return jobs.filter(j => j.body.intent === 'correction');
      if (cmd === 'memory_pending') return structuredClone(jobs);
      if (cmd === 'memory_commit') {
        const { revision, entries, done, dream } = args.change;
        if (revision !== store.revision || done.some(id => !jobs.some(j => j.id === id))) return false;
        const next = new Map(store.entries.map(e => [e.id, e]));
        entries.forEach(e => next.set(e.id, e));
        store.entries = [...next.values()];
        store.revision += Number(entries.length > 0);
        if (dream) store.dreamRevision = store.revision;
        jobs = jobs.filter(j => !done.includes(j.id));
        return true;
      }
      throw Error(cmd);
    } };
  };
  const path = './build/assistant/memoryBackground.js';
  try {
    let module = require(path);
    assert.ok(await module.writeExplicitMemory(jobs[0]));
    assert.equal(jobs.length, 0);
    delete require.cache[require.resolve(path)];
    module = require(path);
    assert.match((await module.loadLongMemory()).entries[0].content, /不用打包/);
    jobs = [{ id: 2, body: { text: '普通闲聊', intent: 'normal', at: 20 } }];
    const cancel = new AbortController();
    await assert.rejects(module.reflectInBackground(async () => { throw Error('离线'); }, cancel.signal));
    assert.equal(jobs.length, 1);
    await assert.rejects(module.reflectInBackground(async () => '无效 JSON', cancel.signal));
    assert.equal(jobs.length, 1);
    assert.equal(await module.reflectInBackground(async () => '{"ops":[]}', cancel.signal), true);
    assert.equal(jobs.length, 0);
    // 重载后，待处理纠正只隐藏目标，另一个项目照常召回；新结论提交后替换旧版本。
    const first = { ...store.entries[0], id: 'atlas-old', content: '开发迭代使用 npm run tauri dev 验证', kind: 'rule', scope: 'project:atlas' };
    const other = { ...first, id: 'dusk', content: '开发迭代使用 pnpm test 验证', scope: 'project:dusk' };
    store.entries = [first, other];
    jobs = [{ id: 3, body: { text: '刚才那个不对，改成 npm run dev 验证', intent: 'correction', at: 40, scope: 'project:atlas', excludedIds: ['atlas-old'] } }];
    delete require.cache[require.resolve(path)];
    module = require(path);
    await module.loadLongMemory();
    assert.deepEqual(module.recallableMemories().map(e => e.id), ['dusk']);
    assert.equal(await module.reflectInBackground(async () => JSON.stringify({ ops: [{ op: 'update', evidenceId: 3,
      id: 'atlas-old', quote: 'npm run dev', content: '迭代用 npm run dev 验证' }] }), cancel.signal), true);
    assert.equal(jobs.length, 0);
    assert.deepEqual(recallLongMemory(module.recallableMemories(), '改完怎么验证', true, true, 'project:atlas').map(e => e.content), ['迭代用 npm run dev 验证']);
    assert.deepEqual(recallLongMemory(module.recallableMemories(), '改完怎么验证', true, true, 'project:dusk').map(e => e.id), ['dusk']);
    await module.dreamInBackground(cancel.signal);
    assert.equal(store.dreamRevision, store.revision);
  } finally { Module._load = original; }
  console.log('long-term-memory: pass');
})().catch(err => { console.error(err); process.exitCode = 1; });

// 有关联才暂缓；同内容、不同项目不是重复项，且不能跨项目更新。
{
  const { evidenceScope, namedMemoryScope, SESSION_ONLY } = require('./build/assistant/memoryScope.js');
  const { correctionTargets, canQueueEvidence } = require('./build/assistant/longTermMemory.js');
  const atlas = namedMemoryScope('项目 Atlas：改完怎么验证？');
  assert.equal(atlas, 'project:atlas');
  assert.equal(namedMemoryScope('「夜航」项目怎么跑'), 'project:夜航');
  assert.equal(namedMemoryScope('项目进度怎么样'), undefined);
  assert.equal(evidenceScope('这个项目以后不用打包'), SESSION_ONLY);
  assert.equal(evidenceScope('只在这次聊天里用文言', atlas), SESSION_ONLY);
  assert.equal(evidenceScope('以后所有项目都用这个规范', atlas), undefined);
  assert.equal(evidenceScope('按原定方式验证', atlas), atlas);
  const make = (id, content, scope) => ({ ...entries.find(e => e.id === 'current'), id, content, scope, kind: 'rule' });
  const dusk = 'project:dusk';
  const set = [make('base', '默认称老大'), make('a1', '开发迭代用 npm run tauri dev 验证', atlas), make('b1', '开发迭代用 pnpm test 验证', dusk)];
  const q = '改完怎么验证';
  assert.deepEqual(new Set(recallLongMemory(set, q, true, false, atlas).map(e => e.id)), new Set(['a1', 'base']));
  assert.deepEqual(new Set(recallLongMemory(set, q, true, false, dusk).map(e => e.id)), new Set(['b1', 'base']));
  assert.deepEqual(recallLongMemory(set, q, true).map(e => e.id), ['base']);
  const body = { ...correction.body, text: '刚才那个不对，改成 npm run dev 验证', reference: set[1].content, scope: atlas };
  assert.deepEqual(correctionTargets(set, body), ['a1']);
  assert.deepEqual(correctionTargets(set, { ...body, text: '刚才那个不对', reference: undefined }), []);
  assert.deepEqual(applyReflection(set, set, [{ id: 2, body }], [{ ...change, id: 'b1', quote: 'npm run dev' }], 50, () => 'no'), []);
  assert.deepEqual(consolidateMemories([set[1], { ...set[1], id: 'same-in-dusk', source: 'ai_inferred', scope: dusk }], 50), []);
  for (const line of ['嗯？', '哈哈', '收到。']) assert.equal(canQueueEvidence(line, 'normal'), false);
}
