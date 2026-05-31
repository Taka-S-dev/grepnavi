// grepnavi HTTP API client. Bridge は dumb pipe に徹するため、ここでは
// ロジックを置かず、API のシェイプそのままを通す。
//
// 例外: ノード追加直後の memo セットだけは 2-step を畳んで 1 ツール化している
// (POST /api/graph/node → PUT /api/graph/node/<id> 内部 chain)。AI に POST+PUT を
// 順序付きで呼ばせるのは事故が多いため bridge 側で吸収する。

import { randomBytes } from "node:crypto";

export interface DefHit {
  file: string;
  line: number;
  text: string;
  kind: string;
  engine?: string;
  likely_trivial?: boolean;
  in_caller_subtree?: boolean;
}

export interface CallSite {
  func: string;
  file: string;
  line: number;
  call_line: number;
  indirect: boolean;
}

export interface SearchMatch {
  file: string;
  line: number;
  col: number;
  text: string;
  kind?: string;
  snippet?: Array<{ line: number; text: string; is_match: boolean }>;
  non_utf8?: boolean;
}

export interface Symbol {
  name: string;
  detail: string;
  start_line: number;
  end_line: number;
}

export interface GraphNode {
  id: string;
  match: { file: string; line: number; col?: number; text?: string };
  label: string;
  memo?: string;
  tags?: string[];
  badge_color?: string;
  badge_text?: string;
  children: string[];
}

export interface RangeMemo {
  id: string;
  file: string;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
  memo: string;
}

export interface GraphResponse {
  id: string;
  name: string;
  nodes: Record<string, GraphNode>;
  edges: Array<{ id: string; from: string; to: string; label: string }>;
  root_dir: string;
  root_order?: string[];
  line_memos?: Record<string, string>;
  range_memos?: RangeMemo[];
  bookmarks?: Record<string, string>;
}

export class GrepnaviError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "GrepnaviError";
  }
}

// memo に verify-status tag が無ければ [未確認] を自動付与する。
// AI が grepnavi_func_body 等で関数を読まずに想像で memo 書いた事故 (再発多数) を
// 「description で nudge」だけでは止められなかったので、bridge 側で構造的に強制する。
// 認識済みタグ (verified / unverified / 確認済 / 推測 / 未確認 / 読了 / 未読 / inferred)
// で始まる memo はそのまま通す。AI が verify したと主張するなら [verified] / [確認済] を
// 明示すれば auto-prefix されない。idempotent (2 回掛けても同じ)。
const MEMO_TAG_RE = /^\s*\[\s*(verified|unverified|inferred|確認済|推測|未確認|読了|未読)\s*\]/i;

export function annotateMemo(memo: string | undefined): string | undefined {
  if (memo === undefined || memo === null) return memo;
  if (!memo.trim()) return memo;
  if (MEMO_TAG_RE.test(memo)) return memo;
  return `[未確認] ${memo}`;
}

// definition の hit を kind の有用性順で score 付け。
// func (実装) > define (マクロ) > typedef (型 alias) > その他 (struct/enum/union/member 等)
export function kindRankScore(kind: string | undefined | null): number {
  if (!kind) return 0;
  if (kind === "func") return 100;
  if (kind === "define") return 50;
  if (kind === "typedef") return 30;
  return 0;
}

// likelyTrivial: ヒューリスティックで「汎用プリミティブ」を判定する。
// 除外せずフラグだけ surface して、AI が「これは深追い不要」と即断できるようにする。
// Linux kernel 寄りだが memcpy/printk 等は generic C にも効く。
const TRIVIAL_NAME_PATTERNS = [
  /^(le|be)\d+_to_cpu(p|s)?$/i,
  /^cpu_to_(le|be)\d+(p|s)?$/i,
  /^(spin|raw_spin|mutex|rwlock|rwsem|down|up)_(lock|unlock|trylock|init|destroy|read|write)/,
  /^(atomic|atomic64|refcount|kref)_/,
  /^(READ_ONCE|WRITE_ONCE|smp_(mb|rmb|wmb)|barrier|likely|unlikely|container_of)$/,
  /^(IS_ERR|PTR_ERR|ERR_PTR|IS_ERR_OR_NULL)$/,
  /^(memcpy|memset|memcmp|memmove|memchr|memscan)$/,
  /^(strcpy|strncpy|strcmp|strncmp|strlen|strchr|strstr|strdup|strlcpy|strscpy)$/,
  /^(printk|pr_(emerg|alert|crit|err|warn|notice|info|debug|cont)(_client|_ratelimited)?)$/,
  /^(dev_(emerg|alert|crit|err|warn|notice|info|dbg))$/,
  /^(kmalloc|kzalloc|kfree|vmalloc|vfree|kmem_cache_(alloc|free|create))/,
  /^(local_irq_(enable|disable|save|restore)|preempt_(enable|disable))/,
  /^(rcu_(read_lock|read_unlock|dereference|assign_pointer))/,
  /^(min|max|min_t|max_t|clamp|clamp_t|swap|abs)$/,
  /^(EXPORT_SYMBOL(_GPL)?|MODULE_(LICENSE|AUTHOR|DESCRIPTION))$/,
];
const TRIVIAL_PATH_PATTERNS = [
  /\/kernel\/locking\//,
  /\/include\/(linux|asm-generic|asm)\/atomic/,
  /\/lib\/(string|printf|vsprintf|kasprintf|errno)\.c/,
];

