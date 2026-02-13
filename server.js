require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
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
  fox:     { voiceId: 'oW8bn5YtBB89X2nJ0DT9', name: 'Voxel' },
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
  owl: 'Hootspa', cat: 'Whiskers', wizard: 'Glitch'
};

// =====================================================================
// HELPERS
// =====================================================================

// =====================================================================
// POSTGRESQL PERSISTENT STORAGE — survives Railway deploys
// =====================================================================
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDB() {
  if (!pool) {
    console.log('[DB] No DATABASE_URL — falling back to JSON file cache');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS story_cache (
      mode TEXT NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (mode)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audio_cache (
      filename TEXT PRIMARY KEY,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS power_ticker (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      generated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('[DB] PostgreSQL connected, story_cache + audio_cache + power_ticker tables ready');
}

function getCacheFile(mode) {
  return path.join(DATA_DIR, `stories-${mode}.json`);
}

async function loadCache(mode) {
  // Try Postgres first
  if (pool) {
    try {
      const res = await pool.query('SELECT data FROM story_cache WHERE mode = $1', [mode]);
      if (res.rows.length > 0) return res.rows[0].data;
      return null;
    } catch (err) {
      console.error('[DB] loadCache error:', err.message);
    }
  }
  // Fallback to file
  const file = getCacheFile(mode);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

async function saveCache(mode, data) {
  // Write to Postgres
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO story_cache (mode, data, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (mode) DO UPDATE SET data = $2, updated_at = NOW()`,
        [mode, JSON.stringify(data)]
      );
    } catch (err) {
      console.error('[DB] saveCache error:', err.message);
    }
  }
  // Also write file as local backup
  try {
    fs.writeFileSync(getCacheFile(mode), JSON.stringify(data, null, 2));
  } catch {}
}

const STORY_PUBLIC_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours — visible on site
const STORY_RETAIN_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days — retained in DB

// Filter stories visible to users (< 48h old)
function getPublicStories(stories) {
  const now = Date.now();
  return stories.filter(s => {
    const addedAt = s.addedAt ? new Date(s.addedAt).getTime() : 0;
    return (now - addedAt) < STORY_PUBLIC_TTL_MS;
  });
}

// Permanently remove stories older than 14 days from DB
function pruneExpiredStories(stories) {
  const now = Date.now();
  return stories.filter(s => {
    const addedAt = s.addedAt ? new Date(s.addedAt).getTime() : 0;
    return (now - addedAt) < STORY_RETAIN_TTL_MS;
  });
}

// Merge new stories on top of existing, dedup by id
function mergeStories(existingStories, newStories) {
  const now = new Date().toISOString();
  // Tag new stories with addedAt timestamp
  const tagged = newStories.map(s => ({ ...s, addedAt: s.addedAt || now }));
  // Dedup: new stories replace any with the same id
  const existingIds = new Set(tagged.map(s => s.id));
  const kept = existingStories.filter(s => !existingIds.has(s.id));
  // New stories on top, then existing (still sorted by recency)
  return [...tagged, ...kept];
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
    sota: `Find today's 8 most significant state-of-the-art breakthroughs in AI, robotics, future tech, biotech, quantum computing, space tech, and frontier science. Focus on actual technical achievements, new model releases, research papers, product launches, and engineering milestones — not opinion pieces. Real advances only.`
  };

  const toneInstructions = {
    everything: `Classic Max Headroom — witty, sardonic, rapid-fire, slightly glitchy in delivery. Mix of genuine insight with cutting humor.`,
    uponly: `Enthusiastically optimistic, almost suspiciously positive. Genuinely excited about good news but with a wink — you know the world is complicated but right now we're celebrating. Peppy, warm, encouraging.`,
    sota: `Excited tech enthusiast energy. You're genuinely thrilled by what humans are building. Speak like the smartest engineer at the conference who just saw the future demo — precise technical language, infectious excitement, specific details that matter. Not hype — substance.`
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
// AUDIO PERSISTENCE — Postgres (survives deploys) + filesystem (fast cache)
// =====================================================================
async function saveAudioToDB(filename, buffer) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO audio_cache (filename, data) VALUES ($1, $2) ON CONFLICT (filename) DO NOTHING`,
      [filename, buffer]
    );
  } catch (err) {
    console.error(`[Audio DB] Save failed for ${filename}:`, err.message);
  }
}

async function loadAudioFromDB(filename) {
  if (!pool) return null;
  try {
    const res = await pool.query('SELECT data FROM audio_cache WHERE filename = $1', [filename]);
    if (res.rows.length > 0) {
      const buffer = res.rows[0].data;
      // Restore to filesystem cache for fast subsequent serves
      const filepath = path.join(AUDIO_DIR, filename);
      fs.writeFileSync(filepath, buffer);
      return buffer;
    }
  } catch (err) {
    console.error(`[Audio DB] Load failed for ${filename}:`, err.message);
  }
  return null;
}

async function audioExistsInDB(filename) {
  if (!pool) return false;
  try {
    const res = await pool.query('SELECT 1 FROM audio_cache WHERE filename = $1', [filename]);
    return res.rows.length > 0;
  } catch { return false; }
}

// =====================================================================
// TTS GENERATION
// =====================================================================
async function generateTTSForStory(characterId, storyId, text, voiceId, energy, voiceSettings) {
  const filename = `${characterId}-${storyId}-${energy}.mp3`;
  const filepath = path.join(AUDIO_DIR, filename);

  // Skip if already on filesystem
  if (fs.existsSync(filepath)) return filename;

  // Skip if already in Postgres — restore to filesystem
  const dbAudio = await loadAudioFromDB(filename);
  if (dbAudio) {
    console.log(`  Restored from DB: ${filename} (${(dbAudio.length / 1024).toFixed(0)}KB)`);
    return filename;
  }

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
    // Save to filesystem (fast cache) AND Postgres (survives deploys)
    fs.writeFileSync(filepath, buffer);
    await saveAudioToDB(filename, buffer);
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

  const cache = await loadCache(mode);
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

    // Load existing stories and prune expired (>48h)
    const existing = await loadCache(mode);
    const survivingStories = existing ? pruneExpiredStories(existing.stories || []) : [];
    const prunedCount = (existing?.stories?.length || 0) - survivingStories.length;
    if (prunedCount > 0) console.log(`Pruned ${prunedCount} expired stories (>48h)`);
    console.log(`${survivingStories.length} existing stories still active`);

    // Fetch NEW stories from Anthropic (with retry)
    let newStories;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`Fetching new stories from Anthropic (attempt ${attempt})...`);
        newStories = await fetchNewsFromAPI(mode, CHARACTER_NAMES.frog);
        console.log(`Got ${newStories.length} new stories`);
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
    const withImages = await resolveStoryImages(newStories);
    const imgCount = withImages.filter(s => s.imageUrl).length;
    console.log(`Resolved ${imgCount}/${withImages.length} images`);

    // Merge: new stories on top, existing below, deduped
    const merged = mergeStories(survivingStories, withImages);
    console.log(`Total stories after merge: ${merged.length} (${withImages.length} new + ${merged.length - withImages.length} retained)`);

    // Save merged stories to cache
    const cacheData = {
      mode,
      stories: merged,
      fetchedAt: new Date().toISOString(),
      fetchedAtET: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
      lastRefreshET: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
    };
    await saveCache(mode, cacheData);
    console.log(`Cached ${mode} stories`);

    // Generate TTS audio for new stories only (default voice — frog/Ribbitz)
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
// SCHEDULE — 6pm ET daily
// =====================================================================
function getNextRefreshTime() {
  const now = new Date();
  // Convert to ET
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const etParts = etStr.split(', ')[1].split(':');
  const etHour = parseInt(etParts[0]);

  // Next 6pm ET only (once daily — captures the day's news before evening)
  const etNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  if (etHour >= 18) {
    // Already past 6pm today — next is tomorrow 6pm
    etNow.setDate(etNow.getDate() + 1);
  }
  etNow.setHours(18, 0, 0, 0);
  return etNow;
}

function scheduleNextRefresh() {
  const next = getNextRefreshTime();
  const delay = next.getTime() - Date.now();
  const delayMin = (delay / 60000).toFixed(0);
  console.log(`Next refresh scheduled for ${next.toLocaleString('en-US', { timeZone: 'America/New_York' })} ET (${delayMin} min)`);

  setTimeout(async () => {
    // Refresh all three modes
    for (const mode of ['everything', 'uponly', 'sota']) {
      await refreshNews(mode);
    }
    // Refresh power ticker
    await refreshPowerTicker();
    scheduleNextRefresh();
  }, delay);
}

// =====================================================================
// API ENDPOINTS
// =====================================================================

// GET /api/stories?mode=everything — serve cached stories (public = <48h only)
app.get('/api/stories', async (req, res) => {
  const mode = req.query.mode || 'everything';
  const cache = await loadCache(mode);

  if (!cache) {
    return res.status(404).json({ error: 'No cached stories yet. Refresh in progress...' });
  }

  // Only serve stories < 48h old to clients (older ones retained in DB but hidden)
  res.json({ ...cache, stories: getPublicStories(cache.stories || []) });
});

// POST /api/news — legacy endpoint, serves cache only (refreshes happen on 6pm ET schedule)
app.post('/api/news', async (req, res) => {
  const { mode = 'everything' } = req.body;
  const cache = await loadCache(mode);

  if (cache && cache.stories && cache.stories.length > 0) {
    return res.json({ stories: getPublicStories(cache.stories) });
  }

  // No cache at all — do initial fetch (only happens on very first boot)
  if (!isRefreshing) {
    try {
      await refreshNews(mode);
      const freshCache = await loadCache(mode);
      if (freshCache) {
        return res.json({ stories: freshCache.stories });
      }
    } catch (err) {
      console.error('News fetch error:', err);
    }
  }
  res.status(503).json({ error: 'Stories not available yet. Next refresh at 6pm ET.' });
});

// GET /api/audio/:characterId/:storyId/:energy — serve pre-generated audio
app.get('/api/audio/:characterId/:storyId/:energy', async (req, res) => {
  const { characterId, storyId, energy } = req.params;
  if (energy !== 'highkey') {
    return res.status(400).json({ error: 'energy must be highkey' });
  }

  const filename = `${characterId}-${storyId}-${energy}.mp3`;
  const filepath = path.join(AUDIO_DIR, filename);

  // 1. Filesystem cache (fastest)
  if (fs.existsSync(filepath)) {
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' });
    return fs.createReadStream(filepath).pipe(res);
  }

  // 2. Postgres (survives deploys) — restore to filesystem and serve
  const dbAudio = await loadAudioFromDB(filename);
  if (dbAudio) {
    console.log(`[Audio] Restored from DB: ${filename}`);
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' });
    return res.send(dbAudio);
  }

  // 3. On-demand generation (last resort — costs ElevenLabs credits)
  const voice = CHARACTER_VOICES[characterId];
  if (!voice) return res.status(404).json({ error: 'Unknown character' });

  // Find which mode has this story
  let storyData = null;
  const baseId = storyId.replace(/-headline$|-summary$/, '');
  const isHeadline = storyId.endsWith('-headline');
  for (const mode of ['everything', 'uponly', 'sota']) {
    const cache = await loadCache(mode);
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
app.post('/api/prepare-character', async (req, res) => {
  const { characterId, mode = 'everything' } = req.body;
  if (!CHARACTER_VOICES[characterId]) return res.status(400).json({ error: 'Unknown character' });
  if (characterId === 'frog') return res.json({ status: 'ready', preGenerated: true });

  // Check if all clips exist already
  const cache = await loadCache(mode);
  if (!cache || !cache.stories) return res.json({ status: 'no_stories' });

  let allReady = true;
  for (const story of cache.stories) {
    const hFile = `${characterId}-${story.id}-headline-highkey.mp3`;
    const sFile = `${characterId}-${story.id}-summary-highkey.mp3`;
    const hExists = fs.existsSync(path.join(AUDIO_DIR, hFile)) || await audioExistsInDB(hFile);
    const sExists = fs.existsSync(path.join(AUDIO_DIR, sFile)) || await audioExistsInDB(sFile);
    if (!hExists || !sExists) { allReady = false; break; }
  }

  if (allReady) return res.json({ status: 'ready', preGenerated: true });

  // Kick off generation in background
  generateCharacterTTS(characterId, mode).catch(e => console.error('Char TTS error:', e));
  res.json({ status: 'generating', characterId, mode });
});

// GET /api/character-status — check if a character's audio is ready
app.get('/api/character-status/:characterId/:mode', async (req, res) => {
  const { characterId, mode } = req.params;
  const cache = await loadCache(mode);
  if (!cache || !cache.stories) return res.json({ ready: false, total: 0, generated: 0 });

  let total = 0, generated = 0;
  for (const story of cache.stories) {
    total += 2; // headline + summary
    const hFile = `${characterId}-${story.id}-headline-highkey.mp3`;
    const sFile = `${characterId}-${story.id}-summary-highkey.mp3`;
    if (fs.existsSync(path.join(AUDIO_DIR, hFile)) || await audioExistsInDB(hFile)) generated++;
    if (fs.existsSync(path.join(AUDIO_DIR, sFile)) || await audioExistsInDB(sFile)) generated++;
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
// POWER TICKER — daily public figure power scores via Anthropic API
// =====================================================================
const POWER_TICKER_FILE = path.join(DATA_DIR, 'power-ticker.json');

async function loadPowerTicker() {
  if (pool) {
    try {
      const res = await pool.query("SELECT data, generated_at FROM power_ticker WHERE id = 'current'");
      if (res.rows.length > 0) return res.rows[0].data;
    } catch (err) {
      console.error('[PowerTicker] DB load error:', err.message);
    }
  }
  if (fs.existsSync(POWER_TICKER_FILE)) {
    try { return JSON.parse(fs.readFileSync(POWER_TICKER_FILE, 'utf8')); } catch { return null; }
  }
  return null;
}

async function savePowerTicker(data) {
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO power_ticker (id, data, generated_at) VALUES ('current', $1, NOW())
         ON CONFLICT (id) DO UPDATE SET data = $1, generated_at = NOW()`,
        [JSON.stringify(data)]
      );
    } catch (err) {
      console.error('[PowerTicker] DB save error:', err.message);
    }
  }
  try { fs.writeFileSync(POWER_TICKER_FILE, JSON.stringify(data, null, 2)); } catch {}
}

async function fetchPowerRankings() {
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
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
      messages: [{
        role: 'user',
        content: `You are a political/cultural power analyst. Search today's news and score 30 prominent public figures on their "power trajectory" today — are they gaining or losing influence/momentum RIGHT NOW based on today's headlines?

Score each person from -5 (terrible day, major scandal/loss) to +5 (dominant day, major win/breakthrough). Use LAST NAMES ONLY (e.g. "Trump" not "Donald Trump"). Mix of politics, tech, business, culture, global leaders.

Sort by absolute score descending (biggest movers first).

Return ONLY a JSON array, no markdown fences:
[{"name":"LastName","score":3},{"name":"LastName","score":-2}...]

CRITICAL: Exactly 30 entries. Real scores based on TODAY's actual news. No ties at 0 — everyone is moving.`
      }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);

  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (arrStart === -1 || arrEnd === -1) throw new Error('No JSON array in power ticker response');
  return JSON.parse(text.substring(arrStart, arrEnd + 1));
}

let isRefreshingPower = false;

async function refreshPowerTicker() {
  if (isRefreshingPower) return;
  isRefreshingPower = true;
  try {
    console.log('[PowerTicker] Fetching power rankings...');
    let rankings;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        rankings = await fetchPowerRankings();
        console.log(`[PowerTicker] Got ${rankings.length} rankings`);
        break;
      } catch (err) {
        console.error(`[PowerTicker] Attempt ${attempt} failed:`, err.message);
        if (attempt === 2) throw err;
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    const payload = { rankings, generatedAt: new Date().toISOString() };
    await savePowerTicker(payload);
    console.log('[PowerTicker] Saved to cache');
  } catch (err) {
    console.error('[PowerTicker] Refresh failed:', err.message);
  } finally {
    isRefreshingPower = false;
  }
}

const STATIC_POWER_FALLBACK = {
  rankings: [
    {name:"Trump",score:4},{name:"Musk",score:3},{name:"Zuckerberg",score:2},{name:"Altman",score:3},
    {name:"Biden",score:-2},{name:"Harris",score:-1},{name:"Newsom",score:1},{name:"DeSantis",score:-2},
    {name:"Putin",score:-3},{name:"Zelensky",score:2},{name:"Xi",score:1},{name:"Modi",score:2},
    {name:"Bezos",score:1},{name:"Cook",score:1},{name:"Nadella",score:2},{name:"Pichai",score:1},
    {name:"Dimon",score:1},{name:"Powell",score:-1},{name:"Yellen",score:-1},{name:"Buffett",score:1},
    {name:"Swift",score:2},{name:"Rogan",score:1},{name:"Oprah",score:-1},{name:"Kardashian",score:1},
    {name:"Karpathy",score:3},{name:"Huang",score:2},{name:"Amodei",score:2},{name:"Hassabis",score:2},
    {name:"Macron",score:-1},{name:"Milei",score:2}
  ],
  generatedAt: new Date().toISOString()
};

// =====================================================================
// FINANCIAL TICKER — fetch prices from Yahoo Finance
// =====================================================================
const TICKER_SYMBOLS = {
  '^DJI': 'DJI', '^GSPC': 'SPX', '^VIX': 'VIX', 'BTC-USD': 'BTC', 'ETH-USD': 'ETH',
  'GC=F': 'GOLD', 'SI=F': 'SILVER', 'EURUSD=X': 'EUR/USD', 'GBPUSD=X': 'GBP/USD',
  'AAPL': 'AAPL', 'NVDA': 'NVDA', 'TSLA': 'TSLA', 'GOOG': 'GOOG',
  'META': 'META', 'AMZN': 'AMZN', 'MSFT': 'MSFT'
};
let tickerCache = { data: [], fetchedAt: 0 };

// Yahoo Finance requires crumb/cookie auth from server IPs
let yahooCrumb = null;
let yahooCookie = null;

async function getYahooCrumb() {
  try {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    // Step 1: Get consent cookie
    const consentRes = await fetch('https://fc.yahoo.com', {
      redirect: 'manual',
      headers: { 'User-Agent': ua }
    });
    const setCookie = consentRes.headers.get('set-cookie') || '';
    yahooCookie = setCookie.split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');

    // Step 2: Get crumb using cookie
    const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': ua, 'Cookie': yahooCookie }
    });
    if (!crumbRes.ok) {
      console.warn('[Ticker] Crumb fetch failed:', crumbRes.status);
      return false;
    }
    yahooCrumb = await crumbRes.text();
    console.log('[Ticker] Yahoo crumb acquired');
    return true;
  } catch (e) {
    console.warn('[Ticker] Crumb error:', e.message);
    return false;
  }
}

async function fetchTickerData() {
  // Cache for 2 minutes
  if (Date.now() - tickerCache.fetchedAt < 120000 && tickerCache.data.length > 0) {
    return tickerCache.data;
  }

  // Ensure we have a valid crumb
  if (!yahooCrumb) await getYahooCrumb();

  const symbols = Object.keys(TICKER_SYMBOLS);
  const results = [];
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const headers = { 'User-Agent': ua };
  if (yahooCookie) headers['Cookie'] = yahooCookie;

  // Try batch quote endpoint first (1 request for all symbols)
  try {
    const symbolList = symbols.map(s => encodeURIComponent(s)).join(',');
    const crumbParam = yahooCrumb ? `&crumb=${encodeURIComponent(yahooCrumb)}` : '';
    const batchUrl = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbolList}${crumbParam}`;
    const batchRes = await fetch(batchUrl, { headers, signal: AbortSignal.timeout(10000) });

    if (batchRes.status === 401 || batchRes.status === 403) {
      console.warn('[Ticker] Batch auth failed, refreshing crumb...');
      yahooCrumb = null;
      await getYahooCrumb();
    } else if (batchRes.ok) {
      const data = await batchRes.json();
      const quotes = data.quoteResponse?.result || [];
      for (const q of quotes) {
        const label = TICKER_SYMBOLS[q.symbol];
        if (!label) continue;
        const price = q.regularMarketPrice;
        const change = q.regularMarketChangePercent || 0;
        results.push({
          symbol: label,
          price,
          change: parseFloat(change.toFixed(2)),
          up: change >= 0
        });
      }
    } else {
      console.warn('[Ticker] Batch HTTP', batchRes.status);
    }
  } catch (e) {
    console.warn('[Ticker] Batch error:', e.message);
  }

  // Fallback: individual chart requests if batch failed
  if (results.length === 0) {
    await Promise.all(symbols.map(async (symbol) => {
      try {
        const crumbParam = yahooCrumb ? `&crumb=${encodeURIComponent(yahooCrumb)}` : '';
        const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d${crumbParam}`;
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
        if (res.status === 401 || res.status === 403) {
          if (!yahooCrumb) return; // already refreshing
          yahooCrumb = null;
          await getYahooCrumb();
          return;
        }
        if (!res.ok) {
          console.warn(`[Ticker] ${symbol} HTTP ${res.status}`);
          return;
        }
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
      } catch (e) {
        console.warn(`[Ticker] ${symbol} error:`, e.message);
      }
    }));
  }

  // Sort to match original order
  const order = Object.values(TICKER_SYMBOLS);
  results.sort((a, b) => order.indexOf(a.symbol) - order.indexOf(b.symbol));

  if (results.length > 0) {
    tickerCache = { data: results, fetchedAt: Date.now() };
    return results;
  }

  // Yahoo completely failed — return last known data if available, else static fallback
  if (tickerCache.data.length > 0) {
    console.log('[Ticker] Yahoo failed, serving stale cache');
    return tickerCache.data;
  }
  console.log('[Ticker] Yahoo failed, serving static fallback');
  return [
    { symbol: 'DJI', price: 44200, change: 0.12, up: true },
    { symbol: 'SPX', price: 6050, change: 0.08, up: true },
    { symbol: 'VIX', price: 15.2, change: -2.1, up: false },
    { symbol: 'BTC', price: 97500, change: 1.45, up: true },
    { symbol: 'ETH', price: 2650, change: -0.32, up: false },
    { symbol: 'GOLD', price: 2920, change: 0.25, up: true },
    { symbol: 'SILVER', price: 32.5, change: 0.4, up: true },
    { symbol: 'EUR/USD', price: 1.0425, change: -0.05, up: false },
    { symbol: 'GBP/USD', price: 1.2580, change: 0.03, up: true },
    { symbol: 'AAPL', price: 232, change: -0.18, up: false },
    { symbol: 'NVDA', price: 128, change: 2.1, up: true },
    { symbol: 'TSLA', price: 345, change: 1.8, up: true },
    { symbol: 'GOOG', price: 188, change: 0.45, up: true },
    { symbol: 'META', price: 725, change: 0.67, up: true },
    { symbol: 'AMZN', price: 228, change: 0.35, up: true },
    { symbol: 'MSFT', price: 415, change: 0.22, up: true }
  ];
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
  const cache = await loadCache(mode);
  if (!cache) return res.json({ status: 'no cached stories for ' + mode });
  res.json({ status: 'tts regen started for ' + mode });
  generateAllTTS(cache.stories, 'frog').catch(err => console.error('TTS regen error:', err));
});

