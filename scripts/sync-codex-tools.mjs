// Preserve conversation-scoped native tools alongside the shared gateway tools.
import { readFileSync,writeFileSync } from 'node:fs';
import { TOOLS } from '../services/geod-agent-model-gateway/server.mjs';

const native=JSON.parse(readFileSync(new URL('../apps/geod-agent-desktop/src-tauri/native-tools.json',import.meta.url),'utf8'));
const names=new Set(native.map(tool=>tool.function.name));
if(names.size!==native.length)throw new Error('Duplicate native tool definitions');
const tools=[...native,...TOOLS.filter(tool=>!names.has(tool.function.name))];
writeFileSync(new URL('../apps/geod-agent-desktop/src-tauri/codex-tools.json', import.meta.url), JSON.stringify(tools, null, 2) + '\n');
console.log(`Synced ${tools.length} GeoD tools, including ${native.length} native document/database tools.`);
