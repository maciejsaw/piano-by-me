// Minimal static server. AudioWorklet needs a secure context; localhost counts.
// Serves the whole repo, so / is the chooser and /modelled/, /sampled/ the pianos.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.webm': 'audio/webm' };
const port = Number(process.env.PORT || 8080);
createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    // /sampled -> /sampled/, or the page's relative ./src/ imports resolve one level too high
    if (/^\/(modelled|sampled)$/.test(url)) { res.writeHead(301, { location: url + '/' }).end(); return; }
    let path = join(root, normalize(url));
    if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
    if (url.endsWith('/')) path = join(path, 'index.html');          // /sampled/ -> its page
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
}).listen(port, () => console.log(`\n  piano-by-me  ->  http://localhost:${port}\n     modelled    ->  http://localhost:${port}/modelled/\n     sampled     ->  http://localhost:${port}/sampled/\n`));
