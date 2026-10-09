// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

// Remove trailing forward slashes from a URL or path string without
// using a regex, avoiding ReDoS surface on uncontrolled input.
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}
