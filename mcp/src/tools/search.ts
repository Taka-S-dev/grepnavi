import { client, ok, text } from "../shared.js";
import type { ToolDef, ToolHandler } from "../shared.js";
import {
  formatFileContent,
  resolveWordToLocation,
  callersTree,
  resolveAndEnrichCallees,
  normalizeInputPath,
} from "../helpers.js";

export const definitions: ToolDef[] = [
  {
    name: "grepnavi_read_file",
    description:
      "Read a file from grepnavi's tree with correct encoding (SJIS / EUC-JP auto-decoded to UTF-8). Returns content with `<line>\\t<text>` line prefixes.\n\n" +
      "**When to use this vs your own Read tool**:\n" +
      "  - Source may not be UTF-8 (SJIS / EUC-JP) → grepnavi_read_file (your own Read will mangle multi-byte chars silently).\n" +
      "  - Source is confirmed UTF-8 and you already know the path → your own Read tool is fine.\n" +
      "  - You only need a specific function body → use grepnavi_func_body instead (one call, no line math).\n\n" +
      "Pass the absolute `file` returned by grepnavi_definition / callers / callees / search verbatim. Relative paths get joined with grepnavi_root.\n\n" +
      "`start_line` / `end_line` are 1-based inclusive; omit both for the whole file (10 MB cap). For large files, ALWAYS pass a range — full reads burn context.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Absolute path, or relative to grepnavi_root (e.g. 'fs/affs/dir.c').",
        },
        start_line: { type: "integer", description: "1-based inclusive start line." },
        end_line: { type: "integer", description: "1-based inclusive end line." },
      },
      required: ["file"],
    },
  },
  {
    name: "grepnavi_definition",
    description:
      "Resolve a symbol to file:line via gtags → ctags → ripgrep fallback. Each hit has `kind`, `engine`, plus `likely_trivial` (well-known primitive name) and `in_caller_subtree` (true when this hit shares the caller's top-2 path components — pass `file` for this to work).\n\n" +
      "**Returns `{ hits, hint? }`**. `hits` is empty when nothing matched. `hint` (optional) explains *why* — e.g. 'X is a #define/enum constant but its location could not be resolved', or 'no ctags/gtags index built'. Surface this hint when reporting back to the user instead of just saying 'not found'.\n\n" +
      "**Results are pre-sorted by bridge: `func > define > typedef > others`**, so hits[0] is usually the actual implementation. Prefer .c over .h when both exist at the top.\n\n" +
      "**Next step**: take `hits[0].file` + `hits[0].line` and feed them to grepnavi_func_body (to read the implementation) or grepnavi_callees (to see what it calls). The `file` is absolute — pass verbatim.",
    inputSchema: {
      type: "object",
      properties: {
        word: {
          type: "string",
          description: "Identifier to resolve (function, struct, macro, etc).",
        },
        file: {
          type: "string",
          description: "Optional current file path. Improves ranking for local definitions.",
        },
        dir: {
          type: "string",
          description: "Optional subdirectory to limit search.",
        },
      },
      required: ["word"],
    },
  },
  {
    name: "grepnavi_search",
    description:
      "Ripgrep through MCP, with SJIS/EUC-JP auto-decode and paginated results. Same engine as `rg` on the Bash side — same hits, same regex syntax — plus a few extras grepnavi adds on top.\n\n" +
      "**When to prefer this over Bash `rg`**:\n" +
      "  - Source may not be UTF-8 (SJIS / EUC-JP / UTF-16). Raw `rg` will silently miss multi-byte matches; this auto-decodes.\n" +
      "  - You want chunked retrieval via `limit` + `next_offset` instead of one giant response.\n" +
      "  - You want per-hit ifdef stack on C/C++ matches for context.\n\n" +
      "**When Bash `rg` is fine**: source is confirmed UTF-8 AND you just want a quick one-shot search. Same results, less plumbing.\n\n" +
      "Returns matches with file, line, col, text, optional 8-line snippet, and `non_utf8: true` when fallback decoding was used.\n\n" +
      "**Next step**: each match's `file` is absolute. Feed it to grepnavi_func_body (for the surrounding function), grepnavi_read_file (for a wider range), or grepnavi_callers (if the hit is a function name). Don't dump huge searches without `limit` — set it to 20-50 first, paginate with `next_offset` only if the user actually needs more.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Text or regex to search for." },
        dir: { type: "string", description: "Optional subdirectory (relative to root or absolute)." },
        glob: { type: "string", description: "Optional file glob (e.g. '*.c', '!vendor/**')." },
        case: { type: "boolean", description: "Case-sensitive when true (default false)." },
        word: {
          type: "boolean",
          description:
            "Whole-word match when true (default false). Wraps the pattern with word boundaries.",
        },
        regex: {
          type: "boolean",
          description:
            "Treat pattern as a regular expression when true (default false = literal).",
        },
        encoding: {
          type: "string",
          enum: ["sjis", "euc-jp", "utf-16le", "utf-16be"],
          description:
            "Force a specific source encoding. Usually omit — grepnavi auto-detects.",
        },
        limit: {
          type: "integer",
          description: "Cap on number of matches returned. Set this when you only need a sample; response includes `has_more` and `next_offset` for pagination.",
        },
        offset: {
          type: "integer",
          description: "Skip this many matches before returning (pagination). Use with `limit`. Default 0.",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grepnavi_func_body",
    description:
      "Return the full body of a function in one call — finds the enclosing { ... } and returns it with start/end line numbers.\n\n" +
      "Pass `word` (function name) for auto-resolve via grepnavi_definition (same flow as grepnavi_callees) — lets you parallelize with definition/callees calls. Or pass `file`+`line` directly to skip resolution. Errors on ambiguity with candidate list, then disambiguate via `file`+`line`.\n\n" +
      "**Prefer this over grepnavi_read_file when you want a function**: one call vs computing line ranges. Use grepnavi_read_file only for non-function ranges or whole files.",
    inputSchema: {
      type: "object",
      properties: {
        word: {
          type: "string",
          description:
            "Function name. If `file`+`line` are omitted, the bridge resolves via grepnavi_definition.",
        },
        file: { type: "string", description: "File containing the function." },
        line: {
          type: "integer",
          description: "Any line within the function (typically the definition line).",
        },
      },
    },
  },
  {
    name: "grepnavi_symbols",
    description:
      "List the top-level symbols (functions / typedef / struct / etc) defined in a single file, with their line ranges. Use this for a quick outline of a file before diving into specific functions.\n\n" +
      "**Next step**: pick the interesting entry, then grepnavi_func_body(file, line) or grepnavi_read_file(file, start_line, end_line) to drill in. Avoid `grepnavi_read_file` on the whole file just to find one function — symbols + func_body is cheaper.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "File to outline." },
      },
      required: ["file"],
    },
  },
  {
    name: "grepnavi_callers",
    description:
      "Find call sites that invoke `word` (caller function, file, definition line, call line). Walks UP the call tree. `depth` > 1 recurses (max 5); cycles auto-pruned.\n\n" +
      "**Cost note**: `depth > 1` fans out per-level and can take several seconds on large codebases. Start with depth 1, only increase when you actually need the wider tree.\n\n" +
      "**Next step**: for each caller you care about, grepnavi_func_body(caller_file, def_line) to see the calling context, or grepnavi_callers again (depth 1) to walk up one more level.",
    inputSchema: {
      type: "object",
      properties: {
        word: { type: "string", description: "Function name to find callers of." },
        dir: { type: "string", description: "Optional subdirectory to limit search." },
        glob: { type: "string", description: "Optional file glob (e.g. '*.c')." },
        depth: { type: "integer", description: "Levels to walk up (default 1, max 5)." },
      },
      required: ["word"],
    },
  },
  {
    name: "grepnavi_callees",
    description:
      "Find functions called from a given caller. Walks DOWN the call tree.\n\n" +
      "Pass `word` (caller name) for auto-resolve via grepnavi_definition; errors on ambiguity with candidate list, then disambiguate via `file`+`line`. Or pass `file`+`line` directly.\n\n" +
      "Each result: `name`, `call_line`, `kind`, `engine`, `confidence` ('high'|'medium'|'low' for the picked top definition — **'low' means the pick may be wrong**), `likely_macro`, `likely_non_callable`, `likely_trivial` (well-known primitives: locking / atomics / mem-str / printk / le_to_cpu / container_of etc — definition lookup is **skipped entirely** for these to avoid bogus picks like spin_lock → selftests/.../spinlock.c), `in_caller_subtree` (def shares caller's dir tree = same subsystem), `recommended_for_tree` (= !macro && !non_callable && !trivial — **the simple filter for 'what to actually pin'**), `definitions` (top 1, proximity-ranked), `definitions_total`. Caller itself auto-excluded.\n\n" +
      "**Defaults**: `exclude_macros: true`, `exclude_non_callable: true` (noise filtered out; pass false to see). The response's `excluded.macros` / `excluded.non_callable` are **arrays of NAMES** that were dropped — eyeball them to confirm they're real noise, no re-query needed.\n\n" +
      "`depth` > 1 recurses (max 5). Macros / no-def / cycles don't recurse further. **Cost note**: each extra level fans out and can take seconds; start at depth 1 unless you need more.\n\n" +
      "**Call-tree node anchor (critical)**: when pinning callees as child nodes, use the CALLER's file + the callee's `call_line` — NOT the callee's definition. This activates grepnavi's call ↔ definition memo sync and keeps clicks in the parent's file.\n\n" +
      "**Next step**: pick `recommended_for_tree: true` entries, then grepnavi_func_body(definitions[0].file, definitions[0].line) to inspect each. For macros, grepnavi_search the name to find the #define.",
    inputSchema: {
      type: "object",
      properties: {
        word: { type: "string", description: "Caller name. Auto-resolved via grepnavi_definition if file+line omitted." },
        file: { type: "string", description: "Caller's file (skip resolve / disambiguate `word`)." },
        line: { type: "integer", description: "Caller's definition line. Required with `file`." },
        exclude_macros: { type: "boolean", description: "Drop likely_macro entries. Default true." },
        exclude_non_callable: { type: "boolean", description: "Drop likely_non_callable entries. Default true." },
        depth: { type: "integer", description: "Recursion levels (default 1, max 5)." },
        with_preview: {
          type: "boolean",
          description:
            "When true, attach `body_preview` (first N lines of the function body) to each kept callee. Lets you mark memos as [確認済] without a separate grepnavi_func_body round-trip. Skipped for trivial/macro/non-callable. Default false (extra fetch per callee).",
        },
        preview_lines: {
          type: "integer",
          description: "Lines to include in body_preview when with_preview=true (default 8, max 30).",
        },
      },
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  grepnavi_read_file: async (args) => {
    const a = args as { file: string; start_line?: number; end_line?: number };
    const r = await client.readFile(normalizeInputPath(a.file), {
      startLine: a.start_line,
      endLine: a.end_line,
    });
    return text(formatFileContent(r));
  },
  grepnavi_definition: async (args) => {
    const a = args as { word: string; file?: string; dir?: string };
    return ok(await client.definition(a.word, {
      file: normalizeInputPath(a.file),
      dir: normalizeInputPath(a.dir),
    }));
  },
  grepnavi_search: async (args) => {
    const a = args as Parameters<typeof client.search>[0];
    return ok(await client.search({ ...a, dir: normalizeInputPath(a.dir) }));
  },
  grepnavi_func_body: async (args) => {
    const a = args as { word?: string; file?: string; line?: number };
    let file = normalizeInputPath(a.file);
    let line = a.line;
    if (!file || !line) {
      if (!a.word)
        throw new Error("Either `word` or (`file`+`line`) is required");
      const resolved = await resolveWordToLocation(a.word);
      file = resolved.file;
      line = resolved.line;
    }
    return ok(await client.funcBody(file, line));
  },
  grepnavi_symbols: async (args) => {
    const a = args as { file: string };
    return ok(await client.symbols(normalizeInputPath(a.file)));
  },
  grepnavi_callers: async (args) => {
    const a = args as {
      word: string;
      dir?: string;
      glob?: string;
      depth?: number;
    };
    return ok(await callersTree({ ...a, dir: normalizeInputPath(a.dir) }));
  },
  grepnavi_callees: async (args) => {
    const a = args as {
      word?: string;
      file?: string;
      line?: number;
      exclude_macros?: boolean;
      exclude_non_callable?: boolean;
      depth?: number;
      with_preview?: boolean;
      preview_lines?: number;
    };
    return ok(await resolveAndEnrichCallees({ ...a, file: normalizeInputPath(a.file) }));
  },
};
