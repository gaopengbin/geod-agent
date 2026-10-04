import assert from "node:assert/strict";
import test from "node:test";
import { readMapSession, saveMapSession } from "../src/map-session.ts";

test("map commands and view stay in their originating conversation", () => {
  const values = new Map();
  const storage = { getItem:key => values.get(key) ?? null, setItem:(key,value) => values.set(key,value) };
  const first = {commands:[{name:"loadSource",args:{sourceId:"esri-world-imagery"}}],view:{center:[117.2,39.1],zoom:10,rotation:0}};
  saveMapSession(storage,"first",first);
  assert.deepEqual(readMapSession(storage,"first"),first);
  assert.deepEqual(readMapSession(storage,"second"),{commands:[]});
  saveMapSession(storage,"second",{commands:[{name:"addVectorLayer",args:{id:"second-layer"}}]});
  assert.deepEqual(readMapSession(storage,"first"),first);
  values.set("geod-map-session-1:broken","not-json");
  assert.deepEqual(readMapSession(storage,"broken"),{commands:[]});
});
