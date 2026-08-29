// callees の関数ポインタ経由の分離。
import { test } from "node:test";
import assert from "node:assert/strict";

import { splitIndirectCallees, toCompactCallees } from "../dist/helpers.js";

test("callees - メンバ呼び出しは定義解決の列から外れる", () => {
  const { direct, indirect } = splitIndirectCallees([
    { name: "plain", call_line: 3, text: "plain(x);" },
    { name: "ssl_read", call_line: 5, indirect: true, receiver: "s->method", text: "  return s->method->ssl_read(s, buf, num);" },
    { name: "write", call_line: 7, indirect: true, text: "get(s)->write(f);" },
  ]);
  assert.deepEqual(direct.map((c) => c.name), ["plain"]);
  assert.deepEqual(indirect, [
    { name: "ssl_read", call_line: 5, receiver: "s->method", text: "return s->method->ssl_read(s, buf, num);" },
    { name: "write", call_line: 7, text: "get(s)->write(f);" },
  ]);
});

test("callees - compact でもメンバ呼び出しは残る", () => {
  const compact = toCompactCallees([
    {
      name: "f", call_line: 1, kind: "func", engine: "gtags",
      likely_macro: false, likely_non_callable: false, likely_trivial: false,
      in_caller_subtree: true, confidence: "high", recommended_for_tree: true,
      definitions_total: 1, definitions: [{ file: "/a.c", line: 10, kind: "func" }],
      indirect_calls: [
        { name: "read", call_line: 12, receiver: "f->f_op", text: "f->f_op->read(f);" },
        { name: "cb", call_line: 13, text: "get()->cb();" },
      ],
    },
  ]);
  assert.deepEqual(compact[0].indirect_calls, [
    { name: "read", call_line: 12, receiver: "f->f_op" },
    { name: "cb", call_line: 13 },
  ]);
});
