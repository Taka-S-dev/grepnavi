// [verified] の裏取り。AI の申告ではなく、ブリッジが実際に返した範囲で判定する。
// 依存: tsc で dist/ を生成済みであること (npm run build)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { recordRead, wasRead, verifyMemo, hasVerifiedTag, resetReadLog } from "../dist/readlog.js";

beforeEach(() => resetReadLog());

// これが無いと「読まずに [verified] と書く」が素通りする。仕組みの存在理由そのもの。
test("readlog - 読んでいない行の [verified] は [未確認] に落ちる", () => {
  const v = verifyMemo("[verified] 初期化する", [{ file: "C:/p/ssl/x.c", line: 10 }]);
  assert.equal(v.downgraded, true);
  assert.equal(v.memo, "[未確認] 初期化する");
  assert.match(v.reason, /x\.c:10/);
});

test("readlog - 読んだ範囲に入っていれば通る", () => {
  recordRead("C:/p/ssl/x.c", 5, 20);
  const v = verifyMemo("[確認済] 初期化する", [{ file: "C:/p/ssl/x.c", line: 10 }]);
  assert.equal(v.downgraded, false);
  assert.equal(v.memo, "[確認済] 初期化する");
});

// 呼び出し木の子はアンカーが呼び出し元の行。読んだのは呼び先の本体なので、
// 定義位置を候補に含めないと正しく読んだ場合まで落としてしまう。
test("readlog - 複数アンカーのどれかが読まれていれば通る", () => {
  recordRead("C:/p/ssl/callee.c", 100, 140);
  const v = verifyMemo("[verified] x", [
    { file: "C:/p/ssl/caller.c", line: 55 },
    { file: "C:/p/ssl/callee.c", line: 100 },
  ]);
  assert.equal(v.downgraded, false);
});

// 範囲メモは一部でも読んだ範囲に掛かれば読んだ扱い。
test("readlog - 範囲メモは重なりで判定", () => {
  recordRead("C:/p/a.c", 30, 40);
  assert.equal(wasRead("C:/p/a.c", 35, 60), true);
  assert.equal(wasRead("C:/p/a.c", 41, 60), false);
  assert.equal(wasRead("C:/p/a.c", 10, 29), false);
});

// AI が渡すパスは区切り・大小・相対/絶対が経由したツールで揺れる。
test("readlog - パスは区切りと大小を無視し、相対は末尾一致で照合", () => {
  recordRead("C:\\p\\SSL\\x.c", 1, 9);
  assert.equal(wasRead("c:/p/ssl/x.c", 3), true);
  assert.equal(wasRead("ssl/x.c", 3), true);
  assert.equal(wasRead("ssl/y.c", 3), false);
});

// [未確認] や無タグは裏取りの対象外。annotateMemo の仕事なので触らない。
test("readlog - verified 系以外は素通り", () => {
  assert.equal(hasVerifiedTag("[未確認] x"), false);
  assert.equal(hasVerifiedTag("x"), false);
  assert.equal(hasVerifiedTag("[ Verified ] x"), true);
  assert.equal(hasVerifiedTag("[読了] x"), true);
  assert.equal(verifyMemo("[未確認] x", [{ file: "a.c", line: 1 }]).downgraded, false);
  assert.equal(verifyMemo("x", [{ file: "a.c", line: 1 }]).downgraded, false);
  assert.equal(verifyMemo(undefined, [{ file: "a.c", line: 1 }]).memo, "");
});

test("readlog - 不正な範囲は記録しない", () => {
  recordRead("a.c", 0, 5);
  recordRead("a.c", 10, 5);
  recordRead("", 1, 5);
  assert.equal(wasRead("a.c", 3), false);
});
