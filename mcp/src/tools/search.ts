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
    name: "grepnavi_references",
    description:
      "Find every place a symbol is USED — not just called. Use this for struct members, global variables, enum constants and macros, which grepnavi_callers cannot see because it only resolves function calls.\n\n" +
      "Typical questions: \"who writes this field?\", \"where is this global read?\", \"which code depends on this macro?\". Each hit carries `text` (the source line) and `func` when the reference sits inside a function, so you can classify read vs write without another fetch.\n\n" +
      "Comment-only and string-only mentions are filtered out, as are references inside `#if 0`. Returns `{ references, count, engine, truncated }`; `truncated: true` means the cap was reached, so treat the list as a sample and narrow with `dir`, `filter` or `assign`.\n\n" +
      "**Answer \"who writes this?\" with `assign: true`** instead of reading every hit: it keeps only the lines that write the symbol (`=`, `+=`, `++`, ...), judged on the source line with comments and strings stripped. A field with 200 references usually has a handful of writes.\n\n" +
      "**Narrow with `filter` before the cap bites.** It is applied on the server, over everything the index returned, so it reaches hits that `limit` would have cut off — filtering the returned list cannot. Space-separated terms are AND, a leading `-` excludes, and `path:` / `file:` match the path only: `filter: \"path:net/ipv4 -test\"`.\n\n" +
      "**`group: \"value,func\"` is usually what you want**: it answers \"which value, set by which function, on which lines\" in one call. One level names the values but not the places, so you end up fetching the raw list anyway - two calls that together cost more than the ungrouped list did.\n\n" +
      "**Note `group: \"func\"` and `group: \"file\"` count reads as well as writes.** Only `value` implies `assign` (a read has no assigned value). Pass `assign: true` explicitly with the other two when you mean writes.\n\n" +
      "**Use `group` when a symbol has more references than you want to read.** One row per hit does not scale: openssl\u0027s `hand_state` has 132 writes and the plain list stops at the first 100, so its distribution is of a sample. `group` counts every hit before the cap and comes back as \"which value, how many times, where\" - the shape the question was asked in.\n\n" +
      "**Next step**: grepnavi_func_body on an interesting `func` to see the surrounding logic, or grepnavi_callers if the symbol turns out to be a function after all.",
    inputSchema: {
      type: "object",
      properties: {
        word: { type: "string", description: "Symbol to look for (field, global, macro, enum constant...)." },
        dir: { type: "string", description: "Optional subdirectory to limit the search." },
        limit: { type: "integer", description: "Max references to return (default 100)." },
        assign: {
          type: "boolean",
          description: "Keep only the lines that write the symbol. Use for \"who sets this?\".",
        },
        filter: {
          type: "string",
          description:
            "Narrow on the server, over every hit the index returned. Space = AND, leading `-` excludes, `path:` / `file:` match the path only. Example: \"path:net/ipv4 -test\".",
        },
        group: {
          type: "string",
          description:
            "Return counts per group instead of one row per hit. One of `value` (what the writes assign; implies assign), `func` (enclosing function), `file`. Give two comma-separated for a two-level breakdown, e.g. \"value,func\" — the inner level carries every line number, so no second call is needed to find the places.",
        },
        sample: {
          type: "integer",
          description: "Locations to attach to each group, 0-2 (default 1). Only with `group`.",
        },
      },
      required: ["word"],
    },
  },
  {
    name: "grepnavi_ifdef_context",
    description:
      "Show which `#ifdef` / `#if` blocks enclose a line, outermost first.\n\n" +
      "Use it before concluding that code is live. In C a function or branch often exists only under a config (`CONFIG_BLK_CGROUP_PUNT_BIO`, `_WIN32`, `DEBUG`), and definition / callers / callees results carry no such marker — only `grepnavi_search` hits do, via `ifdef_stack`.\n\n" +
      "Returns `{ guarded, frames: [{ line, directive, condition }] }`; `frames` is empty when the line is unconditional. **This is structural nesting only** — grepnavi does not evaluate config values, so a condition means \"guarded by this\", never \"disabled\". Report the guard instead of deciding compiled-in yourself.\n\n" +
      "**Next step**: grepnavi_search the condition name to see where it is set, or grepnavi_read_file around the directive lines to read the alternative branch.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "File containing the line." },
        line: { type: "integer", description: "1-based line number to inspect." },
      },
      required: ["file", "line"],
    },
  },
  {
    name: "grepnavi_definitions",
    description:
      "Resolve MANY symbols in one call. Same engine and ranking as grepnavi_definition, run concurrently.\n\n" +
      "Use this whenever you have a list of names to place — e.g. every entry returned by grepnavi_callees, or the symbols you plan to pin as nodes. One call instead of N saves round trips and tokens.\n\n" +
      "Returns `{ results: [{ word, hits, hint? }] }` in the order requested; a symbol that resolves to nothing simply has an empty `hits` (the call does not fail).\n\n" +
      "**Next step**: feed the resolved file/line pairs straight into grepnavi_graph_add_nodes, or grepnavi_func_body for the ones you need to read.",
    inputSchema: {
      type: "object",
      properties: {
        words: {
          type: "array",
          items: { type: "string" },
          description: "Symbols to resolve (max 50).",
        },
        file: { type: "string", description: "Optional current file path. Improves ranking for local definitions." },
        dir: { type: "string", description: "Optional subdirectory to limit the search." },
      },
      required: ["words"],
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
    name: "grepnavi_symbol_search",
    description:
      "Find symbols by NAME PATTERN across the whole project (regex over ctags symbol names, case-insensitive by default). **Use when you don't know the exact identifier** — the user says \"the recipe save function\" and the name could be `save_recipe` / `RecipeSave` / `recipe_write`: search `recipe.*(save|write)` in ONE call instead of guessing names one by one through grepnavi_definition.\n\n" +
      "Returns `{ symbols: [{name, text, kind, file, line}], count, truncated, hint? }` where `text` is the definition line itself, so you can often pick the right symbol without reading the file. Sorted: exact name match first, then `func > define > typedef > others`, then name. `truncated: true` = more matches exist — narrow the pattern or filter with `kind`.\n\n" +
      "This searches symbol NAMES (definitions) only, not file content — for content matches use grepnavi_search.\n\n" +
      "**Next step**: pick the right name, then grepnavi_definition(name) for ranked resolution across engines, or jump straight to grepnavi_func_body(file, line) with the returned location.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Regex matched against symbol names (e.g. 'recipe.*(save|write)', '^usb_.*_init$'). Case-insensitive unless `case` is true.",
        },
        kind: {
          type: "string",
          enum: ["func", "define", "typedef", "struct", "enum", "enum_member", "member", "var", "union"],
          description: "Limit results to one symbol kind.",
        },
        case: { type: "boolean", description: "Case-sensitive match when true (default false)." },
        limit: { type: "integer", description: "Max results (default 50, max 200)." },
      },
      required: ["pattern"],
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
      "**Do not grep for assignments.** A pattern like \"x =\" also matches \"x ==\", misses \"x  =\" and \"*p =\", and cannot tell a write from a comparison. grepnavi_references with `assign: true` decides that on the comment-stripped line, and `group: \"value\"` returns the values themselves.\n\n" +
      "**Set `context: 0` unless you need the surrounding lines.** The snippet is 8 lines per hit and is most of the response. Read the surroundings with grepnavi_func_body on the few hits that matter instead.\n\n" +
      "Returns matches with file, line, col, text, optional 8-line snippet, `non_utf8: true` when fallback decoding was used, and `enclosing_function` ({name, start_line}, C files) — the function containing the hit.\n\n" +
      "**Group hits by `enclosing_function` BEFORE reading anything**: 30 hits are often just 4-5 functions. Read each unique function once via grepnavi_func_body(file, enclosing_function.start_line) instead of investigating hit by hit.\n\n" +
      "**0 matches may come with a `hint`** explaining a probable tool-use mistake (glob matched no files; regex syntax in a literal search). Read it and retry before concluding the text does not exist.\n\n" +
      "**Next step**: each match's `file` is absolute. Feed it to grepnavi_func_body (for the surrounding function), grepnavi_read_file (for a wider range), or grepnavi_callers (if the hit is a function name). Don't dump huge searches without `limit` — set it to 20-50 first, paginate with `next_offset` only if the user actually needs more.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Text or regex to search for." },
        context: {
          type: "integer",
          description:
            "Lines of context around each hit, 0-8 (default 8). Set 0 when you only need locations - the context lines are most of the payload and grow with the hit count.",
        },
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
      "**Prefer this over grepnavi_read_file when you want a function**: one call vs computing line ranges. Use grepnavi_read_file only for non-function ranges or whole files." +
      "**Pass `at` to read one case instead of the whole function.** A transition function is one big switch; feeding it the line numbers from grepnavi_references group=\"value,func\" returns just those cases, so parallel fetches stop overflowing.\n\n",
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
        at: {
          type: "array",
          items: { type: "integer" },
          description:
            "Return only the switch cases containing these lines, not the whole function. Feed the line numbers from grepnavi_references group=\"value,func\".",
        },
        containing: {
          type: "string",
          description:
            "Return only the switch cases mentioning this text. Use `at` instead when you already know the lines — a name that appears in six cases returns all six.",
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
      "Each result carries `text`: the source of the call line itself. **Judge from `text` before fetching anything** — it shows whether the hit is a plain call, a function-pointer assignment (`.submit = foo`), or a macro wrapper, so you rarely need a second round trip to classify a caller.\n\n" +
      "Comment-only and string-only mentions are already filtered out, as are calls inside `#if 0` blocks. Calls reached through function pointers or generated by macros cannot be resolved by any text-based engine, so treat the list as complete-for-direct-calls, not exhaustive.\n\n" +
      "**Cost note**: `depth > 1` fans out per-level and can take several seconds on large codebases. Start with depth 1, only increase when you actually need the wider tree.\n\n" +
      "**Next step**: `text` not enough? grepnavi_func_body(caller_file, def_line) for the full calling context, or grepnavi_callers again (depth 1) to walk up one more level.",
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
      "`compact: true` drops the judgement fields and returns name / call_line / kind / `pin` (= recommended_for_tree) / `def` only — a fraction of the tokens when you only need the list to pick from.\n\n" +
      "**A large answer compacts itself.** When you pass neither value and the full form would be over ~8 KB, the response comes back compact with a `compacted` field naming what was dropped and how to get it — a function with 38 callees is 12.5 KB full and 5 KB compact, and past that size the answer tends to be set aside unread rather than used. Pass `compact: false` when you actually need the judgement fields, ideally with `depth: 1` or a narrower caller.\n\n" +
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
        compact: {
          type: "boolean",
          description:
            "Return only name, call_line, kind, `pin` (= recommended_for_tree) and `def` (\"file:line\"). Use when you just need the list of callees to pick from; omit it when you need the judgement fields (engine / confidence / likely_* / definitions).",
        },
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
  {
    name: "grepnavi_structure",
    description:
      "CALL THIS FIRST when the question is about the shape of the codebase rather than one symbol: \"where do I start reading?\", \"which modules does X cross?\", \"what does this depend on?\". One call answers what would otherwise take a dozen searches, and it comes from the index, so it cannot name a file that does not exist.\n\n" +
      "Skip it when you already have a symbol to chase — grepnavi_definition, grepnavi_references and grepnavi_callers answer that directly.\n\n" +
      "It returns which parts of the tree reference which, folded from the gtags index.\n\n" +
      "Without `focus` you get the whole tree folded into parts, ordered by how much they are referenced — the top of that list is what everything else depends on, which is usually where reading starts. Large parts are split by weight, so a deep boundary like `drivers/net` appears beside a shallow one like `net`; a name that is also a prefix of others is the REMAINDER of its children, not their total.\n\n" +
      "With `focus: \"<path>\"` you get that part alone: `incoming` (which outside parts enter through which file — the concentration here is its public face), `internal` (its pieces referencing each other), `outgoing` (what it depends on). Every edge is \"from>to:count\", where count is (symbol, referencing file) pairs, not lines. A name ending in `/` is a folder, so its references spread over several files.\n\n" +
      "**`built: false` means the map does not exist yet.** Building reads the whole index (seconds on a small tree, about a minute on a kernel-sized one), so it never starts on its own — tell the user to open the map panel and press build, and answer the question another way for now.\n\n" +
      "`omitted.same_name` counts symbols implemented in several files, left out because the index cannot say which one a reference means; `omitted.same_name_refs` is how many references that hides. Absence from the map is not proof that nothing references a part.",
    inputSchema: {
      type: "object",
      properties: {
        focus: {
          type: "string",
          description: "Path of one part, e.g. \"ssl/record\". Omit for the whole tree.",
        },
        top: {
          type: "number",
          description: "Edges per list (default 40). Raise only when the default was cut and you need more.",
        },
      },
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  grepnavi_structure: async (args) => {
    const a = args as { focus?: string; top?: number };
    return ok(await client.structure(a));
  },
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
  grepnavi_references: async (args) => {
    const a = args as {
      word: string; dir?: string; limit?: number; assign?: boolean;
      filter?: string; group?: string; sample?: number;
    };
    if (!a.word) throw new Error("`word` is required");
    if (a.group) {
      const g = await client.groupReferences(a.word, a.group, {
        dir: normalizeInputPath(a.dir),
        filter: a.filter,
        assign: a.assign,
        sample: a.sample,
      });
      return ok({
        ...g,
        note: g.truncated
          ? "Capped while counting: the distribution is over a sample, not every hit. Narrow with `filter` or `dir`."
          : "`sample` paths are relative to `root`. Ask again without `group` and with `filter` to list one group in full.",
      });
    }
    const r = await client.references(a.word, {
      dir: normalizeInputPath(a.dir),
      limit: a.limit,
      assign: a.assign,
      filter: a.filter,
    });
    return ok({
      references: r.refs,
      count: r.refs.length,
      engine: r.engine,
      truncated: r.truncated,
      hint: r.hint,
      assign_only: a.assign || undefined,
      filter: a.filter || undefined,
      note: r.truncated
        ? "Capped: this is a sample, not every reference. Narrow with `filter`, `assign` or `dir` — they are applied before the cap, so they reach hits this list does not contain."
        : undefined,
    });
  },
  grepnavi_ifdef_context: async (args) => {
    const a = args as { file: string; line: number };
    if (!a.file || !a.line) throw new Error("`file` and `line` are both required");
    const frames = await client.ifdefStack(normalizeInputPath(a.file)!, a.line);
    return ok({
      file: a.file,
      line: a.line,
      guarded: frames.length > 0,
      frames,
      note: frames.length
        ? "Structural nesting only: grepnavi does not evaluate config values, so this says the line is guarded, not that it is disabled."
        : undefined,
    });
  },
  grepnavi_definitions: async (args) => {
    const a = args as { words: string[] | string; file?: string; dir?: string };
    // 単数の grepnavi_definition と1文字違いなので、文字列1つで呼ばれる。
    // 意味は明らかなので受け取る（弾いても呼び直しに1往復かかるだけ）
    if (typeof a.words === "string" && a.words.trim()) a.words = [a.words.trim()];
    if (!Array.isArray(a.words) || a.words.length === 0)
      throw new Error(
        "`words` must be a non-empty array of symbol names, e.g. [\"ssl3_read_bytes\", \"tls1_enc\"]. " +
          "For one symbol use grepnavi_definition instead.",
      );
    if (a.words.length > 50)
      throw new Error(`\`words\` is limited to 50 symbols (got ${a.words.length})`);
    const opts = { file: normalizeInputPath(a.file), dir: normalizeInputPath(a.dir) };
    // 1件の失敗で全体を落とさない: 解決できない語は hits 空で返す
    const results = await Promise.all(
      a.words.map(async (word) => {
        try {
          return { word, ...(await client.definition(word, opts)) };
        } catch (e) {
          return { word, hits: [], hint: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    return ok({ results });
  },
  grepnavi_symbol_search: async (args) => {
    const a = args as { pattern: string; kind?: string; case?: boolean; limit?: number };
    return ok(await client.symbolSearch(a.pattern, a));
  },
  grepnavi_search: async (args) => {
    const a = args as Parameters<typeof client.search>[0];
    return ok(await client.search({ ...a, dir: normalizeInputPath(a.dir) }));
  },
  grepnavi_func_body: async (args) => {
    const a = args as {
      word?: string; file?: string; line?: number;
      at?: number[]; containing?: string;
    };
    let file = normalizeInputPath(a.file);
    let line = a.line;
    if (!file || !line) {
      if (!a.word)
        throw new Error("Either `word` or (`file`+`line`) is required");
      const resolved = await resolveWordToLocation(a.word);
      file = resolved.file;
      line = resolved.line;
    }
    // at / containing が来たら関数全体ではなく該当する case だけ返す
    if ((a.at && a.at.length) || a.containing) {
      return ok(await client.funcBodyBlocks(file, line, { at: a.at, containing: a.containing }));
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
      compact?: boolean;
    };
    return ok(await resolveAndEnrichCallees({ ...a, file: normalizeInputPath(a.file) }));
  },
};
