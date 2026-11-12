// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

// Avoid regex backtracking on untrusted paths.
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}
