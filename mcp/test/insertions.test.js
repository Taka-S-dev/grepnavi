// grepnavi_list_insertions の絞り込みのテスト。
// 依存: tsc で dist/ を生成済みであること (npm run build)
import { test } from "node:test";
import assert from "node:assert/strict";

import { selectInsertions } from "../dist/tools/insertions.js";

const REC = [
  { id: "GN1", file: "C:/p/ssl/rec_layer_s3.c", sites: [{ line: 1301, text: '  printf("[GN1]\\n");' }], group: "path-A", enabled: true, created_at: "" },
  { id: "GN2", file: "C:/p/ssl/rec_layer_s3.c", sites: [{ line: 1410, text: '  printf("[GN2]\\n");' }], group: "path-A", enabled: false, created_at: "" },
  { id: "GN9", file: "C:/p/crypto/mem.c", sites: [{ line: 42, text: '  printf("[GN9]\\n");' }], enabled: true, created_at: "" },
];
const ids = (r) => r.map((i) => i.id);

// 実機やプログラムの出力で見た "[GN9]" から記録を引く、というのがこのツールの
// 主用途。ソースに焼き込まれるのは id そのものなので、完全一致で引ける。
test("list_insertions - 出力で見たタグから1件引ける", () => {
  assert.deepEqual(ids(selectInsertions(REC, { tag: "GN9" })), ["GN9"]);
  // 出力から拾ったタグの大文字小文字は当てにならない
  assert.deepEqual(ids(selectInsertions(REC, { tag: " gn9 " })), ["GN9"]);
  assert.deepEqual(ids(selectInsertions(REC, { tag: "GN99" })), []);
});

// group は撤去の単位。空文字は「無グループだけ」を意味するので、
// 未指定（絞り込まない）と同じ扱いにしてはいけない。
test("list_insertions - 空グループの指定は無グループの絞り込み", () => {
  assert.deepEqual(ids(selectInsertions(REC, { group: "path-A" })), ["GN1", "GN2"]);
  assert.deepEqual(ids(selectInsertions(REC, { group: "" })), ["GN9"]);
  assert.deepEqual(ids(selectInsertions(REC, {})), ["GN1", "GN2", "GN9"]);
});

// AI が渡してくるパスの区切りは、どのツールの出力を経由したかで揺れる。
test("list_insertions - パスは区切りと大小を無視して部分一致", () => {
  assert.deepEqual(ids(selectInsertions(REC, { file: "ssl/rec_layer" })), ["GN1", "GN2"]);
  assert.deepEqual(ids(selectInsertions(REC, { file: "ssl\\rec_layer" })), ["GN1", "GN2"]);
  assert.deepEqual(ids(selectInsertions(REC, { file: "MEM.C" })), ["GN9"]);
});

// enabled:false はコメントアウト中。出力に出ないのが当然なので、
// 「出なかった＝通らなかった」を判断するときは外せる必要がある。
test("list_insertions - 無効な仕込みを外せる", () => {
  assert.deepEqual(ids(selectInsertions(REC, { enabled_only: true })), ["GN1", "GN9"]);
  assert.deepEqual(ids(selectInsertions(REC, { group: "path-A", enabled_only: true })), ["GN1"]);
});
