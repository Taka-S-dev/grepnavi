import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// README の「提供ツール」表は一覧のつもりで書かれているので、ツールを足して
// 書き忘れると「無い機能」として扱われる（実際に 26 個中 6 個が抜けていて、
// 参照マップ / references という主要機能が README から見えなくなっていた）。
test('MCP - README の提供ツール表が実装と一致する', () => {
  const src = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) src.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(path.join(root, 'src'));
  const inCode = new Set(src.flatMap((s) => [...s.matchAll(/name:\s*"(grepnavi_[a-z_]+)"/g)].map((m) => m[1])));
  assert.ok(inCode.size > 20, `ツール定義が読めていない (${inCode.size})`);

  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  // 表の行にあるものだけを数える（本文中の言及は一覧ではない）
  const inDoc = new Set(
    readme.split(/\r?\n/).filter((l) => l.startsWith('|'))
      .flatMap((l) => [...l.matchAll(/`(grepnavi_[a-z_]+)`/g)].map((m) => m[1]))
  );
  const missing = [...inCode].filter((t) => !inDoc.has(t)).sort();
  const ghost = [...inDoc].filter((t) => !inCode.has(t)).sort();
  assert.deepEqual(missing, [], 'README の表に無いツール: ' + missing.join(', '));
  assert.deepEqual(ghost, [], 'README にあるが実装に無いツール: ' + ghost.join(', '));
});
