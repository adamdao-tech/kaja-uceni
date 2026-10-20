// ============================================================
//  Kája učení – knihovna PDF + MCP connector pro Clauda
//  Web:   /            (nahrávání knih, prohlížení materiálů)
//  API:   /api/*       (chráněné heslem přes cookie)
//  MCP:   /mcp         (chráněné OAuth – přihlášení heslem)
// ============================================================
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';

const MAX_READ_PAGES = 40;          // max stránek na jedno čtení
const MAX_READ_CHARS = 150_000;     // pojistka proti obřím odpovědím

// ---------------- databáze ----------------
let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, title TEXT NOT NULL, pages INTEGER NOT NULL, outline TEXT NOT NULL DEFAULT '[]', outline_source TEXT NOT NULL DEFAULT 'pdf', uploaded_pages INTEGER NOT NULL DEFAULT 0, empty_pages INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS pages (book_id TEXT NOT NULL, n INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (book_id, n))`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS materials (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, chapter TEXT, pages TEXT, content TEXT NOT NULL, created TEXT NOT NULL)`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS materials_book ON materials(book_id)`),
    ]).catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}
const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

async function getBook(env, id) {
  const b = await env.DB.prepare('SELECT * FROM books WHERE id = ?').bind(id).first();
  if (!b) return null;
  b.outline = JSON.parse(b.outline || '[]');
  return b;
}
async function findBook(env, ref) {
  // ref = id nebo část názvu
  let b = await getBook(env, ref);
  if (b) return b;
  const row = await env.DB.prepare('SELECT id FROM books WHERE lower(title) LIKE ? ORDER BY created DESC LIMIT 1').bind('%' + String(ref).toLowerCase() + '%').first();
  return row ? getBook(env, row.id) : null;
}

// ---------------- přihlášení na web (cookie) ----------------
async function hmac(env, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('kaja:' + (env.APP_PASSWORD || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function passwordOk(env, pw) { return !!env.APP_PASSWORD && safeEqual(await hmac(env, 'pw:' + pw), await hmac(env, 'pw:' + env.APP_PASSWORD)); }
async function makeSession(env) { const exp = Date.now() + 30 * 864e5; return exp + '.' + await hmac(env, 'session:' + exp); }
async function sessionOk(env, req) {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)ks=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  return Number(exp) > Date.now() && safeEqual(sig || '', await hmac(env, 'session:' + exp));
}

// ---------------- web API ----------------
async function api(req, env, url) {
  const p = url.pathname;
  if (p === '/api/login' && req.method === 'POST') {
    if (!env.APP_PASSWORD) return json({ error: 'Na serveru není nastavené heslo (secret APP_PASSWORD).' }, 500);
    const { password } = await req.json().catch(() => ({}));
    if (!(await passwordOk(env, String(password || '')))) return json({ error: 'Špatné heslo' }, 401);
    return json({ ok: true }, 200, { 'set-cookie': `ks=${await makeSession(env)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}` });
  }
  if (p === '/api/logout') return json({ ok: true }, 200, { 'set-cookie': 'ks=; Path=/; Max-Age=0' });
  if (!(await sessionOk(env, req))) return json({ error: 'Nepřihlášen' }, 401);
  await ensureSchema(env);

  if (p === '/api/me') return json({ ok: true });

  if (p === '/api/books' && req.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT b.id,b.title,b.pages,b.uploaded_pages,b.empty_pages,b.created,b.outline_source,json_array_length(b.outline) AS chapters,(SELECT count(*) FROM materials m WHERE m.book_id=b.id) AS materials FROM books b ORDER BY created DESC').all();
    return json(results);
  }
  if (p === '/api/books' && req.method === 'POST') {
    const b = await req.json();
    const id = newId();
    await env.DB.prepare('INSERT INTO books (id,title,pages,outline,outline_source,created) VALUES (?,?,?,?,?,?)')
      .bind(id, String(b.title || 'Bez názvu').slice(0, 200), Number(b.pages) || 0, JSON.stringify(b.outline || []), (b.outline || []).length ? 'pdf' : 'none', now()).run();
    return json({ id });
  }
  let m = p.match(/^\/api\/books\/([\w-]+)\/pages$/);
  if (m && req.method === 'POST') {
    const { pages } = await req.json();
    if (!Array.isArray(pages) || pages.length > 100) return json({ error: 'max 100 stránek na dávku' }, 400);
    const stmts = pages.map(pg => env.DB.prepare('INSERT OR REPLACE INTO pages (book_id,n,text) VALUES (?,?,?)').bind(m[1], Number(pg.n), String(pg.text || '').slice(0, 200_000)));
    await env.DB.batch(stmts);
    await env.DB.prepare(`UPDATE books SET uploaded_pages=(SELECT count(*) FROM pages WHERE book_id=?1), empty_pages=(SELECT count(*) FROM pages WHERE book_id=?1 AND length(trim(text))<20) WHERE id=?1`).bind(m[1]).run();
    return json({ ok: true });
  }
  m = p.match(/^\/api\/books\/([\w-]+)$/);
  if (m && req.method === 'GET') {
    const b = await getBook(env, m[1]);
    if (!b) return json({ error: 'Nenalezeno' }, 404);
    const { results } = await env.DB.prepare('SELECT id,title,kind,chapter,pages,created FROM materials WHERE book_id=? ORDER BY created DESC').bind(m[1]).all();
    return json({ ...b, materials: results });
  }
  if (m && req.method === 'PATCH') {
    const b = await req.json();
    if (b.title) await env.DB.prepare('UPDATE books SET title=? WHERE id=?').bind(String(b.title).slice(0, 200), m[1]).run();
    return json({ ok: true });
  }
  if (m && req.method === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM pages WHERE book_id=?').bind(m[1]),
      env.DB.prepare('DELETE FROM materials WHERE book_id=?').bind(m[1]),
      env.DB.prepare('DELETE FROM books WHERE id=?').bind(m[1]),
    ]);
    return json({ ok: true });
  }
  m = p.match(/^\/api\/books\/([\w-]+)\/page\/(\d+)$/);
  if (m) {
    const r = await env.DB.prepare('SELECT text FROM pages WHERE book_id=? AND n=?').bind(m[1], Number(m[2])).first();
    return json({ text: r ? r.text : null });
  }
  m = p.match(/^\/api\/materials\/([\w-]+)$/);
  if (m && req.method === 'GET') {
    const r = await env.DB.prepare('SELECT * FROM materials WHERE id=?').bind(m[1]).first();
    return r ? json(r) : json({ error: 'Nenalezeno' }, 404);
  }
  if (m && req.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM materials WHERE id=?').bind(m[1]).run();
    return json({ ok: true });
  }
  return json({ error: 'Neznámá cesta' }, 404);
}

// ---------------- OAuth přihlášení pro connector ----------------
const page = (body) => new Response(`<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kája učení – přihlášení</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f3ee;color:#1f1b16;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.c{background:#fff;border:1px solid #e4ddd2;border-radius:16px;padding:32px;width:min(380px,90vw);box-shadow:0 10px 30px rgba(60,40,10,.08)}
h1{font:600 22px Georgia,serif;margin:0 0 6px}p{color:#6b6255;margin:0 0 20px;font-size:14px}
input{width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #d8cfc1;border-radius:10px;font:inherit;margin-bottom:12px}
button{width:100%;padding:12px;border:0;border-radius:10px;background:#2f5d50;color:#fff;font:600 15px inherit;cursor:pointer}.e{color:#b3261e;font-size:14px;margin-bottom:10px}</style></head>
<body><div class="c">${body}</div></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' } });
const escH = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function authorize(req, env) {
  if (req.method === 'GET') {
    const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(req);
    const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
    const state = btoa(unescape(encodeURIComponent(JSON.stringify(oauthReq))));
    return page(`<h1>Kája učení</h1><p>Aplikace <b>${escH(client?.clientName || 'Claude')}</b> chce přístup k tvým knihám a materiálům.</p>
      <form method="post"><input type="hidden" name="state" value="${escH(state)}"><input type="password" name="password" placeholder="Heslo" autofocus required><button>Povolit přístup</button></form>`);
  }
  const form = await req.formData();
  const state = String(form.get('state') || '');
  let oauthReq;
  try { oauthReq = JSON.parse(decodeURIComponent(escape(atob(state)))); } catch { return new Response('Neplatný požadavek', { status: 400 }); }
  if (!(await passwordOk(env, String(form.get('password') || '')))) {
    return page(`<h1>Kája učení</h1><div class="e">Špatné heslo, zkus to znovu.</div>
      <form method="post"><input type="hidden" name="state" value="${escH(state)}"><input type="password" name="password" placeholder="Heslo" autofocus required><button>Povolit přístup</button></form>`);
  }
  if (!(await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId))) return new Response('Neznámý klient', { status: 400 });
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({ request: oauthReq, userId: 'owner', metadata: {}, scope: oauthReq.scope || [], props: { user: 'owner' } });
  return Response.redirect(redirectTo, 302);
}

// ---------------- MCP nástroje ----------------
const KINDS = ['notes', 'summary', 'quiz', 'test', 'flashcards', 'chapters', 'other'];
const TOOLS = [
  { name: 'list_books', description: 'Seznam nahraných knih (PDF): id, název, počet stránek, počet kapitol a uložených materiálů. Začni tímhle, když uživatel mluví o „knize“ nebo „souboru, co nahrál“.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'get_outline', description: 'Obsah knihy: kapitoly s rozsahem stránek (číslování stránek PDF od 1). Pokud kniha nemá obsah (chapters prázdné), projdi úvodní stránky (read_pages 1–15) a hledej obsah, pak ho ulož přes set_outline.',
    inputSchema: { type: 'object', properties: { book: { type: 'string', description: 'id knihy nebo část názvu' } }, required: ['book'] } },
  { name: 'read_pages', description: `Text stránek knihy v rozsahu from–to (včetně), max ${MAX_READ_PAGES} stránek na jedno volání – delší kapitolu čti po částech. Každá stránka je označena [strana N]. Pozor: číslo strany v PDF se může lišit od čísla vytištěného v knize.`,
    inputSchema: { type: 'object', properties: { book: { type: 'string' }, from: { type: 'integer', minimum: 1 }, to: { type: 'integer', minimum: 1 } }, required: ['book', 'from', 'to'] } },
  { name: 'read_chapter', description: 'Text jedné kapitoly podle pořadí v obsahu (index z get_outline) nebo podle části názvu. U kapitol delších než limit vrátí první část a řekne, kde pokračovat přes read_pages.',
    inputSchema: { type: 'object', properties: { book: { type: 'string' }, chapter: { type: 'string', description: 'index (např. "3") nebo část názvu kapitoly' } }, required: ['book', 'chapter'] } },
  { name: 'search_book', description: 'Fulltextové hledání v knize. Vrátí čísla stránek s úryvky. Hodí se na dohledání pojmu nebo nadpisu kapitoly.',
    inputSchema: { type: 'object', properties: { book: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['book', 'query'] } },
  { name: 'set_outline', description: 'Uloží rozdělení knihy na kapitoly (přepíše stávající). Použij, když kniha nemá obsah v PDF nebo je špatný. Stránky = číslování PDF.',
    inputSchema: { type: 'object', properties: { book: { type: 'string' }, chapters: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, from: { type: 'integer' }, to: { type: 'integer' }, level: { type: 'integer', description: '1 = kapitola, 2 = podkapitola' } }, required: ['title', 'from', 'to'] } } }, required: ['book', 'chapters'] } },
  { name: 'save_material', description: 'Uloží studijní materiál ke knize, aby ho uživatel viděl na webu. Obsah v Markdownu, česky (pokud uživatel nechce jinak). U kvízů a testů dávej správné odpovědi do <details><summary>Odpověď</summary>…</details>, aby se daly odkrýt. kind: notes (výpisky), summary (shrnutí), quiz, test, flashcards, chapters, other.',
    inputSchema: { type: 'object', properties: { book: { type: 'string' }, title: { type: 'string' }, kind: { type: 'string', enum: KINDS }, chapter: { type: 'string', description: 'název kapitoly (volitelné)' }, pages: { type: 'string', description: 'např. "28-35" (volitelné)' }, content: { type: 'string', description: 'Markdown' } }, required: ['book', 'title', 'kind', 'content'] } },
  { name: 'list_materials', description: 'Seznam uložených materiálů ke knize (bez obsahu).',
    inputSchema: { type: 'object', properties: { book: { type: 'string' } }, required: ['book'] } },
  { name: 'get_material', description: 'Obsah uloženého materiálu podle id (např. abys navázal na dřívější výpisky nebo opravil kvíz).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'update_material', description: 'Přepíše obsah nebo název existujícího materiálu.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } }, required: ['id'] } },
];

