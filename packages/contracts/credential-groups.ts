import type { RuntimeNode } from './runtime-node.ts';

// Private center -> Gateway only. This metadata never contains raw credentials.
export const INFERRED_CREDENTIAL_GROUPS_HEADER = 'x-aig-credential-groups';
const MAX_GROUPS_HEADER_LENGTH = 8192;

export function encodeInferredCredentialGroups(nodes: ReadonlyArray<RuntimeNode>): string | null {
  const idsByCredential = new Map<string, string[]>();
  const covered: string[] = [];
  for (const node of nodes) {
    if (!node.credential) continue;
    covered.push(node.id);
    const lookup = JSON.stringify([node.provider, node.credential]);
    const ids = idsByCredential.get(lookup);
    if (ids) ids.push(node.id);
    else idsByCredential.set(lookup, [node.id]);
  }
  const groups = [...idsByCredential.values()]
    .filter((ids) => ids.length > 1)
    .map((ids) => ids.sort())
    .sort((left, right) => (left[0] ?? '').localeCompare(right[0] ?? ''));
  const payload = JSON.stringify({ covered: covered.sort(), groups });
  const bounded = payload.length <= MAX_GROUPS_HEADER_LENGTH ? payload : null;
  return bounded;
}

// Authenticate the private center before calling this. Reject malformed or
// mismatched metadata as a whole; never derive key sharing from node names.
export function adoptInferredCredentialGroups(nodes: ReadonlyArray<RuntimeNode>, payload: string): boolean {
  if (!payload || payload.length > MAX_GROUPS_HEADER_LENGTH) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const data = parsed as Record<string, unknown>;
  if (!Array.isArray(data.covered) || !Array.isArray(data.groups)) return false;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const covered = new Set<string>();
  for (const id of data.covered) {
    if (typeof id !== 'string' || !nodeById.has(id) || covered.has(id)) return false;
    covered.add(id);
  }
  const identities = new Map<string, string>();
  for (const group of data.groups) {
    if (!Array.isArray(group) || group.length < 2 || group.length > nodes.length) return false;
    if (!group.every((id) => typeof id === 'string' && covered.has(id))) return false;
    const sorted = [...group].sort() as string[];
    const first = nodeById.get(sorted[0] as string);
    if (!first) return false;
    for (const id of sorted) {
      const node = nodeById.get(id);
      if (!node || node.provider !== first.provider || identities.has(id)) return false;
      identities.set(id, sorted[0] as string);
    }
  }
  for (const id of covered) {
    const node = nodeById.get(id);
    if (!node) continue;
    node.credentialIdentity = identities.get(id) ?? id;
    node.credentialShared = identities.has(id);
  }
  return true;
}
