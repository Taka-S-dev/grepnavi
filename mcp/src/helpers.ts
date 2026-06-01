import { annotateMemo, likelyTrivial, inCallerSubtree } from "./client.js";
import type { GrepnaviClient, MemoCategory } from "./client.js";
import { client } from "./shared.js";
import type { BatchNodeInput, CallerTreeNode } from "./shared.js";

// AI が hand-build した Windows パス (バックスラッシュ区切り、drive letter 小文字)
// を grepnavi が受け取れる形に正規化する。definition / callers / callees が返した
// path をそのまま渡せば本来不要だが、AI は時々 hand-build するため safety net。
export function normalizeInputPath<T extends string | undefined>(p: T): T {
  if (!p) return p;
  return p
    .replace(/\\/g, "/")
    .replace(/^([a-z]):/, (_, d) => d.toUpperCase() + ":") as T;
}

// Claude Code の Read tool と同じ「行番号 + tab + 内容」フォーマットで返す。
// AI が出力をそのまま citation に使ったり、行番号で他ツールに繋いだりしやすい。
export function formatFileContent(r: {
  file: string;
  total_lines: number;
  start: number;
  end: number;
  lines: string[];
}): string {
  const width = String(r.end).length;
  const header =
    `=== ${r.file} (lines ${r.start}-${r.end} of ${r.total_lines}) ===`;
  const body = r.lines
    .map((line, i) => {
      const num = (r.start + i).toString().padStart(width, " ");
      return `${num}\t${line}`;
    })
    .join("\n");
  return header + "\n" + body;
}

// 行 memo の key 形式は browser 側と互換: `<file>::<line>`。
function lineMemoKey(file: string, line: number): string {
  return `${file}::${line}`;
}

export async function setLineMemo(
  file: string,
  line: number,
  memo: string,
  category: string = "draft",
) {
  const g = await client.graph();
  const lineMemos = { ...(g.line_memos ?? {}) };
  const lineMemoCategories = { ...(g.line_memo_categories ?? {}) };
  const lineMemoSources = { ...(g.line_memo_sources ?? {}) };
  const rangeMemos = [...(g.range_memos ?? [])];
  const bookmarks = { ...(g.bookmarks ?? {}) };
  const key = lineMemoKey(file, line);
  const had = key in lineMemos;
  if (memo === "") {
    delete lineMemos[key];
    delete lineMemoCategories[key];
    delete lineMemoSources[key];
  } else {
    // 新規 / 上書きの memo にだけ annotate (既存 memo は触らない)
    lineMemos[key] = annotateMemo(memo) ?? memo;
    lineMemoCategories[key] = category;
    lineMemoSources[key] = "ai";
  }
  await client.writeMemos(
    lineMemos,
    rangeMemos,
    bookmarks,
    lineMemoCategories,
    lineMemoSources,
  );
  return {
    file,
    line,
    category,
    deleted: memo === "" && had,
    set: memo !== "",
    total_line_memos: Object.keys(lineMemos).length,
  };
}

