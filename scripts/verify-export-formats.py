"""Independent GDAL/rasterio readback of real-source acceptance files."""
from pathlib import Path
import sys, json, sqlite3
import numpy as np
import rasterio
from PIL import Image

root = Path(sys.argv[1]).resolve()
report = []
for path in sorted(root.glob('imagery-z*.tif')):
    with rasterio.open(path) as src:
        assert src.crs.to_epsg() == 3857
        pixels = src.read()
        assert src.count == 4 and src.dtypes == ('uint8',)*4
        if max(src.width,src.height) > 256:
            assert src.overviews(1), 'GDAL did not detect internal overviews'
        png = np.array(Image.open(path.with_suffix('.png')))
        assert np.array_equal(pixels.transpose(1,2,0), png)
        jpeg = np.array(Image.open(path.with_suffix('.jpg')))
        assert jpeg.shape == png[:,:,:3].shape
        assert float(np.abs(jpeg.astype(float)-png[:,:,:3].astype(float)).mean()) < 15
        report.append({'file':path.name,'crs':str(src.crs),'size':[src.width,src.height],'overviews':src.overviews(1),'pngPixelsEqual':True})
with rasterio.open(root/'imagery.gpkg') as gpkg:
    assert gpkg.crs.to_epsg() == 3857
    assert gpkg.read(1,out_shape=(32,32)).max() > 0
    report.append({'file':'imagery.gpkg','crs':str(gpkg.crs),'size':[gpkg.width,gpkg.height]})
for name in ['imagery.gpkg','imagery.mbtiles','tiles-index.sqlite']:
    with sqlite3.connect(root/name) as db:
        assert db.execute('pragma integrity_check').fetchone()[0] == 'ok'
print(json.dumps(report,ensure_ascii=False))
(root/'gdal-readback.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
