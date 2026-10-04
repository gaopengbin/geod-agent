"""Independent GDAL readback plus real source-pixel coordinate verification.

The analytic GCJ-02 forward equations follow coordtransform (MIT); this is an
independent Python acceptance calculation, not the Rust download implementation.
"""
import io
import json
import math
import sqlite3
import sys
import urllib.request
from functools import lru_cache
from pathlib import Path
import numpy as np
import rasterio
from PIL import Image

root = Path(sys.argv[1]).resolve()
pi = math.pi

def gcj(lon, lat):
    x, y = lon - 105, lat - 35
    a, ee = 6378245.0, 0.006693421622965943
    dy = -100 + 2*x + 3*y + .2*y*y + .1*x*y + .2*math.sqrt(abs(x))
    dy += (20*math.sin(6*x*pi)+20*math.sin(2*x*pi))*2/3
    dy += (20*math.sin(y*pi)+40*math.sin(y*pi/3))*2/3
    dy += (160*math.sin(y*pi/12)+320*math.sin(y*pi/30))*2/3
    dx = 300 + x + 2*y + .1*x*x + .1*x*y + .1*math.sqrt(abs(x))
    dx += (20*math.sin(6*x*pi)+20*math.sin(2*x*pi))*2/3
    dx += (20*math.sin(x*pi)+40*math.sin(x*pi/3))*2/3
    dx += (150*math.sin(x*pi/12)+300*math.sin(x*pi/30))*2/3
    rad = lat*pi/180
    magic = 1-ee*math.sin(rad)**2
    return lon+dx*180/(a/math.sqrt(magic)*math.cos(rad)*pi), lat+dy*180/(a*(1-ee)/magic**1.5*pi)

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
@lru_cache(64)
def tile(x, y):
    url = f'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z=17'
    with opener.open(url, timeout=20) as response:
        image = np.asarray(Image.open(io.BytesIO(response.read())).convert('RGBA'))
    assert image.shape == (256, 256, 4)
    return image

def pixel(px, py):
    ix, iy = math.floor(px), math.floor(py)
    fx, fy = px-ix, py-iy
    result = np.zeros(4)
    for dx, dy, weight in [(0,0,(1-fx)*(1-fy)),(1,0,fx*(1-fy)),(0,1,(1-fx)*fy),(1,1,fx*fy)]:
        x, y = ix+dx, iy+dy
        result += tile(x//256, y//256)[y%256, x%256]*weight
    return np.floor(result+.5).astype(np.uint8)

with rasterio.open(root/'imagery-z17.tif') as ds:
    assert ds.crs.to_epsg() == 3857
    data = ds.read().transpose(1,2,0)
    assert np.array_equal(data, np.asarray(Image.open(root/'imagery-z17.png')))
    n = 256*2**17
    checks = []
    for row, col in [(30,30),(30,ds.width//2),(30,ds.width-31),(ds.height//2,30),(ds.height//2,ds.width//2),(ds.height//2,ds.width-31),(ds.height-31,30),(ds.height-31,ds.width//2),(ds.height-31,ds.width-31)]:
        mx, my = ds.xy(row, col)
        lon = mx/6378137*180/pi
        lat = math.atan(math.sinh(my/6378137))*180/pi
        gx, gy = gcj(lon, lat)
        px = (gx+180)/360*n-.5
        py = (1-math.asinh(math.tan(gy*pi/180))/pi)/2*n-.5
        expected = pixel(px, py)
        actual = data[row,col]
        delta = np.abs(actual.astype(int)-expected.astype(int)).max()
        assert delta <= 1, (row,col,actual,expected)
        checks.append({'row':row,'col':col,'wgs84':[lon,lat],'gcj02':[gx,gy],'maxChannelDifference':int(delta)})
    with sqlite3.connect(root/'imagery.mbtiles') as conn:
        assert conn.execute('pragma integrity_check').fetchone()[0]=='ok'
        zoom, tx, ty, blob = conn.execute('select zoom_level,tile_column,tile_row,tile_data from tiles limit 1').fetchone()
        assert zoom==17
        downloaded = np.asarray(Image.open(io.BytesIO(blob)).convert('RGBA'))
        # MBTiles and GeoTIFF use the same corrected WGS84 tile grid.
        y = (2**zoom-1-ty)*256+100+.5
        x = tx*256+100+.5
        lon = x/n*360-180
        lat = math.atan(math.sinh(pi*(1-2*y/n)))*180/pi
        gx,gy = gcj(lon,lat)
        expected = pixel((gx+180)/360*n-.5,(1-math.asinh(math.tan(gy*pi/180))/pi)/2*n-.5)
        assert np.abs(downloaded[100,100].astype(int)-expected.astype(int)).max()<=1
    report={'pass':True,'artifact':str(root),'crs':str(ds.crs),'size':[ds.width,ds.height],'pngExact':True,'coordinateChecks':checks,'mbtilesCorrected':True,'sourceTilesIndependentlyRead':tile.cache_info().currsize}
path = Path(__file__).resolve().parents[1]/'docs/implementation/evidence/gcj-source-export-2026-10-02.json'
path.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))
