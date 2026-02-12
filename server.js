require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static('.'));

const DATA_DIR = path.join(__dirname, 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

// Ensure dirs exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// =====================================================================
// VOICE CONFIG — matches client CHARACTER_VOICES
// =====================================================================
const CHARACTER_VOICES = {
  frog:    { voiceId: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie' },
  robot:   { voiceId: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel' },
  skull:   { voiceId: 'nPczCjzI2devNBz1zQrb', name: 'Brian' },
  fox:     { voiceId: 'VURZ3kCSkbLjDYld5lne', name: 'Celeste' },
  octopus: { voiceId: 'pqHfZKP75CvOlQylNhV4', name: 'Bill' },
  owl:     { voiceId: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger' },
  cat:     { voiceId: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica' },
  wizard:  { voiceId: 'cjVigY5qzO86Huf0OWal', name: 'Eric' }
};

// Highkey only — unhinged Max Headroom chaos energy
const VOICE_ENERGY_SETTINGS = {
  'highkey-headline': { stability: 0.1,  similarity_boost: 0.55, style: 1.0, speed: 1.0, use_speaker_boost: true },
  'highkey-summary':  { stability: 0.2, similarity_boost: 0.6, style: 0.8, speed: 1.02, use_speaker_boost: true }
};

const CHARACTER_NAMES = {
  frog: 'Ribbitz', robot: 'CHROM-E', skull: 'Mortimer', fox: 'Voxel',
  octopus: 'Inkwell', owl: 'Hootspa', cat: 'Whiskers', wizard: 'Glitch'
};

// =====================================================================
// HELPERS
// =====================================================================

function getCacheFile(mode) {
  return path.join(DATA_DIR, `stories-${mode}.json`);
}

function loadCache(mode) {
  const file = getCacheFile(mode);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data;
  } catch { return null; }
}

function saveCache(mode, data) {
  fs.writeFileSync(getCacheFile(mode), JSON.stringify(data, null, 2));
}

function loadStats() {
  if (!fs.existsSync(STATS_FILE)) return { characters: {}, totalPlays: 0 };
  try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch { return { characters: {}, totalPlays: 0 }; }
}

function saveStats(stats) {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

// =====================================================================
// OG:IMAGE SCRAPER — extract real images from article URLs
// =====================================================================
async function scrapeArticleImage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const html = await res.text();
    const baseUrl = new URL(url);

    function makeAbsolute(imgUrl) {
      if (!imgUrl) return null;
      imgUrl = imgUrl.trim();
      if (imgUrl.startsWith('//')) return 'https:' + imgUrl;
      if (imgUrl.startsWith('/')) return baseUrl.origin + imgUrl;
      if (imgUrl.startsWith('http')) return imgUrl;
      return null;
    }

    // 1. JSON-LD structured data (most reliable for article images)
    const ldMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    for (const m of ldMatches) {
      try {
        const ld = JSON.parse(m[1]);
        const items = Array.isArray(ld) ? ld : [ld];
        for (const item of items) {
          if (item.image) {
            const img = typeof item.image === 'string' ? item.image
              : (item.image.url || (Array.isArray(item.image) ? item.image[0] : null));
            if (img) {
              const abs = makeAbsolute(typeof img === 'string' ? img : img.url || img);
              if (abs) return abs;
            }
          }
        }
      } catch {}
    }

    // 2. og:image
    const ogMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
    if (ogMatch) { const u = makeAbsolute(ogMatch[1]); if (u) return u; }

    // 3. twitter:image
    const twMatch = html.match(/<meta[^>]*(?:name|property)=["']twitter:image["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["']twitter:image["']/i);
    if (twMatch) { const u = makeAbsolute(twMatch[1]); if (u) return u; }

    // 4. First <figure><img> in article body (common news site pattern)
    const figMatch = html.match(/<figure[^>]*>[\s\S]*?<img[^>]*src=["']([^"']+)["']/i);
    if (figMatch) { const u = makeAbsolute(figMatch[1]); if (u) return u; }

    return null;
  } catch { return null; }
}

// Search for a single story's image by scraping top Google/Bing-style results
async function searchSingleStoryImage(story) {
  // Try scraping multiple news sites that cover the same story
  const searchTerms = story.headline.replace(/['"]/g, '');
  const searchUrls = [
    `https://www.google.com/search?q=${encodeURIComponent(searchTerms)}&tbm=isch&tbs=qdr:w`,
    `https://news.google.com/search?q=${encodeURIComponent(searchTerms)}`,
  ];

  // Strategy: search for related articles on major outlets and scrape their og:image
  const majorOutlets = [
    `https://www.reuters.com/search/news?query=${encodeURIComponent(searchTerms)}`,
    `https://apnews.com/search?q=${encodeURIComponent(searchTerms)}`,
    `https://www.bbc.com/search?q=${encodeURIComponent(searchTerms)}`,
    `https://www.cnn.com/search?q=${encodeURIComponent(searchTerms)}`,
  ];

  // Try scraping each outlet's search results page for article links, then scrape those
  for (const searchUrl of majorOutlets) {
    try {
      const res = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html'
        },
        signal: AbortSignal.timeout(5000),
        redirect: 'follow'
      });
      if (!res.ok) continue;
      const html = await res.text();

      // Extract article links from search results
      const linkMatches = html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi);
      for (const m of linkMatches) {
        const url = m[1];
        // Skip non-article URLs
        if (url.includes('/search') || url.includes('javascript:') || url.includes('#')) continue;
        if (!url.match(/\/(article|story|news|202[0-9])/i)) continue;

        // Try scraping this article for its image
        const img = await scrapeArticleImage(url);
        if (img && !isGenericImage(img)) {
          return img;
        }
      }
    } catch { continue; }
  }
  return null;
}

// Search for relevant news images — individual per-story scraping
async function searchForStoryImages(stories) {
  const storiesNeedingImages = stories.filter(s => !s.imageUrl);
  if (storiesNeedingImages.length === 0) return stories;

  // Try individual searches in parallel
  await Promise.all(storiesNeedingImages.map(async (story) => {
    try {
      const img = await searchSingleStoryImage(story);
      if (img) {
        story.imageUrl = img;
        console.log(`  Found image for "${story.id}" via search`);
      }
    } catch {}
  }));

  // Last resort: use Anthropic API web_search for any still missing
  const stillMissing = stories.filter(s => !s.imageUrl);
  if (stillMissing.length > 0) {
    try {
      const storyList = stillMissing.map((s, i) =>
        `${i + 1}. "${s.headline}" (source: ${s.source})`
      ).join('\n');

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 2048,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: stillMissing.length * 2 }],
          messages: [{
            role: 'user',
            content: `Find a news photo URL for each story. Search for each one individually. Return a JSON array with "index" (0-based) and "imageUrl" (direct .jpg/.png/.webp URL from a news site CDN).\n\n${storyList}\n\nReturn ONLY the JSON array.`
          }]
        })
      });

      const data = await response.json();
      if (!data.error) {
        const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        const arrStart = text.indexOf('['), arrEnd = text.lastIndexOf(']');
        if (arrStart !== -1 && arrEnd !== -1) {
          const results = JSON.parse(text.substring(arrStart, arrEnd + 1));
          for (const r of results) {
            if (r.imageUrl && r.index >= 0 && r.index < stillMissing.length) {
              stillMissing[r.index].imageUrl = r.imageUrl;
            }
          }
        }
      }
    } catch (err) {
      console.error('API image search failed:', err.message);
    }
  }

  return stories;
}

