/**
 * Parse agent text for sub-agent delegation announcements.
 * Handles multiple formats, e.g.:
 * - "Session: agent:linear:subagent:uuid Run ID: uuid"
 * - "**Session Key:** `agent:linear:subagent:uuid` **Run ID:** `uuid`"
 * - "Linear Agent spawn initiated... Session Key: ... Run ID: ..."
 */

export interface DelegationParsed {
  runId: string;
  childSessionKey: string;
  label?: string;
  task?: string;
}

export function parseDelegationFromText(text: string): DelegationParsed | null {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();

  let runId = "";
  let childSessionKey = "";
  let label: string | undefined;
  let task: string | undefined;

  // Run ID: "run: x", "runId: x", "Run ID: x", "**Run ID:** `uuid`"
  const runMatch = trimmed.match(/run(?:\s*id)?[:\s*]+[`\s]*([a-fA-F0-9][a-fA-F0-9_.-]{10,})/i);
  if (runMatch) runId = runMatch[1].replace(/`\s*$/, "");

  // Session key: agent:X:subagent:uuid (supports backticks in markdown)
  const sessionMatch = trimmed.match(/agent:[^:\s]+:subagent:[a-fA-F0-9-]+/);
  if (sessionMatch) childSessionKey = sessionMatch[0];

  // Label: "label X" or parentheses
  const labelMatch = trimmed.match(/label\s+([^\s•]+)/i) ?? trimmed.match(/\(([^)]+)\)/);
  if (labelMatch) label = labelMatch[1].trim();

  // Accept if we have both IDs and text suggests a spawn announcement
  const hasSpawnSignature =
    /sessions_spawn/i.test(trimmed) ||
    /sub[- ]?agent\s+spawned/i.test(trimmed) ||
    /spawn\s+initiated/i.test(trimmed) ||
    /session(?:\s*key)?:?\s*`?agent:[^:\s]+:subagent:/i.test(trimmed) ||
    (runId && childSessionKey && /agent:[^:\s]+:subagent:/i.test(trimmed));

  if (runId && childSessionKey && hasSpawnSignature)
    return { runId, childSessionKey, label, task };
  return null;
}
