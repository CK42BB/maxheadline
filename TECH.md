# MaxHeadline — Technology Stack

Internal reference doc. Everything that makes this thing tick.

---

## Architecture

Single-page app (`index.html`, ~5000 lines) + lightweight Node/Express server (`server.js`, ~840 lines). No build step, no bundler, no framework. ES6 modules loaded via CDN import maps. Deploys on Railway.

---

## 3D Rendering — Three.js r0.172.0

The entire broadcast scene is built with Three.js primitives — no imported models, no GLTF, no Blender. Every character is hand-constructed from `BoxGeometry`, `SphereGeometry`, `CylinderGeometry`, and `ConeGeometry` with manual vertex manipulation for organic shapes.

### Custom Post-Processing Pipeline

Two custom GLSL shaders stacked via `EffectComposer`:

**CRT Shader** — Full vintage monitor simulation in a single fragment shader. Scanlines (400-line overlay with configurable intensity), barrel distortion (curved screen edges), chromatic aberration (RGB channel offset), phosphor subpixel simulation, vignette darkening, and temporal flicker. All uniforms are animated per-frame for a living, breathing CRT feel.

**Glitch Shader** — Block-based digital corruption. Divides the screen into random blocks and displaces them horizontally with per-channel color splitting. Intensity is driven by character emotion state — outraged = heavy glitch, deadpan = almost none. Glitch events use smooth cubic easing (80ms ease-in, 120ms hold, 150ms ease-out) rather than instant snaps, making every glitch feel intentional and broadcast-quality.

### Real-Time CubeCamera Reflections

The robot character (CHROM-E) uses a `THREE.CubeCamera` with a 256px `WebGLCubeRenderTarget` for real-time environment-mapped chrome. A hidden "studio" of 9 colorful emissive panels (hot pink, cyan, gold, purple, orange, green, vaporwave gradient) is toggled visible only during CubeCamera capture, then hidden again — giving the robot vivid neon reflections of a scene the viewer never sees. Materials run at metalness 1.0, roughness 0.03, envMapIntensity 2.5. Updates throttled to every 3rd frame for performance.

### Procedural Environment Map

A `PMREMGenerator` creates a baked environment map from a custom shader sphere with neutral grays and 3 emissive highlight spheres — gives all materials subtle ambient reflections without a skybox texture.

### Vaporwave Scene Construction

- **Infinite grid floor**: `GridHelper(100, 40)` in pink/purple with transparency, plus an emissive ground glow plane
- **Gradient sky**: Large sphere with custom `ShaderMaterial` blending 3 colors vertically with animated horizontal scan drift and procedural star twinkle
- **20 wireframe floating props**: Torus, octahedron, icosahedron, tetrahedron, torus knot, dodecahedron — all neon-colored, slowly rotating and floating at varying depths
- **6 solid glowing shapes**: Semi-transparent emissive geometry for depth
- **300-particle sparkle field**: Additive-blended points in pink/cyan/purple/green
- **Neon ring halos**: 2 torus rings behind the character, independently rotating
- **Neon columns**: Purple cylinders with cyan orbs flanking the stage

### Mode-Specific Backgrounds

Three complete color palettes swap based on news mode — Everything (pink/cyan/purple vaporwave), Up Only (green/gold/amber warmth), Not Great (red/orange/dark aggressive). Grid, sky gradient, props, fog, and lighting all shift.

### Broadcast Lighting Rig

7-light setup: warm key (upper-right, 2.5 intensity), cyan fill (left, 1.5), hot pink rim (backlight, 2.0), purple kick (below, 0.8), ambient (1.0), hemisphere (cyan sky/pink ground, 0.6), and a character spotlight point light (1.5). Fill light color shifts per mode.

---

## Character System — 10 Procedural 3D Characters

All characters extend `CharacterBase`, which provides shared animation, emotion response, and lip sync. Each character is built entirely from Three.js primitives with no external assets.

### Characters