// =====================================================================
// FETCH NEWS FROM ANTHROPIC
// =====================================================================
async function fetchNewsFromAPI(mode, characterName = 'Ribbitz') {
  const searchInstructions = {
    everything: `Find today's top 8 global news stories across politics, technology, science, culture, environment, and world events. Diverse mix.`,
    uponly: `Find today's 8 most positive, hopeful, uplifting global news stories — scientific breakthroughs, environmental wins, medical advances, acts of kindness, progress on hard problems, good policy outcomes. Genuinely good news only.`,
    thisisfine: `Find today's 8 most alarming, dystopian, or absurd news stories — climate disasters, corporate malfeasance, political chaos, inequality milestones, AI concerns, societal decline indicators. The kind that make you say "this is fine" while everything burns.`
  };

  const toneInstructions = {
    everything: `Classic Max Headroom — witty, sardonic, rapid-fire, slightly glitchy in delivery. Mix of genuine insight with cutting humor.`,
    uponly: `Enthusiastically optimistic, almost suspiciously positive. Genuinely excited about good news but with a wink — you know the world is complicated but right now we're celebrating. Peppy, warm, encouraging.`,
    thisisfine: `Dark gallows humor. Deadpan delivery of horrifying facts. Sardonic, occasionally breaking into manic laughter. Channel the "this is fine" dog energy. Find the absurd comedy in civilizational decline.`
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 8192,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
      messages: [{
        role: 'user',
        content: `You are ${characterName}, a Max Headroom style AI news anchor.

TASK: ${searchInstructions[mode] || searchInstructions.everything}
TONE: ${toneInstructions[mode] || toneInstructions.everything}

Search for today's news. Return EXACTLY 8 stories as a JSON array. No markdown fences, no commentary — just the JSON array.

SUMMARYHIGHKEY INSTRUCTIONS: 2-3 PUNCHY sentences MAX. Write like the smartest, most excited person at the party who cracked the code. Follow the money, name the incentive, connect ONE key dot — with infectious energy. No filler, no hedging, no long setups. ${mode === 'uponly' ? 'Be genuinely electrified — ONE killer technical detail, ONE reason it changes everything.' : 'Be razor-sharp. Specific insider detail, not rants.'}

HEADLINE: Max 8 words. Punchy. Broadcast-ready.
SUMMARY: 1-2 sentences max. Tight newsreader copy. Under 40 words.
SUMMARYHIGHKEY: 2-3 sentences max. Under 60 words. The real take.

Return this structure (imageUrl can be null if you can't find a direct image URL):
[{"id":"slug","headline":"Under 8 words","summary":"1-2 sentences, under 40 words","summaryHighkey":"2-3 sentences, under 60 words","emotion":"excited|sarcastic|alarmed|amused|deadpan|outraged|hopeful|bewildered","severity":5,"source":"Source Name","sourceUrl":"real article URL","imageUrl":"direct .jpg/.png/.webp URL or null","category":"politics|tech|science|culture|environment|world|economy|health"}]

CRITICAL: Always return JSON. sourceUrl must be real URLs from search results. severity 1=lighthearted 10=existential. KEEP IT TIGHT — every word costs money.`
      }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);

  const text = (data.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  // Extract JSON array — handle markdown fences and surrounding text
  let clean = text.replace(/```json\n?|```\n?/g, '').trim();
  // Find the JSON array in the response (Claude sometimes adds preamble text)
  const arrayStart = clean.indexOf('[');
  const arrayEnd = clean.lastIndexOf(']');
  if (arrayStart === -1 || arrayEnd === -1) {
    throw new Error('No JSON array found in API response: ' + clean.substring(0, 100));
  }
  clean = clean.substring(arrayStart, arrayEnd + 1);
  return JSON.parse(clean);
}

// =====================================================================
// RESOLVE IMAGES — scrape og:image from each story's sourceUrl
// =====================================================================
function isGenericImage(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  // Skip known generic patterns
  const genericPatterns = [
    'logo', 'icon', 'favicon', 'social-share', 'default-image',
    'placeholder', 'og-image', 'site-image', 'brand', 'avatar',
    '/static/assets/images/', '_default.', 'noimage', 'generic'
  ];
  if (genericPatterns.some(p => lower.includes(p))) return true;
  // Skip tiny images (likely icons) based on URL hints
  if (/\b(\d{1,2})x\1\b/.test(lower)) return true; // e.g. 16x16, 32x32
  return false;
}

async function resolveStoryImages(stories) {
  const seenUrls = new Set();

  // Phase 1: Keep imageUrls from Claude's initial fetch if they look valid
  stories.forEach(story => {
    if (story.imageUrl && !isGenericImage(story.imageUrl)) {
      seenUrls.add(story.imageUrl);
    } else {
      story.imageUrl = null;
    }
  });
  const fromClaude = stories.filter(s => s.imageUrl).length;
  console.log(`Got ${fromClaude}/${stories.length} images from Claude's initial fetch`);

  // Phase 2: Scrape article pages for stories still missing images
  const resolved = await Promise.all(stories.map(async (story) => {
    if (story.imageUrl) return story; // already have one from Claude
    if (story.sourceUrl) {
      const articleImage = await scrapeArticleImage(story.sourceUrl);
      if (articleImage && !isGenericImage(articleImage) && !seenUrls.has(articleImage)) {
        seenUrls.add(articleImage);
        story.imageUrl = articleImage;
        return story;
      }
    }
    story.imageUrl = null;
    return story;
  }));

  const found = resolved.filter(s => s.imageUrl).length;
  console.log(`Resolved ${found}/${resolved.length} images after article scraping`);

  // Phase 3: For stories STILL missing images, use aggressive Anthropic image search
  const missing = resolved.filter(s => !s.imageUrl).length;
  if (missing > 0) {
    console.log(`Searching for ${missing} missing story images via API...`);
    await searchForStoryImages(resolved);
    const newFound = resolved.filter(s => s.imageUrl).length;
    console.log(`Total images after search: ${newFound}/${resolved.length}`);
  }

  return resolved;
}

// =====================================================================
// TTS GENERATION
// =====================================================================
async function generateTTSForStory(characterId, storyId, text, voiceId, energy, voiceSettings) {
  const filename = `${characterId}-${storyId}-${energy}.mp3`;
  const filepath = path.join(AUDIO_DIR, filename);

  // Skip if already generated
  if (fs.existsSync(filepath)) return filename;

  if (!process.env.ELEVENLABS_API_KEY || process.env.ELEVENLABS_API_KEY === 'your-elevenlabs-key-here') {
    return null;
  }

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': process.env.ELEVENLABS_API_KEY
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: voiceSettings
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error(`ElevenLabs error:`, response.status, errText);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filepath, buffer);
    console.log(`  Generated: ${filename} (${(buffer.length / 1024).toFixed(0)}KB)`);
    return filename;
  } catch (err) {
    console.error(`TTS generation failed for ${storyId}/${energy}:`, err.message);
    return null;
  }
}

