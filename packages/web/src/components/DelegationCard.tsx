import React from "react";
import type { Delegation } from "../store";

type DelegationCardProps = {
  delegation: Delegation;
};

/** Card showing a sub-agent delegation (sessions_spawn) — label, runId, status with spinner. */
export function DelegationCard({ delegation }: DelegationCardProps) {
  const displayLabel = delegation.label || delegation.task || "Sub-agent";
  const shortRunId = delegation.runId.length > 12
    ? `${delegation.runId.slice(0, 8)}…`
    : delegation.runId;

  return (
    <div
      className="flex items-center gap-3 px-3 py-2 rounded-md"
      style={{
        background: "var(--bg-hover)",
        border: "1px solid var(--border)",
      }}
    >
      <div
        className="flex-shrink-0 w-8 h-8 rounded flex items-center justify-center"
        style={{ background: "var(--bg-surface)" }}
      >
        {delegation.status === "running" ? (
          <svg
            className="w-4 h-4 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
            style={{ color: "var(--text-link)" }}
          >
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="32"
              strokeDashoffset="12"
            />
          </svg>
        ) : (
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>✓</span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-caption font-bold" style={{ color: "var(--text-primary)" }}>
          {displayLabel}
        </div>
        <div className="text-caption" style={{ color: "var(--text-muted)" }}>
          {delegation.status === "running" ? "Running" : "Completed"} · {shortRunId}
        </div>
      </div>
    </div>
  );
}
