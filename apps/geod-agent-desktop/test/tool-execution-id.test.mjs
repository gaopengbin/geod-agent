import test from 'node:test';import assert from 'node:assert/strict';
import {nativeToolExecutionId} from '../src/tool-execution-id.ts';
test('a host operation keeps native planning identity across model call IDs; legacy callers stay distinct',()=>{
 const id='runtime-operation:27f9e8a9-1638-4572-a543-a2931517ca3b';
 assert.equal(nativeToolExecutionId(id,'call-a'),nativeToolExecutionId(id,'call-b'));
 assert.notEqual(nativeToolExecutionId('generation','call-a'),nativeToolExecutionId('generation','call-b'));
});
