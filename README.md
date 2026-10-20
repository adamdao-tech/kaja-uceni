# Kája učení

Knihovna studijních PDF + vlastní MCP connector pro Clauda.

- **Web** (`/`): nahrávání PDF (text se vytahuje v prohlížeči přes pdf.js, takže projdou i velké soubory), obsah knihy, uložené výpisky/kvízy.
- **MCP** (`/mcp`): nástroje `list_books`, `get_outline`, `read_pages`, `read_chapter`, `search_book`, `set_outline`, `save_material`, `list_materials`, `get_material`, `update_material`.
- Přihlášení: web i connector chrání heslo ze secretu `APP_PASSWORD` (connector přes OAuth).

## Nasazení (Cloudflare Workers)
1. Workers & Pages → Create → Import repository `kaja-uceni` (deploy command `npx wrangler deploy`).
   D1 databáze a KV se při prvním deployi vytvoří samy.
2. Settings → Variables and Secrets → přidat **Secret** `APP_PASSWORD`.
3. Domains → vlastní doména (např. `uceni.daotech.dev`).
4. claude.ai → Settings → Connectors → Add custom connector → `https://<domena>/mcp`.

Lokálně: `.dev.vars` s `APP_PASSWORD=...` a `npm run dev`.
