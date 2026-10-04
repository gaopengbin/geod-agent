/** Generate a reviewable English catalogue through the existing native model route. */
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const runtime=process.argv[2];
if(!runtime) throw new Error('Pass the existing Playwright module path.');
const {chromium}=await import(pathToFileURL(runtime).href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));
if(!page) throw new Error('Development desktop is not open.');
const inventory=JSON.parse(fs.readFileSync('artifacts/product-gaps-20261004/ui-message-inventory.json','utf8'));
const cataloguePath=path.resolve('apps/geod-agent-desktop/src/locales/en.json');
fs.mkdirSync(path.dirname(cataloguePath),{recursive:true});
const catalogue=fs.existsSync(cataloguePath)?JSON.parse(fs.readFileSync(cataloguePath,'utf8')):{};
const items=inventory.filter(item=>item.text.length<900 && !item.locations.every(location=>['agent-workflow.ts','builtin-skills.ts','cesium-tool-definitions.ts','conversation-context.ts'].includes(location.file))).filter(item=>!catalogue[item.text]);
const batches=[];
for(const item of items){let batch=batches.at(-1);if(!batch||batch.length>=32||batch.reduce((sum,item)=>sum+item.text.length,0)+item.text.length>2400)batches.push(batch=[]);batch.push(item);}
const receipts=[];
let cursor=0,done=0;
try{
  async function worker(){
    while(cursor<batches.length){
      const index=cursor++,batch=batches[index];
      let translated;
      for(let attempt=0;attempt<3&&!translated;attempt++){
        const generationId=randomUUID(),conversationId=randomUUID();
        const prompt='Translate the following GeoD desktop UI strings from Simplified Chinese into concise, natural English. This is a software localization task; do not call tools. Return ONLY a JSON array of strings in exactly the same order, no explanation or markdown. Preserve every numbered placeholder such as {0}, file extension, ID, API name and variable. Do not add placeholders. Use imagery for 影像, source for 图源, workspace for 工作区, tiles for 瓦片.\n'+JSON.stringify(batch.map(item=>item.text));
        const generation=await page.evaluate(async({generationId,conversationId,prompt})=>window.__TAURI_INTERNALS__.invoke('agent_generate',{generationId,conversationId,messages:[{role:'user',content:prompt}]}),{generationId,conversationId,prompt});
        receipts.push({generationId,state:generation.state,model:generation.model,inputTokens:generation.inputTokens,outputTokens:generation.outputTokens});
        const content=generation.result?.content;
        try{
          const value=JSON.parse(String(content).replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,''));
          if(!Array.isArray(value)||value.length!==batch.length||value.some(v=>typeof v!=='string'||!v.trim()))throw new Error('Translation count or type mismatch');
          value.forEach((value,i)=>{const tokens=text=>[...text.matchAll(/\{\d+\}/g)].map(match=>match[0]).sort().join('|');if(tokens(value)!==tokens(batch[i].text))throw new Error('Placeholder mismatch');});
          translated=value;
        }catch(error){console.log(JSON.stringify({batch:index,attempt,error:error.message,state:generation.state,errorCode:generation.errorCode,contentType:typeof content,contentPreview:String(content).slice(0,180)}));if(attempt===2)throw error;}
      }
      batch.forEach((item,i)=>catalogue[item.text]=translated[i]);
      fs.writeFileSync(cataloguePath,JSON.stringify(Object.fromEntries(Object.entries(catalogue).sort(([a],[b])=>a.localeCompare(b))),null,2)+'\n');
      done++;console.log(JSON.stringify({completed:done,total:batches.length,entries:Object.keys(catalogue).length}));
      fs.writeFileSync('artifacts/product-gaps-20261004/catalogue-generation.json',JSON.stringify({complete:done===batches.length,receipts,entries:Object.keys(catalogue).length},null,2));
    }
  }
  await Promise.all([worker(),worker()]);
}finally{await browser.close();}
