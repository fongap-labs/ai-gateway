// Infer only mirrored logical slots across independent naming namespaces.
// Example shape: A, B, C and X-A, X-B, X-C. Never bridge namespaces,
// and never treat an unrelated singleton as a family member.
function splitName(name: string): { namespace: string; slot: string } | null {
  const normalized = name.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) return null;
  const separator = normalized.lastIndexOf('-');
  return separator < 0
    ? { namespace: '', slot: normalized }
    : { namespace: normalized.slice(0, separator), slot: normalized.slice(separator + 1) };
}

export function inferMirroredModelSiblings(requested: string, knownModels: ReadonlySet<string>): string[] {
  const origin = splitName(requested);
  if (!origin) return [];

  const families = new Map<string, Map<string, string>>();
  for (const model of knownModels) {
    const parts = splitName(model);
    if (!parts) continue;
    let members = families.get(parts.namespace);
    if (!members) {
      members = new Map<string, string>();
      families.set(parts.namespace, members);
    }
    if (!members.has(parts.slot)) members.set(parts.slot, model);
  }

  const own = families.get(origin.namespace);
  if (!own || !own.has(origin.slot) || own.size < 3) return [];

  // Requiring three independent mirrored slots prevents free-form names,
  // vision-only singletons and incidental suffix collisions from becoming
  // fallback candidates without an explicit declaration.
  const verified = new Set<string>();
  for (const [namespace, members] of families) {
    if (namespace === origin.namespace || !members.has(origin.slot)) continue;
    const shared = [...own.keys()].filter((slot) => members.has(slot));
    if (shared.length < 3) continue;
    for (const slot of shared) verified.add(slot);
  }
  if (!verified.has(origin.slot)) return [];

  return [...own]
    .filter(([slot, model]) => slot !== origin.slot && slot !== 'air' && verified.has(slot) && model.toLowerCase() !== requested.trim().toLowerCase())
    .map(([, model]) => model);
}
