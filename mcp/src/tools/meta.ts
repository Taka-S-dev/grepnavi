import { BRIDGE_VERSION, client, ok } from "../shared.js";
import type { ToolDef, ToolHandler } from "../shared.js";

export const definitions: ToolDef[] = [
  {
    name: "grepnavi_root",
    description:
      "Return grepnavi's current root directory (absolute path) and bridge_version. The root may DIFFER from your working directory — anchor all subsequent file paths to this root.\n\n" +
      "**Read this first — investigation workflows.** Most user requests resolve through one of these chains. Use them as recipes; don't try to one-shot everything through grepnavi_search.\n\n" +
      "1. *\"Where is X output / written / created?\"*\n" +
      "   - grepnavi_search the keyword (e.g. \"recipe\") to find write-like call sites.\n" +
      "   - For each promising hit: grepnavi_func_body on the surrounding function to confirm it actually writes.\n" +
      "   - grepnavi_callers on that function to trace who triggers the write.\n\n" +
      "2. *\"What does function F do?\"*\n" +
      "   - grepnavi_definition(\"F\") → file:line of the implementation.\n" +
      "   - grepnavi_func_body(file, line) → read the body.\n" +
      "   - grepnavi_callees(file, line) for the downstream call chain; recurse with depth 1 each step instead of jumping to depth 3.\n\n" +
      "3. *\"What does this file contain / outline a header.\"*\n" +
      "   - grepnavi_symbols(file) for the outline.\n" +
      "   - grepnavi_read_file(file, start_line, end_line) to read targeted ranges instead of the whole file.\n\n" +
      "4. *\"Who calls function F?\"*\n" +
      "   - grepnavi_callers(\"F\", depth=1). Only bump depth when you actually need the wider tree — each level fans out.\n\n" +
      "5. *Exact symbol name unknown* (the user describes behavior, not an identifier).\n" +
      "   - grepnavi_symbol_search(\"recipe.*(save|write)\") → candidate names with kind/file/line in one call.\n" +
      "   - Then grepnavi_definition / grepnavi_func_body on the name you picked.\n\n" +
      "**Tool ↔ file access**: Every grepnavi_* result's `file` is an ABSOLUTE path. Three ways to read content:\n" +
      "  - grepnavi_read_file → SAFE for SJIS / EUC-JP source (auto-decode). Use when encoding is unknown or known non-UTF-8.\n" +
      "  - grepnavi_func_body → one call returns the whole function with line numbers; preferred for \"show me this function\".\n" +
      "  - Your own Read tool (Claude Code Read, Codex view_file, etc.) → fine when source is confirmed UTF-8.\n\n" +
      "**Avoid**: hand-building relative paths from memory, calling grepnavi_search with no `limit` on huge repos, jumping to depth>1 on callers/callees before depth=1 told you anything, guessing identifier names one by one through grepnavi_definition (use grepnavi_symbol_search).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "grepnavi_editor_state",
    description:
      "Return a snapshot of the user's Monaco editor: `active_file`, `cursor` (line / column), `selection` (range or omitted), `viewport` (visible line range), plus `fresh` and `last_updated_ms_ago` for staleness signaling. Use this to handle requests like \"explain this function\" or \"add a memo to this range\" without making the user spell out file:line.\n\n" +
      "**MANDATORY safety checks before any destructive op (grepnavi_set_line_memo, grepnavi_set_range_memo, grepnavi_graph_add_node, grepnavi_graph_update_node, grepnavi_graph_delete_node, grepnavi_graph_move_node) anchored on this response**:\n" +
      "1. If `fresh` is false (no editor activity in the last ~20 s — browser closed, idle, or backgrounded), DO NOT silently use the cached state. Ask the user what they want.\n" +
      "2. Echo back the resolved `file`, `line` and any range you intend to act on, and get explicit confirmation from the user before invoking the destructive tool.\n" +
      "3. Compare `root` to grepnavi_root — the user may have multiple grepnavi tabs, and `editor_state` reflects whichever pushed last. If they differ, ask which instance to target.\n\n" +
      "**Non-destructive reads (grepnavi_read_file, grepnavi_func_body, grepnavi_definition, grepnavi_callers, grepnavi_callees, grepnavi_search, grepnavi_symbols, grepnavi_list_memos)** may use `editor_state` without explicit confirmation, but still respect `fresh=false` by mentioning the staleness to the user when summarizing results.\n\n" +
      "If the response includes `server_supported: false`, the running grepnavi predates this endpoint — fall back to asking the user for file:line and tell them to rebuild grepnavi.",
    inputSchema: { type: "object", properties: {} },
  },
];

export const handlers: Record<string, ToolHandler> = {
  grepnavi_root: async () => {
    const r = await client.root();
    return ok({ ...r, bridge_version: BRIDGE_VERSION });
  },
  grepnavi_editor_state: async () => {
    return ok(await client.editorState());
  },
};
