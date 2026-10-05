import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {runJsonProcess} from './schedule-rpc-process.mjs';

test('native RPC child can await the identity server hosted by its controller',async()=>{
  let requests=0;
  const server=createServer((request,response)=>{requests++;response.setHeader('content-type','application/json');response.end(JSON.stringify({renewed:true}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const childCode='import json,sys,urllib.request; value=json.load(sys.stdin); opener=urllib.request.build_opener(urllib.request.ProxyHandler({})); print(opener.open(value["url"],timeout=2).read().decode())';
    const result=await runJsonProcess('python',['-X','utf8','-c',childCode],{url:`http://127.0.0.1:${server.address().port}/renew`});
    assert.deepEqual(result,{renewed:true});assert.equal(requests,1);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('failed or malformed native helpers cannot be recorded as successful',async()=>{
  await assert.rejects(runJsonProcess('python',['-c','import sys; sys.stderr.write("fixture failure"); sys.exit(3)'],{}),/fixture failure/);
  await assert.rejects(runJsonProcess('python',['-c','print("not json")'],{}),SyntaxError);
});

test('hung native helpers are bounded',async()=>{
  await assert.rejects(runJsonProcess('python',['-c','import time; time.sleep(10)'],{},{timeoutMs:300}),/timed out/);
});
