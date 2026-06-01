import { client, ok } from "../shared.js";
import type { BatchNodeInput, ToolDef, ToolHandler } from "../shared.js";
import { addNodesBatch, normalizeInputPath } from "../helpers.js";

export const definitions: ToolDef[] = [
  {
    name: "grepnavi_graph_list",
    description:
      "List nodes in the active investigation graph (id, label, file, line, memo, tags, badge, children). Call before grepnavi_graph_add_node to dedup (compare file+line) and pick `parent_id`.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "grepnavi_graph_add_node",
    description:
      "Pin a file:line to the active investigation graph. Returns `node_id`. GUI updates in real time.\n\n" +
      "- Pass `word` (the symbol name) so default label becomes `<word>:<line>` (much more readable than the `<basename>:<line>` fallback).\n" +
      "- Use absolute `file` from grepnavi_definition / callers / callees verbatim — don't hand-build relative paths.\n" +
      "- **Call-tree children: anchor at the CALLER's file + callee's `call_line`** (not the callee's definition). Activates grepnavi's call ↔ definition memo sync and keeps clicks in the parent's file.\n" +
      "- Attach via `parent_id`; empty = root.\n" +
      "- Strings must be UTF-8. If `text` may have been corrupted by your own file-read on non-UTF-8 source, omit it — grepnavi will fetch its own preview.\n" +
      "- **Before writing a substantive `memo`, actually READ the function** via grepnavi_func_body (or grepnavi_read_file). Function names lie — inferring purpose without reading the body produces plausible-but-wrong memos. The bridge **auto-prefixes `[未確認]`** to any memo that doesn't start with a verification tag. To mark a memo as actually verified, prefix it explicitly with `[verified]` or `[確認済]` AFTER reading the code. Recognized tags: `[verified]` / `[確認済]` / `[読了]` (read), `[unverified]` / `[推測]` / `[未確認]` / `[未読]` (not read).",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Absolute path, or relative to grepnavi_root." },
        line: { type: "integer", description: "1-based line number." },
        label: {
          type: "string",
          description: "Short label (<=40 chars). Function name or finding tag. Long text → `memo`.",
        },
        memo: {
          type: "string",
          description: "Multi-line explanation shown in node tooltip. Plain text or markdown.",
        },
        parent_id: {
          type: "string",
          description: "Existing node id to attach under. Empty = root.",
        },
        text: {
          type: "string",
          description: "One-line source preview. Omit if unsure about UTF-8 cleanliness.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for grouping (e.g. ['bug', 'tls']).",
        },
        badge_color: { type: "string", description: "Hex color (e.g. '#e05252') for severity flag." },
        badge_text: { type: "string", description: "Short badge text (e.g. 'BUG', 'TODO')." },
        word: {
          type: "string",
          description: "Symbol name being pinned. Used to derive `<word>:<line>` default label.",
        },
        client_node_id: {
          type: "string",
          description:
            "Caller-supplied node id (8+ chars recommended). For retry-safe inserts or cross-referencing later. Same id = dedup (existing returned). Bridge generates random hex if omitted.",
        },
      },
      required: ["file", "line"],
    },
  },
  {
    name: "grepnavi_graph_add_nodes",
    description:
      "Batch-add multiple nodes in ONE call. Bridge topo-sorts and rejects cycles / `client_id` collisions / unknown parents upfront. POST failure aborts and returns partial results.\n\n" +
      "Each node needs `client_id` (unique in batch). `parent_client_id` is: empty (root) | another batch `client_id` | existing server node id (from grepnavi_graph_list). All other per-node fields match grepnavi_graph_add_node.\n\n" +
      "**Always call grepnavi_callees FIRST** to get authoritative file/line/call_line. Building from your own guesses is the #1 cause of delete+re-add cycles.\n\n" +
      "**Call-tree children: anchor at caller's file + callee's `call_line`** (not the callee's definition).\n\n" +
      "**Memo verification**: same rule as grepnavi_graph_add_node. Bridge auto-prefixes `[未確認]` to any memo without a verification tag. Read each function via grepnavi_func_body first and prefix the memo with `[verified]` / `[確認済]` to mark it as actually verified.",
    inputSchema: {
      type: "object",
      properties: {
        nodes: {
          type: "array",
          description: "Nodes to add. Order doesn't matter — bridge topo-sorts.",
          items: {
            type: "object",
            properties: {
              client_id: { type: "string", description: "Unique id within this batch (also used as server node id)." },
              parent_client_id: {
                type: "string",
                description: "Empty = root. Or another batch client_id. Or existing server node id.",
              },
              file: { type: "string" },
              line: { type: "integer" },
              label: { type: "string" },
              memo: { type: "string" },
              word: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              badge_color: { type: "string" },
              badge_text: { type: "string" },
              text: { type: "string" },
            },
            required: ["client_id", "file", "line"],
          },
        },
      },
      required: ["nodes"],
    },
  },
  {
    name: "grepnavi_graph_set_memo",
    description:
      "Replace the memo on an existing node. Use this to record findings on nodes you (or the user) created earlier without rebuilding them. Pass empty string to clear the memo.\n\n" +
      "**Read the function before writing** (grepnavi_func_body / grepnavi_read_file). Bridge auto-prefixes `[未確認]` to any memo without a verification tag. To mark verified, prefix explicitly with `[verified]` / `[確認済]`.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "Target node id (from grepnavi_graph_list)." },
        memo: { type: "string", description: "New memo content (plain text / markdown)." },
      },
      required: ["node_id", "memo"],
    },
  },
  {
    name: "grepnavi_graph_update_node",
    description:
      "Update one or more editable fields on an existing node: label, memo, badge (color/text), or correct the line number. Only the provided fields are changed. Use grepnavi_graph_set_memo when you only need to change the memo (clearer intent).",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string" },
        label: { type: "string", description: "New label (omit to keep current)." },
        memo: { type: "string", description: "New memo (omit to keep current)." },
        badge_color: {
          type: "string",
          description: "Badge color hex like '#e05252'. Useful to flag severity.",
        },
        badge_text: { type: "string", description: "Badge text shown over the node." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Replace the tag list. Pass [] to clear tags.",
        },
        line: {
          type: "integer",
          description: "Correct the line number if the original pin was off.",
        },
      },
      required: ["node_id"],
    },
  },
  {
    name: "grepnavi_graph_delete_node",
    description:
      "Delete a node from the active investigation graph by id. Use when you added the wrong location and want to retract it.",
    inputSchema: {
      type: "object",
      properties: { node_id: { type: "string" } },
      required: ["node_id"],
    },
  },
  {
    name: "grepnavi_graph_move_node",
    description:
      "Re-attach a node under a different parent (or promote it to root). Use this after grepnavi_graph_add_node if you realize the finding belongs under a different context, instead of delete+re-add.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string" },
        new_parent_id: {
          type: "string",
          description: "Target parent node id, or empty string to make it a root node.",
        },
        edge_label: { type: "string", description: "Optional edge label (default 'ref')." },
      },
      required: ["node_id", "new_parent_id"],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  grepnavi_graph_list: async () => {
    const g = await client.graph();
    const summary = Object.values(g.nodes).map((n) => ({
      id: n.id,
      label: n.label,
      file: n.match.file,
      line: n.match.line,
      memo: n.memo ?? "",
      tags: n.tags ?? [],
      badge_color: n.badge_color ?? "",
      badge_text: n.badge_text ?? "",
      children: n.children,
    }));
    return ok({ root_dir: g.root_dir, active_tree: g.name, nodes: summary });
  },
  grepnavi_graph_add_node: async (args) => {
    const a = args as {
      file: string;
      line: number;
      label?: string;
      memo?: string;
      parent_id?: string;
      text?: string;
      tags?: string[];
      badge_color?: string;
      badge_text?: string;
      word?: string;
      client_node_id?: string;
    };
    // word が来てるのに label 空なら、シンボル名:line を default に使う
    // (grepnavi の自動 label は basename:line で tree 上の可読性が悪い)
    const effectiveLabel = a.label || (a.word ? `${a.word}:${a.line}` : undefined);
    const r = await client.addNode({ ...a, file: normalizeInputPath(a.file), label: effectiveLabel });
    return ok({
      node_id: r.node.id,
      label: r.node.label,
      memo: r.node.memo ?? "",
      tags: r.node.tags ?? [],
      badge_color: r.node.badge_color ?? "",
      badge_text: r.node.badge_text ?? "",
    });
  },
  grepnavi_graph_add_nodes: async (args) => {
    const a = args as { nodes: BatchNodeInput[] };
    const normalized = a.nodes.map((n) => ({ ...n, file: normalizeInputPath(n.file) }));
    return ok(await addNodesBatch(normalized));
  },
  grepnavi_graph_set_memo: async (args) => {
    const a = args as { node_id: string; memo: string };
    const n = await client.updateNode(a.node_id, { memo: a.memo });
    return ok({ node_id: n.id, memo: n.memo ?? "" });
  },
  grepnavi_graph_update_node: async (args) => {
    const a = args as {
      node_id: string;
      label?: string;
      memo?: string;
      badge_color?: string;
      badge_text?: string;
      line?: number;
      tags?: string[];
    };
    const { node_id, ...fields } = a;
    const n = await client.updateNode(node_id, fields);
    return ok({
      node_id: n.id,
      label: n.label,
      memo: n.memo ?? "",
      tags: n.tags ?? [],
      badge_color: n.badge_color ?? "",
      badge_text: n.badge_text ?? "",
    });
  },
  grepnavi_graph_delete_node: async (args) => {
    const a = args as { node_id: string };
    await client.deleteNode(a.node_id);
    return ok({ deleted: a.node_id });
  },
  grepnavi_graph_move_node: async (args) => {
    const a = args as {
      node_id: string;
      new_parent_id: string;
      edge_label?: string;
    };
    await client.moveNode(a.node_id, a.new_parent_id, a.edge_label);
    return ok({ moved: a.node_id, new_parent_id: a.new_parent_id });
  },
};
