// Codex invokes this reviewed helper with its actual lifecycle input. No model
// calls are made. A failed preflight fails closed (exit 2 = blocking hook).
import {readFileSync} from 'node:fs';
let text='';for await(const chunk of process.stdin)text+=chunk;
try{
 const event=JSON.parse(text),endpoint=JSON.parse(readFileSync(process.argv[2],'utf8'));
 const response=await fetch(endpoint.url,{method:'POST',headers:{authorization:'Bearer '+process.env.GEOD_CODEX_BRIDGE_TOKEN,'content-type':'application/json'},body:JSON.stringify(event),signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw new Error('Execution policy unavailable');
 process.stdout.write(JSON.stringify(await response.json()));
}catch(cause){process.stderr.write('GeoD execution preflight failed: '+cause.message);process.exitCode=2;}
