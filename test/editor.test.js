const { test } = require('node:test');
const assert = require('node:assert/strict');

// setup.js (--require) で browser globals をスタブ済み
global.id = () => null;

const { statusGate, fzfMatchToken, fzfScore, fzfFilter, buildDefinitionParams, extractFuncName, _isDefAnchored, hasInternalEditorPane } = require('../static/js/editor.js');

test('fzfMatchToken - exact match', () => {
  const r = fzfMatchToken('foobar', 'foo');
  assert.ok(r !== null);
  assert.ok(r.score > 0);
});

test('fzfMatchToken - no match', () => {
  assert.equal(fzfMatchToken('foobar', 'xyz'), null);
});

test('fzfMatchToken - consecutive chars score higher', () => {
  const consecutive = fzfMatchToken('foobar', 'foo');
  const scattered   = fzfMatchToken('fxoxo', 'foo');
  assert.ok(consecutive.score > scattered.score);
});

test('fzfScore - single token match', () => {
  assert.ok(fzfScore('src/main.c', 'main') > 0);
});

test('fzfScore - multi token AND', () => {
  assert.ok(fzfScore('src/main.c', 'src main') > 0);
});

test('fzfScore - token not found returns -1', () => {
  assert.equal(fzfScore('src/main.c', 'xyz'), -1);
});

test('fzfScore - empty query returns 0', () => {
  assert.equal(fzfScore('src/main.c', ''), 0);
});

test('fzfFilter - returns top N results', () => {
  const files = ['a.c', 'b.c', 'c.c', 'd.c', 'e.c'];
  const result = fzfFilter(files, '', 3);
  assert.equal(result.length, 3);
});

test('fzfFilter - filters and sorts by score', () => {
  const files = ['openssl/bio.c', 'openssl/ssl.c', 'curl/easy.c'];
  const result = fzfFilter(files, 'ssl', 10);
  assert.ok(result.every(f => f.includes('ssl')));
});

test('fzfFilter - no match returns empty', () => {
  const result = fzfFilter(['a.c', 'b.c'], 'xyz', 10);
  assert.equal(result.length, 0);
});

test('buildDefinitionParams - basic', () => {
  const p = buildDefinitionParams('foo', '', '', false);
  assert.ok(p.get('q').includes('foo'));
  assert.equal(p.get('regex'), '1');
  assert.equal(p.get('case'), '0');
});

test('buildDefinitionParams - case sensitive', () => {
  const p = buildDefinitionParams('Foo', '', '', true);
  assert.equal(p.get('case'), '1');
});

test('buildDefinitionParams - with dir and glob', () => {
  const p = buildDefinitionParams('bar', 'src', '*.h', false);
  assert.equal(p.get('dir'), 'src');
  assert.equal(p.get('glob'), '*.h');
});

test('buildDefinitionParams - escapes regex special chars', () => {
  const p = buildDefinitionParams('foo.bar', '', '', false);
  assert.ok(p.get('q').includes('foo\\.bar'));
});

// ----- extractFuncName -----
// call ↔ def sync の起点。label 形式が崩れると黙って sync が動かなくなる ため
// パターンごとに固定しておく。

test('extractFuncName - simple identifier', () => {
  assert.equal(extractFuncName('foo'), 'foo');
});

test('extractFuncName - <word>:<line> label form', () => {
  // 末尾 `:<line>` 形式の label から関数名を抽出する。
  // 取りこぼすと call ↔ def sync 装飾が全 ノード で動かなくなる。
  assert.equal(extractFuncName('ceph_inc_mds_stopping_blocker:51'), 'ceph_inc_mds_stopping_blocker');
  assert.equal(extractFuncName('foo:42'), 'foo');
});

test('extractFuncName - function call form', () => {
  assert.equal(extractFuncName('foo(args)'), 'foo');
});

test('extractFuncName - skip control keywords', () => {
  assert.equal(extractFuncName('if (foo(x))'), 'foo');
  assert.equal(extractFuncName('while (bar())'), 'bar');
});

test('extractFuncName - nested calls picks leftmost', () => {
  assert.equal(extractFuncName('a = b(c())'), 'b');
});

test('extractFuncName - method-like call', () => {
  assert.equal(extractFuncName('obj->method()'), 'method');
});

test('extractFuncName - returns null for empty / non-identifier', () => {
  assert.equal(extractFuncName(''), null);
  assert.equal(extractFuncName(null), null);
  assert.equal(extractFuncName(':42'), null);
  assert.equal(extractFuncName('123'), null);
});

test('extractFuncName - identifier with line plus call form still works', () => {
  // 「label を編集して `<word>:<line> ...` の後ろに何か足した」ケースは対象外
  // (この時は最初の identifier を func 名とみなす)
  assert.equal(extractFuncName('foo(x):42'), 'foo');
});

