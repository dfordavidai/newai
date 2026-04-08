/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║                  DaveAI — /api/chat                              ║
 * ║              Vercel Serverless LLM Proxy                         ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * PURPOSE
 * ───────
 * This file is the single entry point for every AI chat request in
 * DaveAI. The browser never touches an API key — it just posts to
 * /api/chat and this function handles everything server-side.
 *
 *
 * ════════════════════════════════════════════════════════════════════
 *  PROVIDER WATERFALL  (strict order — Groq → OpenRouter → Gemini)
 * ════════════════════════════════════════════════════════════════════
 *
 *  STEP 1 ── GROQ  (primary — fastest, most generous free tier)
 *  ┌───────────────────────────────────────────────────────────────┐
 *  │  For each GROQ_KEY_1 … GROQ_KEY_10 (in order):               │
 *  │    Try preferred model                                        │
 *  │      ✓ 200  → stream response back to browser. DONE.         │
 *  │      ✗ 429  → rate-limited. Try next model on same key.      │
 *  │      ✗ 401  → bad key. Skip ALL models. Try next key.        │
 *  │      ✗ other → log warning. Try next model.                  │
 *  │    Try llama-3.3-70b-versatile  (model fallback 1)           │
 *  │    Try llama-3.1-8b-instant     (model fallback 2)           │
 *  │    Try gemma2-9b-it             (model fallback 3)           │
 *  │    Try mixtral-8x7b-32768       (model fallback 4)           │
 *  │    ── all 4 models rate-limited on this key ──               │
 *  │  Move to GROQ_KEY_2 … repeat same model chain …              │
 *  │  Move to GROQ_KEY_3 … and so on up to GROQ_KEY_10 …         │
 *  └───────────────────────────────────────────────────────────────┘
 *    ↓  Only reached when EVERY Groq key × EVERY Groq model = 429
 *
 *  STEP 2 ── OPENROUTER  (secondary — large model catalogue, free tier)
 *  ┌───────────────────────────────────────────────────────────────┐
 *  │  For each OPENROUTER_KEY_1 … OPENROUTER_KEY_5 (in order):    │
 *  │    Try google/gemini-2.0-flash-exp:free  (best free model)   │
 *  │    Try google/gemini-flash-1.5:free                          │
 *  │    Try meta-llama/llama-3.3-70b-instruct:free                │
 *  │    Try mistralai/mistral-7b-instruct:free                    │
 *  │  Move to OPENROUTER_KEY_2 … repeat …                         │
 *  └───────────────────────────────────────────────────────────────┘
 *    ↓  Only reached when EVERY OpenRouter key × model = 429
 *
 *  STEP 3 ── GOOGLE AI STUDIO / GEMINI  (last resort — very generous)
 *  ┌───────────────────────────────────────────────────────────────┐
 *  │  For each GEMINI_KEY_1 … GEMINI_KEY_10 (in order):           │
 *  │    Try gemini-2.0-flash                                      │
 *  │    Try gemini-1.5-flash                                      │
 *  │    Try gemini-1.5-flash-8b                                   │
 *  │  Move to GEMINI_KEY_2 … repeat …                             │
 *  └───────────────────────────────────────────────────────────────┘
 *    ↓  Only reached when ALL providers are exhausted
 *
 *  STEP 4 ── 503 error returned to browser with friendly message
 *
 *
 * ════════════════════════════════════════════════════════════════════
 *  ADDING MORE KEYS (no code changes needed)
 * ════════════════════════════════════════════════════════════════════
 *  In Vercel dashboard → your project → Settings → Environment Variables:
 *
 *    GROQ_KEY_1=gsk_...          ← primary
 *    GROQ_KEY_2=gsk_...          ← kicks in when KEY_1 is rate-limited
 *    GROQ_KEY_3=gsk_...          ← and so on, up to GROQ_KEY_10
 *    OPENROUTER_KEY_1=sk-or-v1-...
 *    OPENROUTER_KEY_2=sk-or-v1-...   ← up to OPENROUTER_KEY_5
 *    GEMINI_KEY_1=AIzaSy...
 *    GEMINI_KEY_2=AIzaSy...          ← up to GEMINI_KEY_10
 *
 *  The pool loaders below auto-discover any _N keys that are set.
 *
 *
 * ════════════════════════════════════════════════════════════════════
 *  STREAMING
 * ════════════════════════════════════════════════════════════════════
 *  SSE (Server-Sent Events) streams from the upstream provider are
 *  piped byte-for-byte back to the browser. The existing token-by-
 *  token renderer in index.html works without any changes.
 *
 *
 * ════════════════════════════════════════════════════════════════════
 *  REQUEST SHAPE (sent by the browser)
 * ════════════════════════════════════════════════════════════════════
 *  POST /api/chat
 *  Content-Type: application/json
 *  {
 *    "messages":    [...],                      // OpenAI-format array
 *    "model":       "llama-3.3-70b-versatile",  // preferred model
 *    "temperature": 0.7,
 *    "max_tokens":  8192,
 *    "stream":      true
 *  }
 *
 *
 * ════════════════════════════════════════════════════════════════════
 *  RESPONSE HEADERS (added by this proxy — visible in DevTools)
 * ════════════════════════════════════════════════════════════════════
 *  X-DaveAI-Provider:   groq | openrouter | google
 *  X-DaveAI-Model:      the exact model that answered
 *  X-DaveAI-Key-Index:  1-based index of the key that worked
 */


