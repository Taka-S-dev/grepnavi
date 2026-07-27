const { test } = require('node:test');
const assert = require('node:assert/strict');
const { saveStateOf } = require('../static/js/project.js');

// 保存状態は3つある。旧 UI は下2つを同じ「無題 (graph.json)」で表示していたが、
// working は自動保存されていて安全、unsaved は保存先が無く閉じると失われる。
test('saveStateOf - 名前を付けて保存したファイルがある', () => {
  assert.deepEqual(saveStateOf('C:/w/srtp.json', 'C:/w/graph.json'),
    { kind: 'named', path: 'C:/w/srtp.json' });
});

test('saveStateOf - 名前は無いがサーバの作業ファイルがある', () => {
  assert.deepEqual(saveStateOf('', 'C:/w/graph.json'),
    { kind: 'working', path: 'C:/w/graph.json' });
});

test('saveStateOf - 保存先が無い (新規JSON / ルート切替の直後)', () => {
  assert.deepEqual(saveStateOf('', ''), { kind: 'unsaved', path: '' });
});

test('saveStateOf - 名前付きは作業ファイルより優先される', () => {
  assert.equal(saveStateOf('C:/w/a.json', 'C:/w/graph.json').kind, 'named');
});
