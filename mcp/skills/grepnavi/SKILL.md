---
name: grepnavi
description: "Use when investigating a C/C++ codebase through the grepnavi MCP tools (grepnavi_search, grepnavi_definition, grepnavi_callers, grepnavi_callees, grepnavi_path, grepnavi_references) — tracing what calls what, where a value is written, what a function does, or building a persistent investigation graph the user can see. Covers which tool to reach for, how far to trust each answer, and how to record findings."
---

# grepnavi

grepnavi indexes a C/C++ tree with GNU Global + Universal Ctags + ripgrep and exposes it over MCP.
Every answer is anchored to a real `file:line` in a live index, and the user sees the same graph in a GUI.

That grounding is the whole point — so is knowing where it stops. Read `references/accuracy.md`
before reporting anything as certain.

## Start here

**Call `grepnavi_root` first, always.** It costs one round trip and returns three things you need:

- `root` — the absolute path everything else is relative to. It may differ from your working directory.
- `index` — whether gtags/ctags are built and whether they are **stale**. A stale index returns
  normal-looking results that point at wrong line numbers. If `stale: true`, say so whenever you
  report a location.
- `graph` — a digest of the investigation already in progress: node count, entry points with their
  memos, and `unverified` (memos written from inference and never confirmed). **If this is
  non-empty, the user has been here before — continue from those roots instead of starting over.**
  Absent entirely on grepnavi builds older than 2026-07; fall back to `grepnavi_graph_list` then.

## Picking a tool

| The question | Tool | Note |
|---|---|---|
| What does `F` do? | `grepnavi_definition` → `grepnavi_func_body` | `func_body` also takes `word` directly |
| Who calls `F`? | `grepnavi_callers` (depth 1) | Each hit carries `text` — classify from it, don't re-fetch |
| What does `F` call? | `grepnavi_callees` | Use `recommended_for_tree` to skip macros and primitives |
| How does `A` reach `B`? | `grepnavi_path` | Not `callers(depth: N)` — that returns the whole subtree |
| Who *uses* this field/global/macro? | `grepnavi_references` | `callers` only sees function calls |
| I don't know the identifier | `grepnavi_symbol_search` | Regex over symbol names; returns the definition line |
| Where does this text appear? | `grepnavi_search` | Group hits by `enclosing_function` before reading |
| What's in this file? | `grepnavi_symbols` | Outline first, then `func_body` — never read a whole file to find one function |
| Is this code even compiled? | `grepnavi_ifdef_context` | Reports the guard; it does **not** evaluate config values |

Many names to resolve at once → `grepnavi_definitions` (batch), not N single calls.

Full request-to-chain recipes: `references/workflows.md`.

## Depth costs money

`callers`/`callees` accept `depth` up to 5. Each level fans out — on a kernel-sized tree a depth-3
walk is hundreds of entries and several seconds. **Start at depth 1.** Increase only after depth 1
told you something that makes the next level worth paying for.

If the real question is "how does A reach B", `grepnavi_path` searches from both ends and returns
the chain alone.

## Reading files

Every `file` in a grepnavi result is an **absolute path** — pass it verbatim, never rebuild it.

- Non-UTF-8 source (SJIS / EUC-JP) → `grepnavi_read_file`. Your own Read tool mangles multi-byte
  characters silently, with no error.
- A whole function → `grepnavi_func_body`. One call, no line arithmetic.
- Confirmed UTF-8 and you know the range → your own Read tool is fine.

## Recording what you find

The graph is the deliverable the user keeps. Two rules matter more than the rest:

1. **Read the function before you write a memo about it.** Names lie. The bridge auto-prefixes
   `[未確認]` to any memo that lacks a verification tag; prefix with `[verified]` / `[確認済]`
   yourself only after actually reading the body.
2. **Call-tree children anchor at the CALLER's file + the callee's `call_line`** — not the callee's
   definition. This is what activates grepnavi's call ↔ definition memo sync.

Details, batch node building, and memo categories: `references/graph-protocol.md`.

## Before you call anything done

- Did you check `index.stale`? A stale index makes every line number suspect.
- Did any response carry `truncated: true`? Then your list is a sample, not the answer — say so.
- Are you claiming a call graph is complete? Function pointers and macro-generated calls are
  invisible to every text-based engine. See `references/accuracy.md`.
- Did you write memos you never verified against the code? Fix them or mark them.

Silent inaccuracy is the failure mode that matters here. The tools carry `truncated`, `stale`,
`engine`, `confidence`, `kind` and `text` precisely so you can calibrate — use them, and pass the
uncertainty on to the user instead of absorbing it.