// ════════════════════════════════════════════════════════════════════
//  KEY POOL LOADERS
//  Read N environment variables at request time and return them as
//  a plain array. Missing / empty vars are silently skipped.
// ════════════════════════════════════════════════════════════════════

/**
 * Returns all configured Groq API keys in order.
 * Set GROQ_KEY_1 … GROQ_KEY_10 in Vercel env vars.
 * Get keys: https://console.groq.com/keys
 */
function loadGroqKeys() {
  const keys = [];
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`GROQ_KEY_${i}`];
    if (k && k.trim()) keys.push(k.trim());
  }
  return keys;
}

/**
 * Returns all configured OpenRouter API keys in order.
 * Set OPENROUTER_KEY_1 … OPENROUTER_KEY_5 in Vercel env vars.
 * Get keys: https://openrouter.ai/keys
 */
function loadOpenRouterKeys() {
  const keys = [];
  for (let i = 1; i <= 5; i++) {
    const k = process.env[`OPENROUTER_KEY_${i}`];
    if (k && k.trim()) keys.push(k.trim());
  }
  return keys;
}

/**
 * Returns all configured Google AI Studio / Gemini keys in order.
 * Set GEMINI_KEY_1 … GEMINI_KEY_10 in Vercel env vars.
 * Get keys: https://aistudio.google.com/app/apikey  (free)
 */
function loadGeminiKeys() {
  const keys = [];
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`GEMINI_KEY_${i}`];
    if (k && k.trim()) keys.push(k.trim());
  }
  return keys;
}


// ════════════════════════════════════════════════════════════════════
//  MODEL FALLBACK CHAINS
//  When the preferred model is rate-limited on a key, we try the
//  next model in the chain before moving to the next key.
//  Order: largest/best first → smallest/fastest last.
// ════════════════════════════════════════════════════════════════════

// Groq free-tier models (all confirmed active as of 2025)
const GROQ_MODEL_CHAIN = [
  'llama-3.3-70b-versatile',   // Best general-purpose — try first
  'llama-3.1-8b-instant',      // Fast + lightweight
  'gemma2-9b-it',              // Google Gemma via Groq
  'mixtral-8x7b-32768',        // Long context (32k tokens)
];

// OpenRouter free models (:free suffix = no credits needed)
const OPENROUTER_MODEL_CHAIN = [
  'google/gemini-2.0-flash-exp:free',        // Best quality free model
  'google/gemini-flash-1.5:free',            // Stable Gemini fallback
  'meta-llama/llama-3.3-70b-instruct:free',  // Llama 70B via OpenRouter
  'mistralai/mistral-7b-instruct:free',      // Lightweight fallback
];

