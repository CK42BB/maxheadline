# MaxHeadline

AI-powered news broadcast with 7 procedural 3D characters, vaporwave aesthetics, and unhinged Max Headroom energy.

**Live demo: [maxheadline.com](https://maxheadline.com)**

## Features

- **7 procedural 3D characters** — built entirely from Three.js primitives (no imported models), each with unique personality, voice, and animation style
- **AI news generation** — Claude API with web search fetches and editorially rewrites real news stories
- **Character voice acting** — ElevenLabs TTS with 7 distinct voices, pre-generated and cached
- **Real-time lip sync** — Web Audio API analyser drives mouth animation from actual audio amplitude
- **3 news modes** — Everything (balanced), Up Only (positive news), State of the Art (frontier tech)
- **CRT post-processing** — custom GLSL shaders for scanlines, barrel distortion, chromatic aberration, and glitch effects
- **Vaporwave scene** — animated grid floor, gradient sky, floating wireframe props, neon columns, particle field
- **Live data tickers** — financial markets (Yahoo Finance), power rankings (Claude API), prediction markets (Polymarket)
- **Procedural sunglasses** — 7 styles with animated fractal lens textures (Mandelbrot, Voronoi, Julia set, fire)

## Tech Stack

- **Frontend**: Single HTML file (~5600 lines) — Three.js r172, Web Audio API, pure CSS
- **Backend**: Node.js + Express (~1500 lines) — zero framework overhead
- **Database**: PostgreSQL (stories, audio, rankings, markets)
- **AI**: Anthropic Claude API (news + rankings), ElevenLabs (TTS)
- **Hosting**: Railway (auto-deploys from GitHub)
- **Build tools**: None. No bundler, no TypeScript, no React, no webpack.

## Quick Start

```bash
git clone https://github.com/CK42BB/maxheadline.git
cd maxheadline
npm install
cp .env.example .env
# Add your API keys to .env
node server.js
```

Open `http://localhost:3000` and trigger a news refresh:

```bash
curl -X POST http://localhost:3000/api/refresh -d '{"mode":"all"}' -H 'Content-Type: application/json'
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key for news generation and power rankings |
| `ELEVENLABS_API_KEY` | Yes | ElevenLabs API key for TTS voice generation |
| `DATABASE_URL` | No | PostgreSQL connection string (falls back to JSON file cache) |
| `PORT` | No | Server port (default: 3000) |

## Architecture

```
index.html          — entire frontend (CSS, JS, Three.js scene, characters, UI)
server.js           — entire backend (API routes, TTS, news, caching, scheduling)
data/               — runtime cache (gitignored)
memes/              — static meme images served at /memes
```

For a full technical deep-dive, see [TECH.md](TECH.md).

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/stories` | Cached news stories by mode |
| POST | `/api/refresh` | Trigger news refresh |
| GET | `/api/audio/:char/:story/:energy` | Stream character audio |
| GET | `/api/ticker` | Financial market data |
| GET | `/api/power-ticker` | Power score rankings |
| GET | `/api/event-markets` | Prediction market odds |
| GET | `/api/image-proxy` | CORS proxy for news images |

## Characters

| Character | Name | Personality |
|-----------|------|-------------|
| Frog | Ribbitz | Inflating throat pouch, wide protruding eyes |
| Robot | CHROM-E | Real-time chrome reflections, LED mouth grid |
| Skull | Mortimer | Hinged jaw with teeth, glowing red pupils |
| Fox | Voxel | Tapered snout, tall ear cones, squinted eyes |
| Owl | Hootspa | Huge double-ring eyes, feather ruff torus |
| Cat | Whiskers | 6 whiskers, vertical slit pupils, "w" mouth |
| Wizard | Glitch | Cone hat with sparkles, beard, crystal orb |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and guidelines.

## License

[MIT](LICENSE)