// Only pre-generate for the default character (frog) on scheduled refresh
// All other characters generate on-demand when first requested
async function generateAllTTS(stories, characterId = 'frog') {
  const voice = CHARACTER_VOICES[characterId];
  if (!voice) return;

  console.log(`Pre-generating TTS for ${stories.length} stories (${voice.name} only)...`);

  for (const story of stories) {
    await generateTTSForStory(
      characterId, `${story.id}-headline`, story.headline, voice.voiceId,
      'highkey', VOICE_ENERGY_SETTINGS['highkey-headline']
    );
    await new Promise(r => setTimeout(r, 300));

    const summaryText = story.summaryHighkey || story.summary;
    await generateTTSForStory(
      characterId, `${story.id}-summary`, summaryText, voice.voiceId,
      'highkey', VOICE_ENERGY_SETTINGS['highkey-summary']
    );
    await new Promise(r => setTimeout(r, 300));
  }
  console.log('Pre-generation complete.');
}

// On-demand TTS: generate all clips for a character+mode combination
// Called when a user first selects a non-default character
const _generatingCharacters = new Set();

async function generateCharacterTTS(characterId, mode) {
  const key = `${characterId}-${mode}`;
  if (_generatingCharacters.has(key)) return; // already in progress
  _generatingCharacters.add(key);

  const voice = CHARACTER_VOICES[characterId];
  if (!voice) { _generatingCharacters.delete(key); return; }

  const cache = loadCache(mode);
  if (!cache || !cache.stories) { _generatingCharacters.delete(key); return; }

  console.log(`On-demand TTS: generating ${characterId} for ${mode}...`);
  for (const story of cache.stories) {
    await generateTTSForStory(
      characterId, `${story.id}-headline`, story.headline, voice.voiceId,
      'highkey', VOICE_ENERGY_SETTINGS['highkey-headline']
    );
    await new Promise(r => setTimeout(r, 200));

    const summaryText = story.summaryHighkey || story.summary;
    await generateTTSForStory(
      characterId, `${story.id}-summary`, summaryText, voice.voiceId,
      'highkey', VOICE_ENERGY_SETTINGS['highkey-summary']
    );
    await new Promise(r => setTimeout(r, 200));
  }
  _generatingCharacters.delete(key);
  console.log(`On-demand TTS complete: ${characterId} for ${mode}`);
}