export function likelyTrivial(name: string, defFile?: string): boolean {
  if (TRIVIAL_NAME_PATTERNS.some((re) => re.test(name))) return true;
  if (defFile) {
    const norm = defFile.replace(/\\/g, "/");
    if (TRIVIAL_PATH_PATTERNS.some((re) => re.test(norm))) return true;
  }
  return false;
}

// inCallerSubtree: def file が caller と「同じ subsystem」にあるか。
// 「先頭 2 階層比較」だと /abs プレフィックスが共通な絶対パスで誤判定するので、
// caller_dir と def_dir が互いに包含関係 (一方が他方の prefix) かどうかで判定する。
//
// 例: caller=fs/ceph/quota.c, def=fs/ceph/super.c       → true (同じ dir)
//     caller=fs/ceph/quota.c, def=fs/ceph/include/h.h    → true (def が caller dir 配下)
//     caller=fs/ceph/sub/x.c, def=fs/ceph/super.c        → true (caller が def dir 配下)
//     caller=fs/ceph/quota.c, def=fs/btrfs/super.c       → false (兄弟 subsystem)
//     caller=fs/ceph/quota.c, def=arch/x86/asm/spin.h    → false
// caller_file が無ければ false (情報不足で判断不能)。
export function inCallerSubtree(defFile: string, callerFile?: string): boolean {
  if (!callerFile || !defFile) return false;
  const dir = (p: string) =>
    p.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
  const callerDir = dir(callerFile);
  const defDir = dir(defFile);
  if (!callerDir || !defDir) return false; // root 直下のファイルは subsystem 判定不能
  return (
    defDir === callerDir ||
    defDir.startsWith(callerDir + "/") ||
    callerDir.startsWith(defDir + "/")
  );
}

export class GrepnaviClient {
  // grepnavi が現在見ている root の絶対パス。最初の readFile / resolvePath で fetch。
  // session 内で root が変わるケースは稀 (変えるなら Claude Code を restart する運用前提)。
  private cachedRoot: string | null = null;

  constructor(private readonly baseUrl: string) {}