| # | ID | Name | Signature Feature |
|---|-----|---------|---|
| 1 | frog | Ribbitz | Throat pouch inflates on emphasis, wide protruding eyes |
| 2 | robot | CHROM-E | Real-time CubeCamera chrome, 12-LED mouth grid, signal-ring antennas |
| 3 | skull | Mortimer | Vertex-colored bone gradient (ivory/darker temples/brow), hinged jaw with teeth rows, glowing red pupils |
| 4 | fox | Voxel | Tapered snout cone, tall ear cones, squinted eyes |
| 5 | octopus | Inkwell | 8 tentacles with suction cups, bulbous dome, sinusoidal wave animation |
| 6 | alien | Zyx-9 | Massive wrap-around eyes (no pupils), antenna orbs that pulse per emotion |
| 7 | owl | Hootspa | Huge double-ring eyes with twitching pupils, feather ruff torus |
| 8 | cat | Whiskers | 6 whiskers from single origin point, vertical slit pupils, custom "w"-shaped mouth |
| 9 | wizard | Glitch | Cone hat with sparkle spheres, tapered beard, rotating crystal orb |
| 10 | mask | Persona | Split comedy/tragedy sunglasses lenses (blue/red) |

### Sunglasses System

Every character wears sunglasses — 7 procedural styles (visor, angular, round, wrap, hexagonal, slit, split). Lenses use dynamic `CanvasTexture` with 5 procedural patterns that cycle:

- **Mandelbrot fractal** with infinite zoom
- **Voronoi tessellation** with toroidal distance (seamless tiling)
- **Gradient flow** (lava lamp / aurora borealis)
- **Recursive origami** folding patterns
- **Julia set fractal** with rotating parameter

In "Not Great" mode, lenses switch to **procedural fire** — multi-octave sin-based noise with a fire color ramp (black, deep red, orange, yellow, white). Lens textures update every 3 frames.

### Animation System

- **Idle**: Gentle sine-wave sway, periodic blinks (randomized 2-6s interval), micro head movements
- **Speaking**: Multi-axis mouth animation (vertical open, horizontal stretch, depth push), head bob scaled by emotion intensity, shoulder reactive bounce, sunglasses independent float
- **Glitch**: Smooth cubic-eased position/rotation snap — not instant jitter. Ease-in (80ms) to offset, hold (120ms), ease-out (150ms) to origin. Rates vary by emotion (0.05% for hopeful → 0.5% for outraged)
- **Emphasis**: Forward lunge on stressed words
- **Emotion transitions**: Smooth lerp on body lean, eye scale, head speed

### Emotion Map (8 emotions)

Each emotion drives: head movement speed, glitch probability, eye scale, voice rate/pitch, and a signature color. Stories arrive tagged with an emotion from the AI, and the character's entire behavior shifts to match.

---

## Audio — ElevenLabs TTS + Web Audio API

### ElevenLabs Integration

10 unique voices mapped to characters, using the `eleven_multilingual_v2` model. Two energy modes per voice — **lowkey** (smooth newsreader: higher stability, lower style) and **highkey** (unhinged Max Headroom: low stability, max style). Headline and summary get separate voice configs — headlines are slower and more authoritative.

Server pre-generates all TTS on news refresh: every story x every character x both energy levels x headline + summary = bulk generation with 300ms rate limiting. Cached as MP3 files on disk.

### Web Audio API Pipeline

```
AudioBufferSourceNode → GainNode → AnalyserNode → AudioContext.destination
```

**Gapless playback**: Headline and summary audio buffers are fetched in parallel via `Promise.all`, then concatenated into a single `AudioBuffer` with a 0.6s broadcast-style gap using a custom `joinBuffers()` method. No sequential network waterfall, no audible pause.

**Real-time lip sync**: `AnalyserNode` (FFT 256, smoothing 0.6) extracts frequency data every animation frame. Amplitude maps to character mouth openness with fast attack (18x multiplier) and slow release (8x) for natural-feeling speech animation.

**Audio glitches**: Smooth volume swells (1.0 → 1.3 → 1.0 over 320ms) at randomized 4-10s intervals. No jarring cuts.