// =====================================================================
// FULL REFRESH — fetch news, resolve images, generate TTS
// =====================================================================
let isRefreshing = false;

async function refreshNews(mode = 'everything') {
  if (isRefreshing) {
    console.log('Refresh already in progress, skipping...');
    return;
  }
  isRefreshing = true;
  const startTime = Date.now();

  try {
    console.log(`\n=== Refreshing ${mode} news at ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET ===`);

    // Fetch stories from Anthropic (with retry)
    let stories;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`Fetching stories from Anthropic (attempt ${attempt})...`);
        stories = await fetchNewsFromAPI(mode, CHARACTER_NAMES.frog);
        console.log(`Got ${stories.length} stories`);
        break;
      } catch (fetchErr) {
        console.error(`Fetch attempt ${attempt} failed:`, fetchErr.message);
        if (attempt === 2) throw fetchErr;
        console.log('Retrying in 3s...');
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    // Resolve real images via og:image scraping
    console.log('Resolving story images...');
    const withImages = await resolveStoryImages(stories);
    const imgCount = withImages.filter(s => s.imageUrl).length;
    console.log(`Resolved ${imgCount}/${withImages.length} images`);

    // Save stories to cache
    const cacheData = {
      mode,
      stories: withImages,
      fetchedAt: new Date().toISOString(),
      fetchedAtET: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
    };
    saveCache(mode, cacheData);
    console.log(`Cached ${mode} stories`);

    // Generate TTS audio (default voice — frog/Ribbitz)
    await generateAllTTS(withImages, 'frog');

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`=== Refresh complete in ${elapsed}s ===\n`);
  } catch (err) {
    console.error(`Refresh failed for ${mode}:`, err);
  } finally {
    isRefreshing = false;
  }
}