export async function setRangeMemo(args: {
  file: string;
  start_line: number;
  end_line: number;
  memo: string;
  id?: string;
  start_col?: number;
  end_col?: number;
  category?: string;
}) {
  const g = await client.graph();
  const lineMemos = { ...(g.line_memos ?? {}) };
  const lineMemoCategories = { ...(g.line_memo_categories ?? {}) };
  const lineMemoSources = { ...(g.line_memo_sources ?? {}) };
  const rangeMemos = [...(g.range_memos ?? [])];
  const bookmarks = { ...(g.bookmarks ?? {}) };
  const category = args.category ?? "draft";

  let resultId = args.id;
  let action: "created" | "updated" | "deleted" = "created";

  if (args.id) {
    const idx = rangeMemos.findIndex((m) => m.id === args.id);
    if (idx < 0) throw new Error(`range memo id '${args.id}' not found`);
    if (args.memo === "") {
      rangeMemos.splice(idx, 1);
      action = "deleted";
    } else {
      rangeMemos[idx] = {
        ...rangeMemos[idx],
        file: args.file,
        start_line: args.start_line,
        end_line: args.end_line,
        start_col: args.start_col ?? rangeMemos[idx].start_col,
        end_col: args.end_col ?? rangeMemos[idx].end_col,
        memo: annotateMemo(args.memo) ?? args.memo,
        category: category as MemoCategory,
        source: "ai" as const,
      };
      action = "updated";
    }
  } else {
    if (args.memo === "") {
      throw new Error("Cannot create an empty range memo (pass `id` with empty memo to delete)");
    }
    const { randomBytes } = await import("node:crypto");
    resultId = randomBytes(8).toString("hex");
    rangeMemos.push({
      id: resultId,
      file: args.file,
      start_line: args.start_line,
      start_col: args.start_col ?? 1,
      end_line: args.end_line,
      end_col: args.end_col ?? 9999,
      memo: annotateMemo(args.memo) ?? args.memo,
      category: category as MemoCategory,
      source: "ai" as const,
    });
  }

  await client.writeMemos(
    lineMemos,
    rangeMemos,
    bookmarks,
    lineMemoCategories,
    lineMemoSources,
  );
  return { id: resultId, action, category, total_range_memos: rangeMemos.length };
}

// callers の再帰展開。各 caller の `func` 名で更に callers を引く。
// visited で循環を防ぐ (caller func 名 + 定義 file:line)。
export async function callersTree(args: {
  word: string;
  dir?: string;
  glob?: string;
  depth?: number;
}): Promise<{
  callee: { word: string };
  depth: number;
  callers: CallerTreeNode[];
}> {
  const maxDepth = Math.max(1, Math.min(5, args.depth ?? 1));
  const visited = new Set<string>([args.word]);

  async function expand(word: string, level: number): Promise<CallerTreeNode[]> {
    const sites = await client.callers(word, { dir: args.dir, glob: args.glob });
    const nodes: CallerTreeNode[] = sites.map((s) => ({
      func: s.func,
      file: s.file,
      line: s.line,
      call_line: s.call_line,
      indirect: s.indirect,
    }));
    if (level >= maxDepth) {
      for (const n of nodes) n.recursion_stopped = "depth_limit";
      return nodes;
    }
    for (const n of nodes) {
      const key = `${n.func}@${n.file}:${n.line}`;
      if (visited.has(key) || visited.has(n.func)) {
        n.recursion_stopped = "already_visited";
        continue;
      }
      visited.add(key);
      n.callers = await expand(n.func, level + 1);
    }
    return nodes;
  }

  const top = await expand(args.word, 1);
  return { callee: { word: args.word }, depth: maxDepth, callers: top };
}

// 配列を topo-sort: 親が空 / batch 外 / 先に置かれた、いずれかのときに置ける。
// 1 周しても何も置けなければ循環参照と判定。
export function topoSortBatch(nodes: BatchNodeInput[]): BatchNodeInput[] {
  const byId = new Map(nodes.map((n) => [n.client_id, n]));
  const placed = new Set<string>();
  const sorted: BatchNodeInput[] = [];
  let progress = true;
  while (progress && sorted.length < nodes.length) {
    progress = false;
    for (const n of nodes) {
      if (placed.has(n.client_id)) continue;
      const p = n.parent_client_id ?? "";
      const inBatch = p && byId.has(p);
      if (!p || !inBatch || placed.has(p)) {
        sorted.push(n);
        placed.add(n.client_id);
        progress = true;
      }
    }
  }
  if (sorted.length < nodes.length) {
    const stuck = nodes.filter((n) => !placed.has(n.client_id)).map((n) => n.client_id);
    throw new Error(
      `Cycle or unresolved parent in batch. Stuck client_ids: ${stuck.join(", ")}`,
    );
  }
  return sorted;
}

