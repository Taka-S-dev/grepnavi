import { GrepnaviClient } from "./client.js";

export const BRIDGE_VERSION = "0.16.0";

const baseUrl = process.env.GREPNAVI_URL ?? "http://localhost:8080";
export const client = new GrepnaviClient(baseUrl);
export const grepnaviBaseUrl = baseUrl;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolHandler = (args: any) => Promise<unknown>;

export function ok(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function text(body: string) {
  return { content: [{ type: "text", text: body }] };
}

export interface BatchNodeInput {
  client_id: string;
  parent_client_id?: string;
  file: string;
  line: number;
  label?: string;
  memo?: string;
  word?: string;
  tags?: string[];
  badge_color?: string;
  badge_text?: string;
  text?: string;
}

export interface CallerTreeNode {
  func: string;
  file: string;
  line: number;
  call_line: number;
  indirect: boolean;
  callers?: CallerTreeNode[];
  recursion_stopped?: "depth_limit" | "already_visited";
}