// =====================================================================
// SCHEDULE — 6am and 6pm ET daily
// =====================================================================
function getNextRefreshTime() {
  const now = new Date();
  // Convert to ET
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const etParts = etStr.split(', ')[1].split(':');
  const etHour = parseInt(etParts[0]);

  // Next 6am or 6pm ET
  const etNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  let nextHour;
  if (etHour < 6) nextHour = 6;
  else if (etHour < 18) nextHour = 18;
  else { nextHour = 6; etNow.setDate(etNow.getDate() + 1); }

  etNow.setHours(nextHour, 0, 0, 0);
  return etNow;
}

function scheduleNextRefresh() {
  const next = getNextRefreshTime();
  const delay = next.getTime() - Date.now();
  const delayMin = (delay / 60000).toFixed(0);
  console.log(`Next refresh scheduled for ${next.toLocaleString('en-US', { timeZone: 'America/New_York' })} ET (${delayMin} min)`);

  setTimeout(async () => {
    // Refresh all three modes
    for (const mode of ['everything', 'uponly', 'thisisfine']) {
      await refreshNews(mode);
    }
    scheduleNextRefresh();
  }, delay);
}

// =====================================================================
// API ENDPOINTS
// =====================================================================

// GET /api/stories?mode=everything — serve cached stories
app.get('/api/stories', (req, res) => {
  const mode = req.query.mode || 'everything';
  const cache = loadCache(mode);

  if (!cache) {
    return res.status(404).json({ error: 'No cached stories yet. Refresh in progress...' });
  }

  res.json(cache);
});