// Google AI Studio models (OpenAI-compatible endpoint)
const GEMINI_MODEL_CHAIN = [
  'gemini-2.0-flash',     // Latest, fast, generous free tier (15 RPM)
  'gemini-1.5-flash',     // Stable 1.5 fallback
  'gemini-1.5-flash-8b',  // Smallest Gemini — absolute last resort
];


// ════════════════════════════════════════════════════════════════════
//  CORS HEADERS
// ════════════════════════════════════════════════════════════════════

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}


// ════════════════════════════════════════════════════════════════════
//  MAIN HANDLER
//  Vercel calls this for every POST /api/chat request.
// ════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {

  // ── CORS preflight ─────────────────────────────────────────────
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

  // ── Parse body ─────────────────────────────────────────────────
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    res.writeHead(400, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  // ── Extract + normalise params ─────────────────────────────────
  const {
    messages    = [],
    model       = 'llama-3.3-70b-versatile',
    temperature = 0.7,
    max_tokens  = 8192,
    stream      = true,
  } = body;

  // Shared payload object passed to all provider functions
  const basePayload = {
    messages,
    temperature : parseFloat(temperature)  || 0.7,
    max_tokens  : parseInt(max_tokens, 10) || 8192,
    stream,
  };

  console.log(`[DaveAI/chat] New request — model: ${model}, stream: ${stream}, messages: ${messages.length}`);

  // ════════════════════════════════════════════════════════════════
  //  WATERFALL
  //  Each try* function returns:
  //    true  → success, response already sent to browser
  //    null  → all keys/models for this provider exhausted → next step
  // ════════════════════════════════════════════════════════════════

  try {

    // ── STEP 1: GROQ ───────────────────────────────────────────────
    console.log('[DaveAI/chat] ── STEP 1: Groq ──');
    const groqResult = await tryGroq(basePayload, model, stream, res);
    if (groqResult === true) return; // Groq answered — done

    // ── STEP 2: OPENROUTER ────────────────────────────────────────
    console.log('[DaveAI/chat] ── STEP 2: OpenRouter ──');
    const orResult = await tryOpenRouter(basePayload, model, stream, res);
    if (orResult === true) return; // OpenRouter answered — done

    // ── STEP 3: GOOGLE GEMINI ─────────────────────────────────────
    console.log('[DaveAI/chat] ── STEP 3: Google Gemini ──');
    const geminiResult = await tryGemini(basePayload, stream, res);
    if (geminiResult === true) return; // Gemini answered — done

    // ── STEP 4: ALL EXHAUSTED ─────────────────────────────────────
    console.error('[DaveAI/chat] All providers exhausted. Returning 503.');
    res.writeHead(503, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'All AI providers are currently rate-limited. Please wait ~60 seconds and try again. You can also add more API keys (GROQ_KEY_2, GROQ_KEY_3 …) in your Vercel environment variables.',
    }));

  } catch (err) {
    console.error('[DaveAI/chat] Unhandled error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { ...corsHeaders(), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Internal server error' }));
    }
  }
}


// ════════════════════════════════════════════════════════════════════
//  STEP 1 — GROQ
//
//  Outer loop: each key in GROQ_KEY_1 … GROQ_KEY_10
//  Inner loop: preferred model → GROQ_MODEL_CHAIN fallbacks
//
//  Only moves to the NEXT KEY when all models on the current key
//  return 429. A single 401 (bad key) skips that key immediately.
//  Returns null only when every key × every model = 429 or invalid.
// ════════════════════════════════════════════════════════════════════

