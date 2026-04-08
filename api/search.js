/**
 * DaveAI — /api/search
 * ─────────────────────────────────────────────────────────────
 * Proxies web search requests so Brave / Serper / Tavily keys
 * stay server-side. Falls back to DuckDuckGo if no keys set.
 *
 * POST /api/search
 * {
 *   query:    "latest AI news",
 *   provider: "brave" | "serper" | "tavily" | "auto"
 * }
 *
 * Returns: { results: [...] }  — same shape the frontend already
 * uses in webSearchWithCitations(), so no parsing changes needed.
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

  const { query = '', provider = 'auto' } = body;

  if (!query.trim()) {
    res.writeHead(400, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Query is required' }));
    return;
  }

  try {
    const results = await search(query, provider);
    res.writeHead(200, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results }));
  } catch (err) {
    console.error('[/api/search] Error:', err);
    res.writeHead(500, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message, results: [] }));
  }
}

async function search(query, provider) {
  // Try in priority order based on what keys are configured
  if ((provider === 'tavily' || provider === 'auto') && process.env.TAVILY_KEY) {
    const results = await tavilySearch(query);
    if (results?.length) return results;
  }

  if ((provider === 'serper' || provider === 'auto') && process.env.SERPER_KEY) {
    const results = await serperSearch(query);
    if (results?.length) return results;
  }

  if ((provider === 'brave' || provider === 'auto') && process.env.BRAVE_KEY) {
    const results = await braveSearch(query);
    if (results?.length) return results;
  }

  // DuckDuckGo fallback (no key required)
  return await duckDuckGoSearch(query);
}

async function tavilySearch(query) {
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_KEY,
        query,
        search_depth: 'basic',
        max_results: 6,
        include_answer: true,
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    let results = (data.results || [])
      .slice(0, 6)
      .map((x, i) => ({ index: i + 1, title: x.title, url: x.url, snippet: x.content || '' }));
    if (data.answer) {
      results = [{ index: 0, title: 'Direct Answer', url: '', snippet: data.answer }, ...results];
      results = results.map((r, i) => ({ ...r, index: i + 1 }));
    }
    return results;
  } catch {
    return null;
  }
}

async function serperSearch(query) {
  try {
    const r = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 6 }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    let results = (data.organic || [])
      .slice(0, 6)
      .map((x, i) => ({ index: i + 1, title: x.title, url: x.link, snippet: x.snippet || '' }));
    if (data.answerBox?.answer) {
      results = [{ index: 0, title: 'Answer Box', url: '', snippet: data.answerBox.answer }, ...results];
      results = results.map((r, i) => ({ ...r, index: i + 1 }));
    }
    return results;
  } catch {
    return null;
  }
}

async function braveSearch(query) {
  try {
    const r = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=6`,
      {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': process.env.BRAVE_KEY,
        },
      }
    );
    if (!r.ok) return null;
    const data = await r.json();
    return (data.web?.results || [])
      .slice(0, 6)
      .map((x, i) => ({ index: i + 1, title: x.title, url: x.url, snippet: x.description || '' }));
  } catch {
    return null;
  }
}

async function duckDuckGoSearch(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const resp = await Promise.race([
      fetch(url),
      new Promise((_, rej) => setTimeout(() => rej(new Error('DDG timeout')), 5000)),
    ]);
    const ddg = await resp.json();
    const results = [];
    if (ddg.AbstractText)
      results.push({ index: 1, title: ddg.AbstractSource || 'Summary', url: ddg.AbstractURL || '', snippet: ddg.AbstractText });
    if (ddg.Answer)
      results.push({ index: results.length + 1, title: 'Direct Answer', url: '', snippet: ddg.Answer });
    (ddg.RelatedTopics || []).slice(0, 4).forEach((t) => {
      if (t.Text)
        results.push({ index: results.length + 1, title: t.FirstURL || 'Related', url: t.FirstURL || '', snippet: t.Text });
    });
    return results;
  } catch {
    return [];
  }
}
