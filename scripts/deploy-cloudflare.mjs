// Run from the application root after npm run build.
// Credentials are read only from the environment supplied by GitHub Secrets.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const worker = process.env.WORKER_NAME || 'stafftrack';
if (!account || !token) throw new Error('Add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to GitHub repository Secrets.');
if (!/^[a-z0-9][a-z0-9-]{0,50}$/.test(worker)) throw new Error('WORKER_NAME must use lowercase letters, digits and hyphens.');
if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error('Invalid Cloudflare account ID.');

async function api(path, method = 'GET', body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json();
  if (!response.ok || !json.success) {
    // Never print request headers or tokens.
    throw new Error(`Cloudflare ${method} ${path}: ${json.errors?.map(e => e.message).join('; ') || response.status}`);
  }
  return json;
}

const databaseName = `${worker}-db`, bucketName = `${worker}-files`;
let database;
for (let page = 1; ; page++) {
  const list = await api(`/d1/database?per_page=100&page=${page}`);
  database = list.result.find(d => d.name === databaseName);
  if (database || list.result.length < 100) break;
}
if (!database) database = (await api('/d1/database', 'POST', { name: databaseName })).result;
let bucket;
let cursor;
do {
  const list = await api(`/r2/buckets?per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  bucket = list.result.buckets.find(b => b.name === bucketName);
  cursor = list.result_info?.cursor;
} while (!bucket && cursor);
if (!bucket) await api('/r2/buckets', 'POST', { name: bucketName });

const configPath = 'dist/server/wrangler.json';
const config = JSON.parse(readFileSync(configPath, 'utf8'));
config.name = worker;
config.account_id = account;
config.workers_dev = true;
config.d1_databases = [{ binding: 'DB', database_name: databaseName, database_id: database.uuid, migrations_dir: '../../drizzle' }];
config.r2_buckets = [{ binding: 'BUCKET', bucket_name: bucketName }];
delete config.topLevelName;
writeFileSync(configPath, JSON.stringify(config, null, 2));

function wrangler(args) {
  const result = spawnSync(process.execPath, ['--import', './scripts/sites-env.mjs', './node_modules/wrangler/bin/wrangler.js', ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Wrangler ${args[0]} failed. Deployment stopped.`);
}
// Wrangler records applied migrations; reruns preserve existing data.
wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath]);
wrangler(['deploy', '--config', configPath]);

const subdomain = (await api('/workers/subdomain')).result.subdomain;
const url = `https://${worker}.${subdomain}.workers.dev`;
const result = `StaffTrack deployed: ${url}\n`;
console.log(result);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## StaffTrack\n\n[Open the deployed application](${url})\n\nDatabase and files persist between deployments.\n`);