async function tryGroq(basePayload, preferredModel, stream, res) {
  const keys = loadGroqKeys();

  if (keys.length === 0) {
    console.warn('[Groq] No keys set. Add GROQ_KEY_1 in Vercel env vars. Skipping.');
    return null;
  }

  // Put the preferred model first, then the rest of the chain (deduplicated)
  const modelChain = [preferredModel, ...GROQ_MODEL_CHAIN.filter(m => m !== preferredModel)];

  for (let ki = 0; ki < keys.length; ki++) {
    const key      = keys[ki];
    const keyLabel = `GROQ_KEY_${ki + 1}`;
    let   allRateLimited = true; // tracks whether all models on this key returned 429

    console.log(`[Groq] Trying ${keyLabel}…`);

    for (const model of modelChain) {
      try {
        const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method : 'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${key}`,
          },
          body: JSON.stringify({ ...basePayload, model }),
        });

        // ✓ SUCCESS
        if (upstream.ok) {
          console.log(`[Groq] ✓ ${keyLabel} answered with model: ${model}`);
          await pipeResponse(upstream, stream, res, { provider: 'groq', model, keyIndex: ki + 1 });
          return true;
        }

        // ✗ RATE LIMITED — try next model on same key
        if (upstream.status === 429) {
          const retryAfter = upstream.headers.get('retry-after') || '~60';
          console.warn(`[Groq] 429 ${keyLabel}/${model} — rate limited (retry-after: ${retryAfter}s). Trying next model…`);
          continue; // allRateLimited stays true
        }

        // ✗ INVALID KEY — skip all remaining models on this key
        if (upstream.status === 401) {
          console.error(`[Groq] 401 ${keyLabel} — invalid or revoked key. Skipping to next key.`);
          allRateLimited = false; // 401 is not a rate-limit; don't penalise this as exhausted
          break;
        }

        // ✗ OTHER ERROR — log and try next model
        const errBody = await upstream.json().catch(() => ({}));
        console.warn(`[Groq] ${upstream.status} ${keyLabel}/${model}: ${errBody?.error?.message || 'unknown'}. Trying next model…`);
        allRateLimited = false;
        continue;

      } catch (networkErr) {
        console.warn(`[Groq] Network error ${keyLabel}/${model}: ${networkErr.message}. Trying next model…`);
        allRateLimited = false;
        continue;
      }
    } // end model loop

    if (allRateLimited) {
      console.warn(`[Groq] ${keyLabel} — all models rate-limited. Moving to next key…`);
    }
  } // end key loop

  // Every key × every model either returned 429 or was invalid
  console.warn('[Groq] All keys exhausted → handing off to OpenRouter.');
  return null;
}


// ════════════════════════════════════════════════════════════════════
//  STEP 2 — OPENROUTER
//
//  Same structure as tryGroq. Uses OpenRouter's free-tier model IDs.
//  The preferred model (a Groq model ID) is mapped to its nearest
//  OpenRouter equivalent via mapToOpenRouterModel().
//
//  Required extra headers for OpenRouter:
//    HTTP-Referer → your site URL (used for routing analytics)
//    X-Title      → app name shown in the OpenRouter dashboard
// ════════════════════════════════════════════════════════════════════

async function tryOpenRouter(basePayload, preferredModel, stream, res) {
  const keys = loadOpenRouterKeys();

  if (keys.length === 0) {
    console.warn('[OpenRouter] No keys set. Add OPENROUTER_KEY_1 in Vercel env vars. Skipping.');
    return null;
  }

  // Map the Groq preferred model to its closest OpenRouter free equivalent
  const orPreferred = mapToOpenRouterModel(preferredModel);
  const modelChain  = [orPreferred, ...OPENROUTER_MODEL_CHAIN.filter(m => m !== orPreferred)];

  for (let ki = 0; ki < keys.length; ki++) {
    const key      = keys[ki];
    const keyLabel = `OPENROUTER_KEY_${ki + 1}`;

    console.log(`[OpenRouter] Trying ${keyLabel}…`);

    for (const model of modelChain) {
      try {
        const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method : 'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${key}`,
            'HTTP-Referer':  process.env.SITE_URL || 'https://daveai.vercel.app',
            'X-Title':       'DaveAI',
          },
          body: JSON.stringify({ ...basePayload, model }),
        });

        if (upstream.ok) {
          console.log(`[OpenRouter] ✓ ${keyLabel} answered with model: ${model}`);
          await pipeResponse(upstream, stream, res, { provider: 'openrouter', model, keyIndex: ki + 1 });
          return true;
        }

        if (upstream.status === 429) {
          console.warn(`[OpenRouter] 429 ${keyLabel}/${model} — rate limited. Trying next model…`);
          continue;
        }

        if (upstream.status === 401 || upstream.status === 403) {
          console.error(`[OpenRouter] ${upstream.status} ${keyLabel} — bad key. Skipping to next key.`);
          break;
        }

        const errBody = await upstream.json().catch(() => ({}));
        console.warn(`[OpenRouter] ${upstream.status} ${keyLabel}/${model}: ${errBody?.error?.message || 'unknown'}. Trying next model…`);
        continue;

      } catch (networkErr) {
        console.warn(`[OpenRouter] Network error ${keyLabel}/${model}: ${networkErr.message}. Trying next model…`);
        continue;
      }
    } // end model loop
  } // end key loop

  console.warn('[OpenRouter] All keys exhausted → handing off to Google Gemini.');
  return null;
}


