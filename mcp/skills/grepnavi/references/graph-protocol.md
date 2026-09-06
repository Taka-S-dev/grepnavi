# Recording findings

The investigation graph is what the user keeps after the session ends, and they watch it update
live in the GUI. Treat it as shared state, not scratch space.

## Resuming

`grepnavi_root` returns a `graph` digest: `tree`, `description`, `nodes`, `unverified`,
`line_memos`, and `roots` (entry points with their memos). `roots_total` appears only when the list
was capped — its presence means "not all of them".

If the digest is non-empty, the user has investigated this project before. Read the roots and
continue from them. Call `grepnavi_graph_list` only when you need the full node list — the digest is
enough to decide where to pick up.

`unverified > 0` counts memos written from inference that were never confirmed against the code.
Those are the first things to either verify or correct.

## Memos: read before you write

The bridge auto-prefixes `[未確認]` to any memo that does not start with a verification tag.
This exists because inferring a function's purpose from its name produces memos that are plausible
and wrong, repeatedly.

- Read the body first (`grepnavi_func_body`, or `grepnavi_read_file` for a range).
- Then prefix explicitly with `[verified]` or `[確認済]`.
- Recognized as read: `[verified]` `[確認済]` `[読了]`.
- Recognized as not read: `[unverified]` `[推測]` `[未確認]` `[未読]`.

The tag is checked, not trusted. The bridge keeps every range that `grepnavi_func_body` and
`grepnavi_read_file` returned in this session. A `[verified]` memo whose anchor line — or the
definition of its `word` — was never inside one of those ranges is rewritten to `[未確認]`, and the
response carries `verification.downgraded` with the reason. So:

- Pass `word` on call-tree children. Their anchor is the caller's line; without `word` the bridge
  cannot match the callee body you read against that anchor.
- A `with_preview` body preview counts only for the lines it showed, not the whole function.
- A downgrade is not an error. Read the code and resubmit with the tag.

If you did not read it, leave it unverified — the digest surfaces the count so it can be cleaned up
later.

## Edge labels

`edge_label` on `grepnavi_graph_add_node` / `add_nodes` puts text on the edge from the parent. Use it
for the reason the child exists in the flow — the call condition (`on error`, `state == READY`),
not a restatement of the child's name. Omit it for a plain link. `seq` is reserved by the GUI.

## Node anchoring

**Call-tree children anchor at the CALLER's file + the callee's `call_line`** — not the callee's
definition site.

This is what activates grepnavi's call ↔ definition memo sync, and it keeps the user's clicks inside
the parent's file instead of scattering them across the tree. Getting this wrong is the difference
between a graph that reads as a call flow and one that reads as a pile of unrelated locations.

Other field rules:

- Pass `word` (the symbol name) so the default label becomes `<word>:<line>` rather than the
  `<basename>:<line>` fallback.
- Use the absolute `file` from `definition` / `callers` / `callees` verbatim.
- `parent_id` empty = root.
- Omit `text` if your own file read may have mangled it (non-UTF-8 source) — grepnavi will fetch its
  own preview.

## Batch building

`grepnavi_graph_add_nodes` builds a subtree in one call. The bridge topologically sorts entries and
rejects cycles, `client_id` collisions, and unknown parents up front.

- Each node needs a `client_id` unique within the batch.
- `parent_client_id` is: empty (root) | another batch `client_id` | an existing server node id.
- **Call `grepnavi_callees` first.** Building payloads from your own guesses is the top cause of
  delete-and-re-add cycles.
- A POST failure aborts and returns partial results — check what actually landed before retrying.

## Line and range memos

Separate from graph nodes; they render in the editor margin. Use them for annotations too
fine-grained to deserve a node ("TODO: race", "returns NULL when X").

They also show up in the tree. A line memo placed inside the function of an existing node is
listed under that node (the nearest node above it in the same function). Memos in functions that
have no node are grouped at the tail of the tree by file and function, where the user can promote
the function to a node. So when a finding belongs to a step the tree already has, put the memo
inside that step's function — it will appear in the flow, not only in the list.

- The bridge tags `source: "ai"` and defaults `category: "draft"`.
- Drafts are bulk-deletable by the user, which is the point — promote to `ok` / `warn` / `error` /
  `note` only once you have verified the claim.
- Empty memo string deletes.
- `grepnavi_set_range_memo` needs the existing `id` (from `grepnavi_list_memos`) to replace a memo;
  omit `id` to create.

## Acting on the user's cursor

`grepnavi_editor_state` resolves "explain this function" without making the user spell out
`file:line`. Before any **write** anchored on it:

1. If `fresh: false` (no editor activity for ~20 s — browser closed, idle, backgrounded), do not use
   the cached state silently. Ask.
2. Echo back the resolved `file`, `line`, and range, and get explicit confirmation.
3. Compare its `root` to `grepnavi_root`. Multiple grepnavi tabs push to the same endpoint; if they
   differ, ask which instance to target.

Non-destructive reads may use it without confirmation, but still mention staleness when `fresh` is
false.
