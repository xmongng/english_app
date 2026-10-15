# english_app

Run locally with Node.js 20 or later:

1. Copy `.env.example` to `.env` and set `NVIDIA_API_KEY` in `.env`.
2. Run `node server.mjs` from this directory.
3. Open `http://127.0.0.1:3000`.

The API key is read only by the server. `.env` is ignored by Git and excluded from Vercel deployment. For Vercel, set `NVIDIA_API_KEY` in the project's environment variables rather than uploading `.env`.

Study progress is stored locally immediately and synced to a private Vercel Blob store when the badge says **Cloud saved**. Create an email/password account on the device holding your current lessons; registration copies its words and progress into the account. Sign in with the same account on another device to restore them without a recovery code. Existing recovery-code backups remain available from the sign-in screen for migration. The previous Firebase setup used one shared profile for all visitors and remains disabled; data in that Firebase project is not published with this repository.

The Vercel project needs a private Blob store connected to it. Vercel provides `BLOB_STORE_ID` and short-lived OIDC credentials to its functions. `/api/account` stores salted scrypt password hashes and issues a 30-day HttpOnly session cookie. `/api/vault` uses that session to access the account's private snapshot and checks revisions before overwriting. Anonymous recovery-code backups remain supported. Local changes remain available if cloud storage is temporarily unavailable; the badge shows when cloud saving succeeds. This app currently has no email verification or password-reset delivery service, so keep your password safe.

AI vocabulary extraction tries Nemotron 3.5 Lightning, GPT-OSS 20B, Nemotron 3 Super and Nemotron 3 Ultra in order until an answer passes completeness validation. It prepares up to 20 entries per call (12,000-character batching target), requests compact English/Vietnamese/example output, and allows 50 seconds and 8,192 output tokens per import attempt inside a 60-second function. Supplied optional details can be retained without generating unnecessary fields. Tables retain their headers across chunks, and examples stay with their entries. Difficult batches split into smaller groups; successful groups are cached in the current page so retries only repeat failed groups. Partial results remain available for explicit review and saving. `AI_IMPORT_MODELS` can override the ordered route.

The AI proxy allows at most one NVIDIA call every 15 seconds, counting model fallbacks. Browsers honor `Retry-After`, resume the next pending model, and carry failure diagnostics across requests. The connected private Blob store uses conditional writes to coordinate this limit across Vercel instances. Redis can override it with both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Without either service, the local limiter coordinates only one server process. Shared limiter failures stop AI calls rather than bypassing the quota.

Run `node --test tests/*.test.mjs` for parser, scoring, streak, review, and rate-limit checks. Scripts in `scripts/` can be used for manual provider checks; they are excluded from Vercel deployment.