export async function addNodesBatch(nodes: BatchNodeInput[]): Promise<{
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{
    client_id: string;
    node_id?: string;
    label?: string;
    error?: string;
  }>;
}> {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("`nodes` must be a non-empty array");
  }

  // client_id の一意性
  const seen = new Set<string>();
  for (const n of nodes) {
    if (!n.client_id) throw new Error("Every node needs a `client_id`");
    if (seen.has(n.client_id)) {
      throw new Error(`Duplicate client_id in batch: ${n.client_id}`);
    }
    seen.add(n.client_id);
  }

  // 既存 graph と client_id の衝突 / 未知の parent_client_id チェック
  const existingGraph = await client.graph();
  const existingIds = new Set(Object.keys(existingGraph.nodes));
  for (const n of nodes) {
    if (existingIds.has(n.client_id)) {
      throw new Error(
        `client_id '${n.client_id}' collides with an existing server node id. ` +
          `Pick a different client_id (server would silently dedup and skip your fields).`,
      );
    }
    const p = n.parent_client_id ?? "";
    if (p && !seen.has(p) && !existingIds.has(p)) {
      throw new Error(
        `Node '${n.client_id}' has parent_client_id '${p}' which is neither in this batch nor an existing server node. ` +
          `Use empty string for root, a client_id from this batch, or a known server node id.`,
      );
    }
  }

  // 親 → 子の順に並べる
  const sorted = topoSortBatch(nodes);

  const results: Array<{
    client_id: string;
    node_id?: string;
    label?: string;
    error?: string;
  }> = [];
  for (const n of sorted) {
    try {
      const effectiveLabel = n.label || (n.word ? `${n.word}:${n.line}` : undefined);
      const r = await client.addNode({
        file: n.file,
        line: n.line,
        label: effectiveLabel,
        memo: n.memo,
        tags: n.tags,
        badge_color: n.badge_color,
        badge_text: n.badge_text,
        text: n.text,
        parent_id: n.parent_client_id ?? "",
        client_node_id: n.client_id,
      });
      results.push({ client_id: n.client_id, node_id: r.node.id, label: r.node.label });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ client_id: n.client_id, error: msg });
      // 失敗したら以降は中断 (子が宙ぶらりんになるのを避ける)
      break;
    }
  }

  const succeeded = results.filter((r) => !r.error).length;
  return {
    total: nodes.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}

export async function listMemos(file?: string) {
  const g = await client.graph();
  const lineMemos = g.line_memos ?? {};
  const lineCategories = g.line_memo_categories ?? {};
  const lineSources = g.line_memo_sources ?? {};
  const rangeMemos = g.range_memos ?? [];
  const lineList = Object.entries(lineMemos)
    .filter(([key]) => !file || key.startsWith(file + "::"))
    .map(([key, memo]) => {
      const idx = key.lastIndexOf("::");
      return {
        file: key.slice(0, idx),
        line: parseInt(key.slice(idx + 2), 10),
        memo,
        category: lineCategories[key] || undefined,
        source: lineSources[key] || undefined,
      };
    });
  const rangeList = rangeMemos.filter((m) => !file || m.file === file);
  return {
    line_memos: lineList,
    range_memos: rangeList,
    total_line: lineList.length,
    total_range: rangeList.length,
  };
}

// 確実に「呼び出せない」型の kind 一覧。grepnavi の DefHit.Kind は
// 'func' / 'define' / 'struct' / 'enum' / 'union' / 'typedef' の他に
// ctags 由来で 'enum_member' / 'member' / 'field' / 'enumerator' が返ることがある。
const NON_CALLABLE_KINDS = new Set([
  "struct",
  "union",
  "enum",
  "enumerator",
  "enum_member",
  "typedef",
  "member",
  "field",
]);

