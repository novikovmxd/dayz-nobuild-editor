import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const PORT = 8766;
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};

createServer(async (req, res) => {
    try {
        let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (path === '/') path = '/index.html';
        if (path.includes('..')) { res.writeHead(400); res.end('bad'); return; }
        const data = await readFile(new URL('.' + path, import.meta.url));
        res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
        res.end(data);
    } catch (e) {
        res.writeHead(404); res.end('not found');
    }
}).listen(PORT, () => {
    console.log(`✓ Открой в браузере: http://localhost:${PORT}`);
    console.log('  (Chrome/Edge для сохранения файла через File System Access API)');
});
