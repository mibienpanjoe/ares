# 06 — LLM provider profiles

> Goal: choose the right LLM + embedding combination for cognify, avoid the
> traps the build hit (daily caps, thinking models, oversized chunks), and
> match provider to box.

## The split: agents vs cognee

There are **two different model populations** in MISHKAN and they don't have
to use the same provider:

| Population | What runs it | Where it's configured |
|---|---|---|
| **Agents** (the 45) | Claude Code's own model routing (Opus / Sonnet / Haiku) per tier | `payload/mishkan/config/model-routing.yaml` (enforced by `hooks/model-route.py`) |
| **Cognee's `cognify` extraction + embeddings** | a provider you choose | `payload/mishkan/cognee/.env` (work box) and `.env.curated` (curated box) |

This chapter is about the second — the model that powers `cognify`/`memify`/`search`
inside the cognee containers. The agents' Claude tiers are covered in
[Orchestration](./03-orchestration.md).

## Match provider to box

The two stores have different threat models, which translate into different
provider choices.

| Store | Contains | Provider recommendation | Why |
|---|---|---|---|
| **Work** (`:7777`) | project knowledge, may contain PII | **Local Ollama LLM** (private, no quota), or paid/no-train cloud, or a free cloud you accept training on | every free cloud tier trains on prompts; PII shouldn't leak |
| **Curated** (`:7730`) | public reference resources, no PII | Any free cloud (Gemini, NVIDIA catalog, OpenRouter named-free) is fine | nothing sensitive |

**Embeddings should be local** in both stores. Bulk ingest fires many embedding
calls in a burst; cloud free-tier embedding endpoints 429 on that pattern. Local
Ollama (`nomic-embed-text`, 768-dim) has no rate cap and embeds in milliseconds
once the model is loaded.

## The five provider profiles in `.env.example`

The shipped `.env.example` carries five commented profiles. Pick one, uncomment,
recreate the relevant services.

| Profile | LLM | Embeddings | Use it when |
|---|---|---|---|
| **A — fully self-hosted (Ollama)** | local `qwen2.5:3b` (recommended) or `llama3.1:8b` | local `nomic-embed-text` | want privacy + zero cost, accept slower cognify; the default for work box if there's PII |
| **B — Google Gemini** | `gemini-2.5-flash` | `gemini-embedding-001` (3072-dim) | fast cloud, **need a billing-enabled key** — bare free keys 429 immediately |
| **C — OpenAI** | `gpt-5-mini` (or current) | `text-embedding-3-large` (3072-dim) | familiar, paid, reliable |
| **D — Anthropic/Claude LLM + OpenAI embeddings** | `claude-sonnet-4-5` | OpenAI's | **must split** — Claude ships no embedding model |
| **E — NVIDIA API Catalog (OpenAI-compatible)** | a non-thinking catalog model (e.g. `meta/llama-3.3-70b-instruct`) | local Ollama | **recommended low-cost cloud** — generous free testing tier, OpenAI-compatible |

The dimension column matters: **embedding dimensions cannot change after first
ingest without wiping the vector store**. Pick 768 (Ollama / Gemini) or 3072
(OpenAI / Gemini-embedding-001) and stick with it. This caveat is documented
in the `.env.example` header.

## Hybrid is fine — and the recommended starting point

Cloud LLM + local embeddings is the practical hybrid. Live `.env` example used
during the build:

```
LLM_PROVIDER=gemini
LLM_MODEL=gemini/gemini-2.5-flash
LLM_API_KEY=<billed key>
EMBEDDING_PROVIDER=ollama
EMBEDDING_MODEL=nomic-embed-text:latest
EMBEDDING_ENDPOINT=http://ollama:11434/api/embed
EMBEDDING_DIMENSIONS=768
HUGGINGFACE_TOKENIZER=nomic-ai/nomic-embed-text-v1.5
```

