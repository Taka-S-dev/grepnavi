import { client, ok } from "../shared.js";
import { normalizeInputPath } from "../helpers.js";
import type { ToolDef, ToolHandler } from "../shared.js";
import type { Insertion } from "../client.js";

export const definitions: ToolDef[] = [
  {
    name: "grepnavi_list_insertions",
    description:
      "List the debug lines (printf and the like) grepnavi has recorded, with the file and line each one sits on. Read-only; `source` says who put each one there (`mcp` = you, empty = the user, in the GUI).\n\n" +
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
  {
    name: "grepnavi_insert_debug_line",
    description:
      "Insert printf-style debug lines into the source, and record where they went. **WRITES TO THE USER'S FILES.** Disabled unless grepnavi was started with `-mcp-insert`; without it this returns 403 and you should tell the user the flag rather than retrying.\n\n" +
      "**Read the surrounding code first** (grepnavi_func_body or grepnavi_read_file). You cannot compile or run what you write: a `%s` pointed at a non-string crashes the target, and a line added to a hot path can change timing enough to hide the very bug being chased. The response echoes the lines as written plus their new line numbers — check them.\n\n" +
      "Only whole lines are added; no existing line is ever modified. Write them already indented to match the insertion point.\n\n" +
      "`group` is **required** and is the unit that removes everything you planted — use one group per hypothesis (`path-A`) and keep using it. Templates may contain `{tag}` (replaced with the record id, e.g. `GN9`) and `{group}`; print at least `{tag}` so the output can be traced back with grepnavi_list_insertions.\n\n" +
      "Caps: 20 lines per call, 100 outstanding agent-inserted lines. **Rebuilding and running is the user's job** — say what you added and ask them to run it.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Absolute path, as returned by grepnavi_definition / callers / callees." },
        line: { type: "number", description: "Insert AFTER this 1-based line." },
        lines: {
          type: "array",
          items: { type: "string" },
          description: 'The lines to insert, indented. No newline characters inside an element. e.g. ["    printf(\\"[{tag}] n=%d\\\\n\\", n);"]',
        },
        group: { type: "string", description: 'Removal unit, one per hypothesis (e.g. "path-A"). Required.' },
      },
      required: ["file", "line", "lines", "group"],
    },
  },
  {
    name: "grepnavi_remove_debug_line",
    description:
      "Remove debug lines you inserted and restore the file. **WRITES TO THE USER'S FILES.** Requires `-mcp-insert`, same as inserting.\n\n" +
      "Pass `id` for one record, or `group` to take out everything you planted under that name — the normal way to clean up after a hypothesis is settled.\n\n" +
      "**You can only remove what you inserted.** Lines the user added in the GUI are refused (`id`) or left in place and counted as `kept_not_yours` (`group`); do not try to work around that, tell the user instead.\n\n" +
      "Removal is verified against the recorded text, so a line the user edited by hand is reported in `skipped` rather than guessed at. **The file changes, so the user must rebuild before the removal is reflected in a run.**",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: 'One record id, e.g. "GN9".' },
        group: { type: "string", description: "Every record you planted under this group name." },
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
      // 自分が撒いた分だけを撤去できるので、どれが自分のかを返す
      source: i.source ?? "",
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

  grepnavi_insert_debug_line: async (args) => {
    const a = args as { file: string; line: number; lines: string[]; group: string };
    if (!a?.group) throw new Error("group is required: it is what removes everything you planted");
    if (!Array.isArray(a.lines) || a.lines.length === 0) throw new Error("lines is required");
    // 改行入りの要素はサーバが 400 で返すが、原因が分かる形で先に止める。
    if (a.lines.some((l) => /[\r\n]/.test(l))) {
      throw new Error("no newline characters inside an element — pass one array element per source line");
    }
    const { insertion } = await client.insertDebugLines({
      file: normalizeInputPath(a.file),
      line: a.line,
      lines: a.lines,
      group: a.group,
    });
    // 書いた結果をそのまま返す。{tag} / {group} は差し替わっているので、
    // 何が入ったかは要求した文字列ではなくこちらを読ませる。
    return ok({
      id: insertion.id,
      file: insertion.file,
      group: insertion.group ?? "",
      inserted: insertion.sites,
      note: "The file changed on disk. Ask the user to rebuild and run; then read the output back with grepnavi_list_insertions.",
    });
  },

  grepnavi_remove_debug_line: async (args) => {
    const a = (args ?? {}) as { id?: string; group?: string };
    if (!a.id && a.group === undefined) throw new Error("pass id or group");
    if (a.id) {
      await client.removeDebugLine(a.id);
      return ok({ removed: [a.id], note: "The file changed on disk; the user must rebuild for it to take effect." });
    }
    const r = await client.removeDebugLineGroup(a.group!);
    return ok({
      removed: r.removed,
      skipped: r.skipped,
      // 残した分を黙っていると「全部消えた」と読まれる
      kept_not_yours: r.kept_not_yours ?? 0,
      note: "The file changed on disk; the user must rebuild for it to take effect.",
    });
  },
};
