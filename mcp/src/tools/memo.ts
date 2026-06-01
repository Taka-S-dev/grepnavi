import { ok } from "../shared.js";
import type { ToolDef, ToolHandler } from "../shared.js";
import { setLineMemo, setRangeMemo, listMemos, normalizeInputPath } from "../helpers.js";

const CATEGORY_DESCRIPTION =
  "Memo classification. Default `draft` — bulk-deletable by the user after their review. " +
  "Promote to one of the typed categories once you've actually read the code and want the memo " +
  "to persist: `ok` (verified safe), `warn` (caution), `error` (bug / hazard), `note` (general fact). " +
  "Memos left as `draft` may be wiped at any time without warning, so use `draft` only for " +
  "first-pass annotations you expect to revisit.";

const CATEGORY_ENUM = ["draft", "ok", "warn", "error", "note"];

export const definitions: ToolDef[] = [
  {
    name: "grepnavi_set_line_memo",
    description:
      "Attach/replace a memo on a SINGLE line (editor margin annotation, separate from graph nodes). Use for fine-grained annotations that don't deserve a tree node ('TODO: race', 'returns NULL when X'). Empty string = delete.\n\n" +
      "Bridge auto-tags `source = \"ai\"` and defaults `category = \"draft\"`. Promote to ok/warn/error/note via the `category` argument once verified — drafts are bulk-deletable.\n\n" +
      "Bridge also auto-prefixes `[未確認]` if memo text doesn't start with a verification tag. Read the code first and prefix with `[verified]` / `[確認済]` to mark as verified.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Absolute file path (matching grepnavi's view)." },
        line: { type: "integer", description: "1-based line number." },
        memo: {
          type: "string",
          description: "Memo content (plain text / markdown). Empty string = delete.",
        },
        category: {
          type: "string",
          enum: CATEGORY_ENUM,
          description: CATEGORY_DESCRIPTION,
        },
      },
      required: ["file", "line", "memo"],
    },
  },
  {
    name: "grepnavi_set_range_memo",
    description:
      "Attach/replace a memo on a multi-line range. Pass `id` (from grepnavi_list_memos) to replace an existing range memo; omit to create new (bridge generates id). Empty `memo` with known `id` = delete.\n\n" +
      "Bridge auto-tags `source = \"ai\"` and defaults `category = \"draft\"`. Promote to ok/warn/error/note via the `category` argument once verified — drafts are bulk-deletable.\n\n" +
      "Bridge also auto-prefixes `[未確認]` if memo text doesn't start with a verification tag.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        start_line: { type: "integer", description: "1-based start line." },
        end_line: { type: "integer", description: "1-based end line (inclusive)." },
        memo: { type: "string" },
        id: {
          type: "string",
          description: "Existing range-memo id to replace; omit to create a new one.",
        },
        start_col: { type: "integer", description: "Optional start column (defaults to 1)." },
        end_col: {
          type: "integer",
          description: "Optional end column (defaults to a large value).",
        },
        category: {
          type: "string",
          enum: CATEGORY_ENUM,
          description: CATEGORY_DESCRIPTION,
        },
      },
      required: ["file", "start_line", "end_line", "memo"],
    },
  },
  {
    name: "grepnavi_list_memos",
    description:
      "Return all line memos and range memos. Optionally filter by file. Call this before grepnavi_set_range_memo to find the `id` of an existing memo you want to replace.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Optional: only return memos whose file matches exactly.",
        },
      },
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  grepnavi_set_line_memo: async (args) => {
    const a = args as { file: string; line: number; memo: string; category?: string };
    const result = await setLineMemo(
      normalizeInputPath(a.file),
      a.line,
      a.memo,
      a.category,
    );
    return ok(result);
  },
  grepnavi_set_range_memo: async (args) => {
    const a = args as {
      file: string;
      start_line: number;
      end_line: number;
      memo: string;
      id?: string;
      start_col?: number;
      end_col?: number;
      category?: string;
    };
    const result = await setRangeMemo({ ...a, file: normalizeInputPath(a.file) });
    return ok(result);
  },
  grepnavi_list_memos: async (args) => {
    const a = args as { file?: string };
    return ok(await listMemos(normalizeInputPath(a.file)));
  },
};
