# Leech-RS API

`leech-rs` is a Rust-based LLM gateway with a compact provider-style API and a same-port dashboard.

Model-facing endpoints:

- `POST /v1/chat/completions`
- `POST /v1/messages`

Operational endpoints:

- `GET /`
- `GET /v1/models`
- `GET /health`
- `GET /bank`
- `GET /proxies`
- `GET /usage/overview`
- `GET /usage/session/:session_id`
- `POST /usage/cap`
- `POST /usage/reset`

`/config` intentionally returns `404`.

## Providers

| Provider | Model IDs | Credentials | Proxy behavior |
|---|---|---|---|
| use.ai | `gpt-*`, `claude-*`, and default catalog models | Warm use.ai account pool | Tor range from `provider_proxies.use_ai_ports` |
| Sakana | `sakana-*` | Lazy persistent Sakana sessions | Direct egress, no Tor |
| Faceb | `faceb-*` | Persistent/generated Faceb API keys | Tor range from `provider_proxies.faceb_ports` |

Only use.ai requests acquire use.ai accounts. Sakana and Faceb do not consume the use.ai account pool.

## Models

Core model examples:

- `gpt-5-5`
- `gpt-5-4`
- `gpt-5-mini`
- `gpt-4o`
- `claude-sonnet-4-6`
- `claude-haiku-4-5`

Sakana models:

- `sakana-namazu`
- `sakana-fugu`
- `sakana-fugu-ultra`

Faceb model examples:

- `faceb-openai/gpt-5.4`
- `faceb-openai/gpt-5.5`
- `faceb-anthropic/claude-opus-4.8`
- `faceb-anthropic/claude-fable-5`
- `faceb-google/gemini-2.5-flash`
- `faceb-google/gemini-3.1-pro-preview`
- `faceb-qwen/qwen3-coder`
- `faceb-mistralai/ministral-14b-2512`

Faceb IDs strip the `faceb-` prefix before calling the upstream Faceb API. For example, `faceb-google/gemini-2.5-flash` is sent upstream as `google/gemini-2.5-flash`.

## OpenAI-Compatible Chat

Endpoint: `POST /v1/chat/completions`

```json
{
  "model": "gpt-5-4",
  "user": "session-123",
  "messages": [
    { "role": "user", "content": "Reply with OK." }
  ]
}
```

Streaming is supported with `"stream": true`.

Multimodal/file-style content is folded into the same endpoint:

```json
{
  "model": "gpt-5-4",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Read this file." },
        {
          "type": "file",
          "file": {
            "data": "data:text/plain;base64,aGVsbG8=",
            "filename": "notes.txt",
            "media_type": "text/plain"
          }
        }
      ]
    }
  ]
}
```

OpenAI-style `tools` and `tool_choice` are accepted. Tool calls are simulated through trusted prompts and returned as OpenAI `tool_calls`.

## Anthropic-Compatible Messages

Endpoint: `POST /v1/messages`

```json
{
  "model": "claude-sonnet-4-6",
  "metadata": { "session_id": "session-123" },
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Reply with OK." }
      ]
    }
  ]
}
```

Anthropic-style `tools` and `tool_choice` are accepted. Tool calls are simulated and returned as Anthropic `tool_use` blocks.

## Usage and Spend

Usage is persisted under `LEECH_DATA_DIR` or `.leech-rs`.

Files:

- `.leech-rs/usage.json`
- `.leech-rs/sakana_pool.json`
- `.leech-rs/faceb_pool.json`

Session keys:

- OpenAI-compatible calls use `user`.
- Anthropic-compatible calls use `metadata.session_id`, then `metadata.user_id`.
- Missing session IDs use `default`.

Spend estimates are approximate. The dashboard tracks `model_input_tokens` and `model_output_tokens` separately and applies dashboard-side input/output pricing estimates.

## Health and Proxies

`GET /health` includes provider pool stats:

- `provider`
- `ready`
- `target`
- `generated`
- `failed`
- `dead`
- `cooling`
- `degraded`
- `last_error`

`GET /proxies` includes active proxies plus `provider_assignments`, which shows active routing per provider.

## Dashboard

The dashboard is served from `/` and built from `frontend/src/main.ts` into `frontend/dist`.

Dashboard sections:

- Global cards: estimated spend, Tor instances, request rate, favorite model.
- use.ai: warm accounts, proxy count, mode, status.
- Sakana: ready sessions, cooling sessions, direct-egress mode, status.
- Faceb: ready keys, generated keys, dead keys, proxy count.
- Usage metrics: sessions, messages, tokens, legacy warm account view.
- Panels: spend by model, Tor proxies, provider pools, provider proxies, daily usage, health notes.
- Use guides at the bottom.

Build the frontend:

```powershell
npm run build --prefix frontend
```

## Tor and Provider Proxies

Provider proxy ranges are configured in `config.toml`:

```toml
[provider_proxies]
use_ai_ports = [9050, 9051, 9052, 9053, 9054, 9055, 9056, 9057, 9058, 9059, 9060]
sakana_ports = []
faceb_ports = [9071, 9072, 9073, 9074, 9075, 9076, 9077, 9078, 9079, 9080]
```

Startup only warms a minimal active set instead of every configured port. use.ai scales inside its configured range. Faceb uses active Faceb proxies for key warmup and requests. Sakana uses direct egress.

Tor state and binary paths can be controlled with:

- `LEECH_TOR_DATA_ROOT`
- `TOR_BIN`

## Validation

Run core checks:

```powershell
cargo test
npm run build --prefix frontend
```

Local smoke defaults to `http://127.0.0.1:8000`:

```powershell
.\smoke.ps1 -SkipProviderSmokes
```

Remote smoke example:

```powershell
.\smoke.ps1 -BaseUrl "https://proxy-rust.fly.dev" -SkipProviderSmokes
```

Provider smokes are opt-in because Faceb can run out of credits and Sakana depends on upstream Firebase acceptance.

## Run Locally

```powershell
cargo run
```

Then open:

```text
http://127.0.0.1:8000/
```

## Fly.io

Expected secrets/settings:

```powershell
fly secrets set LEECH__SERVER__HOST=0.0.0.0 LEECH__SERVER__PORT=8000
fly secrets set LEECH_DATA_DIR=/data LEECH_TOR_DATA_ROOT=/data/tor TOR_BIN=/usr/bin/tor
```

Optional:

```powershell
fly secrets set SAKANA_API_KEY=your-sakana-key
```

Useful commands:

```powershell
fly deploy
fly logs
fly checks list
fly apps open
```

Known test deployment:

```text
https://proxy-rust.fly.dev
```

## Known Limitations

- Faceb provider tests require available Faceb credits.
- Sakana chat-site signup depends on upstream Firebase acceptance of the egress IP.
- Sakana pool is lazy and persistent; it does not background-warm to target.
- Sakana pool mutex refactor remains an optional concurrency improvement.
- SSE parser hardening for multi-line events remains optional.
- Unknown non-Faceb models currently fall back to the default model.