  private async req(path: string, init?: RequestInit): Promise<Response> {
    const url = this.baseUrl + path;
    try {
      const r = await fetch(url, init);
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new GrepnaviError(
          `grepnavi ${path} returned HTTP ${r.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
        );
      }
      return r;
    } catch (err) {
      if (err instanceof GrepnaviError) throw err;
      // fetch failed は cause を見ないと原因が分からないので展開する
      const code = (err as { cause?: { code?: string } })?.cause?.code;
      const hint =
        code === "ECONNREFUSED"
          ? ` — grepnavi が ${this.baseUrl} で起動していない可能性。'go run .' で起動しているか、GREPNAVI_URL の port が合っているか確認してください。`
          : code === "ENOTFOUND"
            ? ` — ホスト名を解決できません (${this.baseUrl})。`
            : code === "ETIMEDOUT"
              ? ` — タイムアウト。grepnavi が応答していません。`
              : "";
      throw new GrepnaviError(
        `fetch ${url} failed (${code ?? (err as Error)?.message ?? "unknown"})${hint}`,
        err,
      );
    }
  }

  async root(): Promise<{ root: string }> {
    const r = await this.req("/api/root");
    return (await r.json()) as { root: string };
  }

  // 相対パスを grepnavi root と join して絶対化する。Windows / POSIX どちらの root でも
  // forward slash 統一で結合する (grepnavi の os.Stat は両方受け付ける)。
  async resolvePath(file: string): Promise<string> {
    const isAbs = /^([a-zA-Z]:[\\/]|[\\/])/.test(file);
    if (isAbs) return file;
    if (!this.cachedRoot) this.cachedRoot = (await this.root()).root;
    const r = this.cachedRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    return r + "/" + file.replace(/\\/g, "/").replace(/^\/+/, "");
  }

  // file は相対でも絶対でも受け付ける (相対は root と join)。range 省略 = 全行。
  // grepnavi が file 不在で 500 を返した場合は root を含む hint を error に上乗せする
  // (AI の CWD と grepnavi root が違う典型ミスを 1 回で回復させるため)。
  async readFile(
    file: string,
    opts: { startLine?: number; endLine?: number } = {},
  ): Promise<{
    file: string;
    total_lines: number;
    start: number;
    end: number;
    lines: string[];
  }> {
    const resolved = await this.resolvePath(file);
    const params = new URLSearchParams({ file: resolved });
    let r: Response;
    try {
      r = await this.req("/api/file?" + params.toString());
    } catch (err) {
      if (
        err instanceof GrepnaviError &&
        (err.message.includes("no such file") || err.message.includes("HTTP 500"))
      ) {
        const root = this.cachedRoot ?? "(unknown — call grepnavi_root)";
        throw new GrepnaviError(
          `${err.message}\n\nHint: '${file}' resolved to '${resolved}' but the file was not found. ` +
            `grepnavi root is '${root}'. Relative paths are joined with this root, NOT your working directory. ` +
            `Use grepnavi_definition / grepnavi_callers / grepnavi_callees to discover the correct file path.`,
          err,
        );
      }
      throw err;
    }
    const text = await r.text();
    // grepnavi は最後の \n を出さない (Join with \n) ので split がそのまま行数になる
    const allLines = text.length === 0 ? [] : text.split("\n");
    const total = allLines.length;
    let start = opts.startLine ?? 1;
    let end = opts.endLine ?? total;
    if (start < 1) start = 1;
    if (end > total) end = total;
    if (start > end) {
      throw new GrepnaviError(
        `Invalid range: start_line (${start}) > end_line (${end}). File has ${total} lines.`,
      );
    }
    return {
      file: resolved,
      total_lines: total,
      start,
      end,
      lines: allLines.slice(start - 1, end),
    };
  }

  async definition(word: string, opts: { file?: string; dir?: string } = {}): Promise<DefHit[]> {
    const params = new URLSearchParams({ word });
    if (opts.file) params.set("file", opts.file);
    if (opts.dir) params.set("dir", opts.dir);
    const r = await this.req("/api/definition?" + params.toString());
    const hits = (await r.json()) as DefHit[];
    // 各 hit に likely_trivial / in_caller_subtree フラグ付与 (除外せずに AI 判断材料)
    const enriched = hits.map((h) => ({
      ...h,
      likely_trivial: likelyTrivial(word, h.file),
      in_caller_subtree: inCallerSubtree(h.file, opts.file),
    }));
    // grepnavi の生 order は engine (gtags/ctags/rg) 依存で予測しづらく、
    // enum_member 等が上位に来ると AI が誤った行番号を pick する事故が起きる。
    // bridge 側で kind 優先ソート (func > define > typedef > その他) で正規化。
    // callees enrichment 側の rankDef もこの値を使うので idempotent。
    return enriched.sort((a, b) => kindRankScore(b.kind) - kindRankScore(a.kind));
  }

  async callers(
    word: string,
    opts: { dir?: string; glob?: string } = {},
  ): Promise<CallSite[]> {
    const params = new URLSearchParams({ word });
    if (opts.dir) params.set("dir", opts.dir);
    if (opts.glob) params.set("glob", opts.glob);
    const r = await this.req("/api/callers?" + params.toString());
    return (await r.json()) as CallSite[];
  }

  // /api/callees は (file, line) で「その関数定義の中から呼ばれる識別子と呼び出し行」を返す。
  // 新しい server は [{name, call_line}]、古い server は []string を返すので両形式を吸収する
  // (古い server に当たっても crash させない)。
  async callees(file: string, line: number): Promise<Array<{ name: string; call_line: number }>> {
    const params = new URLSearchParams({ file, line: String(line) });
    const r = await this.req("/api/callees?" + params.toString());
    const data = (await r.json()) as unknown;
    if (!Array.isArray(data)) return [];
    return data.map((c) =>
      typeof c === "string"
        ? { name: c, call_line: 0 }
        : (c as { name: string; call_line: number }),
    );
  }

  async graph(): Promise<GraphResponse> {
    const r = await this.req("/api/graph");
    return (await r.json()) as GraphResponse;
  }

  async addNode(args: {
    file: string;
    line: number;
    text?: string;
    label?: string;
    parent_id?: string;
    edge_label?: string;
    memo?: string;
    tags?: string[];
    badge_color?: string;
    badge_text?: string;
    client_node_id?: string;
  }): Promise<{ node: GraphNode; edge: unknown }> {
    // Match.ID が空だと Store.AddNode で全件同一 ID 扱いになるので、
    // 呼び出し元が client_node_id を渡してきた場合はそれを使い、無ければ生成する。
    // 同じ ID で 2 回呼ぶと server 側 AddNode は dedup して既存を返す (idempotent)。
    const id = args.client_node_id ?? randomBytes(8).toString("hex");
    const body = {
      match: {
        id,
        file: args.file,
        line: args.line,
        col: 0,
        text: args.text ?? "",
        kind: "",
        snippet: [],
        ifdef_stack: [],
        query: "",
      },
      parent_id: args.parent_id ?? "",
      edge_label: args.edge_label ?? "ref",
      label: args.label ?? "",
    };
    const r = await this.req("/api/graph/node", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const created = (await r.json()) as { node: GraphNode; edge: unknown };
    // POST だけでは設定できないフィールド (memo / tags / badge) があれば PUT で追補。
    // 失敗しても node 自体は残るが、AI 視点で「失敗が分からないまま設定落ち」が一番ハマるので fail-fast。
    const followup: Parameters<GrepnaviClient["updateNode"]>[1] = {};
    if (args.memo && args.memo.length > 0) followup.memo = annotateMemo(args.memo);
    if (args.tags && args.tags.length > 0) followup.tags = args.tags;
    if (args.badge_color) followup.badge_color = args.badge_color;
    if (args.badge_text) followup.badge_text = args.badge_text;
    if (Object.keys(followup).length > 0) {
      const updated = await this.updateNode(created.node.id, followup);
      return { node: updated, edge: created.edge };
    }
    return created;
  }

  async updateNode(
    id: string,
    fields: {
      label?: string;
      memo?: string;
      badge_color?: string;
      badge_text?: string;
      line?: number;
      tags?: string[];
    },
  ): Promise<GraphNode> {
    // memo を annotate (addNode 経由で既に tag 済の場合は idempotent でそのまま)
    const payload =
      fields.memo !== undefined
        ? { ...fields, memo: annotateMemo(fields.memo) }
        : fields;
    const r = await this.req("/api/graph/node/" + encodeURIComponent(id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await r.json()) as GraphNode;
  }

  async deleteNode(id: string): Promise<void> {
    await this.req("/api/graph/node/" + encodeURIComponent(id), { method: "DELETE" });
  }

  async moveNode(
    nodeId: string,
    newParentId: string,
    edgeLabel?: string,
  ): Promise<unknown> {
    const r = await this.req("/api/graph/reparent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        node_id: nodeId,
        new_parent_id: newParentId,
        edge_label: edgeLabel ?? "ref",
      }),
    });
    return await r.json();
  }

  async search(opts: {
    pattern: string;
    dir?: string;
    glob?: string;
    case?: boolean;
    word?: boolean;
    regex?: boolean;
    encoding?: string;
    limit?: number;
  }): Promise<{ matches: SearchMatch[] }> {
    const params = new URLSearchParams({ q: opts.pattern });
    if (opts.dir) params.set("dir", opts.dir);
    if (opts.glob) params.set("glob", opts.glob);
    if (opts.case) params.set("case", "1");
    if (opts.word) params.set("word", "1");
    if (opts.regex) params.set("regex", "1");
    if (opts.encoding) params.set("enc", opts.encoding);
    if (opts.limit && opts.limit > 0) params.set("limit", String(opts.limit));
    const r = await this.req("/api/search?" + params.toString());
    return (await r.json()) as { matches: SearchMatch[] };
  }

  async funcBody(
    file: string,
    line: number,
  ): Promise<{ body: string; start_line: number; end_line: number }> {
    const params = new URLSearchParams({ file, line: String(line) });
    const r = await this.req("/api/func-body?" + params.toString());
    return (await r.json()) as { body: string; start_line: number; end_line: number };
  }

  async symbols(file: string): Promise<Symbol[]> {
    const params = new URLSearchParams({ file });
    const r = await this.req("/api/symbols?" + params.toString());
    return (await r.json()) as Symbol[];
  }

  // memo は line_memos / range_memos / bookmarks の 3 つを 1 つの PUT で全置換する
  // API なので、bridge 側で「現在値を fetch → 差分 merge → PUT」を畳む。
  // GUI が同時編集していた場合、bridge と GUI の間で短い race window があるが、
  // 双方が memos.updated SSE で再ロードするので最終状態は収束する想定。
  async writeMemos(
    line_memos: Record<string, string>,
    range_memos: RangeMemo[],
    bookmarks: Record<string, string>,
  ): Promise<void> {
    await this.req("/api/graph/memos", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line_memos, range_memos, bookmarks }),
    });
  }
}