// ════════════════════════════════════════════════════════════════════
//  STEP 3 — GOOGLE AI STUDIO (GEMINI)
//
//  Uses Google's OpenAI-compatible endpoint so the exact same
//  request/response shape works — no special Gemini SDK needed.
//
//  Free tier (per key): 15 RPM, 1,000,000 TPM on gemini-2.0-flash
//  Get keys free at: https://aistudio.google.com/app/apikey
//
//  Special handling:
//    400 Bad Request → Gemini rejects system messages in some configs.
//    We strip the system message and retry once on the same key+model
//    before moving on.
// ════════════════════════════════════════════════════════════════════

async function tryGemini(basePayload, stream, res) {
  const keys = loadGeminiKeys();

  if (keys.length === 0) {
    console.warn('[Gemini] No keys set. Add GEMINI_KEY_1 in Vercel env vars. Skipping.');
    return null;
  }

  for (let ki = 0; ki < keys.length; ki++) {
    const key      = keys[ki];
    const keyLabel = `GEMINI_KEY_${ki + 1}`;

    console.log(`[Gemini] Trying ${keyLabel}…`);

    for (const model of GEMINI_MODEL_CHAIN) {
      try {
        const upstream = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
          {
            method : 'POST',
            headers: {
              'Content-Type':  'application/json',
              'Authorization': `Bearer ${key}`,
            },
            body: JSON.stringify({ ...basePayload, model }),
          }
        );

        if (upstream.ok) {
          console.log(`[Gemini] ✓ ${keyLabel} answered with model: ${model}`);
          await pipeResponse(upstream, stream, res, { provider: 'google', model, keyIndex: ki + 1 });
          return true;
        }

        if (upstream.status === 429 || upstream.status === 503) {
          console.warn(`[Gemini] ${upstream.status} ${keyLabel}/${model} — rate limited / overloaded. Trying next model…`);
          continue;
        }

        if (upstream.status === 400) {
          // Gemini sometimes rejects requests with system messages.
          // Strip the system message and retry once on same key+model.
          const errBody = await upstream.json().catch(() => ({}));
          console.warn(`[Gemini] 400 ${keyLabel}/${model}: ${errBody?.error?.message}. Retrying without system message…`);
          const noSystem = basePayload.messages.filter(m => m.role !== 'system');
          if (noSystem.length !== basePayload.messages.length) {
            const retry = await fetch(
              'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
              {
                method : 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                body   : JSON.stringify({ ...basePayload, model, messages: noSystem }),
              }
            );
            if (retry.ok) {
              console.log(`[Gemini] ✓ ${keyLabel}/${model} answered after stripping system message.`);
              await pipeResponse(retry, stream, res, { provider: 'google', model, keyIndex: ki + 1 });
              return true;
            }
          }
          continue; // Try next model
        }

        if (upstream.status === 401 || upstream.status === 403) {
          console.error(`[Gemini] ${upstream.status} ${keyLabel} — invalid key. Skipping to next key.`);
          break;
        }

        const errBody = await upstream.json().catch(() => ({}));
        console.warn(`[Gemini] ${upstream.status} ${keyLabel}/${model}: ${errBody?.error?.message || 'unknown'}. Trying next model…`);
        continue;

      } catch (networkErr) {
        console.warn(`[Gemini] Network error ${keyLabel}/${model}: ${networkErr.message}. Trying next model…`);
        continue;
      }
    } // end model loop
  } // end key loop

  console.warn('[Gemini] All keys exhausted. No providers left.');
  return null;
}


