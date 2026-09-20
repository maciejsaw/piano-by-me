// Minimal static server. AudioWorklet needs a secure context; localhost counts.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const root = process.cwd();
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.webm': 'audio/webm' };
const port = Number(process.env.PORT || 8080);
createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let path = join(root, normalize(url === '/' ? '/index.html' : url));
    if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
    if (url.endsWith('/')) path = join(path, 'index.html');          // /sampled/ -> its page
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
}).listen(port, () => console.log(`\n  piano-model-x  ->  http://localhost:${port}\n`));
