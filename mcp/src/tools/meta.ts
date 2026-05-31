import { BRIDGE_VERSION, client, ok } from "../shared.js";
import type { ToolDef, ToolHandler } from "../shared.js";

export const definitions: ToolDef[] = [
  {
    name: "grepnavi_root",
    description:
      "Return grepnavi's current root directory (absolute path) and bridge_version. The root may DIFFER from your working directory — anchor all subsequent file paths to this root.",
    inputSchema: { type: "object", properties: {} },
  },
];

export const handlers: Record<string, ToolHandler> = {
  grepnavi_root: async () => {
    const r = await client.root();
    return ok({ ...r, bridge_version: BRIDGE_VERSION });
  },
};
