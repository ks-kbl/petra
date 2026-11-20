const assert = require('node:assert/strict');
const { loadMusicEvidence } = require('./build/music/musicEvidence.js');
(async () => {
  const track = { title: 'i walk this earth all by myself', artist: 'EKKSTACY', appId: 'QQMusic.exe', positionMs: 5500, durationMs: 150000 };
  const calls = [];
  const lyrics = async (...args) => {
    calls.push(args);
    return { lines: [{timeMs: 1000, text: 'first fixture'}, {timeMs: 5000, text: 'current fixture'}, {timeMs: 8000, text: 'next fixture'}] };
  };
  const current = await loadMusicEvidence(track, undefined, lyrics);
  assert.deepEqual(calls[0], [track.title, track.artist, track.durationMs, false, 'qq']);
  assert.equal(current.lyric, 'current fixture');
  assert.match(current.lyricContext, /next fixture/);
  const withoutPosition = await loadMusicEvidence({ ...track, positionMs: 0 }, undefined, lyrics);
  assert.equal(withoutPosition.lyric, undefined);
  assert.match(withoutPosition.lyricContext, /first fixture/);
  const unavailable = await loadMusicEvidence(track, undefined, async () => { throw new Error('offline'); });
  assert.equal(unavailable.lyricStatus, 'error');
  assert.equal(unavailable.title, track.title);
  assert.equal((await loadMusicEvidence(track, 'already synced', lyrics)).lyric, 'already synced');
  console.log('music-evidence: all assertions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