// POST /api/news — legacy endpoint, now triggers refresh if no cache exists
app.post('/api/news', async (req, res) => {
  const { mode = 'everything' } = req.body;
  const cache = loadCache(mode);

  if (cache) {
    return res.json({ stories: cache.stories });
  }

  // No cache — do a live fetch (only happens on first load)
  try {
    await refreshNews(mode);
    const freshCache = loadCache(mode);
    if (freshCache) {
      return res.json({ stories: freshCache.stories });
    }
    res.status(500).json({ error: 'Failed to fetch and cache news' });
  } catch (err) {
    console.error('News fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch news', detail: err.message });
  }
});

// GET /api/audio/:characterId/:storyId/:energy — serve pre-generated audio
app.get('/api/audio/:characterId/:storyId/:energy', async (req, res) => {
  const { characterId, storyId, energy } = req.params;
  if (energy !== 'highkey') {
    return res.status(400).json({ error: 'energy must be highkey' });
  }

  const filepath = path.join(AUDIO_DIR, `${characterId}-${storyId}-${energy}.mp3`);

  // If file exists, serve it immediately (cached)
  if (fs.existsSync(filepath)) {
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' });
    return fs.createReadStream(filepath).pipe(res);
  }

  // On-demand generation: find the story text and generate this one clip
  const voice = CHARACTER_VOICES[characterId];
  if (!voice) return res.status(404).json({ error: 'Unknown character' });

  // Find which mode has this story
  let storyData = null;
  const baseId = storyId.replace(/-headline$|-summary$/, '');
  const isHeadline = storyId.endsWith('-headline');
  for (const mode of ['everything', 'uponly', 'thisisfine']) {
    const cache = loadCache(mode);
    if (!cache) continue;
    const found = cache.stories.find(s => s.id === baseId);
    if (found) { storyData = found; break; }
  }

  if (!storyData) return res.status(404).json({ error: 'Story not found in cache' });

  const text = isHeadline
    ? storyData.headline
    : (storyData.summaryHighkey || storyData.summary);
  const settings = VOICE_ENERGY_SETTINGS[`highkey-${isHeadline ? 'headline' : 'summary'}`];

  console.log(`[On-demand] Generating ${characterId}/${storyId} with voice ${voice.name} (${voice.voiceId})`);
  const result = await generateTTSForStory(characterId, storyId, text, voice.voiceId, energy, settings);
  if (!result) return res.status(503).json({ error: 'TTS generation failed' });

  res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' });
  fs.createReadStream(filepath).pipe(res);
});

