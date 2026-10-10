import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceArrangement, fitPanelWidths, resizePanelWidths } from '../src/workspace-layout.ts';
for (const width of [390,800,900,960,1120,1280,1440,1920]) {
  test(`workspace at ${width}px preserves usable panels and fits exactly`,()=>{
    const a=workspaceArrangement('tasks',width);
    const fitted=fitPanelWidths(a.defaults,width,a.minimums);
    assert.ok(Math.abs(fitted.reduce((sum,n)=>sum+n,0)-width)<.1);
    assert.ok(fitted.every((n,i)=>n>=a.minimums[i]));
    assert.equal(fitted.length,width>=1120?4:width<900?2:3);
    if(width<1120)assert.equal(fitted[0],64);
  });
}
test('expanding tasks borrows space from map then conversation then navigation', () => {
  const initial = [224, 480, 400, 336], minimums = [180, 340, 240, 300];
  const next = resizePanelWidths(initial, minimums, 2, -500);
  assert.deepEqual(next, [180, 340, 240, 680]);
  assert.equal(next.reduce((a,b)=>a+b,0), 1440);
  assert.deepEqual(initial, [224,480,400,336]);
});
test('every divider keeps total width and all minimums, even at extreme deltas', () => {
  for (const width of [1120,1280,1440,1920]) {
    const a=workspaceArrangement('tasks',width);
    const initial=fitPanelWidths(a.defaults,width,a.minimums);
    for(let index=0;index<3;index++)for(const delta of [-10000,-80,0,80,10000]) {
      const next=resizePanelWidths(initial,a.minimums,index,delta);
      assert.ok(Math.abs(next.reduce((x,y)=>x+y,0)-width)<.001);
      assert.ok(next.every((n,i)=>n>=a.minimums[i]-.001));
    }
  }
});
test('saved widths survive resizing without changing the selected arrangement',()=>{
  const a=workspaceArrangement('tasks',1440);
  const fitted=fitPanelWidths([200,520,400,320],1600,a.minimums);
  assert.equal(fitted.reduce((sum,n)=>sum+n,0),1600);
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
