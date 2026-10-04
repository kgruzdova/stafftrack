import {spawnSync} from 'node:child_process';
import {existsSync,readdirSync} from 'node:fs';
const args=['--import','./scripts/sites-env.mjs','./node_modules/wrangler/bin/wrangler.js','d1','execute','DB','--local','--config','dist/server/wrangler.json','--persist-to','.wrangler/state'];
if(!existsSync('dist/server/wrangler.json')){console.error('Сначала выполните npm run build.');process.exit(1)}
const check=spawnSync(process.execPath,[...args,'--command',"SELECT name FROM sqlite_master WHERE type='table' AND name='users'",'--json'],{encoding:'utf8'});
if(check.status!==0){console.error(check.stderr||check.stdout);process.exit(1)}
if(check.stdout.includes('"name": "users"')||check.stdout.includes('"name":"users"')){
 const members=spawnSync(process.execPath,[...args,'--command',"SELECT name FROM sqlite_master WHERE type='table' AND name='task_assignees'",'--json'],{encoding:'utf8'});
 if(members.status!==0){console.error(members.stderr||members.stdout);process.exit(1)}
 if(!members.stdout.includes('"task_assignees"')){const update=spawnSync(process.execPath,[...args,'--file','drizzle/0001_last_vance_astro.sql'],{stdio:'inherit'});if(update.status!==0)process.exit(update.status||1)}
 console.log('Локальная база готова. Существующие данные сохранены.');process.exit(0)
}
for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort()){const r=spawnSync(process.execPath,[...args,'--file','drizzle/'+file],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1)}
console.log('Локальная база готова. Создайте компанию на странице входа.');
