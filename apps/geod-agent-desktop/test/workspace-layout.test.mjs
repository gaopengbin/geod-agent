import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationMinWidth, workspaceArrangement, fitPanelWidths, resizePanelWidths } from '../src/workspace-layout.ts';
for (const width of [390,800,900,960,1083,1084,1119,1120,1243,1244,1280,1440,1920]) {
  test(`workspace at ${width}px preserves usable panels and fits exactly`,()=>{
    const a=workspaceArrangement('tasks',width);
    const fitted=fitPanelWidths(a.defaults,width,a.minimums);
    assert.ok(Math.abs(fitted.reduce((sum,n)=>sum+n,0)-width)<.1);
    assert.ok(fitted.every((n,i)=>n>=a.minimums[i]));
    const separateTasks = width >= (a.rail ? 64 : 224) + conversationMinWidth + 240 + 300;
    assert.equal(fitted.length,width<900?2:separateTasks?4:3);
    assert.equal(a.tasksOverlay,width>=900&&!separateTasks);
    if(width<1120)assert.equal(fitted[0],64);
  });
}
test('expanding tasks borrows available space without squeezing the conversation', () => {
  const initial = [224, 480, 400, 336], { minimums } = workspaceArrangement('tasks',1440);
  const next = resizePanelWidths(initial, minimums, 2, -500);
  assert.deepEqual(next, [180, 480, 240, 540]);
  assert.equal(next.reduce((a,b)=>a+b,0), 1440);
  assert.deepEqual(initial, [224,480,400,336]);
});
test('every divider keeps total width and all minimums, even at extreme deltas', () => {
  for (const width of [900,1083,1084,1120,1243,1244,1280,1440,1920]) {
    const a=workspaceArrangement('tasks',width);
    const initial=fitPanelWidths(a.defaults,width,a.minimums);
    for(let index=0;index<initial.length-1;index++)for(const delta of [-10000,-80,0,80,10000]) {
      const next=resizePanelWidths(initial,a.minimums,index,delta);
      assert.ok(Math.abs(next.reduce((x,y)=>x+y,0)-width)<.001);
      assert.ok(next.every((n,i)=>n>=a.minimums[i]-.001));
      assert.ok(next[1]>=conversationMinWidth);
      // Pointer painting and the committed/saved layout use the same bounds.
      assert.deepEqual(fitPanelWidths(next,width,a.minimums),next);
    }
  }
});
test('saved widths survive resizing without changing the selected arrangement',()=>{
  const a=workspaceArrangement('tasks',1440);
  const fitted=fitPanelWidths([200,520,400,320],1600,a.minimums);
  assert.ok(Math.abs(fitted.reduce((sum,n)=>sum+n,0)-1600)<.001);
  assert.ok(fitted[1]>520);
  assert.ok(fitted[2]>=240);
});
test('an old saved preference cannot bypass new readable panel minimums',()=>{
  const a=workspaceArrangement('tasks',1440);
  const fitted=fitPanelWidths([100,280,740,320],1440,a.minimums);
  assert.ok(fitted.every((n,i)=>n>=a.minimums[i]));
  assert.ok(Math.abs(fitted.reduce((sum,n)=>sum+n,0)-1440)<.1);
});
for (const width of [390,960,1280,1440,1920]) {
  test(`collapsing navigation at ${width}px reclaims space without shrinking content below its minimum`,()=>{
    const expanded=workspaceArrangement('tasks',width);
    const collapsed=workspaceArrangement('tasks',width,true);
    const fitted=fitPanelWidths(collapsed.defaults,width,collapsed.minimums);
    assert.equal(fitted[0],64);
    assert.ok(fitted.every((n,i)=>n>=collapsed.minimums[i]));
    assert.ok(Math.abs(fitted.reduce((sum,n)=>sum+n,0)-width)<.1);
    if(width>=1120){assert.notEqual(collapsed.key,expanded.key);assert.ok(fitted[2]>expanded.defaults[2]);}
  });
}
test('inspector overlays the map before an expanded sidebar would squeeze chat',()=>{
  assert.equal(workspaceArrangement('tasks',1243).tasksOverlay,true);
  assert.equal(workspaceArrangement('tasks',1244).tasksOverlay,false);
  assert.equal(workspaceArrangement('tasks',1120,true).tasksOverlay,false);
  for(const mode of ['focus','map','tasks'])for(const width of [900,1120,1440]) {
    assert.equal(workspaceArrangement(mode,width).minimums[1],conversationMinWidth);
  }
});
