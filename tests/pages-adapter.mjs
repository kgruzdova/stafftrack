import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import initSqlJs from 'sql.js';
import { createServer as createViteServer } from 'vite';

// Run the server's acceptance suites against the SQLite adapter shipped to Pages.
const vite = await createViteServer({ configFile: 'vite.pages.config.ts', root: process.cwd(), server: { middlewareMode: true, hmr: false, ws: false } });
const { BrowserDatabase } = await vite.ssrLoadModule('/standalone/d1-adapter.ts');
const { env } = await vite.ssrLoadModule('/standalone/bindings.ts');
const { handle } = await vite.ssrLoadModule('/lib/server.ts');
const SQL = await initSqlJs();
const sqlite = new SQL.Database();
sqlite.run('PRAGMA foreign_keys=ON');
for (const name of (await readdir('drizzle')).filter(name => name.endsWith('.sql')).sort()) {
  sqlite.run(await readFile('drizzle/' + name, 'utf8'));
}
env.DB = new BrowserDatabase(sqlite);
const files = new Map();
env.BUCKET = {
  async put(key, bytes, options) { files.set(key, new Blob([bytes], { type: options?.httpMetadata?.contentType })); },
  async get(key) { return files.has(key) ? { body: files.get(key) } : null; },
  async delete(key) { files.delete(key); },
};
const server = createHttpServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await handle(new Request('http://127.0.0.1:' + server.address().port + req.url, {
      method: req.method, headers: req.headers,
      ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }),
    }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.env.TEST_URL = 'http://127.0.0.1:' + server.address().port;
try {
  await import('./acceptance.mjs');
  await import('./task-editing.mjs');
  await import('./task-lifecycle.mjs');
  const restored = new SQL.Database(sqlite.export());
  assert.deepEqual(restored.exec('SELECT id,priority,status,deleted_at FROM tasks ORDER BY id'), sqlite.exec('SELECT id,priority,status,deleted_at FROM tasks ORDER BY id'));
  restored.close();
  console.log('Pages SQLite adapter: all acceptance suites and persistence round trip passed');
} finally {
  await new Promise(resolve => server.close(resolve));
  await vite.close();
  sqlite.close();
}
