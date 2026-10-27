// Local QA stack: serves dist/ and proxies /api/* to a local leaderboard server.
// Usage: node scripts/local-stack.mjs [port=4400] [api=http://127.0.0.1:8080]
import http from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'

const port = Number(process.argv[2] ?? 4400)
const api = new URL(process.argv[3] ?? 'http://127.0.0.1:8080')
const root = join(process.cwd(), 'dist')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' }

http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    const proxied = http.request({ host: api.hostname, port: api.port, path: req.url, method: req.method, headers: req.headers }, r => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    proxied.on('error', () => { res.writeHead(502); res.end() })
    req.pipe(proxied)
    return
  }
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = join(root, path)
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html')
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
}).listen(port, '127.0.0.1', () => console.log(`local stack on http://127.0.0.1:${port}/`))
