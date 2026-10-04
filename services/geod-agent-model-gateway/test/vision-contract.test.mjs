import test from 'node:test';
import assert from 'node:assert/strict';
import {codexRequest} from '../../../packages/codex-protocol/codex-contract.mjs';
test('Responses image bytes stay separate from text and cannot become remote fetch URLs',()=>{
 const url='data:image/png;base64,iVBORw0KGgo=';
 const result=codexRequest({input:[{role:'user',content:[{type:'input_text',text:'Read the image'},{type:'input_image',image_url:url,detail:'original'}]}]});
 assert.deepEqual(result.messages[0].content,[{type:'text',text:'Read the image'},{type:'image_url',image_url:{url,detail:'original'}}]);
 assert.equal(result.hasImages,true);
 for(const bad of ['file:///C:/secret.png','http://127.0.0.1/private','data:image/svg+xml;base64,abcd'])assert.throws(()=>codexRequest({input:[{role:'user',content:[{type:'input_image',image_url:bad}]}]}),/CODEX_IMAGE_INVALID/);
 assert.throws(()=>codexRequest({input:[{role:'system',content:[{type:'input_image',image_url:url}]}]}),/CODEX_IMAGE_ROLE_UNSUPPORTED/);
});
