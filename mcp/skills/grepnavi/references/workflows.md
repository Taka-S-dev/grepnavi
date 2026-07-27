# Request → tool chain

Most requests resolve through one of these. Follow the chain instead of trying to one-shot
everything through `grepnavi_search`.

## "Where is X written / output / created?"

1. `grepnavi_search` the keyword to find candidate sites.
2. **Group the hits by `enclosing_function` before reading anything.** 30 hits are often 4–5
   functions. Read each unique function once via `grepnavi_func_body(file, enclosing_function.start_line)`.
   The field is absent on hits outside any function (file-scope declarations, comments) — those need
   individual attention rather than grouping.
3. `grepnavi_callers` on the function that actually writes, to find who triggers it.

If X is a struct field or a global rather than a function, use `grepnavi_references` instead of
`search` — it filters comment-only and string-only mentions and tells you the enclosing `func`.

## "What does function F do?"

1. `grepnavi_definition("F")` → `hits[0]` is usually the implementation (pre-sorted
   `func > define > typedef`; prefer `.c` over `.h` when both are at the top).
2. `grepnavi_func_body(file, line)` → the body.
3. `grepnavi_callees(file, line)` for the downstream chain, one level at a time.

`grepnavi_func_body` also accepts `word` directly, which lets you fire it in parallel with other
calls. It errors with a candidate list on ambiguity — disambiguate with `file`+`line`.

## "Who calls F?"

`grepnavi_callers("F", depth: 1)`.

Each hit carries `text`, the source of the call line. That tells you whether it is a plain call, a
function-pointer assignment (`.submit = foo`), or a macro wrapper — usually enough to classify the
caller without a second round trip.

## "How does A reach B?"

`grepnavi_path(from: "A", to: "B")`. It searches from both ends, so a widely-called target like an
allocator does not blow up.

`found: false` means "no direct chain seen", not "unreachable". Check `truncated` — it distinguishes
"budget ran out, a path may exist" from "the search was exhaustive".

## "What's in this file?"

1. `grepnavi_symbols(file)` for the outline with line ranges.
2. `grepnavi_func_body` or `grepnavi_read_file(file, start, end)` on the entries you care about.

Reading a whole file to find one function wastes context. Symbols + func_body is cheaper and
gives you line numbers you can pin.

## "I don't know what it's called"

The user describes behavior, not an identifier ("the recipe save function").

1. `grepnavi_symbol_search("recipe.*(save|write)")` — one call, returns candidate names with `kind`,
   `file`, `line`, and `text` (the definition line itself, so you can often pick without reading).
2. `grepnavi_definition` or `grepnavi_func_body` on the name you picked.

Guessing names one at a time through `grepnavi_definition` is the slow way to do this.

## "Is this code actually compiled?"

`grepnavi_ifdef_context(file, line)` returns the enclosing `#ifdef` / `#if` frames, outermost first.

It reports **structural nesting only**. grepnavi does not evaluate config values, so a frame means
"guarded by this", never "disabled". Report the guard and let the user decide; if you need to know
where the symbol is set, `grepnavi_search` the condition name.

`grepnavi_search` hits already carry `ifdef_stack` — `definition` / `callers` / `callees` results do
not, which is exactly when this tool earns its keep.

## Building the graph from a call tree

1. `grepnavi_callees` first — it gives authoritative `file` / `call_line` / `kind`.
2. Filter to `recommended_for_tree: true`.
3. `grepnavi_definitions` (batch) if you need the definition sites too.
4. `grepnavi_graph_add_nodes` in one call, anchoring children at the caller's file + `call_line`.

Building node payloads from your own guesses instead of step 1 is the most common cause of
delete-and-re-add cycles.

## Avoid

- Hand-building relative paths from memory. Every result's `file` is absolute — use it verbatim.
- `grepnavi_search` with no `limit` on a large repo. Start at 20–50, paginate with `next_offset`
  only if the user actually needs more.
- `depth > 1` on callers/callees before depth 1 has told you anything.
- Concluding "not found" without reading the `hint` field. A 0-result response often explains the
  mistake (a glob that matched no files, regex syntax in a literal search).