After the NVIDIA pivot (when Gemini's daily cap kept hitting):

```
LLM_PROVIDER=custom
LLM_MODEL=openai/meta/llama-3.3-70b-instruct
LLM_ENDPOINT=https://integrate.api.nvidia.com/v1
LLM_API_KEY=<nvapi-...>
LLM_MAX_TOKENS=16384
# embeddings unchanged (local Ollama)
```

## Rate cap vs daily cap — they are different walls

This caught the build out and bears repeating:

| Cap | Symptom | What helps |
|---|---|---|
| **Per-minute (RPM)** | `429` mid-run, after a burst of fast calls | `LLM_RATE_LIMIT_*` throttle in `.env` (8 req/60s default) |
| **Per-day (RPD)** | `429 RESOURCE_EXHAUSTED` early in a run that's been quiet | **nothing in-process helps** — wait for reset, switch provider, or use a paid tier |

The throttle (`LLM_RATE_LIMIT_ENABLED=true`, `_REQUESTS=8`, `_INTERVAL=60`) was
added in commit `70d3c2e` after Gemini free-tier bulk-cognify kept blowing the
per-minute window. It cannot rescue you from RPD — Gemini's free RPD is small
enough that even one large doc cognify can exhaust it.

If you keep hitting RPD on a free cloud tier, the durable fixes are
(in increasing severity):

1. **Selectively ingest** (don't cognify large unneeded docs — see
   [05](./05-selective-ingest.md)).
2. **Switch to NVIDIA API Catalog** (Profile E) for a more generous free tier.
3. **Switch the work box to local Ollama LLM** (Profile A) — slowest but
   no quota wall and private.

## The thinking-model trap

DeepSeek V4 Pro, NVIDIA Nemotron reasoning models, and similar are **thinking
models**: they emit `<think>...</think>` tokens before the visible answer. Two
problems for cognee:

- **Cost / latency.** Every extraction call burns thousands of reasoning tokens
  before the structured output.
- **Instructor breaks.** Cognee uses `instructor` for JSON parsing of structured
  output. A reasoning preamble before the JSON throws off the parser.

You need to **disable thinking** for cognee. The canonical knob (from NVIDIA's
own docs) is:

```python
extra_body={"chat_template_kwargs":{"thinking": False}}
```

In `.env` via litellm:

```
LLM_ARGS={"extra_body":{"chat_template_kwargs":{"thinking":false}}}
```

**Caveat from the build:** during this session, litellm's `extra_body`
forwarding through the `custom` provider path was unreliable, and the flag
sometimes didn't reach NVIDIA — calls then 504-timed out as the model thought
unbounded. **The reliable workaround is to pick a non-thinking model** (e.g.
`meta/llama-3.3-70b-instruct` on the NVIDIA catalog) rather than fight the flag.

## Embedding dimensions and limits

| Embedding model | Dim | Max tokens / chunk | Notes |
|---|---|---|---|
| `nomic-embed-text` (Ollama, local) | 768 | 8,192 | the default; long chunks 422 — see [Troubleshooting](./07-troubleshooting.md) |
| `text-embedding-3-large` (OpenAI) | 3,072 | 8,191 | cloud, paid |
| `gemini-embedding-001` (Gemini AI Studio) | 3,072 | up to ~30K | cloud; older `text-embedding-004` retired on v1beta (commit `e17f2a9`) |

The 8,192-token limit on `nomic-embed-text` is the reason cognify can jam on a
single oversized chunk. Lower cognee's `LLM_MAX_TOKENS` if you see persistent
422s on embedding (the chunker uses the same value).

## How to switch profiles

1. Edit `~/.claude/mishkan/cognee/.env` — comment the active block, uncomment
   the chosen profile, set the key.
2. If embedding dimensions changed, the vector store must be wiped:
   ```bash
   docker exec mishkan-cognee-pg psql -U cognee -d cognee_db -c \
     "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
   # then prune cognee's relational state
   ```
   (Documents will need to be re-ingested.)
3. Recreate the services that read the env:
   ```bash
   cd ~/.claude/mishkan/cognee
   docker compose -f docker-compose.yml -f docker-compose.hardening.yml \
                  -f docker-compose.selfhosted.yml -f docker-compose.ui.yml \
                  --profile ui up -d --force-recreate --no-build \
                  cognee-mcp cognee-backend
   ```
4. Re-run an ingest to confirm cognify completes against the new provider.

## Sanity-check any new key before a bulk run

A 30-second curl saves hours:

```bash
K='<your-key>'
# Gemini
curl -s -X POST "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$K" \
  -H 'Content-Type: application/json' \
  -d '{"contents":[{"parts":[{"text":"say ok"}]}]}'

# NVIDIA / OpenAI-compatible
curl -s -X POST "https://integrate.api.nvidia.com/v1/chat/completions" \
  -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -d '{"model":"meta/llama-3.3-70b-instruct","messages":[{"role":"user","content":"reply with single word ok"}],"max_tokens":20}'
```

A `200` with the model's reply means the key + model id are good. A `429
RESOURCE_EXHAUSTED` on the very first call means the daily quota is
already gone.

## See also

- Throttle introduction: commit `70d3c2e`.
- Provider profile cleanup + Gemini embedding model fix: commit `e17f2a9`.
- Hybrid Gemini-LLM + Ollama-embed: live `.env` evolution during the build.
- Cognee provider catalog: `~/.claude/mishkan/cognee/_src/cognee/.env.template`
  (read-only reference).
- Why daily cap fixes are out of in-process scope: [Troubleshooting §RPD](./07-troubleshooting.md#daily-quota-rpd-wall).
