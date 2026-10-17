// Provider catalog loader.
//
// The catalog data lives in providers.json and is the single source for
// provider presets (base URLs, key hints, suggested logical-model mappings),
// the logical-model list and the access-group presets. Adding a provider or
// model is a data edit in that JSON file; this module only loads and resolves
// it. Unknown provider names resolve to the generic OpenAI-compatible
// adapter, so every entry in the data file is a valid `provider` value in
// node config.

export async function loadCatalog() {
  const response = await fetch("./providers.json");
  if (!response.ok) {
    throw new Error(`Provider catalog failed to load (HTTP ${response.status}).`);
  }
  const data = await response.json();
  const providers = Array.isArray(data.providers) ? data.providers : [];
  if (providers.length === 0) {
    throw new Error("Provider catalog is empty; providers.json is missing or malformed.");
  }
  return {
    providers,
    logicalModels: Array.isArray(data.logical_models) ? data.logical_models : [],
    accessGroups: Array.isArray(data.access_groups) ? data.access_groups : [],
    providerById(id) {
      return providers.find((p) => p.id === id) || providers[providers.length - 1];
    },
  };
}
