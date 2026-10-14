import React from 'react';import {createRoot} from 'react-dom/client';
import {ImageryNetworkFailure} from '../src/imagery-network-failure';import {api,type StoredPlan} from '../src/api';
import {rasterPreset} from '../src/source-presets';
import '../src/styles.css';import '../src/theme.css';
const stored={planId:'qa-changping-network',plan:{spec:{sourceId:'qa-unsaved-esri'},tileGrids:[{zoom:15,xMin:26983,xMax:26983,yMin:12375,yMax:12375}]}} as StoredPlan;
// Read-only adapter for an unsaved connection, so the fixture cannot alter the user's registry.
const original=api.sourcePreviewTile;
Object.assign(window,{networkQa:{calls:[],networkOpened:false},api});
api.mapPreviewTile=async(sourceId,_url,z,x,y)=>{(window as any).networkQa.calls.push({sourceId,z,x,y});return original(rasterPreset('esri-world-imagery').source,z,x,y);};
createRoot(document.getElementById('root')!).render(<main style={{padding:24,width:360}}><h2>昌平影像 · 连接验证</h2><ImageryNetworkFailure stored={stored} onOpenNetwork={()=>{(window as any).networkQa.networkOpened=true;}}/></main>);