// definition の hit をランキングする共通関数。
// 優先度: kind (func > define > その他) + 拡張子 (.c > .h)
//        + caller との path 共通プレフィックス長 (kernel スケールでは proximity が支配的)。
export function rankDef(
  def: { kind: string; file: string },
  callerFile?: string,
): number {
  let r = 0;
  if (def.kind === "func") r += 100;
  else if (def.kind === "define") r += 50;
  if (/\.(c|cpp|cc|cxx)$/i.test(def.file)) r += 10;
  else if (/\.(h|hpp|hh|hxx)$/i.test(def.file)) r += 5;

  if (callerFile) {
    const norm = (p: string) => p.replace(/\\/g, "/");
    const callerSegs = norm(callerFile).split("/").slice(0, -1).filter(Boolean);
    const defSegs = norm(def.file).split("/").slice(0, -1).filter(Boolean);
    let common = 0;
    while (
      common < callerSegs.length &&
      common < defSegs.length &&
      callerSegs[common] === defSegs[common]
    ) {
      common++;
    }
    // 同じディレクトリ完全一致は大ボーナス、共通プレフィックス長で加点
    if (defSegs.length === callerSegs.length && common === callerSegs.length) {
      r += 1000;
    } else {
      r += common * 100;
    }
  }
  return r;
}

export function pickBestDef(hits: Awaited<ReturnType<GrepnaviClient["definition"]>>) {
  return [...hits].sort((a, b) => rankDef(b) - rankDef(a))[0];
}

// callees の identifier を definition で並列解決し、macro / non-callable 判定と参照を付ける。
// callerFile が分かっていれば proximity ranking で definitions を並べ替える。
// 並列度は無制限 (ローカル gtags が十分速い前提)。
//
// definitions は top 1 のみ surface。複数候補ある場合は definitions_total で件数だけ知らせ、
// AI が曖昧と判断したら grepnavi_definition(name) で full list を取りに行ける運用。
//
// confidence は「bridge が picked した top hit がどれだけ信頼できるか」:
//   - high: 1 件しかない / 同じ dir / 次点と明確に離れてる
//   - medium: top に kind=func の優位はあるが proximity 弱い
//   - low: def 無し or 同名候補が複数 subsystem に散らばってる (silent failure 警告)
//
// 名前パターンで trivial 判定できる場合 (spin_lock, le64_to_cpu 等) は
// definition 解決自体スキップ → 偽 hit (arch/x86/tools/relocs.c 等) を返さない + fetch 削減。
export async function enrichCallee(name: string, callerFile?: string) {
  // 名前で trivial 判定 → definition fetch 自体スキップして偽 hit を防ぐ
  if (likelyTrivial(name)) {
    return {
      name,
      kind: null,
      engine: null,
      likely_macro: false,
      likely_non_callable: false,
      likely_trivial: true,
      in_caller_subtree: false,
      confidence: "low" as const,
      recommended_for_tree: false,
      definitions_total: 0,
      definitions: [] as Array<{ file: string; line: number; kind: string }>,
    };
  }

  const hits = await client.definition(name).catch(() => []);
  const allDefine = hits.length > 0 && hits.every((h) => h.kind === "define");
  const allNonCallable =
    hits.length > 0 && hits.every((h) => NON_CALLABLE_KINDS.has(h.kind));
  const sorted = [...hits].sort((a, b) => rankDef(b, callerFile) - rankDef(a, callerFile));

  let confidence: "high" | "medium" | "low" = "low";
  if (sorted.length === 0) {
    confidence = "low";
  } else if (sorted.length === 1) {
    confidence = "high";
  } else {
    const topScore = rankDef(sorted[0], callerFile);
    const nextScore = rankDef(sorted[1], callerFile);
    if (topScore >= 1000) confidence = "high"; // same dir as caller
    else if (topScore - nextScore >= 100) confidence = "high"; // clear winner
    else if (topScore >= 100) confidence = "medium";
    else confidence = "low";
  }

  // top hit ベースで domain 判定フラグを top level に surface (AI が 1 行で判断できるよう)
  const topFile = sorted[0]?.file;
  // パスベース trivial 判定 (例: /lib/string.c に解決された non-pattern name)
  const trivial = likelyTrivial(name, topFile);
  const likelyMacro = hits.length === 0 || allDefine;
  const recommended = !likelyMacro && !allNonCallable && !trivial;
  return {
    name,
    kind: sorted[0]?.kind ?? null,
    engine: sorted[0]?.engine ?? null,
    likely_macro: likelyMacro,
    likely_non_callable: allNonCallable,
    likely_trivial: trivial,
    in_caller_subtree: inCallerSubtree(topFile ?? "", callerFile),
    confidence,
    recommended_for_tree: recommended,
    definitions_total: hits.length,
    definitions: sorted.slice(0, 1).map((h) => ({
      file: h.file,
      line: h.line,
      kind: h.kind,
    })),
  };
}

