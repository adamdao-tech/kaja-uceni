// Kája učení – web (nahrávání PDF, knihovna, materiály)
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
const $ = s => document.querySelector(s);
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const KIND = { notes: 'Výpisky', summary: 'Shrnutí', quiz: 'Kvíz', test: 'Test', flashcards: 'Kartičky', chapters: 'Kapitoly', other: 'Ostatní' };
const fmtDate = d => new Date(d).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });

async function api(path, opt = {}) {
  const r = await fetch('/api' + path, { ...opt, headers: { 'content-type': 'application/json', ...(opt.headers || {}) }, body: opt.body && typeof opt.body !== 'string' ? JSON.stringify(opt.body) : opt.body });
  if (r.status === 401 && path !== '/login') { login(); throw new Error('auth'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function toast(t) { let el = $('.toast'); if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.append(el); } el.textContent = t; el.classList.add('on'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('on'), 1600); }
const copy = (t, msg = 'Zkopírováno') => { navigator.clipboard?.writeText(t); toast(msg); };

// ---------------- login ----------------
function login() {
  $('#logout').hidden = true;
  app.innerHTML = `<div class="login card"><h1>Kája učení</h1><p class="muted">Tvoje knihovna studijních PDF pro Clauda.</p>
    <form id="lf"><input type="password" id="pw" placeholder="Heslo" autofocus required><div class="err" id="le"></div><button class="btn">Přihlásit</button></form></div>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    try { await api('/login', { method: 'POST', body: { password: $('#pw').value } }); route(); }
    catch (er) { $('#le').textContent = er.message; }
  };
}
$('#logout').onclick = async () => { await fetch('/api/logout'); login(); };

// ---------------- knihovna ----------------
async function library() {
  const books = await api('/books');
  app.innerHTML = `<h1>Knihovna</h1><p class="sub">Nahraj PDF a pak v Claudovi napiš třeba „z kapitoly 4 mi udělej výpisky a kvíz“. Text se z PDF vytáhne přímo tady v prohlížeči, takže projde i obří soubor.</p>
    <div class="up" id="up">
      <label class="drop" id="drop"><input type="file" id="file" accept="application/pdf" hidden><b>Přetáhni sem PDF</b><span class="muted">nebo klikni a vyber soubor</span></label>
    </div>
    <h2>Tvoje knihy</h2>
    ${books.length ? `<div class="books">${books.map(b => `<a class="card book" href="#/book/${b.id}"><b>${esc(b.title)}</b>
      <div class="meta"><span class="chip">${b.pages} stran</span><span class="chip ${b.chapters ? '' : 'warn'}">${b.chapters ? b.chapters + ' kapitol' : 'bez obsahu'}</span>${b.materials ? `<span class="chip acc">${b.materials} materiálů</span>` : ''}${b.uploaded_pages < b.pages ? `<span class="chip warn">nahráno ${b.uploaded_pages}/${b.pages}</span>` : ''}${b.empty_pages ? `<span class="chip warn">${b.empty_pages} stran bez textu</span>` : ''}</div></a>`).join('')}</div>`
      : `<div class="empty">Zatím tu nic není. Nahraj první PDF nahoře.</div>`}`;
  const drop = $('#drop'), file = $('#file');
  file.onchange = () => file.files[0] && upload(file.files[0]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) upload(f); };
}

// ---------------- nahrávání PDF ----------------
let pdfjs = null;
async function loadPdfjs() { if (!pdfjs) { pdfjs = await import(PDFJS); pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; } return pdfjs; }

async function outlineOf(pdf) {
  const raw = await pdf.getOutline().catch(() => null);
  if (!raw || !raw.length) return [];
  const flat = [];
  async function walk(items, level) {
    for (const it of items) {
      if (level > 3) continue;
      let page = null;
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) page = typeof dest[0] === 'number' ? dest[0] + 1 : (await pdf.getPageIndex(dest[0])) + 1;
      } catch {}
      if (page) flat.push({ title: (it.title || '').trim().slice(0, 200) || '(bez názvu)', from: page, level });
      if (it.items?.length) await walk(it.items, level + 1);
    }
  }
  await walk(raw, 1);
  // konec kapitoly = začátek další kapitoly se stejnou nebo vyšší úrovní − 1
  for (let i = 0; i < flat.length; i++) {
    let end = pdf.numPages;
    for (let j = i + 1; j < flat.length; j++) if (flat[j].level <= flat[i].level) { end = Math.max(flat[i].from, flat[j].from - 1); break; }
    flat[i].to = end;
  }
  return flat;
}
function pageText(tc) {
  let out = '';
  for (const it of tc.items) { if (!('str' in it)) continue; out += it.str; out += it.hasEOL ? '\n' : (it.str && !it.str.endsWith(' ') ? ' ' : ''); }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

async function upload(f) {
  if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) return toast('To není PDF');
  const box = $('#up');
  box.innerHTML = `<div class="card"><b id="ut">${esc(f.name)}</b><p class="upinfo" id="ui">Otevírám PDF (${(f.size / 1048576).toFixed(1)} MB)…</p><div class="prog"><i id="pb"></i></div></div>`;
  const ui = $('#ui'), pb = $('#pb');
  try {
    const lib = await loadPdfjs();
    const pdf = await lib.getDocument({ data: await f.arrayBuffer(), isEvalSupported: false }).promise;
    const meta = await pdf.getMetadata().catch(() => null);
    const mt = (meta?.info?.Title || '').trim();
    const title = (mt.length > 3 && !/^(untitled|unknown|bez názvu|microsoft|document|dokument)/i.test(mt) && !/\.(docx?|pdf|pptx?)$/i.test(mt) ? mt : f.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ')).slice(0, 200);
    ui.textContent = 'Čtu obsah knihy…';
    const outline = await outlineOf(pdf);
    const { id } = await api('/books', { method: 'POST', body: { title, pages: pdf.numPages, outline } });
    let batch = [], empty = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      const pg = await pdf.getPage(n);
      const text = pageText(await pg.getTextContent());
      pg.cleanup();
      if (text.length < 20) empty++;
      batch.push({ n, text });
      if (batch.length === 25 || n === pdf.numPages) {
        await api(`/books/${id}/pages`, { method: 'POST', body: { pages: batch } });
        batch = [];
      }
      pb.style.width = (n / pdf.numPages * 100) + '%';
      ui.textContent = `Strana ${n} / ${pdf.numPages}${outline.length ? ` · ${outline.length} kapitol z obsahu PDF` : ''}`;
    }
    await pdf.destroy();
    ui.innerHTML = `✓ Hotovo. ${empty ? `<b>${empty} stran nemá text</b> (obrázky/skeny) – ty Claude nepřečte.` : ''}`;
    setTimeout(() => location.hash = '#/book/' + id, empty ? 1800 : 500);
  } catch (e) {
    if (e.message === 'auth') return;
    ui.innerHTML = `<span style="color:var(--bad)">Nepodařilo se: ${esc(e.message)}</span>`;
    if (/password/i.test(e.name + e.message)) ui.innerHTML = '<span style="color:var(--bad)">PDF je zaheslované.</span>';
  }
}

// ---------------- detail knihy ----------------
async function book(id, tab) {
  const b = await api('/books/' + id);
  tab = tab || (b.materials.length ? 'mat' : 'toc');
  const tocHtml = b.outline.length ? `<ul class="toc">${b.outline.map((c, i) => `<li class="l${Math.min(3, c.level || 1)}"><span>${esc(c.title)}</span><button class="link cp" data-p="Z knihy „${esc(b.title)}“ mi z kapitoly „${esc(c.title)}“ (strany ${c.from}–${c.to}) udělej výpisky a kvíz a ulož je.">Zkopírovat prompt</button><span class="pg">s. ${c.from}–${c.to}</span></li>`).join('')}</ul>
      <p class="muted" style="font-size:13px;margin-top:10px">Zdroj: ${b.outline_source === 'claude' ? 'rozdělil Claude' : 'záložky v PDF'} · čísla stránek odpovídají PDF, ne vytištěným číslům v knize.</p>`
    : `<div class="empty">PDF nemá obsah (záložky). Napiš Claudovi: <b>„Rozděl knihu ${esc(b.title)} na kapitoly a ulož je.“</b></div>`;
  const matHtml = b.materials.length ? `<div class="mats">${b.materials.map(m => `<div class="card mat" data-m="${m.id}"><span class="k">${KIND[m.kind] || m.kind}</span><div class="t"><b>${esc(m.title)}</b><span>${[m.chapter, m.pages && 's. ' + m.pages, fmtDate(m.created)].filter(Boolean).map(esc).join(' · ')}</span></div><button class="link danger" data-del="${m.id}">smazat</button></div>`).join('')}</div>`
    : `<div class="empty">Zatím žádné materiály. Řekni Claudovi, ať ti z kapitoly udělá výpisky nebo kvíz a uloží je.</div>`;
  app.innerHTML = `<p><a href="#/">← Knihovna</a></p>
    <div class="bhead"><h1>${esc(b.title)}</h1><button class="btn ghost" id="ren">Přejmenovat</button><button class="btn ghost" id="del">Smazat</button></div>
    <div class="meta"><span class="chip">${b.pages} stran</span><span class="chip">${b.outline.length} kapitol</span>${b.empty_pages ? `<span class="chip warn">${b.empty_pages} stran bez textu</span>` : ''}<span class="chip">id: ${b.id}</span></div>
    <div class="tabs"><button data-t="mat" class="${tab === 'mat' ? 'on' : ''}">Materiály (${b.materials.length})</button><button data-t="toc" class="${tab === 'toc' ? 'on' : ''}">Kapitoly</button></div>
    <div id="tb">${tab === 'mat' ? matHtml : tocHtml}</div>`;
  app.querySelectorAll('[data-t]').forEach(x => x.onclick = () => book(id, x.dataset.t));
  app.querySelectorAll('[data-m]').forEach(x => x.onclick = e => { if (!e.target.closest('[data-del]')) location.hash = `#/m/${x.dataset.m}`; });
  app.querySelectorAll('[data-del]').forEach(x => x.onclick = async () => { if (confirm('Smazat materiál?')) { await api('/materials/' + x.dataset.del, { method: 'DELETE' }); book(id, 'mat'); } });
  app.querySelectorAll('[data-p]').forEach(x => x.onclick = () => copy(x.dataset.p, 'Prompt zkopírován – vlož ho Claudovi'));
  $('#del').onclick = async () => { if (confirm(`Opravdu smazat „${b.title}“ i se všemi materiály?`)) { await api('/books/' + id, { method: 'DELETE' }); location.hash = '#/'; } };
  $('#ren').onclick = async () => { const t = prompt('Nový název', b.title); if (t && t.trim()) { await api('/books/' + id, { method: 'PATCH', body: { title: t.trim() } }); book(id, tab); } };
}

async function material(id) {
  const m = await api('/materials/' + id);
  const html = window.DOMPurify ? DOMPurify.sanitize(marked.parse(m.content), { ADD_TAGS: ['details', 'summary'] }) : esc(m.content);
  app.innerHTML = `<p><a href="#/book/${m.book_id}">← Zpět ke knize</a></p>
    <article class="doc"><div class="meta" style="margin-bottom:10px"><span class="chip acc">${KIND[m.kind] || m.kind}</span>${m.chapter ? `<span class="chip">${esc(m.chapter)}</span>` : ''}${m.pages ? `<span class="chip">s. ${esc(m.pages)}</span>` : ''}<span class="chip">${fmtDate(m.created)}</span></div>
    <h1>${esc(m.title)}</h1><div class="md">${html}</div></article>
    <p style="margin-top:14px"><button class="btn ghost" id="cpm">Kopírovat jako Markdown</button></p>`;
  $('#cpm').onclick = () => copy(m.content);
}

// ---------------- napojení na Clauda ----------------
function claudeSetup() {
  const url = location.origin + '/mcp';
  const P = [
    ['Jaké knihy mám v Kája učení?', 'přehled'],
    ['Rozděl knihu [název] na kapitoly a ulož je.', 'když PDF nemá obsah'],
    ['Z kapitoly 4 knihy [název] mi udělej výpisky a ulož je.', 'výpisky'],
    ['Udělej mi kvíz o 10 otázkách ze stran 28–35 a ulož ho.', 'kvíz s odpověďmi k odkrytí'],
    ['Vyzkoušej mě z kapitoly 3 – ptej se po jedné otázce a hodnoť moje odpovědi.', 'interaktivní test v chatu'],
    ['Najdi v knize, kde se píše o [pojem], a vysvětli mi to jednoduše.', 'hledání'],
    ['Udělej kartičky (otázka – odpověď) na pojmy z kapitoly 2.', 'kartičky'],
    ['Shrň celou knihu po kapitolách, každou do 5 bodů.', 'velké shrnutí (po částech)'],
  ];
  app.innerHTML = `<h1>Napojení na Clauda</h1><p class="sub">Jednou přidáš connector a pak se v jakémkoliv chatu s Claudem můžeš ptát na své knihy.</p>
    <ol class="steps">
      <li class="card">V Claudovi otevři <b>Nastavení → Konektory</b> (Connectors) a dej <b>Přidat vlastní konektor</b>.</li>
      <li class="card">Název třeba <b>Kája učení</b>, jako URL vlož:<div class="urlbox"><code>${esc(url)}</code><button class="btn ghost" id="cpu">Kopírovat</button></div></li>
      <li class="card">Klikni <b>Připojit</b>, otevře se přihlašovací stránka – zadej stejné heslo jako sem.</li>
      <li class="card">V chatu pak connector zapni (ikona nástrojů) a piš. Hotové materiály se objeví tady u knihy.</li>
    </ol>
    <h2>Co mu můžeš napsat</h2><div class="prompts">${P.map(([t, s]) => `<div class="card prompt" data-p="${esc(t)}">${esc(t)}<small>${esc(s)} · klikni pro zkopírování</small></div>`).join('')}</div>`;
  $('#cpu').onclick = () => copy(url);
  app.querySelectorAll('[data-p]').forEach(x => x.onclick = () => copy(x.dataset.p));
}

// ---------------- router ----------------
async function route() {
  const h = location.hash.replace(/^#\/?/, '');
  document.querySelectorAll('.top nav a').forEach(a => a.classList.toggle('on', a.dataset.r === h.split('/')[0]));
  try {
    await api('/me');
    $('#logout').hidden = false;
    let m;
    if ((m = h.match(/^book\/([\w-]+)/))) return await book(m[1]);
    if ((m = h.match(/^m\/([\w-]+)/))) return await material(m[1]);
    if (h === 'claude') return claudeSetup();
    return await library();
  } catch (e) {
    if (e.message !== 'auth') app.innerHTML = `<div class="empty">Chyba: ${esc(e.message)}</div>`;
  }
}
window.addEventListener('hashchange', route);
route();
