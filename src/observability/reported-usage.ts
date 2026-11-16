// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

type UsageContainer = { usage?: unknown };

export function reportedUsageFromPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const data = payload as { response?: UsageContainer | null; message?: UsageContainer | null; usage?: unknown };
  if (data.response && typeof data.response === 'object' && data.response.usage !== undefined) {
    return data.response.usage;
  }
  if (data.message && typeof data.message === 'object' && data.message.usage !== undefined) {
    return data.message.usage;
  }
  if (data.usage !== undefined) return data.usage;
  return null;
}

export function reportedUsageFromJsonText(text: unknown): unknown {
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    return reportedUsageFromPayload(JSON.parse(text));
  } catch {
    return null;
  }
}
