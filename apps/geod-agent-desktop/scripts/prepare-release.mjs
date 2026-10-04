import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const tools = spawnSync(process.execPath,[fileURLToPath(new URL('../../../scripts/sync-codex-tools.mjs',import.meta.url))],{stdio:'inherit',windowsHide:true});
if(tools.status !== 0)process.exit(tools.status ?? 1);

const prepare = fileURLToPath(new URL('../../../scripts/prepare-codex-runtime.py', import.meta.url));
const runtime = spawnSync('python', ['-X','utf8',prepare], {stdio:'inherit',windowsHide:true});
if(runtime.status !== 0)process.exit(runtime.status ?? 1);
const pgedge = spawnSync('python', ['-X','utf8',fileURLToPath(new URL('../../../scripts/prepare-pgedge-runtime.py', import.meta.url))], {stdio:'inherit',windowsHide:true});
if(pgedge.status !== 0)process.exit(pgedge.status ?? 1);
const gdal = spawnSync('python', ['-X','utf8',fileURLToPath(new URL('../../../scripts/prepare-gdal-runtime.py', import.meta.url))], {stdio:'inherit',windowsHide:true});
if(gdal.status !== 0)process.exit(gdal.status ?? 1);
const documents = spawnSync('python', ['-X','utf8',fileURLToPath(new URL('../../../scripts/prepare-document-runtime.py', import.meta.url))], {stdio:'inherit',windowsHide:true});
if(documents.status !== 0)process.exit(documents.status ?? 1);
const dbhub = spawnSync('python', ['-X','utf8',fileURLToPath(new URL('../../../scripts/prepare-dbhub-runtime.py', import.meta.url))], {stdio:'inherit',windowsHide:true});
const audio = spawnSync('python', ['-X','utf8',fileURLToPath(new URL('../../../scripts/prepare-audio-runtime.py', import.meta.url))], {stdio:'inherit',windowsHide:true});
if (audio.status !== 0) process.exit(audio.status ?? 1);
if(dbhub.status !== 0)process.exit(dbhub.status ?? 1);
const ocr = spawnSync('python', ['-X','utf8',fileURLToPath(new URL('../../../scripts/prepare-ocr-runtime.py', import.meta.url))], {stdio:'inherit',windowsHide:true});
if(ocr.status !== 0)process.exit(ocr.status ?? 1);
const office = spawnSync('python', ['-X','utf8',fileURLToPath(new URL('../../../scripts/prepare-legacy-office-runtime.py', import.meta.url))], {stdio:'inherit',windowsHide:true});
if(office.status !== 0)process.exit(office.status ?? 1);
const build = spawnSync(process.execPath,[process.env.npm_execpath,'run','build'],{stdio:'inherit',windowsHide:true});
process.exit(build.status ?? 1);