class ToolError extends Error {}
async function needBook(env, ref) {
  const b = await findBook(env, ref);
  if (!b) throw new ToolError(`Kniha „${ref}“ nenalezena. Zavolej list_books.`);
  return b;
}
async function readRange(env, b, from, to) {
  from = Math.max(1, Math.floor(from)); to = Math.min(b.pages, Math.floor(to));
  if (to < from) throw new ToolError(`Neplatný rozsah. Kniha má ${b.pages} stránek.`);
  const end = Math.min(to, from + MAX_READ_PAGES - 1);
  const { results } = await env.DB.prepare('SELECT n,text FROM pages WHERE book_id=? AND n BETWEEN ? AND ? ORDER BY n').bind(b.id, from, end).all();
  let out = '', last = from - 1;
  for (const r of results) {
    const chunk = `\n[strana ${r.n}]\n${r.text.trim() || '(bez textu – pravděpodobně obrázek nebo sken)'}\n`;
    if (out.length + chunk.length > MAX_READ_CHARS && out) break;
    out += chunk; last = r.n;
  }
  if (!results.length) out = '(Tyto stránky nejsou nahrané.)';
  const more = last < to ? `\n\n…pokračuj read_pages od ${last + 1} do ${to}.` : '';
  return `Kniha: ${b.title} · strany ${from}–${last} z ${b.pages}${more ? ' (zkráceno)' : ''}\n${out}${more}`;
}

