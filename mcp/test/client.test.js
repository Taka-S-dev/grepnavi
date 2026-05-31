// bridge pure helper のテスト。
// 依存: tsc で dist/ を生成済みであること (npm run build)
// 実行: node --test test/*.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  likelyTrivial,
  inCallerSubtree,
  annotateMemo,
  kindRankScore,
} from "../dist/client.js";

// ---------- likelyTrivial ----------

test("likelyTrivial - kernel locking primitives", () => {
  assert.equal(likelyTrivial("spin_lock"), true);
  assert.equal(likelyTrivial("spin_unlock"), true);
  assert.equal(likelyTrivial("raw_spin_lock_irqsave"), true);
  assert.equal(likelyTrivial("mutex_lock"), true);
  assert.equal(likelyTrivial("mutex_unlock"), true);
});

test("likelyTrivial - atomics and refcount", () => {
  assert.equal(likelyTrivial("atomic_inc"), true);
  assert.equal(likelyTrivial("atomic64_add"), true);
  assert.equal(likelyTrivial("refcount_dec_and_test"), true);
  assert.equal(likelyTrivial("kref_get"), true);
});

test("likelyTrivial - endian conversion", () => {
  assert.equal(likelyTrivial("le64_to_cpu"), true);
  assert.equal(likelyTrivial("le32_to_cpup"), true);
  assert.equal(likelyTrivial("cpu_to_le64"), true);
  assert.equal(likelyTrivial("be16_to_cpus"), true);
});

test("likelyTrivial - generic C primitives", () => {
  assert.equal(likelyTrivial("memcpy"), true);
  assert.equal(likelyTrivial("memset"), true);
  assert.equal(likelyTrivial("strcmp"), true);
  assert.equal(likelyTrivial("strlen"), true);
});

test("likelyTrivial - logging family", () => {
  assert.equal(likelyTrivial("printk"), true);
  assert.equal(likelyTrivial("pr_warn"), true);
  assert.equal(likelyTrivial("pr_err"), true);
  assert.equal(likelyTrivial("pr_err_client"), true);
  assert.equal(likelyTrivial("dev_info"), true);
});

test("likelyTrivial - common macros", () => {
  assert.equal(likelyTrivial("container_of"), true);
  assert.equal(likelyTrivial("IS_ERR"), true);
  assert.equal(likelyTrivial("PTR_ERR"), true);
  assert.equal(likelyTrivial("READ_ONCE"), true);
  assert.equal(likelyTrivial("likely"), true);
  assert.equal(likelyTrivial("EXPORT_SYMBOL_GPL"), true);
});

test("likelyTrivial - domain functions are NOT trivial", () => {
  assert.equal(likelyTrivial("ceph_handle_quota"), false);
  assert.equal(likelyTrivial("__ceph_update_quota"), false);
  assert.equal(likelyTrivial("ceph_find_inode"), false);
  assert.equal(likelyTrivial("ssl_init_ctx"), false);
});

test("likelyTrivial - path-based fallback for known noisy files", () => {
  assert.equal(likelyTrivial("foo", "/abs/kernel/locking/spinlock.c"), true);
  assert.equal(likelyTrivial("foo", "C:/abs/lib/string.c"), true);
  assert.equal(likelyTrivial("foo", "/abs/include/linux/atomic.h"), true);
  // ドメインコード配下は false
  assert.equal(likelyTrivial("foo", "/abs/fs/ceph/quota.c"), false);
});

// ---------- inCallerSubtree ----------

test("inCallerSubtree - same subsystem (fs/ceph)", () => {
  assert.equal(
    inCallerSubtree("/abs/fs/ceph/super.c", "/abs/fs/ceph/quota.c"),
    true,
  );
});

test("inCallerSubtree - different top-level subsystems", () => {
  assert.equal(
    inCallerSubtree("/abs/arch/x86/include/asm/spinlock.h", "/abs/fs/ceph/quota.c"),
    false,
  );
});

test("inCallerSubtree - same top but different second (fs/btrfs vs fs/ceph)", () => {
  assert.equal(
    inCallerSubtree("/abs/fs/btrfs/super.c", "/abs/fs/ceph/quota.c"),
    false, // 先頭 2 階層が一致しない
  );
});

test("inCallerSubtree - Windows backslash paths normalized", () => {
  assert.equal(
    inCallerSubtree("C:\\abs\\fs\\ceph\\super.c", "C:\\abs\\fs\\ceph\\quota.c"),
    true,
  );
});

test("inCallerSubtree - no caller file → false", () => {
  assert.equal(inCallerSubtree("/abs/foo/bar.c"), false);
  assert.equal(inCallerSubtree("/abs/foo/bar.c", ""), false);
});

// ---------- annotateMemo ----------

test("annotateMemo - already tagged passes through", () => {
  assert.equal(annotateMemo("[verified] x"), "[verified] x");
  assert.equal(annotateMemo("[確認済] 何か"), "[確認済] 何か");
  assert.equal(annotateMemo("[未確認] foo"), "[未確認] foo");
  assert.equal(annotateMemo("[推測] bar"), "[推測] bar");
});

test("annotateMemo - tag matching is case-insensitive + whitespace tolerant", () => {
  assert.equal(annotateMemo("[ Verified ] x"), "[ Verified ] x");
  assert.equal(annotateMemo("[VERIFIED] x"), "[VERIFIED] x");
});

test("annotateMemo - untagged gets [未確認] prefix", () => {
  assert.equal(annotateMemo("hello"), "[未確認] hello");
  assert.equal(annotateMemo("関数の説明"), "[未確認] 関数の説明");
});

test("annotateMemo - idempotent (二度掛けても変わらない)", () => {
  const once = annotateMemo("hello");
  assert.equal(annotateMemo(once), once);
});

test("annotateMemo - empty/undefined pass through unchanged", () => {
  assert.equal(annotateMemo(""), "");
  assert.equal(annotateMemo("   "), "   ");
  assert.equal(annotateMemo(undefined), undefined);
});

// ---------- kindRankScore ----------

test("kindRankScore - ordering func > define > typedef > others", () => {
  assert.ok(kindRankScore("func") > kindRankScore("define"));
  assert.ok(kindRankScore("define") > kindRankScore("typedef"));
  assert.ok(kindRankScore("typedef") > kindRankScore("struct"));
  assert.equal(kindRankScore("struct"), 0);
  assert.equal(kindRankScore("enum_member"), 0);
});

test("kindRankScore - null/undefined → 0", () => {
  assert.equal(kindRankScore(null), 0);
  assert.equal(kindRankScore(undefined), 0);
});
