const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assignTreeMemos, groupLooseMemos: _group } = require('../static/js/graph.js');
const { nodeDir } = require('../static/js/utils.js');
// 帯の鍵は utils.js の nodeDir。ブラウザではグローバル、テストでは渡す
const groupLooseMemos = (loose, spanOf, root) => _group(loose, spanOf, root, nodeDir);

// 行メモを「同じファイル・同じ関数の中の、直近上のノード」へ結ぶ。
// 関数範囲は ctags 由来で、テストでは表で与える。
const SPANS = {
  'c:/p/ssl/record/rec_layer_s3.c': [
    { name: 'ssl3_read_bytes', start_line: 1217, end_line: 1290 },
    { name: 'ssl3_get_record', start_line: 1302, end_line: 1400 },
  ],
  'c:/p/ssl/ssl_lib.c': [{ name: 'SSL_read', start_line: 1775, end_line: 1790 }],
};
const spanOf = (file, line) => {
  const list = SPANS[file.replace(/\\/g, '/').toLowerCase()] || [];
  return list.find((s) => s.start_line <= line && line <= s.end_line) || null;
};
const memo = (file, line, text) => ({ key: file + '::' + line, file, line, end_line: line, text, category: '', source: '' });

test('assignTreeMemos - 関数の中のメモはその関数のノードに付く', () => {
  const nodes = [{ id: 'n1', file: 'C:/p/ssl/record/rec_layer_s3.c', line: 1217 }];
  const r = assignTreeMemos([memo('C:/p/ssl/record/rec_layer_s3.c', 1250, 'x')], nodes, spanOf);
  assert.deepEqual([...r.byNode.keys()], ['n1']);
  assert.equal(r.loose.length, 0);
});

// 同じ関数に呼び出し行のノードが複数あるとき (呼び出し木の子は呼び出し元の行に置く)、
// メモは直近上のノードに付く。関数のどのノードより上なら、いちばん上のノード。
test('assignTreeMemos - 同じ関数に複数ノードがあれば直近上のノード', () => {
  const f = 'C:/p/ssl/record/rec_layer_s3.c';
  const nodes = [
    { id: 'a', file: f, line: 1230 },
    { id: 'b', file: f, line: 1260 },
  ];
  const r = assignTreeMemos([memo(f, 1265, 'after-b'), memo(f, 1240, 'after-a'), memo(f, 1220, 'top')], nodes, spanOf);
  assert.deepEqual(r.byNode.get('b').map((m) => m.text), ['after-b']);
  assert.deepEqual(r.byNode.get('a').map((m) => m.text), ['top', 'after-a']);
});

// 隣の関数のノードに付いてはいけない。関数の外 (グローバル) のメモも付かない。
test('assignTreeMemos - 別の関数・関数外・別ファイルは loose', () => {
  const f = 'C:/p/ssl/record/rec_layer_s3.c';
  const nodes = [{ id: 'n1', file: f, line: 1217 }];
  const r = assignTreeMemos(
    [memo(f, 1310, 'next-func'), memo(f, 1295, 'between'), memo('C:/p/ssl/ssl_lib.c', 1780, 'other-file')],
    nodes, spanOf,
  );
  assert.equal(r.byNode.size, 0);
  assert.deepEqual(r.loose.map((m) => m.text), ['next-func', 'between', 'other-file']);
});

test('assignTreeMemos - パスの区切りと大小は無視', () => {
  const nodes = [{ id: 'n1', file: 'C:\\p\\ssl\\ssl_lib.c', line: 1775 }];
  const r = assignTreeMemos([memo('c:/p/SSL/ssl_lib.c', 1780, 'x')], nodes, spanOf);
  assert.equal(r.byNode.get('n1').length, 1);
});

// ノード外のメモは ディレクトリ → ファイル → 関数 でまとめ、パス順・行順に並ぶ。
test('groupLooseMemos - ファイル → 関数で畳み、関数外は見出し無し', () => {
  const rec = 'C:/p/ssl/record/rec_layer_s3.c';
  const lib = 'C:/p/ssl/ssl_lib.c';
  const g = groupLooseMemos(
    [memo(lib, 1780, 'l'), memo(rec, 1350, 'r2'), memo(rec, 1220, 'r1'), memo(rec, 1295, 'gap')],
    spanOf, 'C:/p',
  );
  assert.deepEqual(g.map((f) => f.file), [rec, lib]);
  assert.deepEqual(g.map((f) => f.dir), ['ssl/record', 'ssl']);
  assert.deepEqual(g[0].funcs.map((fn) => fn.name), [null, 'ssl3_read_bytes', 'ssl3_get_record']);
  assert.deepEqual(g[0].funcs.map((fn) => fn.memos.map((m) => m.text)), [['gap'], ['r1'], ['r2']]);
  assert.equal(g[1].funcs[0].name, 'SSL_read');
});

// 関数範囲がまだ届いていない (spanOf が常に null) ときも落ちず、ファイル直下に出る。
test('groupLooseMemos - 関数範囲が無くてもファイル単位で出る', () => {
  const g = groupLooseMemos([memo('C:/p/x/a.c', 10, 'm')], () => null, 'C:/p');
  assert.equal(g.length, 1);
  assert.equal(g[0].funcs[0].name, null);
  assert.equal(g[0].funcs[0].memos[0].text, 'm');
});
