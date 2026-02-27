# How to Build Scrolling Tickers (Three.js + Canvas)

Guide for building scrolling news/data tickers like the ones in MaxHeadline. All three tickers use the same architecture: **2D Canvas → Three.js Texture → Scrolling Plane**.

## Architecture Overview

```
Data Source (API) → Server Cache → Client Fetch → Canvas Render → Three.js Texture → Scroll Loop
```

Each ticker is a self-contained class that:
1. Fetches data from a server API endpoint
2. Measures text widths for seamless looping
3. Draws colored text on a 2D canvas
4. Maps that canvas as a Three.js texture on a plane
5. Redraws each frame with a scroll offset

## The Three Tickers

| Ticker | Data Source | Refresh | Scroll | Speed |
|--------|-----------|---------|--------|-------|
| Financial | Yahoo Finance (stock prices) | 2 min | ← Left | 0.8 px/frame |
| Power | Claude AI (public figure scores) | 10 min | → Right | 0.6 px/frame |
| Event Markets | Polymarket (prediction odds) | 5 min | ← Left | 0.5 px/frame |

## Step 1: Server-Side Data Endpoint

Each ticker needs a simple JSON API. Cache aggressively — tickers poll frequently.

```javascript
// Example: serve cached data with a static fallback
app.get('/api/my-ticker', async (req, res) => {
  const cached = await loadFromDB();
  if (cached && cached.items) return res.json(cached);
  res.json(STATIC_FALLBACK); // always have a fallback
});
```

**Data format** — keep it minimal. Each item needs:
- A **label** (symbol, name, title)
- A **value** (price, score, odds)
- A **direction** (up/down, positive/negative) for coloring

```javascript
// Financial: { symbol: "BTC", price: 95420, change: 2.3, up: true }
// Power:     { name: "Musk", score: 4 }
// Events:    { title: "Will BTC hit $150k?", odds: 38, volume: 980000 }
```

## Step 2: Client-Side Ticker Class

### Constructor — Set Up Canvas + Three.js Plane

```javascript
class MyTicker {
  constructor(scene) {
    // 1. Create a 2D canvas (wide and short)
    this.canvas = document.createElement('canvas');
    this.canvas.width = 2048;  // wide for smooth scrolling
    this.canvas.height = 56;   // thin strip
    this.ctx = this.canvas.getContext('2d');

    // 2. Create Three.js texture from canvas
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;

    // 3. Create a plane and apply the texture
    const geo = new THREE.PlaneGeometry(6, 0.20); // width, height in 3D units
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,  // prevents z-fighting
      side: THREE.FrontSide
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = -1; // render behind main content
    this.mesh.position.set(0.3, -0.2, -0.4); // x, y, z in scene
    scene.add(this.mesh);

    // 4. Start fetching data
    this.data = [];
    this._scrollPx = 0;
    this._contentWidth = 0;
    this.fetchData();
    setInterval(() => this.fetchData(), 120000); // refresh every 2 min
  }
```

### Fetch Data

```javascript
  async fetchData() {
    try {
      const res = await fetch('/api/my-ticker');
      if (!res.ok) return;
      this.data = await res.json();
      this._measureItems(); // recalculate widths
      this._renderTexture(); // draw initial frame
    } catch {} // silent fail — will retry on next interval
  }
```

### Measure Text Widths (Critical for Seamless Looping)

Pre-measure every item so you know the exact pixel width of the full content strip. This enables the modulo trick for infinite scrolling.

```javascript
  _measureItems() {
    const ctx = this.ctx;
    ctx.font = 'bold 24px monospace';
    let totalWidth = 0;
    this._items = this.data.map(item => {
      const labelW = ctx.measureText(item.label).width;
      const valueW = ctx.measureText(item.value).width;
      const itemWidth = labelW + 12 + valueW + 50; // 12px gap, 50px spacing
      totalWidth += itemWidth;
      return { ...item, labelW, valueW, itemWidth };
    });
    this._contentWidth = totalWidth || 1;
  }
```

### Draw a Single Frame

```javascript
  _drawFrame(scrollPx) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;

    // Background
    ctx.fillStyle = '#0c0820';
    ctx.fillRect(0, 0, W, H);

    // Top/bottom accent borders
    ctx.fillStyle = '#00f0ff'; // cyan
    ctx.fillRect(0, 0, W, 2);
    ctx.fillStyle = '#ff2d95'; // pink
    ctx.fillRect(0, H - 2, W, 2);

    // Scrolling text
    ctx.font = 'bold 24px monospace';
    ctx.textBaseline = 'middle';
    const cw = this._contentWidth;
    let x = -(scrollPx % cw); // modulo = infinite seamless loop

    // Draw enough passes to fill the visible canvas width
    while (x < W) {
      for (const item of this._items) {
        // Label (muted color)
        ctx.fillStyle = '#a0a8c0';
        ctx.fillText(item.label, x, H / 2);
        x += item.labelW + 12;

        // Value (green if up, red if down)
        ctx.fillStyle = item.up ? '#39ff14' : '#ff4444';
        ctx.fillText(item.value, x, H / 2);
        x += item.valueW + 50;
      }
    }
  }
```

### Animate (Called Every Frame)

```javascript
  update(elapsed) {
    if (!this._contentWidth) return;
    this._scrollPx += 0.7; // adjust speed here (px per frame)
    this._drawFrame(this._scrollPx);
    this.texture.needsUpdate = true; // tell Three.js to re-upload texture
  }
}
```

## Step 3: Wire It Up

```javascript
// In your main app setup:
this.myTicker = new MyTicker(this.scene);

// In your animation loop:
function animate() {
  requestAnimationFrame(animate);
  if (this.myTicker) this.myTicker.update(elapsed);
  renderer.render(scene, camera);
}
```

## Visual Style Reference

All MaxHeadline tickers share this palette:

| Element | Color | Hex |
|---------|-------|-----|
| Background | Dark purple-black | `#0c0820` |
| Label text | Muted blue-gray | `#a0a8c0` |
| Value text | Light gray | `#e0e0e8` |
| Positive/Up | Neon green | `#39ff14` |
| Negative/Down | Red | `#ff4444` |
| Accent cyan | Cyan | `#00f0ff` |
| Accent pink | Hot pink | `#ff2d95` |

## Tips

- **Canvas size matters**: 2048px wide gives smooth scrolling. Going smaller causes visible pixel jumping.
- **Always pre-measure text**: Without accurate widths, your loop seam will be visible.
- **`depthWrite: false`** is essential — without it, the ticker plane will z-fight with other transparent objects.
- **`texture.needsUpdate = true`** must be set every frame you redraw. Three.js won't re-upload the texture otherwise.
- **Scroll direction**: Left = `-(scrollPx % width)`, Right = negate scrollPx before modulo.
- **Multiple tickers**: Vary scroll speeds and directions to create visual texture. We use 2 left + 1 right.
- **Static fallback**: Always have hardcoded data so the ticker shows something even if the API is down.
- **Refresh interval**: Match the data's natural update frequency. Stocks = 2 min, predictions = 5 min, AI-generated = 10 min.

## Data Sources Used in MaxHeadline

| Ticker | Source | Cost | Auth |
|--------|--------|------|------|
| Financial | Yahoo Finance v7/v8 API | Free | Cookie/crumb auth |
| Power | Anthropic Claude API + web search | ~$0.02/call | API key |
| Events | Polymarket gamma API | Free | None |
