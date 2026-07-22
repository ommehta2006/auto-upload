import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ejs from 'ejs';

const root = process.cwd();
const required = [
  'Dockerfile.railway','railway.toml','Railway.Caddyfile','docker-compose.yml','docker-compose.local.yml',
  'START_WINDOWS.cmd','START_MAC.command','db/schema.sql','src/server.js','src/worker.js','src/services/youtube.js',
  'views/dashboard.ejs','views/login.ejs','deploy/youtube_upload_template.xlsx'
];
for (const file of required) {
  if (!fs.existsSync(path.join(root,file))) throw new Error(`Required project file is missing: ${file}`);
}
const ignoredRootDirs = new Set(['.git','node_modules','storage','tmp','artifacts','runtime']);
function walk(directory, options = {}) {
  return fs.readdirSync(directory,{ withFileTypes:true }).flatMap(entry => {
    if (entry.isDirectory() && options.skipRootRuntime && directory === root && ignoredRootDirs.has(entry.name)) return [];
    return entry.isDirectory() ? walk(path.join(directory,entry.name), options) : [path.join(directory,entry.name)];
  });
}
for (const file of [...walk(path.join(root,'src')),...walk(path.join(root,'public')),...walk(path.join(root,'deploy')),...walk(path.join(root,'scripts'))]) {
  if (/\.(?:js|mjs)$/.test(file)) execFileSync(process.execPath,['--check',file],{ stdio:'pipe' });
}
for (const file of walk(path.join(root,'views')).filter(file => file.endsWith('.ejs'))) {
  ejs.compile(fs.readFileSync(file,'utf8'),{ filename:file });
}
const forbidden = walk(root, { skipRootRuntime:true }).filter(file => /instagram/i.test(path.basename(file)) || /browser-profile|storage-state\.json/i.test(file));
if (forbidden.length) throw new Error(`Forbidden legacy or session files found: ${forbidden.join(', ')}`);
const schema = fs.readFileSync(path.join(root,'db/schema.sql'),'utf8');
for (const table of ['users','youtube_accounts','media_files','uploads','activity_logs','user_sessions']) {
  if (!schema.includes(`TABLE IF NOT EXISTS ${table}`)) throw new Error(`Schema table missing: ${table}`);
}
console.log('Project structure, JavaScript syntax, EJS syntax, security exclusions and schema checks passed.');