// POST /api/refresh — manual trigger to refresh news
// Pass mode="all" to refresh all three modes sequentially
app.post('/api/refresh', async (req, res) => {
  const { mode = 'everything' } = req.body;
  if (isRefreshing) return res.json({ status: 'already refreshing' });

  if (mode === 'all') {
    res.json({ status: 'refresh started for all modes' });
    for (const m of ['everything', 'uponly', 'sota']) {
      await refreshNews(m);
    }
  } else {
    res.json({ status: 'refresh started' });
    refreshNews(mode);
  }
});

// GET /api/power-ticker — serve cached power rankings
app.get('/api/power-ticker', async (req, res) => {
  const cached = await loadPowerTicker();
  if (cached && cached.rankings) return res.json(cached);
  res.json(STATIC_POWER_FALLBACK);
});

// POST /api/refresh-power — manual trigger
app.post('/api/refresh-power', async (req, res) => {
  if (isRefreshingPower) return res.json({ status: 'already refreshing' });
  res.json({ status: 'power ticker refresh started' });
  refreshPowerTicker();
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

  // Initialize PostgreSQL if available
  await initDB();

  // Backfill addedAt on old stories that don't have it, then prune expired (>48h)
  for (const mode of ['everything', 'uponly', 'sota']) {
    const cache = await loadCache(mode);
    if (cache && cache.stories) {
      // Backfill addedAt using the cache-level fetchedAt for legacy stories
      let dirty = false;
      const fallbackTime = cache.fetchedAt || new Date().toISOString();
      for (const story of cache.stories) {
        if (!story.addedAt) {
          story.addedAt = fallbackTime;
          dirty = true;
        }
      }
      const before = cache.stories.length;
      cache.stories = pruneExpiredStories(cache.stories);
      if (cache.stories.length !== before) {
        console.log(`[${mode}] Pruned ${before - cache.stories.length} expired stories on startup`);
        dirty = true;
      }
      if (dirty) await saveCache(mode, cache);
    }
  }

  // Restore audio files from Postgres → filesystem (survives deploys)
  if (pool) {
    try {
      const audioFiles = fs.readdirSync(AUDIO_DIR).filter(f => f.endsWith('.mp3'));
      if (audioFiles.length === 0) {
        console.log('[Audio] No local audio files — restoring from Postgres...');
        const res = await pool.query('SELECT filename, data FROM audio_cache');
        for (const row of res.rows) {
          fs.writeFileSync(path.join(AUDIO_DIR, row.filename), row.data);
        }
        console.log(`[Audio] Restored ${res.rows.length} audio files from Postgres`);
      } else {
        console.log(`[Audio] ${audioFiles.length} audio files already on disk`);
      }
    } catch (err) {
      console.error('[Audio] Restore from DB failed:', err.message);
    }
  }

  // Check each mode — refresh any that are stale (>20h) or empty
  const CATCHUP_MS = 20 * 60 * 60 * 1000; // 20 hours
  const staleModes = [];
  for (const m of ['everything', 'uponly', 'sota']) {
    const c = await loadCache(m);
    if (!c || !c.stories || c.stories.length === 0) {
      staleModes.push(m);
      console.log(`[Startup] ${m}: no stories — needs refresh`);
    } else {
      const fetchedAge = c.fetchedAt ? Date.now() - new Date(c.fetchedAt).getTime() : Infinity;
      if (fetchedAge > CATCHUP_MS) {
        staleModes.push(m);
        console.log(`[Startup] ${m}: stale (${(fetchedAge/3600000).toFixed(1)}h old) — needs refresh`);
      } else {
        console.log(`[Startup] ${m}: fresh (${(fetchedAge/3600000).toFixed(1)}h old, ${c.stories.length} stories)`);
      }
    }
  }
  if (staleModes.length > 0) {
    console.log(`Catch-up refresh for: ${staleModes.join(', ')}`);
    for (const m of staleModes) {
      await refreshNews(m);
    }
  } else {
    console.log('All modes fresh. Serving from cache until next 6pm ET refresh.');
  }

  // Check power ticker staleness
  const powerData = await loadPowerTicker();
  if (!powerData || !powerData.rankings || !powerData.generatedAt) {
    console.log('[Startup] Power ticker: empty — needs refresh');
    await refreshPowerTicker();
  } else {
    const powerAge = Date.now() - new Date(powerData.generatedAt).getTime();
    if (powerAge > CATCHUP_MS) {
      console.log(`[Startup] Power ticker: stale (${(powerAge/3600000).toFixed(1)}h old) — needs refresh`);
      await refreshPowerTicker();
    } else {
      console.log(`[Startup] Power ticker: fresh (${(powerAge/3600000).toFixed(1)}h old, ${powerData.rankings.length} entries)`);
    }
  }

  // Schedule 6pm ET refreshes
  scheduleNextRefresh();
});