// ════════════════════════════════════════════════════════════════════
//  PIPE RESPONSE
//
//  Forwards the upstream response back to the browser.
//  Streaming: reads the ReadableStream in chunks and writes each
//    chunk immediately — browser sees tokens as they arrive.
//  Non-streaming: reads the full JSON and forwards it.
//
//  Always adds diagnostic headers so you can see in DevTools →
//  Network tab which provider/model/key actually answered.
// ════════════════════════════════════════════════════════════════════

async function pipeResponse(upstream, stream, res, meta) {
  const outHeaders = {
    ...corsHeaders(),
    'X-DaveAI-Provider':   meta.provider,          // e.g. "groq"
    'X-DaveAI-Model':      meta.model,             // e.g. "llama-3.3-70b-versatile"
    'X-DaveAI-Key-Index':  String(meta.keyIndex),  // e.g. "2" (which key succeeded)
  };

  if (stream) {
    // Streaming — SSE (Server-Sent Events) passthrough
    outHeaders['Content-Type']       = 'text/event-stream';
    outHeaders['Cache-Control']      = 'no-cache, no-transform';
    outHeaders['Connection']         = 'keep-alive';
    outHeaders['X-Accel-Buffering']  = 'no'; // Disable Nginx buffering

    res.writeHead(200, outHeaders);

    const reader  = upstream.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
    } catch (streamErr) {
      // Client disconnected mid-stream (tab closed, etc.) — normal, not an error
      console.warn('[DaveAI/chat] Stream interrupted:', streamErr.message);
    } finally {
      res.end();
    }

  } else {
    // Non-streaming — forward plain JSON
    const data = await upstream.json();
    outHeaders['Content-Type'] = 'application/json';
    res.writeHead(200, outHeaders);
    res.end(JSON.stringify(data));
  }
}


// ════════════════════════════════════════════════════════════════════
//  MODEL MAPPER — Groq model ID → nearest OpenRouter free equivalent
//
//  When we fall to OpenRouter, the preferred model is a Groq ID
//  (e.g. "llama-3.3-70b-versatile"). OpenRouter uses different IDs.
//  This maps them to the closest free-tier equivalent available.
// ════════════════════════════════════════════════════════════════════

function mapToOpenRouterModel(groqModelId) {
  const map = {
    'llama-3.3-70b-versatile' : 'meta-llama/llama-3.3-70b-instruct:free',
    'llama-3.1-70b-versatile' : 'meta-llama/llama-3.3-70b-instruct:free',
    'llama-3.1-8b-instant'    : 'mistralai/mistral-7b-instruct:free',
    'gemma2-9b-it'            : 'google/gemini-flash-1.5:free',
    'mixtral-8x7b-32768'      : 'mistralai/mistral-7b-instruct:free',
    'gemini-2.0-flash'        : 'google/gemini-2.0-flash-exp:free',
    'gemini-1.5-flash'        : 'google/gemini-flash-1.5:free',
  };
  return map[groqModelId] || 'google/gemini-2.0-flash-exp:free';
}


// ════════════════════════════════════════════════════════════════════
//  VERCEL FUNCTION CONFIG
//
//  maxDuration 60s  — long streaming responses need time to complete.
//  responseLimit false — REQUIRED for streaming; disables Vercel's
//    built-in response buffer which would break SSE.
//  bodyParser 4mb   — handles large context windows with images.
// ════════════════════════════════════════════════════════════════════

export const config = {
  api: {
    bodyParser:    { sizeLimit: '4mb' },
    responseLimit: false,
  },
};