async function callTool(env, name, a) {
  await ensureSchema(env);
  switch (name) {
    case 'list_books': {
      const { results } = await env.DB.prepare('SELECT b.id,b.title,b.pages,b.uploaded_pages,b.empty_pages,json_array_length(b.outline) AS chapters,(SELECT count(*) FROM materials m WHERE m.book_id=b.id) AS materials,b.created FROM books b ORDER BY created DESC').all();
      if (!results.length) return 'Zatím tu nejsou žádné knihy. Uživatel je nahraje na webu.';
      return results.map(b => `- ${b.title} (id: ${b.id}) · ${b.pages} stran${b.uploaded_pages < b.pages ? `, nahráno jen ${b.uploaded_pages}` : ''} · kapitol: ${b.chapters} · materiálů: ${b.materials}${b.empty_pages ? ` · ${b.empty_pages} stran bez textu` : ''}`).join('\n');
    }
    case 'get_outline': {
      const b = await needBook(env, a.book);
      if (!b.outline.length) return `Kniha „${b.title}“ (${b.pages} stran) nemá obsah. Projdi úvodní stránky (read_pages 1–15) nebo použij search_book na „kapitola“/„chapter“ a pak ulož kapitoly přes set_outline.`;
      return `Obsah knihy „${b.title}“ (${b.pages} stran, zdroj: ${b.outline_source === 'pdf' ? 'záložky PDF' : 'uložil Claude'}):\n` +
        b.outline.map((c, i) => `${i}. ${'  '.repeat(Math.max(0, (c.level || 1) - 1))}${c.title} — strany ${c.from}–${c.to}`).join('\n');
    }
    case 'read_pages': {
      const b = await needBook(env, a.book);
      return readRange(env, b, Number(a.from), Number(a.to));
    }
    case 'read_chapter': {
      const b = await needBook(env, a.book);
      const q = String(a.chapter).trim();
      let c = /^\d+$/.test(q) ? b.outline[Number(q)] : null;
      if (!c) c = b.outline.find(x => x.title.toLowerCase().includes(q.toLowerCase()));
      if (!c) throw new ToolError('Kapitola nenalezena. Podívej se do get_outline.');
      return `Kapitola: ${c.title}\n` + await readRange(env, b, c.from, c.to);
    }
    case 'search_book': {
      const b = await needBook(env, a.book);
      const q = String(a.query || '').trim().toLowerCase();
      if (q.length < 2) throw new ToolError('Dotaz je moc krátký.');
      const { results } = await env.DB.prepare('SELECT n, text FROM pages WHERE book_id=? AND instr(lower(text), ?) > 0 ORDER BY n LIMIT ?').bind(b.id, q, Math.min(50, a.limit || 20)).all();
      if (!results.length) return `„${a.query}“ v knize nenalezeno.`;
      return results.map(r => { const t = r.text, i = t.toLowerCase().indexOf(q); return `strana ${r.n}: …${t.slice(Math.max(0, i - 120), i + q.length + 120).replace(/\s+/g, ' ')}…`; }).join('\n');
    }
    case 'set_outline': {
      const b = await needBook(env, a.book);
      const ch = (a.chapters || []).map(c => ({ title: String(c.title).slice(0, 200), from: Math.max(1, c.from | 0), to: Math.min(b.pages, c.to | 0), level: c.level || 1 })).filter(c => c.to >= c.from);
      await env.DB.prepare("UPDATE books SET outline=?, outline_source='claude' WHERE id=?").bind(JSON.stringify(ch), b.id).run();
      return `Uloženo ${ch.length} kapitol pro „${b.title}“.`;
    }
    case 'save_material': {
      const b = await needBook(env, a.book);
      const kind = KINDS.includes(a.kind) ? a.kind : 'other';
      const id = newId();
      await env.DB.prepare('INSERT INTO materials (id,book_id,title,kind,chapter,pages,content,created) VALUES (?,?,?,?,?,?,?,?)')
        .bind(id, b.id, String(a.title).slice(0, 200), kind, a.chapter || null, a.pages || null, String(a.content), now()).run();
      return `Uloženo (id: ${id}). Uživatel to najde na webu u knihy „${b.title}“.`;
    }
    case 'list_materials': {
      const b = await needBook(env, a.book);
      const { results } = await env.DB.prepare('SELECT id,title,kind,chapter,pages,created FROM materials WHERE book_id=? ORDER BY created DESC').bind(b.id).all();
      return results.length ? results.map(m => `- [${m.kind}] ${m.title} (id: ${m.id})${m.chapter ? ' · ' + m.chapter : ''}${m.pages ? ' · s. ' + m.pages : ''}`).join('\n') : 'Ke knize zatím nejsou uložené materiály.';
    }
    case 'get_material': {
      const r = await env.DB.prepare('SELECT * FROM materials WHERE id=?').bind(String(a.id)).first();
      if (!r) throw new ToolError('Materiál nenalezen.');
      return `# ${r.title} [${r.kind}]\n\n${r.content}`;
    }
    case 'update_material': {
      const r = await env.DB.prepare('SELECT id FROM materials WHERE id=?').bind(String(a.id)).first();
      if (!r) throw new ToolError('Materiál nenalezen.');
      if (a.title) await env.DB.prepare('UPDATE materials SET title=? WHERE id=?').bind(String(a.title).slice(0, 200), r.id).run();
      if (a.content) await env.DB.prepare('UPDATE materials SET content=? WHERE id=?').bind(String(a.content), r.id).run();
      return 'Upraveno.';
    }
  }
  throw new ToolError('Neznámý nástroj: ' + name);
}

