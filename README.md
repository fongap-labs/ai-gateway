<div align="center">

# ai-gateway

**Resilient AI API gateway for Cloudflare Workers**

Multi-provider routing · Multi-key load balancing · Tiered failover · OpenAI / Anthropic compatibility

[**English**](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/fongap-labs/ai-gateway/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/fongap-labs/ai-gateway/actions/workflows/ci.yml)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![License](https://img.shields.io/github/license/fongap-labs/ai-gateway?label=License)

[Quick Start](#quick-start) · [Architecture](docs/architecture/overview.md) · [Configuration](docs/operations/configuration.md) · [Deployment](docs/operations/deployment.md)

</div>

<p align="center">
  <a href="https://api.135468.xyz/"><img src="https://api.135468.xyz/readme-status.svg?v=20260918-3" alt="Live production usage from the maintainer deployment" width="920"></a>
</p>

## What is ai-gateway?

ai-gateway turns fragmented AI providers, API keys, quotas, and model aliases into **one stable endpoint**.

It runs on Cloudflare Workers and is built for self-hosted individuals or small trusted teams using heterogeneous capacity that may be cheap or free, but often rate-limited or temporarily unavailable.

## Why it exists

Real AI capacity is messy: providers have different quotas, one provider may have several keys, models can disappear or recover, and OpenAI/Anthropic surfaces are not identical. Free capacity should be used first without letting retries or fallback run out of control.

A simple reverse proxy does not solve that. ai-gateway adds bounded routing and reliability around the pool.

## How it works

```text
Client
  ↓
ai-gateway
  ↓
Tier 1  free / effectively free
  ↓
Tier 2  subscription entitlements
  ↓
Tier 3  paid API fallback
  ↓
Providers and keys
```

Each request shares one attempt and wall-clock budget. Native protocol routes are tried first. Cross-protocol fallback is limited to **OpenAI Chat Completions ↔ Anthropic Messages**; **OpenAI Responses stays native-only**.

Tier 1 reshapes traffic using live availability, in-flight pressure, TTFT, 429 cooldown/recovery, and provider-model heat. Model-family fallback is bounded as well.\n\nTier 2 supports both static API-key nodes and **subscription nodes** (`auth: "oauth"`): operator-owned Claude / Codex / Gemini subscriptions onboarded through PKCE, stored AES-GCM encrypted in D1, refreshed automatically at dispatch time, and resolved fail-closed. See [Configuration - Tier 2 subscriptions](docs/operations/configuration.md#tier-2-subscriptions-oauth).

Core behavior:

- **Multi-provider / multi-key pooling** behind one logical endpoint.\n- **Subscription entitlements** via OAuth (PKCE) with encrypted token storage and automatic refresh.
- **Quota-aware reliability** with narrow 404 isolation and 429 recovery.
- **Streaming safety**: transparent failover stops after meaningful output begins.
- **Visible amplification**: Token usage, delivered requests, TTFT, retry/fallback/hedge work stay distinct.
- **Fail-closed access**: credentials are separated from node config; missing model allowlists grant no access.

Full contracts: [Architecture](docs/architecture/overview.md).

## Production use

The panel above is from the maintainer's real production deployment, not a synthetic benchmark.

The project is now in a **stability phase**. Architecture stays frozen unless production data shows a structural problem; current focus is real 429 behavior, fallback/hedge amplification, D1 write volume, and TTFT.

## Quick start

Requires Node.js **>=22.18.0**, a Cloudflare account, and at least one upstream credential.

```bash
git clone https://github.com/fongap-labs/ai-gateway.git
cd ai-gateway
npm ci
sh scripts/install.sh
```

Windows:

```powershell
powershell scripts/install.ps1
```

The installer validates configuration, collects credentials, deploys the Worker, and can verify the live endpoint.

Config and Secret shards are independent and bind by **Tier + node id**, not by matching suffixes. Access is controlled by `AIG_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}` and `AIG_ACCESS_MODELS_{AIR,PRO,MAX,ULTRA,AGENT}`.

See [Configuration](docs/operations/configuration.md) for the schema and [Deployment](docs/operations/deployment.md) for the production flow.

## API surface

| Method | Path | Surface |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses |
| `POST` | `/v1/messages` | Anthropic Messages |
| `POST` | `/v1/messages/count_tokens` | Anthropic-compatible local token count |
| `GET` | `/v1/models` | Authenticated model catalog |
| `GET` | `/health` | Authenticated health diagnostics |
| `GET` | `/metrics` | Authenticated runtime metrics |

## Documentation

[Architecture](docs/architecture/overview.md) · [Configuration](docs/operations/configuration.md) · [Deployment](docs/operations/deployment.md) · [Product Policy](docs/governance/product-policy.md) · [Governance](docs/governance/README.md)

English is canonical; [简体中文](README.zh-CN.md) is maintained for readers.

## Security

Never place upstream credentials in node configuration or public logs. See [SECURITY.md](SECURITY.md).

## License

MIT License. See [LICENSE](LICENSE).
