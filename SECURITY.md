# Security Policy

## Supported versions

Only the current `main` branch and the latest published release are actively maintained. Older releases may not receive security fixes.

## Reporting a vulnerability

Do not disclose exploitable details in a public Issue. Use the repository's **Security → Report a vulnerability** flow to create a private GitHub Security Advisory.

Never include:

- API tokens or gateway access-key values;
- full authorization headers;
- private upstream URLs;
- user prompts, request bodies, or personal data;
- live exploit details in a public thread.

If private advisories are unavailable, open a public Issue containing only a request for a private reporting channel.

## Deployment responsibilities

- Store configured `AIG_ACCESS_KEY_AIR`, `AIG_ACCESS_KEY_PRO`, `AIG_ACCESS_KEY_MAX`, `AIG_ACCESS_KEY_ULTRA`, `AIG_ACCESS_KEY_AGENT` values and all `AIG_TIER{1,2,3}_CREDENTIALS_*` shards as Cloudflare Secrets. Store the corresponding `AIG_ACCESS_MODELS_AIR`, `AIG_ACCESS_MODELS_PRO`, `AIG_ACCESS_MODELS_MAX`, `AIG_ACCESS_MODELS_ULTRA`, `AIG_ACCESS_MODELS_AGENT` values and node configs (`AIG_TIER{1,2,3}_NODES_*`) as non-secret variables. Node credentials bind by **Tier + node id**; `01..10` are shard numbers only, and Config/Secret shard suffixes do not need to match;
- never commit `.dev.vars`, `.env`, `secrets*.json`, or `wrangler.user.jsonc`;
- never pass credentials through URL query parameters;
- keep `/health` and `/metrics` protected;
- revoke and rotate exposed or suspected credentials immediately;
- review Worker logs before sharing them publicly.

## Gateway-enforced protections

- Timing-safe gateway auth (Bearer / `x-api-key`);
- strict upstream header allowlist — client credentials, cookies, forwarded and CF-private headers are never relayed;
- HTTPS-only upstreams by default; `redirect: 'manual'` so redirects never carry credentials;
- bounded request/response reads;
- CORS disabled unless `AIG_CORS_ORIGIN` is set explicitly;
- credentials are excluded from every response, diagnostic endpoint, and log line.