**Cancellation**: Monotonic generation counter (`_playGeneration`) on the playback controller. Every `playStory`/`skip`/`stop` bumps the counter. All async checkpoints verify the generation matches — stale audio chains silently abort. `stop()` disconnects nodes AND resolves pending promises via `_playingResolve` callback for immediate unblocking.

**Silence trimming**: Decoded buffers are scanned for leading/trailing silence (threshold 0.01) and trimmed before playback.

### Fallback Chain

1. Pre-generated character-specific audio from cache
2. Frog's cached audio (always generated first, used as fallback for other characters)
3. Live ElevenLabs TTS fetch (parallel headline + summary, joined client-side)
4. Web Speech API (browser native TTS, last resort)

---

## News Engine — Anthropic Claude API

### Fetching

Claude `claude-sonnet-4-5-20250929` with the `web_search_20250305` tool (up to 8 searches per request). Three mode-specific prompts:

- **Everything**: Balanced mix of world news, tech, politics, environment, economy
- **Up Only**: Positive stories only — breakthroughs, conservation wins, scientific progress
- **Not Great**: Alarming/dystopian stories with dark humor editorial take

Returns 8 stories per mode, each with: `id`, `headline`, `summary`, `summaryHighkey` (editorial "Real Story" take), `emotion`, `severity` (1-10), `source`, `sourceUrl`, `imageUrl`, `category`.

### Image Resolution Pipeline

Three-phase approach to get high-quality hero images:
1. Keep Claude-provided URLs if valid
2. Scrape article pages for `og:image`, `twitter:image`, JSON-LD structured data, or first `<figure><img>`
3. Fall back to a second Anthropic web_search specifically for news photos

Filters out generic logos, favicons, and placeholder images. Resolves relative URLs to absolute.

### Scheduling

Automatic refresh at 6am and 6pm ET daily. On refresh: fetch stories for all 3 modes, resolve images, pre-generate TTS for all characters. Stories cached as JSON on disk.

---

## Financial Ticker — Yahoo Finance API

15 symbols tracked: indices (DJI, S&P 500), crypto (BTC, ETH), commodities (Gold, Silver), forex (EUR/USD, GBP/USD), and mega-cap tech (AAPL, NVDA, TSLA, GOOG, META, AMZN, MSFT). 2-minute cache. Displayed as a CNN-style scrolling ticker bar at the bottom of the viewport.

---

## Frontend CSS

Pure CSS, no preprocessor. Vaporwave palette via CSS custom properties. CRT overlay effect using `repeating-linear-gradient` (4px scanline cycle) + animated flicker + moving scan-drift highlight bar. Glitch text effect via dual `::before`/`::after` pseudo-elements with `clip-path` color splitting. Auto-hiding UI on 3-second idle. Responsive stacking below 768px.

---

## Server — Node.js + Express

~840 lines. Serves static files, proxies all external API calls (Anthropic, ElevenLabs, Yahoo Finance), handles image CORS proxying, manages file-based caching, and runs the scheduled refresh timer. No database. No ORM. Just `fs` and `fetch`.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/stories` | Serve cached stories by mode |
| POST | `/api/news` | Legacy trigger, returns cached or fetches |
| GET | `/api/audio/:char/:story/:energy` | Stream pre-generated MP3 |
| POST | `/api/tts` | Live TTS fallback |
| GET | `/api/image-proxy` | CORS proxy for news images |
| POST | `/api/stats` | Track character play counts |
| GET | `/api/stats` | View usage analytics |
| GET | `/api/ticker` | Financial market data |
| POST | `/api/refresh` | Manual news refresh |
| POST | `/api/regen-tts` | Regenerate missing audio |

---

## Dependencies

**Runtime**: Node.js, Express 4.21, dotenv 16.4. That's it.

**CDN**: Three.js r172 (core + EffectComposer + RenderPass + ShaderPass), Google Fonts (VT323, Space Mono).

**External Services**: Anthropic Claude API, ElevenLabs TTS API, Yahoo Finance API.

**No build tools. No bundler. No TypeScript. No React. No webpack. One HTML file and one server file.**