// ----- _isDefAnchored (逆方向 sync の対象判定) -----
test('_isDefAnchored - match and _def on same line = def pin', () => {
  assert.equal(_isDefAnchored({
    match: { file: 'C:\\src\\recipe.c', line: 42 },
    _def:  { file: 'C:\\src\\recipe.c', line: 42 },
  }), true);
});

test('_isDefAnchored - call site pin (different line) is not def-anchored', () => {
  assert.equal(_isDefAnchored({
    match: { file: 'C:\\src\\main.c',   line: 10 },
    _def:  { file: 'C:\\src\\recipe.c', line: 42 },
  }), false);
  assert.equal(_isDefAnchored({
    match: { file: 'C:\\src\\recipe.c', line: 10 },
    _def:  { file: 'C:\\src\\recipe.c', line: 42 },
  }), false);
});

test('_isDefAnchored - unresolved / failed resolve is not def-anchored', () => {
  assert.equal(_isDefAnchored({ match: { file: 'C:\\a.c', line: 1 } }), false);
  assert.equal(_isDefAnchored({ match: { file: 'C:\\a.c', line: 1 }, _def: null }), false);
  assert.equal(_isDefAnchored(null), false);
});

test('_isDefAnchored - path separators and case are normalized', () => {
  assert.equal(_isDefAnchored({
    match: { file: 'C:/src/Recipe.c',   line: 42 },
    _def:  { file: 'c:\\src\\recipe.c', line: 42 },
  }), true);
});

// 内蔵エディタのペインが無い窓（?mode=search 等）では、内蔵タブを開いても
// display:none の裏に積まれるだけになる。開き先の判断はこの1関数に寄せてある。
test('hasInternalEditorPane - 表示されているペインがあれば内蔵で開く', () => {
  const pane = {};
  global.pageMode = '';
  global.id = sel => (sel === 'pane-right' ? pane : null);
  global.getComputedStyle = el => (el === pane ? {display: 'flex'} : {display: 'none'});
  assert.equal(hasInternalEditorPane(), true);
});

test('hasInternalEditorPane - display:none のペインは無いものとして扱う', () => {
  const pane = {};
  global.pageMode = '';
  global.id = sel => (sel === 'pane-right' ? pane : null);
  global.getComputedStyle = () => ({display: 'none'});
  assert.equal(hasInternalEditorPane(), false);
});

// コールツリーは右ペインを使うので、ペインの有無だけでは用途を区別できない。
test('hasInternalEditorPane - 用途が決まっている窓では開かない', () => {
  global.pageMode = 'calltree';
  global.id = () => ({});
  global.getComputedStyle = () => ({display: 'flex'});
  assert.equal(hasInternalEditorPane(), false);
});

test('hasInternalEditorPane - ペイン自体が無い窓でも落ちない', () => {
  global.pageMode = '';
  global.id = () => null;
  global.getComputedStyle = () => { throw new Error('呼んではいけない'); };
  assert.equal(hasInternalEditorPane(), false);
});

// ---- 履歴の現在位置の追従 ----
// 履歴には到着した行が入る。そのファイル内でカーソルを動かしてから別へ飛ぶと、
// 直しておかないと「離れた場所」ではなく「着地点」に戻ってしまう。
const { syncedNavLine } = require('../static/js/editor.js');
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

test('syncedNavLine - 同じファイルでカーソルが動いていれば現在行を返す', () => {
  assert.equal(syncedNavLine({ file: 'a.c', line: 100 }, 'a.c', 500, same), 500);
});

test('syncedNavLine - 動いていなければ書き戻さない', () => {
  assert.equal(syncedNavLine({ file: 'a.c', line: 100 }, 'a.c', 100, same), 0);
});

test('syncedNavLine - 別のファイルを見ているときは触らない', () => {
  assert.equal(syncedNavLine({ file: 'a.c', line: 100 }, 'b.c', 500, same), 0);
});

test('syncedNavLine - 履歴が空・カーソル不明なら触らない', () => {
  assert.equal(syncedNavLine(undefined, 'a.c', 500, same), 0);
  assert.equal(syncedNavLine({ file: 'a.c', line: 100 }, 'a.c', 0, same), 0);
  assert.equal(syncedNavLine({ file: 'a.c', line: 100 }, '', 500, same), 0);
});

// ---- 参照一覧の絞り込み ----
// stat のようなありふれた名前は部分文字列ひとつでは絞りきれない。
// 語彙は grep の絞り込みバー・シンボルパネルと揃える。
const { refFilterPredicate } = require('../static/js/editor.js');
const row = (file, func, text) => ({ file, func, text });

