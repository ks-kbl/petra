const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, dependencies, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { exports, require: id => {
    assert.ok(id in dependencies, `Unexpected import: ${id}`);
    return dependencies[id];
  }, ...globals });
  return exports;
}
(async () => {
  const settings = { asr: { cloudFirst: true }, assistant: { provider: 'deepseek', activePresetId: '' } };
  const calls = [];
  const api = { invoke: async (command, args) => { calls.push({ command, ...args }); return 'test-key'; } };
  const key = load('src/assistant/apiKey.ts', {
    '@tauri-apps/api/core': api, '../utils/settings': { loadSettings: () => settings },
  });
  await key.setApiKey('one');
  assert.equal(calls.at(-1).scope, 'deepseek');
  settings.assistant.provider = 'openai';
  await key.getApiKey();
  assert.equal(calls.at(-1).scope, 'openai');
  settings.assistant.activePresetId = 'custom-one';
  await key.setApiKey('two');
  assert.equal(calls.at(-1).scope, 'preset:custom-one');
  await key.getApiKey();
  assert.equal(calls.at(-1).scope, 'preset:custom-one');
  settings.assistant.activePresetId = '';
  await key.getApiKey();
  assert.equal(calls.at(-1).scope, 'openai');

  // Exercise the real panel patch handler against persisted state and model bounds.
  const mainSource = ts.createSourceFile('main.ts', fs.readFileSync('src/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const html = fs.readFileSync('src-tauri/panel/index.html', 'utf8');
  const persona = html.slice(html.indexOf('id: "persona", label: "人设"'), html.indexOf('id: "voice", label: "语音"'));
  assert.match(persona, /type: "personapresets"/);
  assert.doesNotMatch(persona, /type: "presets"|含API/);
  const voice = html.indexOf('id: "voice", label: "语音"');
  const fun = html.indexOf('id: "fun", label: "娱乐"');
  assert.match(html.slice(voice, fun), /type: "ttsprobe"/, '语音自检归语音页');
  assert.equal((html.match(/type: "ttsprobe"/g) || []).length, 1);
  const posted = [];
  let probeState;
  const probeCtx = vm.createContext({
    renderTtsProbeStatus() {}, ttsProbeUI: { id: '', message: '', error: false },
    api: async (url, opts) => {
      if (url === '/api/action') {
        const action = JSON.parse(opts.body);
        posted.push(action);
        probeState = { id: action.payload?.requestId, status: 'error', message: '请先填写音色 ID' };
        return {};
      }
      assert.equal(url, '/api/state');
      return { meta: { ttsProbe: probeState } };
    },
  });
  const probeStart = html.indexOf('  async function runTtsProbe(');
  vm.runInContext(html.slice(probeStart, html.indexOf('  function ttsProbeCard(', probeStart)), probeCtx);
  await probeCtx.runTtsProbe('切，你听见了吧？', false);
  assert.equal(posted[0].id, '__data:tts-probe');
  assert.equal(posted[0].payload.text, '切，你听见了吧？');
  assert.equal(posted[0].payload.prosody, false);
  assert.equal(probeCtx.ttsProbeUI.message, '请先填写音色 ID');
  assert.equal(probeCtx.ttsProbeUI.error, true);

  const selected = new Set(['deepAssign', 'applyPanelPatch']);
  const functions = mainSource.statements.filter(n => ts.isFunctionDeclaration(n) && selected.has(n.name?.text)).map(n => n.getText(mainSource)).join('\n');
  let stored = { assistant: { provider: 'deepseek', customBaseUrl: '', model: 'old-model', activePresetId: 'saved', presets: [] }, boundsPaddings: { A: { left: 10, right: 20, top: 0, bottom: 0 }, B: { left: 30, right: 40, top: 0, bottom: 0 } }, fileDenyPaths: ['/keep'] };
  const ctx = vm.createContext({
    settings: null, loadSettings: () => structuredClone(stored),
    saveSettingsRaw: value => { stored = structuredClone(value); },
    panelAssistantModels: ['old-model'], clearPetTalkKeyCache() {}, clearApiKeyCache() {},
    normalizeOpenAIBase: key.normalizeOpenAIBase, invoke: async () => {},
    schedulePanelSync() {}, toast() {}, lastPanelToastAt: 0, PANEL_FIELD_LABELS: {},
    currentBoundsPadding: () => ctx.settings.boundsPaddings.A,
    setCurrentBoundsPadding: value => { ctx.settings.boundsPaddings.A = value; },
  });
  vm.runInContext(ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, ctx);
  await ctx.applyPanelPatch({ assistant: { provider: 'openai' } });
  assert.equal(stored.assistant.activePresetId, '');
  assert.equal(stored.assistant.model, '');
  assert.deepEqual(stored.fileDenyPaths, ['/keep'], 'unrelated persisted settings survive');
  await ctx.applyPanelPatch({ boundsPadding: { left: 15 } });
  assert.equal(stored.boundsPaddings.A.left, 15);
  assert.equal(stored.boundsPaddings.A.right, 20);
  assert.equal(stored.boundsPaddings.B.left, 30, 'other model bounds remain unchanged');

  const logic = load('src/asr/asrLogic.ts', {});
  const wakeGate = { holdWake: () => {}, releaseWake: () => {}, wakeHeld: () => false };
  const asr = load('src/asr/SpeechRecognizer.ts', {
    '@tauri-apps/api/core': api, './asrLogic': logic,
    '../utils/settings': { loadSettings: () => settings },
    '../audio/wakeGate': wakeGate,
  }, { window: { SpeechRecognition: function() {} } });
  const recognizer = asr.getSpeechRecognizer();
  assert.equal(recognizer.needsApiKey(), true);
  settings.asr.cloudFirst = false;
  assert.equal(asr.getSpeechRecognizer(), recognizer);
  assert.equal(recognizer.needsApiKey(), false);
  let started;
  recognizer.startWebSpeech = () => { started = 'web-speech'; };
  recognizer.startSiliconFlow = async () => { started = 'siliconflow'; };
  recognizer.start();
  assert.equal(started, 'web-speech');
  settings.asr.cloudFirst = true;
  recognizer.start();
  assert.equal(started, 'siliconflow');
  recognizer.active = true;
  settings.asr.cloudFirst = false;
  assert.equal(recognizer.getBackendName(), 'siliconflow', 'active recording must retain its backend');
  recognizer.active = false;
  assert.equal(recognizer.getBackendName(), 'web-speech');
  // 原生识别冷却期内 → 回落到云端（需要 Key）
  recognizer.webSpeechRetryAt = Date.now() + 60 * 1000;
  assert.equal(recognizer.needsApiKey(), true, 'broken native backend must still fall back');
  // 冷却到期后自动恢复原生识别 —— 不再"一次失败就整场会话放弃"
  recognizer.webSpeechRetryAt = Date.now() - 1;
  assert.equal(recognizer.needsApiKey(), false, 'native backend must recover after cooldown');
  console.log('panel-regressions: all assertions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