// ---------------- MCP (Streamable HTTP, bezstavové JSON odpovědi) ----------------
const SERVER_INFO = { name: 'kaja-uceni', version: '1.0.0' };
const INSTRUCTIONS = 'Knihovna studijních PDF uživatele. Postup: list_books → get_outline → read_chapter/read_pages. Výpisky, kvízy a testy dělej česky a na přání je ulož přes save_material, aby je uživatel měl na webu.';
async function rpc(env, msg) {
  const { id, method, params } = msg;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return ok({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      try {
        const text = await callTool(env, params?.name, params?.arguments || {});
        return ok({ content: [{ type: 'text', text }] });
      } catch (e) {
        if (e instanceof ToolError) return ok({ content: [{ type: 'text', text: e.message }], isError: true });
        return ok({ content: [{ type: 'text', text: 'Chyba serveru: ' + (e && e.message || e) }], isError: true });
      }
    }
    case 'resources/list': return ok({ resources: [] });
    case 'prompts/list': return ok({ prompts: [] });
    default:
      if (method?.startsWith('notifications/')) return null;
      return err(-32601, 'Method not found: ' + method);
  }
}
const mcpHandler = {
  async fetch(req, env) {
    if (req.method === 'GET') return new Response('SSE stream not supported', { status: 405, headers: { allow: 'POST, DELETE' } });
    if (req.method === 'DELETE') return new Response(null, { status: 204 });
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    let body;
    try { body = await req.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
    const batch = Array.isArray(body);
    const out = (await Promise.all((batch ? body : [body]).map(m => rpc(env, m)))).filter(Boolean);
    if (!out.length) return new Response(null, { status: 202 });
    return json(batch ? out : out[0]);
  },
};

// ---------------- výchozí handler: web + přihlášení ----------------
const defaultHandler = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/authorize') return authorize(req, env);
    if (url.pathname.startsWith('/api/')) {
      try { return await api(req, env, url); }
      catch (e) { return json({ error: String(e && e.message || e) }, 500); }
    }
    return env.ASSETS.fetch(req);
  },
};

// Provider se vytváří podle domény požadavku (funguje na workers.dev i na vlastní doméně)
const providers = new Map();
function providerFor(origin) {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider({
      apiRoute: '/mcp',
      apiHandler: mcpHandler,
      defaultHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      resourceMetadata: { resource: origin + '/mcp', resource_name: 'Kája učení' },
    });
    providers.set(origin, p);
  }
  return p;
}
export default {
  fetch(req, env, ctx) {
    const u = new URL(req.url);
    return providerFor(u.origin.toLowerCase()).fetch(req, env, ctx);
  },
};
