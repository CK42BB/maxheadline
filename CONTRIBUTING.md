# Contributing to MaxHeadline

## Local Setup

1. Clone the repo and install dependencies:
   ```bash
   git clone https://github.com/CK42BB/maxheadline.git
   cd maxheadline
   npm install
   ```

2. Create a `.env` file from the example:
   ```bash
   cp .env.example .env
   ```

3. Add your API keys to `.env`:
   - **ANTHROPIC_API_KEY** — get one at [console.anthropic.com](https://console.anthropic.com)
   - **ELEVENLABS_API_KEY** — get one at [elevenlabs.io](https://elevenlabs.io)

4. (Optional) Set up PostgreSQL and add `DATABASE_URL` to `.env`. Without it, the server uses JSON file caching — stories work fine but audio won't persist across restarts.

5. Start the server:
   ```bash
   node server.js
   ```

6. Open `http://localhost:3000`

## Triggering a News Refresh

Stories don't auto-fetch on startup. To populate stories locally:

```bash
# Refresh all modes
curl -X POST http://localhost:3000/api/refresh -d '{"mode":"all"}' -H 'Content-Type: application/json'

# Refresh a single mode
curl -X POST http://localhost:3000/api/refresh -d '{"mode":"everything"}' -H 'Content-Type: application/json'
```

## PR Workflow

1. Fork the repo and create a feature branch
2. Make your changes
3. Verify the server starts cleanly: `node -c server.js && node server.js`
4. Open a PR against `main` with a clear description of what changed and why

## Code Style

- **Single-file architecture** — `index.html` is the entire frontend, `server.js` is the entire backend. Don't split them into modules.
- **No build tools** — no bundler, no TypeScript, no preprocessors. Keep it simple.
- **No new dependencies** without discussion — the dependency footprint is intentionally tiny (Express, pg, dotenv).
- **CDN imports** for frontend libraries via import maps in `index.html`.

## Iron Rules

These are non-negotiable. PRs that violate them will be rejected.

1. **Stories + audio are immutable once created** — nothing deletes, replaces, or changes them until explicit expiry (72h public, 14 days DB retention).
2. **Never auto-refresh stories** — only the scheduled 6pm ET refresh and manual `POST /api/refresh`. No startup refreshes, no client-triggered refreshes.
3. **Audio in Postgres is the source of truth** — the filesystem is a fast cache layer. Never treat disk audio as authoritative.
4. **Always validate before pushing**: `node -c server.js`

## Where to Find Things

| What | Where |
|------|-------|
| All frontend code (CSS, JS, Three.js, UI) | `index.html` |
| Server, API routes, TTS, news fetching | `server.js` |
| Character builds + shader specs | `index.html` — search for `build[CharacterName]` |
| Voice config + ElevenLabs integration | `server.js` — top of file (`CHARACTER_VOICES`) |
| News prompts per mode | `server.js` — search for `modePrompts` |
| Post-processing shaders (CRT, glitch) | `index.html` — search for `CRTShader`, `GlitchShader` |
| Ticker implementations | `index.html` — search for `FinancialTicker`, `PowerTicker`, `EventMarketsTicker` |
| Technical deep-dive | [TECH.md](TECH.md) |

## Questions?

Open an issue — happy to help.
