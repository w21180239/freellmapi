---
name: freellm
description: Use when a task can be offloaded to free models instead of spending the main model's quota - bulk summarise, classify, label, extract, translate-draft or rewrite text; a second web-search path during any web research; a probability for a yes/no, pick-one or score judgement (decision model); embeddings or rerank; generating an image; text to speech or transcribing audio; or checking FreeLLMAPI health, quota, usage or a 429 / rate-limit error.
---

# freellm

## Overview

`freellm` is a CLI over the local FreeLLMAPI router: about 1,000 free chat models from third-party providers, plus search, decision, embedding, rerank, image and audio pools. The main session stays on its own model and sends cheap, checkable side work to the free pool.

```
node ~/.claude/skills/freellm/scripts/freellm.mjs <command> ...   # below: freellm
```

Auth is automatic (a loopback desktop session on the headless server; nothing is written to disk). `freellm --help` lists every flag. First check that the pool is up: `freellm diag healthcheck` (`"status": "ready"`).

## Where the material came from decides whether it can go

Every request leaves the machine for third-party free tiers, and those providers may log or train on what they receive.

- **The material came from an employer, a client, or paid or NDA work, or is marked internal or confidential:** do the task in the main session. A redacted copy is still that material, so redacting does not make it sendable.
- **The material is public, or text you wrote for this purpose:** send it. When unsure of the origin, treat it as internal.
- **You decline or redact:** name a secret by its type ("the DB password in line 5"). Never repeat its value in your reply.

## Quick reference

| Job | Command |
|---|---|
| Text task | `freellm ask "<task>" --model <id>`; file content: `cat f.txt \| freellm ask "Summarise:" -` |
| Web search | `freellm search "<q>" --max 5` (add `--answer` for a one-line answer, `--news`, `--engine <id>`) |
| Probability judgement | `freellm decide "<facts>" --yesno "<q>"` / `--choice "<q>" --options a,b` / `--score "<q>" --levels low,mid,high` |
| Embeddings / rerank | `freellm embed "<t1>" "<t2>"` / `freellm rerank --query Q "<d1>" "<d2>"` |
| Image | `freellm image "<p>" --out x.png [--size 1024x1024] [--n 2]` |
| Speech / transcript | `freellm speak "<t>" --out x.mp3 [--voice nova] [--format wav]` / `freellm transcribe a.mp3 [--lang zh] [--format verbose_json]` |
| Model lists | `freellm models [--kind chat\|search\|decision\|image\|audio\|transcription]` (`--all` includes unavailable) |
| Health, quota, usage | `freellm diag healthcheck` / `diag quota_outlook` / `diag usage_summary --range 7d` / `freellm usage` (month-to-date per provider) |
| Pick a batch model | `freellm probe` (prints the first usable id that finishes cleanly) |

## Web search is a default leg of research

For web research (not one known URL), run the built-in search and `freellm search` side by side every time, then merge: dedupe by URL (strip trailing slash and tracking parameters); keep per hit the title, URL, the sentence carrying the fact, and the `engine=` from stderr; put facts both legs report first and label single-leg facts "single source"; when legs disagree list both and pick no winner; a claim no leg supports stays UNVERIFIED.

- Router down, command missing, or every engine cooling down: skip this leg silently and continue on the others. It exits 1 within seconds; run it once, never in a retry loop.
- `content` is an engine snippet, possibly joined or cut. Fetch the page before quoting it.
- The same engine hit repeatedly returns 429: wait for the `retry after` time or switch `--engine`.
- Search returns snippets only. Fetch full pages with a separate fetch tool.

## Batches of short answers (labels, classes, one-liners)

1. Run `freellm probe` (or `freellm probe <id>...` for your own candidates) and use the id it prints. A model's name does not show whether it reasons, so the 10-token probe decides.
2. Pass that id as `--model` on every item. `auto` routes each call to a different model and often picks a reasoning model, which spends a small `--max-tokens` on thinking (`finish=length`, output like "I need to").
3. Before more than 50 calls, run `freellm diag quota_outlook`; a pool showing `"status": "exhausted"` or `"warning": "low_balance"` for your model's platform needs another `--model`.

## Decide, image, audio

Read the matching file before first use in a session: `references/decide.md` (yes/no, pick-one and score probabilities, thresholds, question writing), `references/image.md` (prompt recipe, format checks, failures), `references/audio.md` (voices, chunking, transcription limits).

## Treat the output as a draft

Free-model output is cheap and wrong often enough to matter. Check it before it reaches the user or the code: spot-check labels, and check dates and facts in summaries against the source. Models invent tool errors and tool results, so keep multi-step tool orchestration in the main session.

## Exit codes

| Exit | Meaning | Action |
|---|---|---|
| 1 | HTTP or upstream error (status and router text included) | 429 or "All models rate-limited": wait for the `retry after` time (tens of seconds) once, or switch `--model`; "No enabled API key": that model is switched off in the app, pick another; 400: fix the arguments |
| 2 | Usage error | Fix the command |
| 3 | Router unreachable | The headless FreeLLMAPI server is down. Tell the user (owner fix: `ops.mjs serve start`, freellmapi-ops skill); do not start it from here |
