# english_app

Run locally with Node.js 20 or later:

1. Copy `.env.example` to `.env` and set `NVIDIA_API_KEY` in `.env`.
2. Run `node server.mjs` from this directory.
3. Open `http://127.0.0.1:3000`.

The API key is read only by the server. `.env` is ignored by Git and excluded from Vercel deployment. For Vercel, set `NVIDIA_API_KEY` in the project's environment variables rather than uploading `.env`.

Study progress is stored locally immediately and backed up to a private Vercel Blob store when the badge says **Cloud saved**. On first use, the app generates a 256-bit recovery code; copy and keep it safe. Enter this code under **Cloud backup** on another device to open the same lessons and vocabulary. Losing both the code and every browser that holds it makes the cloud data inaccessible. The previous Firebase setup used one shared profile for all visitors and remains disabled; data in that Firebase project is not published with this repository.

The Vercel project needs a private Blob store connected to it. Vercel provides `BLOB_STORE_ID` and short-lived OIDC credentials to its functions. The `/api/vault` endpoint accepts only a recovery code, stores one private JSON snapshot per code, and checks revisions before overwriting. Local changes remain available if cloud storage is temporarily unavailable; the badge shows when cloud saving succeeds.

The AI proxy allows at most one NVIDIA call every 15 seconds, counting model fallbacks. Browsers honor `Retry-After` and resume the pending task automatically. The built-in limiter coordinates requests in one server process. For a Vercel deployment or multiple server instances, configure both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in the deployment environment to coordinate the limit across instances. The proxy refuses AI requests if a configured shared limiter is unavailable, so it cannot silently exceed the quota.

Run `node --test tests/*.test.mjs` for parser, scoring, streak, review, and rate-limit checks. Scripts in `scripts/` can be used for manual provider checks; they are excluded from Vercel deployment.