export type EnrichedCallee = Awaited<ReturnType<typeof enrichCallee>> & {
  call_line: number;
  children?: EnrichedCallee[];
  recursion_stopped?: "depth_limit" | "non_callable" | "already_visited" | "no_definition";
  body_preview?: string;
};

// callees に optional な func body preview を付ける。
// 各 callee の top definition (kind=func 推奨) に対して /api/func-body を呼び、
// 先頭 N 行を抜き出して body_preview に入れる。
// trivial / 定義無し / non-func はスキップ (preview 出しても意味なし)。
export async function attachBodyPreviews(
  callees: EnrichedCallee[],
  previewLines: number,
): Promise<void> {
  await Promise.all(
    callees.map(async (c) => {
      if (c.likely_trivial || c.likely_macro || c.likely_non_callable) return;
      const def = c.definitions[0];
      if (!def || def.kind !== "func") return;
      try {
        const r = await client.funcBody(def.file, def.line);
        const lines = (r.body || "").split("\n").slice(0, previewLines);
        c.body_preview = lines.join("\n");
      } catch {
        // 取得失敗は無視 (preview は best-effort)
      }
    }),
  );
}

// 1 階層分の callees を取って enrich + filter まで実施する内部ヘルパ。再帰は呼び出し側で組む。
// excluded は count ではなく名前リストで返す: AI が「本当に捨てていいか」を判断するときに
// 名前情報が必要 (count だけだと取り直しが発生する)。
export async function fetchEnrichedCallees(
  file: string,
  line: number,
  selfName: string,
  filters: { exclude_macros?: boolean; exclude_non_callable?: boolean },
): Promise<{
  raw: Array<{ name: string; call_line: number }>;
  filtered: Array<{ name: string; call_line: number }>;
  enriched: EnrichedCallee[];
  excludedMacroNames: string[];
  excludedNonCallableNames: string[];
}> {
  const raw = await client.callees(file, line);
  const filtered = selfName ? raw.filter((c) => c.name !== selfName) : raw;
  const enriched = await Promise.all(
    filtered.map(async (c) => ({ ...c, ...(await enrichCallee(c.name, file)) })),
  );

  const excludedMacroNames: string[] = [];
  const excludedNonCallableNames: string[] = [];
  let kept = enriched;
  if (filters.exclude_macros) {
    for (const e of kept) {
      if (e.likely_macro) excludedMacroNames.push(e.name);
    }
    kept = kept.filter((e) => !e.likely_macro);
  }
  if (filters.exclude_non_callable) {
    for (const e of kept) {
      if (e.likely_non_callable) excludedNonCallableNames.push(e.name);
    }
    kept = kept.filter((e) => !e.likely_non_callable);
  }
  return {
    raw,
    filtered,
    enriched: kept,
    excludedMacroNames,
    excludedNonCallableNames,
  };
}

// word → file+line 解決の共通ロジック。callees / func_body から共有。
// 曖昧時は候補 5 件を error message に同梱して disambiguate を促す。
export async function resolveWordToLocation(
  word: string,
): Promise<{ file: string; line: number }> {
  const hits = await client.definition(word);
  const funcHits = hits.filter((h) => h.kind === "func");
  const target = pickBestDef(funcHits.length > 0 ? funcHits : hits);
  if (!target) throw new Error(`No definition found for '${word}'`);
  const sourceHits = funcHits.length > 0 ? funcHits : hits;
  const sameAsTarget = sourceHits.filter(
    (h) => h.file === target.file && h.line === target.line,
  ).length;
  const ambiguous = sameAsTarget !== sourceHits.length;
  if (ambiguous && sourceHits.length > 1) {
    throw new Error(
      `'${word}' is ambiguous (${hits.length} definitions). Disambiguate by passing file+line. Candidates:\n` +
        hits
          .slice(0, 5)
          .map((h) => `  - ${h.file}:${h.line} [${h.kind}]`)
          .join("\n"),
    );
  }
  return { file: target.file, line: target.line };
}

