import { client, ok } from "../shared.js";
import type { ToolDef, ToolHandler } from "../shared.js";
import type { Insertion } from "../client.js";

export const definitions: ToolDef[] = [
  {
    name: "grepnavi_list_insertions",
    description:
      "List the debug lines (printf and the like) grepnavi has recorded, with the file and line each one sits on. READ-ONLY: the bridge never inserts, edits or removes them — the user does that in the GUI.\n\n" +
      "**The main use is reading a program's own output back to its source.** Each record's `id` (\"GN9\") is the `{tag}` that was substituted into the line when it was inserted, so a run that printed `[GN9] ssl3_read_n:1301` can be resolved here to the exact file, line and source text. Pass `tag: \"GN9\"` to look up one, or `group` / `file` to narrow.\n\n" +
      "**Absence is evidence, but only under conditions.** A recorded line whose tag never appeared in the output means that path did not run — provided `enabled` is true and the binary being run was built after the insertion. `enabled: false` means the line is commented out, so its silence means nothing. The bridge cannot tell whether the running binary is current; ask the user if it matters.\n\n" +
      "`group` is the removal unit the user chose (e.g. `path-A`, one hypothesis per group); templates can embed it, so it may also appear in the output. `kind: \"wrap\"` is an `#if 0` / `#endif` pair around existing code, not a print.\n\n" +
      "**Next step**: grepnavi_func_body or grepnavi_read_file on the returned file:line to see what surrounds the line that fired.",
    inputSchema: {
      type: "object",
      properties: {
        tag: {
          type: "string",
          description: 'Resolve one id seen in program output, e.g. "GN9". Case-insensitive.',
        },
        group: { type: "string", description: 'Keep only this group. Pass "" for the ungrouped ones.' },
        file: { type: "string", description: "Keep only records in files whose path contains this substring." },
        enabled_only: { type: "boolean", description: "Drop the commented-out ones (default false)." },
      },
    },
  },
];

export interface InsertionFilter {
  tag?: string;
  group?: string;
  file?: string;
  enabled_only?: boolean;
}

// selectInsertions は記録一覧を絞り込む。タグ照合は大文字小文字を無視し、
// パスは Windows の \ を / に均してから部分一致で見る（AI が渡してくる
// パスの区切りは、どのツールの出力を経由したかで揺れる）。
export function selectInsertions(all: Insertion[], a: InsertionFilter): Insertion[] {
  let hits = all;
  if (a.tag) {
    const want = a.tag.trim().toLowerCase();
    hits = hits.filter((i) => i.id.toLowerCase() === want);
  }
  // group は「無グループだけ」を頼めるよう、空文字と未指定を区別する。
  if (a.group !== undefined) hits = hits.filter((i) => (i.group ?? "") === a.group);
  if (a.file) {
    const want = a.file.replace(/\\/g, "/").toLowerCase();
    hits = hits.filter((i) => i.file.replace(/\\/g, "/").toLowerCase().includes(want));
  }
  if (a.enabled_only) hits = hits.filter((i) => i.enabled);
  return hits;
}

export const handlers: Record<string, ToolHandler> = {
  grepnavi_list_insertions: async (args) => {
    const a = (args ?? {}) as InsertionFilter;
    const g = await client.graph();
    const all: Insertion[] = Array.isArray(g.insertions) ? g.insertions : [];
    const hits = selectInsertions(all, a);

    // グループ別の件数は全件から数える。絞り込んだ結果だけを見せると
    // 「他にどんな仕込みがあるか」が分からず、撒き直しの判断ができない。
    const groups: Record<string, number> = {};
    for (const i of all) groups[i.group ?? ""] = (groups[i.group ?? ""] ?? 0) + 1;

    const out = hits.map((i) => ({
      id: i.id,
      file: i.file,
      group: i.group ?? "",
      enabled: i.enabled,
      kind: i.kind ?? "",
      sites: i.sites.map((s) => ({ line: s.line, text: s.text })),
    }));

    const res: Record<string, unknown> = {
      root_dir: g.root_dir,
      total: all.length,
      shown: out.length,
      groups,
      insertions: out,
    };
    // 探したタグが無いのは「間違ったタグ」か「別の調査ファイルを開いている」
    // かのどちらか。黙って空配列を返すと前者だと思い込まれる。
    if (a.tag && out.length === 0) {
      res.hint =
        `No insertion with id "${a.tag}" is recorded in the project file now open (${all.length} recorded). ` +
        `Either the tag came from an older build, or grepnavi has a different investigation JSON open.`;
    }
    return ok(res);
  },
};
