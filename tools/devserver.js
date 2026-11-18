// Serveur de test local : sert le site + imite l'API RPC de Supabase sur un Postgres local.
// Usage : node tools/devserver.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || 8787);
const pool = new Pool({ host: '/tmp', port: 5433, user: 'postgres', database: 'postgres' });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'apikey, content-type, authorization', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const m = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
  if (m && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    const args = body ? JSON.parse(body) : {};
    const keys = Object.keys(args);
    const role = m[1] === 'push_due' || m[1] === 'push_gone' ? 'service_role' : 'anon';
    const sql = `select to_jsonb(public.${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})) as r`;
    const client = await pool.connect();
    try {
      await client.query(`set role ${role}`);
      const r = await client.query(sql, keys.map((k) => args[k]));
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.rows[0].r));
    } catch (e) {
      res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: e.message, code: e.code }));
    } finally {
      await client.query('reset role').catch(() => {});
      client.release();
    }
    return;
  }
  let p = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
