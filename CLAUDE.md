# MaxHeadline — Claude Code Context

Project context for AI coding assistants working on this repo.

## Iron Rules

1. **Stories + audio are IMMUTABLE once created** — nothing deletes, replaces, or changes them until explicit expiry
2. **NEVER auto-refresh stories** — only the 6pm ET schedule + manual `POST /api/refresh`. Zero startup refreshes.
3. **NEVER push code while data operations are in-flight** — Railway kills the server on deploy, losing in-flight writes
4. **Batch code changes into ONE push** — multiple rapid pushes = multiple deploys = data loss
5. **Public TTL: 72h, DB retention: 14 days** — users see stories for 72h, we retain in DB for 14 days
6. **Always `node -c server.js` before pushing**
7. **Audio in Postgres is the source of truth** — filesystem is just a fast cache

## Architecture

- **Single-file frontend**: `index.html` (~5600 lines) — all CSS, JS, Three.js scene, characters, audio, UI
- **Server**: `server.js` (~1500 lines) — Node/Express API, TTS generation, story caching, scheduling
- **No build tools** — no bundler, no TypeScript, no framework. ES6 modules via CDN import maps.
- **Database**: PostgreSQL with 4 tables (`story_cache`, `audio_cache`, `power_ticker`, `event_markets`)

## Key Patterns

- `_playGeneration` counter — MUST be bumped on any stop/switch to cancel stale audio chains
- `currentEnergyMode` is always `'highkey'`
- Stories fetch at 6pm ET daily via cron-style `setTimeout` scheduling
- Audio fallback chain: pre-generated cache → on-demand ElevenLabs → live TTS → Web Speech API

## Characters (7)

Frog (Ribbitz), Robot (CHROM-E), Skull (Mortimer), Fox (Voxel), Owl (Hootspa), Cat (Whiskers), Wizard (Glitch)

## See Also

- [TECH.md](TECH.md) — full technical deep-dive
- [CONTRIBUTING.md](CONTRIBUTING.md) — contributor guidelines