export async function resolveAndEnrichCallees(args: {
  word?: string;
  file?: string;
  line?: number;
  exclude_macros?: boolean;
  exclude_non_callable?: boolean;
  depth?: number;
  with_preview?: boolean;
  preview_lines?: number;
}) {
  let { word, file, line } = args;
  const maxDepth = Math.max(1, Math.min(5, args.depth ?? 1));

  // file+line が無ければ word から resolve (共通 helper を使う)
  if (!file || !line) {
    if (!word) throw new Error("Either `word` or (`file`+`line`) is required");
    const resolved = await resolveWordToLocation(word);
    file = resolved.file;
    line = resolved.line;
  }

  const selfName = word ?? "";
  // exclude_* の default は true (ノイズ排除優先)。捨てた件数は excluded_* カウントで
  // 呼び出し側に透明性を返す。
  const filters = {
    exclude_macros: args.exclude_macros !== false,
    exclude_non_callable: args.exclude_non_callable !== false,
  };

  // visited に root を入れて、子供で同じ名前+場所に当たったら recurse stop
  const visited = new Set<string>([`${selfName}@${file}:${line}`]);

  const top = await fetchEnrichedCallees(file, line, selfName, filters);

  // depth > 1 のときだけ各子供を再帰展開する
  if (maxDepth > 1) {
    for (const child of top.enriched) {
      await expandCalleeRecursive(child, maxDepth, 1, visited, filters);
    }
  }

  // optional body preview。trivial / macro / 解決失敗以外で先頭 N 行を入れる。
  // depth>1 でも各 enriched node に対して付ける (recursion 後にまとめて)。
  if (args.with_preview) {
    const previewLines = Math.max(1, Math.min(30, args.preview_lines ?? 8));
    const flat: EnrichedCallee[] = [];
    const walk = (nodes: EnrichedCallee[]) => {
      for (const n of nodes) {
        flat.push(n);
        if (n.children) walk(n.children);
      }
    };
    walk(top.enriched);
    await attachBodyPreviews(flat, previewLines);
  }

  return {
    caller: { word: selfName || null, file, line },
    depth: maxDepth,
    total: top.raw.length,
    excluded: {
      self: top.raw.length - top.filtered.length,
      macros: top.excludedMacroNames,
      non_callable: top.excludedNonCallableNames,
    },
    callees: top.enriched,
  };
}

// 1 件の callee を起点に深く掘る。visited で循環/重複を pruning する。
export async function expandCalleeRecursive(
  node: EnrichedCallee,
  maxDepth: number,
  currentDepth: number,
  visited: Set<string>,
  filters: { exclude_macros?: boolean; exclude_non_callable?: boolean },
): Promise<void> {
  if (currentDepth >= maxDepth) {
    node.recursion_stopped = "depth_limit";
    return;
  }
  if (node.likely_macro || node.likely_non_callable) {
    node.recursion_stopped = "non_callable";
    return;
  }
  const target = node.definitions[0];
  if (!target) {
    node.recursion_stopped = "no_definition";
    return;
  }
  const key = `${node.name}@${target.file}:${target.line}`;
  if (visited.has(key)) {
    node.recursion_stopped = "already_visited";
    return;
  }
  visited.add(key);

  const sub = await fetchEnrichedCallees(target.file, target.line, node.name, filters);
  node.children = sub.enriched;
  for (const child of sub.enriched) {
    await expandCalleeRecursive(child, maxDepth, currentDepth + 1, visited, filters);
  }
}
