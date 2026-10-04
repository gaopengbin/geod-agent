import test from 'node:test';
import assert from 'node:assert/strict';
import { arcgisMetadataUrl, thumbnailTile, thumbnailImageUrl } from '../src/source-thumbnail-plan.ts';

test('ArcGIS endpoints use the service metadata; ordinary tile services do not',()=>{
  assert.equal(arcgisMetadataUrl('https://example.com/a/ImageServer/exportImage'),'https://example.com/a/ImageServer');
  assert.equal(arcgisMetadataUrl('https://example.com/a/MapServer/tile/{z}/{y}/{x}'),'https://example.com/a/MapServer');
  assert.equal(arcgisMetadataUrl('https://example.com/{z}/{x}/{y}.png'),null);
  assert.equal(arcgisMetadataUrl('https://example.com/a/ImageServer?token=secret'),null);
});
test('regional coverage chooses a sample inside its extent and allowed levels',()=>{
  const tile=thumbnailTile(10,18,{extent:{xmin:-125,ymin:25,xmax:-66,ymax:50,spatialReference:{wkid:4326}}});
  assert.equal(tile.longitude,-95.5);assert.equal(tile.latitude,37.5);assert.equal(tile.z,10);assert.equal(tile.fromExtent,true);
  assert.ok(tile.x>=0&&tile.x<2**tile.z&&tile.y>=0&&tile.y<2**tile.z);
});
test('Web Mercator metadata aliases convert to geographic positions',()=>{
  const r=6378137,rad=Math.PI/180;
  const tile=thumbnailTile(0,22,{extent:{xmin:100*r*rad,xmax:110*r*rad,ymin:r*Math.asinh(Math.tan(30*rad)),ymax:r*Math.asinh(Math.tan(40*rad)),spatialReference:{wkid:102100}}});
  assert.ok(Math.abs(tile.longitude-105)<1e-8);assert.ok(Math.abs(tile.latitude-35)<1e-8);assert.equal(tile.fromExtent,true);
});
test('world extents and missing metadata keep a land sample, while levels stay bounded',()=>{
  const world=thumbnailTile(0,3,{extent:{xmin:-180,ymin:-85,xmax:180,ymax:85,spatialReference:{wkid:4326}}});
  assert.equal(world.longitude,108);assert.equal(world.latitude,35);assert.equal(world.z,3);
  assert.equal(thumbnailTile(20,22).z,20);
  assert.equal(thumbnailTile(0,18,{extent:{xmin:0,ymin:0,xmax:1000,ymax:1000,spatialReference:{wkid:9999}}}).fromExtent,false);
});
test('invalid levels fail before generating an out of range request',()=>{
  for(const levels of [[-1,18],[12,11],[0,23],[0.5,18]])assert.throws(()=>thumbnailTile(...levels));
});
test('an actual raster footprint takes priority over a broad service extent',()=>{
  const tile=thumbnailTile(10,18,{extent:{xmin:-180,ymin:-15,xmax:180,ymax:72},thumbnailExtent:{xmin:-100.1,ymin:35,xmax:-100,ymax:35.1,spatialReference:{wkid:4326}}});
  assert.equal(tile.longitude,-100.05);assert.equal(tile.latitude,35.05);assert.equal(tile.z,12);
});
test('only validated native PNG or JPEG data is presented as an image',()=>{
  assert.ok(thumbnailImageUrl('iVBORw0KGgoAAA').startsWith('data:image/png;'));
  assert.ok(thumbnailImageUrl('/9j/AA').startsWith('data:image/jpeg;'));
  assert.throws(()=>thumbnailImageUrl('error-page'));
});
