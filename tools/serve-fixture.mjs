/** Static server for the fixture site, used by the end-to-end check. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'site');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

/**
 * A paginated directory, generated so the page number is a real query param.
 * 3 pages x 3 listings, `rel="next"` omitted deliberately — the Next control is
 * an unlabelled icon, which is the case that defeats text-only detection.
 */
function pagedDirectory(pageNumber) {
  const perPage = 3;
  const total = 9;
  const lastPage = Math.ceil(total / perPage);
  if (pageNumber > lastPage) {
    return `<!doctype html><html lang=en><head><meta charset=utf-8><title>Page ${pageNumber}</title></head>
<body><main class="results"><p class="empty">No more results.</p></main></body></html>`;
  }

  const start = (pageNumber - 1) * perPage;
  const cards = Array.from({ length: Math.min(perPage, total - start) }, (_, i) => {
    const n = start + i + 1;
    return `      <div class="listing-card">
        <h4 class="company-name">Salon ${String(n).padStart(2, '0')}</h4>
        <p class="cat">Category: <span>Beauty Salons and Spa</span></p>
        <div class="logo-box"><img src="/images/company/salon-${n}-thumb.jpg" data-src="/images/company/salon-${n}.jpg" alt="Salon ${n}"></div>
        <p class="addr">No.${n}0, Example Road, Township ${n}, Yangon</p>
        <p class="tel"><a href="tel:0942100${String(n).padStart(4, '0')}">09-42100${String(n).padStart(4, '0')}</a></p>
      </div>`;
  }).join('\n');

  const pageLinks = Array.from({ length: lastPage }, (_, i) => {
    const p = i + 1;
    return p === pageNumber
      ? `<span class="page-numbers current">${p}</span>`
      : `<a class="page-numbers" href="/paged?page=${p}">${p}</a>`;
  }).join(' ');

  // The "next" control carries no text at all, only an icon span.
  const next =
    pageNumber < lastPage
      ? `<a class="pagination-next" href="/paged?page=${pageNumber + 1}"><span class="icon-chevron"></span></a>`
      : `<span class="pagination-next disabled"><span class="icon-chevron"></span></span>`;

  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<title>Beauty Salons - page ${pageNumber} | Example Pages</title>
<meta property="og:image" content="/images/ypg-logo.png">
</head><body>
  <header class="site-header"><nav class="navbar"><a href="/">Home</a></nav></header>
  <div class="container">
    <main class="results">
${cards}
      <div class="pagination">${pageLinks} ${next}</div>
    </main>
  </div>
  <footer class="site-footer"><p>Example Co.,Ltd. · Tel : 09-5141770</p></footer>
</body></html>`;
}

export function startFixtureServer(port = 8099) {
  const server = http.createServer(async (req, res) => {
    const [pathOnly, query = ''] = req.url.split('?');
    let rel = decodeURIComponent(pathOnly);

    // Dynamic paginated route, so `?page=N` is genuinely different content.
    if (rel === '/paged') {
      const pageNumber = Number(new URLSearchParams(query).get('page') ?? 1) || 1;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(pagedDirectory(pageNumber));
      return;
    }

    if (rel === '/') rel = '/index.html';
    try {
      const body = await readFile(path.join(root, rel));
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(rel)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8099);
  startFixtureServer(port).then(() => console.log(`fixture site on http://localhost:${port}`));
}
