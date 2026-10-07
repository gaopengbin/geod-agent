// Preserve conversation-scoped native tools alongside the shared gateway tools.
import { readFileSync,writeFileSync } from 'node:fs';
import { TOOLS } from '../services/geod-agent-model-gateway/server.mjs';
import { USER_INPUT_POLICY } from '../packages/codex-protocol/user-input-tools.mjs';

const native=JSON.parse(readFileSync(new URL('../apps/geod-agent-desktop/src-tauri/native-tools.json',import.meta.url),'utf8'));
const names=new Set(native.map(tool=>tool.function.name));
if(names.size!==native.length)throw new Error('Duplicate native tool definitions');
const tools=[...native,...TOOLS.filter(tool=>!names.has(tool.function.name))];
writeFileSync(new URL('../apps/geod-agent-desktop/src-tauri/codex-bulk-data.mjs',import.meta.url),readFileSync(new URL('../packages/codex-protocol/bulk-data.mjs',import.meta.url),'utf8'));
writeFileSync(new URL('../apps/geod-agent-desktop/src-tauri/codex-tools.json', import.meta.url), JSON.stringify(tools, null, 2) + '\n');
// The native host is copied to a private runtime folder, so embed the shared policy.
const hostFile=new URL('../apps/geod-agent-desktop/src-tauri/codex-host.mjs',import.meta.url);
const host=readFileSync(hostFile,'utf8'),policy=/^(?:export )?const USER_INPUT_POLICY = .*;$/m;
if(!policy.test(host))throw new Error('Native clarification policy marker missing');
writeFileSync(hostFile,host.replace(policy,()=>`export const USER_INPUT_POLICY = ${JSON.stringify(USER_INPUT_POLICY)};`));
console.log(`Synced ${tools.length} GeoD tools, including ${native.length} native document/database tools.`);
