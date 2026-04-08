/**
 * DaveAI — /api/imagine
 * ─────────────────────────────────────────────────────────────
 * Proxies image-generation requests so the browser never needs
 * to carry an API key.
 *
 * POST /api/imagine
 * {
 *   action:  "generate" | "edit" | "remove_bg",
 *   prompt:  "...",
 *   image:   "data:image/png;base64,…"  // for edit / remove_bg
 *   width:   1024,
 *   height:  768,
 *   seed:    12345,
 *   model:   "kontext"                   // optional, for Pollinations model param
 * }
 *
 * Returns:
 * {
 *   url:     "https://…"  // for generate (Pollinations returns a URL)
 *   dataURL: "data:…"     // for edit / remove_bg (base64 round-tripped)
 * }
 * ─────────────────────────────────────────────────────────────
 */

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, corsHeaders());
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    res.writeHead(400, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  const {
    action = 'generate',
    prompt = '',
    image,           // base64 data URL for edit operations
    width = 1024,
    height = 768,
    seed = Math.floor(Math.random() * 99999),
    model,
  } = body;

  try {
    let result;

    switch (action) {
      case 'generate':
        result = await handleGenerate({ prompt, width, height, seed, model });
        break;
      case 'edit':
        result = await handleEdit({ prompt, image, width, height, seed, model });
        break;
      case 'remove_bg':
        result = await handleRemoveBg({ image });
        break;
      default:
        res.writeHead(400, { ...corsHeaders(), 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unknown action: ${action}` }));
        return;
    }

    res.writeHead(200, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[/api/imagine] Error:', err);
    res.writeHead(500, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message || 'Image generation failed' }));
  }
}

// ── Generate: return a Pollinations URL ──────────────────────
// Pollinations is free and doesn't need an API key, but by
// proxying through Vercel we avoid CORS issues and can swap
// providers later without touching the frontend.
async function handleGenerate({ prompt, width, height, seed, model }) {
  const params = new URLSearchParams({
    seed: String(seed),
    width: String(width),
    height: String(height),
    nologo: 'true',
    enhance: 'true',
  });
  if (model) params.set('model', model);

  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;

  // Verify the URL is reachable (HEAD request — fast, no body download)
  const check = await fetch(url, { method: 'HEAD' }).catch(() => null);
  if (!check?.ok) {
    throw new Error('Pollinations did not respond — try again');
  }

  return { url };
}

// ── Edit: fetch the image server-side, return as dataURL ─────
// This solves the browser CORS issue with Pollinations edit mode.
async function handleEdit({ prompt, image, width, height, seed, model }) {
  // If the user supplied a base64 image we need to host it so Pollinations can
  // fetch it by URL. We use the Supabase storage bucket configured via env vars
  // if available; otherwise we fall back to sending prompt-only generation.
  let publicImageUrl = null;

  if (image && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    publicImageUrl = await uploadImageToSupabase(image, seed);
  }

  const params = new URLSearchParams({
    seed: String(seed),
    width: String(width),
    height: String(height),
    nologo: 'true',
  });

  if (model) params.set('model', model);
  if (publicImageUrl) params.set('image', publicImageUrl);

  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Pollinations edit failed: HTTP ${resp.status}`);

  const arrayBuffer = await resp.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  const contentType = resp.headers.get('content-type') || 'image/png';

  return { dataURL: `data:${contentType};base64,${base64}` };
}

// ── Remove BG: proxy to remove.bg if key is configured ───────
async function handleRemoveBg({ image }) {
  const removeBgKey = process.env.REMOVE_BG_KEY;

  if (!removeBgKey) {
    // No key configured — signal the frontend to use its canvas fallback
    return { fallback: true, reason: 'REMOVE_BG_KEY not configured' };
  }

  // Decode base64 to buffer
  const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
  const imageBuffer = Buffer.from(base64Data, 'base64');

  const formData = new FormData();
  formData.append(
    'image_file',
    new Blob([imageBuffer], { type: 'image/png' }),
    'image.png'
  );
  formData.append('size', 'auto');

  const resp = await fetch('https://api.remove.bg/v1.0/removebg', {
    method: 'POST',
    headers: { 'X-Api-Key': removeBgKey },
    body: formData,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`remove.bg error: ${err}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');

  return { dataURL: `data:image/png;base64,${base64}` };
}

// ── Upload image to Supabase storage ─────────────────────────
async function uploadImageToSupabase(dataURL, seed) {
  try {
    const base64Data = dataURL.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');
    const filename = `imagine/${Date.now()}-${seed}.png`;

    const resp = await fetch(
      `${process.env.SUPABASE_URL}/storage/v1/object/daveai-images/${filename}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'image/png',
          'x-upsert': 'true',
        },
        body: imageBuffer,
      }
    );

    if (!resp.ok) return null;

    return `${process.env.SUPABASE_URL}/storage/v1/object/public/daveai-images/${filename}`;
  } catch {
    return null;
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb', // images can be large
    },
  },
};