test('refFilterPredicate - 空白区切りは AND', () => {
  const p = refFilterPredicate('crypto init');
  assert.ok(p(row('crypto/evp/e_aes.c', 'aes_init_key', 'x = 1;')));
  assert.ok(!p(row('crypto/evp/e_aes.c', 'aes_cipher', 'x = 1;')));
});

test('refFilterPredicate - 先頭の - は除外', () => {
  const p = refFilterPredicate('-test');
  assert.ok(p(row('ssl/ssl_lib.c', 'f', 'x = 1;')));
  assert.ok(!p(row('test/ssltest.c', 'f', 'x = 1;')));
});

test('refFilterPredicate - path: はパスだけに掛かる', () => {
  const p = refFilterPredicate('path:ssl');
  assert.ok(p(row('ssl/ssl_lib.c', 'f', 'x = 1;')));
  // 本文に ssl があってもパスに無ければ落ちる
  assert.ok(!p(row('apps/openssl_app.c', 'f', 'SSL_read(s);')) === false);
  assert.ok(!p(row('crypto/x.c', 'f', 'ssl_thing();')));
});

test('refFilterPredicate - -path: でパスだけ除外', () => {
  const p = refFilterPredicate('-path:doc');
  assert.ok(p(row('ssl/ssl_lib.c', 'f', 'see doc for details')));
  assert.ok(!p(row('doc/man3/x.pod', 'f', 'x = 1;')));
});

test('refFilterPredicate - 空の条件は全部通す', () => {
  const p = refFilterPredicate('   ');
  assert.ok(p(row('a.c', 'f', 'x')));
});

// 中断された定義検索が、後から始まった検索の結果を上書きしないこと。
// 点滅表示は 80ms ごとに書き続けるので、これが漏れると状態欄が
// 「定義を検索中」のまま固まって二度と更新されなくなる
test('statusGate - 最新の検索だけが状態欄に書ける', () => {
  let gen = 0, shown = '';
  const write = m => { shown = m; };
  const first = statusGate(++gen, () => gen, write);
  first('検索中: A');
  assert.equal(shown, '検索中: A');

  const second = statusGate(++gen, () => gen, write);
  second('定義: b.c:12');
  first('検索中: A');           // 中断された側の点滅が遅れて届く
  assert.equal(shown, '定義: b.c:12');
});

// ---- 右クリックメニューの形を守る ----
// メニューは直キーの教材でもあるので、行が増えすぎないことと、
// キーを持つ操作がキー無しの複製としてメニューに出ないことを見る。
const fs = require('node:fs');
const path = require('node:path');

function contextMenuActions() {
  const dir = path.join(__dirname, '..', 'static', 'js');
  const items = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/addAction\(\{([\s\S]*?)\n {2}\}\)/g)) {
      const b = m[1];
      const label = (b.match(/label:\s*'([^']*)'/) || [])[1];
      if (!label) continue;
      items.push({
        label,
        group: (b.match(/contextMenuGroupId:\s*'([^']*)'/) || [])[1] || null,
        precondition: (b.match(/precondition:\s*'([^']*)'/) || [])[1] || null,
        hasKey: /keybindings:\s*\[[^\]]+\]/.test(b),
      });
    }
  }
  return items;
}

test('右クリックメニュー - キーを持つ操作をキー無しの複製で出さない', () => {
  const all = contextMenuActions();
  for (const item of all.filter(i => i.group && !i.hasKey)) {
    const twin = all.find(o => o !== item && o.label === item.label && o.hasKey);
    assert.equal(twin, undefined,
      `"${item.label}" はキー割り当てのある同名アクションの複製。` +
      'メニューにキーが表示されないので、本体に contextMenuGroupId を付けて1つにする');
  }
});

// Alt+A の一覧に載らない操作は、メニューから外すと入口がキーだけになる。
// 実際に「デバッグ行を挿入」がメニューを外された状態で放置され、機能が
// 見えなくなっていた。
test('右クリックメニュー - ファイルを書き換える操作を隠さない', () => {
  const item = contextMenuActions().find(i => i.label === 'デバッグ行を挿入');
  assert.ok(item, '"デバッグ行を挿入" のアクションが見つからない');
  assert.ok(item.group,
    '"デバッグ行を挿入" が右クリックメニューに出ない。入口が Alt+P だけになる');
});

test('右クリックメニュー - 常時出る項目を12件までに抑える', () => {
  const always = contextMenuActions().filter(i => i.group && !i.precondition);
  assert.ok(always.length <= 12,
    `常時出る項目が ${always.length} 件: ${always.map(i => i.label).join(', ')}`);
});