// POST /api/prepare-character — kick off on-demand TTS generation for a character
// Returns immediately; generation happens in background
app.post('/api/prepare-character', (req, res) => {
  const { characterId, mode = 'everything' } = req.body;
  if (!CHARACTER_VOICES[characterId]) return res.status(400).json({ error: 'Unknown character' });
  if (characterId === 'frog') return res.json({ status: 'ready', preGenerated: true });

  // Check if all clips exist already
  const cache = loadCache(mode);
  if (!cache || !cache.stories) return res.json({ status: 'no_stories' });

  const missing = cache.stories.some(story =>
    !fs.existsSync(path.join(AUDIO_DIR, `${characterId}-${story.id}-headline-highkey.mp3`)) ||
    !fs.existsSync(path.join(AUDIO_DIR, `${characterId}-${story.id}-summary-highkey.mp3`))
  );

  if (!missing) return res.json({ status: 'ready', preGenerated: true });

  // Kick off generation in background
  generateCharacterTTS(characterId, mode).catch(e => console.error('Char TTS error:', e));
  res.json({ status: 'generating', characterId, mode });
});

// GET /api/character-status — check if a character's audio is ready
app.get('/api/character-status/:characterId/:mode', (req, res) => {
  const { characterId, mode } = req.params;
  const cache = loadCache(mode);
  if (!cache || !cache.stories) return res.json({ ready: false, total: 0, generated: 0 });

  let total = 0, generated = 0;
  for (const story of cache.stories) {
    total += 2; // headline + summary
    if (fs.existsSync(path.join(AUDIO_DIR, `${characterId}-${story.id}-headline-highkey.mp3`))) generated++;
    if (fs.existsSync(path.join(AUDIO_DIR, `${characterId}-${story.id}-summary-highkey.mp3`))) generated++;
  }

  res.json({ ready: generated === total, total, generated, pct: total > 0 ? Math.round(generated / total * 100) : 0 });
});

// POST /api/tts — live TTS fallback (for stories without pre-generated audio)
app.post('/api/tts', async (req, res) => {
  const { text, voiceId, voiceSettings, modelId } = req.body;

  if (!text || !voiceId) {
    return res.status(400).json({ error: 'text and voiceId required' });
  }

  if (!process.env.ELEVENLABS_API_KEY || process.env.ELEVENLABS_API_KEY === 'your-elevenlabs-key-here') {
    return res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' });
  }

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': process.env.ELEVENLABS_API_KEY
        },
        body: JSON.stringify({
          text,
          model_id: modelId || 'eleven_multilingual_v2',
          voice_settings: voiceSettings || {
            stability: 0.4,
            similarity_boost: 0.75,
            style: 0.3,
            use_speaker_boost: true,
            speed: 1.0
          }
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('ElevenLabs error:', response.status, errText);
      return res.status(response.status).json({ error: errText });
    }

    res.set({
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache'
    });

    const reader = response.body.getReader();
    const pump = async () => {
      const { done, value } = await reader.read();
      if (done) { res.end(); return; }
      res.write(value);
      return pump();
    };
    await pump();
  } catch (err) {
    console.error('TTS error:', err);
    res.status(500).json({ error: 'TTS failed', detail: err.message });
  }
});

// IMAGE PROXY — fetch news images to avoid CORS
app.get('/api/image-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': new URL(url).origin
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) return res.status(response.status).end();

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return res.status(415).end();

    res.set({
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    });

    const reader = response.body.getReader();
    const pump = async () => {
      const { done, value } = await reader.read();
      if (done) { res.end(); return; }
      res.write(value);
      return pump();
    };
    await pump();
  } catch (err) {
    res.status(500).end();
  }
});

// POST /api/stats — track character play stats
app.post('/api/stats', (req, res) => {
  const { characterId, action } = req.body;
  if (!characterId) return res.status(400).json({ error: 'characterId required' });

  const stats = loadStats();
  if (!stats.characters[characterId]) {
    stats.characters[characterId] = { selects: 0, plays: 0 };
  }

  if (action === 'select') {
    stats.characters[characterId].selects++;
  } else if (action === 'play') {
    stats.characters[characterId].plays++;
    stats.totalPlays++;
  }

  stats.lastUpdated = new Date().toISOString();
  saveStats(stats);
  res.json({ ok: true });
});

