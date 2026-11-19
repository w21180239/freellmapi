# Catalog operations reference

Management API facts and hard-won provider notes. Verified on desktop 0.16.26 (2026-11-13) unless noted.

## Management API

- Base: `http://127.0.0.1:<port>`, port from `%APPDATA%\FreeLLMAPI\config.json` (31415). `ops.mjs` reads it.
- Auth: `POST /api/auth/desktop-session` (empty JSON body) returns a session token; send it as `Authorization: Bearer <token>`; revoke with `POST /api/auth/logout`. `ops.mjs` keeps the token in memory and logs out in `finally`. The session token does not authenticate `/v1`.
- `GET /api/keys`: id, platform, label, status, enabled, monthlyUsage, `cooldowns[]` (modelId, expiresAtMs, remainingMs). The list also carries masked key and base URL fields; project only what the task needs.
- `GET /api/models`: flat array; id, platform, modelId, displayName, enabled, keyCount, source (`catalog` or `user`), endpointScope, supportsTools, supportsVision, contextWindow, limits.
- `POST /api/models`: platform, modelId, displayName?, contextWindow?, supportsTools?, supportsVision?, rpm/rpd/tpm/tpd limits?. Also updates fallback and auto-including profiles and clears tombstones. 409 means the row exists.
- `PATCH /api/models/{id}`: partial update (`{"enabled": true}`). `DELETE /api/models/{id}` records a tombstone (catalog row) or a custom tombstone (custom row).
- `POST /api/models/{id}/test`: uses the configured provider key; returns `success`, `latencyMs`, `error`. The app throttles repeat tests of one model (429 with Retry-After).
- Rate limit: 600 requests/minute on the management API. Pace bulk calls about 120 ms apart; unpaced sweeps return 429 and misclassify working models as broken. `ops.mjs` paces and retries a 429 once.
- Direct SQLite writes skip fallback/profile updates, tombstone handling and cache invalidation, and Windows filesystem virtualization can show a different DB than the live one. Use the API; `scripts/catalog-lists.mjs` (via `ops.mjs lists`) is the one vetted direct-DB tool and targets `%APPDATA%\FreeLLMAPI\freeapi.db`.

## Error taxonomy for `test-sample`

| Class | Typical text | Meaning and action |
|---|---|---|
| ok | | Model answered. |
| no-key | `No enabled API key is currently available for this model` | Check the model's `enabled` flag first (`inventory --list-models`), then key cooldowns and quota. Re-enable with `enable-models`. A keyless provider (AI Horde, Kilo, OVH) needs one `api_keys` row: `POST /api/keys` with only `{platform}`. |
| rate-limit | 429, Rate limit, Daily Token Cap, "Model test is throttled" | Upstream or app throttle. Wait, then retest; the queue stops after 2 in a row. |
| quota | 402, credit insufficient, `403 ... Free plan` | Free tier exhausted or plan-restricted. Account state; delete subscription-only ids before re-probing the rest. |
| consent | `needs your consent for these providers: <slug>` | UnoRouter and OpenRouter `:free` pools: consent is granted once per upstream account in the browser. Account state, not a bad id. |
| banned | `401 This token status is unavailable`, "User has been banned", revoked token | Account banned. The queue stops on the first one. |
| not-found | 404, model not found | Upstream renamed or dropped the id: fix `modelId` or delete the row. |
| upstream-5xx | 500, 503, maintenance | Retry later. |
| modality | `is a search provider`, `supports /v1/audio/speech, not chat`, `does not support chat` | Non-chat model registered as chat by design. Keep non-chat ids out of the chat list. |
| timeout | timed out, aborted | Provider slow; retest once later before judging the model. |
| model-error | anything else, e.g. `returned a different or missing response` | Provider response does not match the OpenAI chat schema. |

## Provider notes

- Adapters with `supportsChat === false` (search, speech, decision) are refused by `POST /api/models`. A custom endpoint registration classifies nothing, so registering an audio or image roster against an OpenAI-compatible endpoint creates rows that can only fail. Filter ids by keyword (`add-models --skip <regex>`) before bulk-adding.
- Hard-restricted free routes in the adapters: KiosAPI accepts only its five `FREE_ROUTES` ids, NovAI only its two `CHAT_MODELS`, Kenari only ids ending `:free`, BeatAPI decision ids `jev-*` only. Anything else is a guaranteed upstream rejection.
- APINex Free caps each key at 5 requests/minute across all models and the app pre-throttles locally, so a burst answers "No enabled API key" without reaching APINex. Pace at 4/minute (`--pace 15000`). A subscription-only id answers 402, which the app reads as a credit cooldown.
- One probe queue per upstream account. A custom endpoint on a built-in provider's host (UnoRouter, KiosAPI, Kenari, LLMTR) is the same account as the built-in. Two parallel queues on one UnoRouter free account got it banned on 2026-11-14. `test-sample` runs queues one after another, one request in flight; test such a pair in a single run, one platform at a time.
- Non-chat smoke tests use the unified key (`settings.unified_api_key`) against `POST /v1/images/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions` (multipart `file`) and `/v1/embeddings`; the `freellm` skill covers these calls.
- Image, audio and transcription rows for built-in platforms come only from the signed catalog. `POST /api/media/custom` binds a row to a base URL as a custom endpoint, so a built-in provider cannot gain a media model through the API. `ops.mjs lists pin|block` keeps or removes catalog media/embedding rows locally.
- The daily custom-endpoint sync honours tombstones, so cleanups survive it, and it adds upstream ids it has not seen before.
- Provider-key swap without the key entering the transcript: click the site's copy button, read the clipboard in a local script (`Get-Clipboard -Raw`), `PATCH /api/keys/:id {key}`, clear the clipboard, print only the length.
- A provider that threw errors from a custom adapter can be fixed in this checkout, then upstreamed from a branch cut from `upstream/main` (see `AGENTS.md`, fork model).

## Researching missing models

1. `ops.mjs inventory` lists platforms with their keys and models. Search, chat, image, audio, embedding and decision providers are separate; a search key with zero chat models is expected.
2. For each platform, fetch the provider's live official model endpoint, pricing page and docs (browser with the existing session when fetch and search show nothing). A zero price in one modality or a marketing catalog page is not proof of free access.
3. Compare exact ids with `inventory --platform <p> --list-models`. Add a model when the official source shows the exact id and free eligibility for the user's scope. Leave unknown or paid ones out and record them as unresolved.
4. `displayName` = official display name, `modelId` = exact provider id (a display name is not a routing alias; check the adapter). Set `contextWindow`, `supportsTools`, `supportsVision` from provider data only; leave unknown fields unset.
5. Write the additions to a JSON array file, run `add-models <file> --dry-run`, then without `--dry-run`. Done = `read-back present N/N`.
6. Keep a progress file per task (sources, timestamps, modality, free eligibility, additions, unresolved) so work survives context compaction. Credentials stay out of progress files and reports.
7. `test-sample --platform <p> -n 2`. Report each provider as verified (all sampled ok), partially verified, not tested, or blocked, with the class and evidence. Two samples never mark a whole catalog verified.