// GET /api/stats — view character play stats
app.get('/api/stats', (req, res) => {
  res.json(loadStats());
});

// =====================================================================
// FINANCIAL TICKER — fetch prices from Yahoo Finance
// =====================================================================
const TICKER_SYMBOLS = {
  '^DJI': 'DJI', '^GSPC': 'SPX', 'BTC-USD': 'BTC', 'ETH-USD': 'ETH',
  'GC=F': 'GOLD', 'SI=F': 'SILVER', 'EURUSD=X': 'EUR/USD', 'GBPUSD=X': 'GBP/USD',
  'AAPL': 'AAPL', 'NVDA': 'NVDA', 'TSLA': 'TSLA', 'GOOG': 'GOOG',
  'META': 'META', 'AMZN': 'AMZN', 'MSFT': 'MSFT'
};
let tickerCache = { data: [], fetchedAt: 0 };

async function fetchTickerData() {
  // Cache for 2 minutes
  if (Date.now() - tickerCache.fetchedAt < 120000 && tickerCache.data.length > 0) {
    return tickerCache.data;
  }

  const symbols = Object.keys(TICKER_SYMBOLS);
  const results = [];

  // Fetch all symbols in parallel
  await Promise.all(symbols.map(async (symbol) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) return;
      const data = await res.json();
      const meta = data.chart?.result?.[0]?.meta;
      if (!meta) return;

      const price = meta.regularMarketPrice;
      const prevClose = meta.chartPreviousClose || meta.previousClose;
      const change = prevClose ? ((price - prevClose) / prevClose * 100) : 0;

      results.push({
        symbol: TICKER_SYMBOLS[symbol],
        price,
        change: parseFloat(change.toFixed(2)),
        up: change >= 0
      });
    } catch {}
  }));

  // Sort to match original order
  const order = Object.values(TICKER_SYMBOLS);
  results.sort((a, b) => order.indexOf(a.symbol) - order.indexOf(b.symbol));

  tickerCache = { data: results, fetchedAt: Date.now() };
  return results;
}

app.get('/api/ticker', async (req, res) => {
  try {
    const data = await fetchTickerData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/regen-tts — regenerate missing TTS audio from cached stories
app.post('/api/regen-tts', async (req, res) => {
  const { mode = 'everything' } = req.body;
  const cache = loadCache(mode);
  if (!cache) return res.json({ status: 'no cached stories for ' + mode });
  res.json({ status: 'tts regen started for ' + mode });
  generateAllTTS(cache.stories, 'frog').catch(err => console.error('TTS regen error:', err));
});

// POST /api/refresh — manual trigger to refresh news
app.post('/api/refresh', async (req, res) => {
  const { mode = 'everything' } = req.body;
  if (isRefreshing) return res.json({ status: 'already refreshing' });

  res.json({ status: 'refresh started' });
  refreshNews(mode);
});

// GET /api/memes — list available meme images
const MEMES_DIR = path.join(__dirname, 'memes');
app.get('/api/memes', (req, res) => {
  try {
    if (!fs.existsSync(MEMES_DIR)) return res.json([]);
    const files = fs.readdirSync(MEMES_DIR)
      .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));
    res.json(files);
  } catch (e) {
    res.json([]);
  }
});

// Serve memes directory
app.use('/memes', express.static(MEMES_DIR));

// =====================================================================
// STARTUP
// =====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`MaxHeadline running on http://localhost:${PORT}`);

  // Check if we have cached stories; if not, do an initial fetch
  const hasCache = ['everything', 'uponly', 'thisisfine'].some(m => loadCache(m));
  if (!hasCache) {
    console.log('No cached stories found — doing initial fetch...');
    await refreshNews('everything');
  } else {
    console.log('Cached stories found. Serving from cache.');
  }

  // Schedule 6am/6pm ET refreshes
  scheduleNextRefresh();
});
