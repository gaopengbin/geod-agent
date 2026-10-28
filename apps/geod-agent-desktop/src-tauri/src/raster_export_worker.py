"""Local numeric TIFF processing only. HTTP and task authorization stay native."""
import sys,json,hashlib,math
from pathlib import Path
def digest(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def main(v):
    import numpy as np
    import rasterio
    from rasterio.crs import CRS
    from rasterio.warp import calculate_default_transform,reproject,transform_geom,Resampling
    from rasterio.io import MemoryFile
    from rasterio.mask import mask
    root=Path(v['directory']).resolve();source=Path(v['inputPath']).resolve()
    if source.parent!=root or root.parent!=Path(v['expectedParent']):raise ValueError('原始栅格输入不在本次任务暂存目录')
    dtype='float32' if v['pixelType']=='F32' else 'float64';target=root/'raster.tif'
    with rasterio.open(source) as data:
        if (data.width,data.height)!=(v['expectedWidth'],v['expectedHeight']) or data.width*data.height*data.count>16000000:raise ValueError('提供方 TIFF 的像元尺寸与已确认的导出网格不一致')
        if data.count!=v['expectedBands'] or any(t!=dtype for t in data.dtypes):raise ValueError('提供方 TIFF 不是已确认的原始浮点波段，未用 RGB 代替')
        if data.crs!=CRS.from_string(v['sourceCrs']):raise ValueError('提供方 TIFF 的实际源坐标系与冻结的导出请求不符')
        transform,width,height=calculate_default_transform(data.crs,v['targetCrs'],data.width,data.height,*data.bounds)
        if width*height*data.count>16000000:raise ValueError('目标坐标网格超出单次处理容量，请拆分范围后继续')
        pixels=np.full((data.count,height,width),np.nan,dtype=dtype)
        for band in range(data.count):
            reproject(rasterio.band(data,band+1),pixels[band],src_transform=data.transform,src_crs=data.crs,src_nodata=data.nodatavals[band],dst_transform=transform,dst_crs=v['targetCrs'],dst_nodata=np.nan,resampling=Resampling.nearest)
        units=data.units
    profile={'driver':'GTiff','crs':v['targetCrs'],'transform':transform,'width':width,'height':height,'count':pixels.shape[0],'dtype':dtype,'nodata':np.nan,'tiled':True,'compress':'NONE','BIGTIFF':'IF_SAFER'}
    if v.get('boundary'):
        geometry=transform_geom('EPSG:4326',v['targetCrs'],{'type':'MultiPolygon','coordinates':v['boundary']['polygons']})
        with MemoryFile() as memory:
            with memory.open(**profile) as temporary:temporary.write(pixels)
            with memory.open() as temporary:pixels,transform=mask(temporary,[geometry],crop=True,nodata=np.nan)
        profile.update(transform=transform,width=pixels.shape[2],height=pixels.shape[1])
    with rasterio.open(target,'w',**profile) as result:result.write(pixels)
    stats=[]
    with rasterio.open(target) as result:
        if result.crs!=CRS.from_string(v['targetCrs']):raise ValueError('栅格实际坐标系与已确认计划不同')
        for i in range(result.count):
            values=result.read(i+1,masked=True).compressed();values=values[np.isfinite(values)]
            if not values.size:raise ValueError('提供方没有返回可核实的有效数值像元')
            stats.append({'band':i+1,'dataType':'Float32' if dtype=='float32' else 'Float64','min':float(values.min()),'max':float(values.max()),'mean':float(values.astype('float64').mean()),'validPixels':int(values.size),'noDataPixels':result.width*result.height-int(values.size),'noDataCountIncludesOutsideBoundary':bool(v.get('boundary')),'statisticsScope':'finite valid values only; NaN/NoData excluded','noData':'NaN','unit':units[i] or None})
        width,height=result.width,result.height;geo_transform=list(result.transform.to_gdal())
        preview_width=min(1024,width);preview_height=max(1,round(height*preview_width/width))
        visible=result.read(1,out_shape=(preview_height,preview_width),resampling=Resampling.nearest)
        low,high=stats[0]['min'],max(stats[0]['max'],stats[0]['min']+1e-12)
        visible=np.clip(np.nan_to_num((visible-low)/(high-low)*255,nan=0),0,255).astype('uint8')
    # The PNG is explicitly a stretched visualization; the Float TIFF remains
    # untouched by this separate preview operation.
    preview=root/'preview.png'
    with rasterio.open(preview,'w',driver='PNG',width=preview_width,height=preview_height,count=1,dtype='uint8') as image:image.write(visible,1)
    assets=[{'kind':kind,'path':p.name,'size':p.stat().st_size,'sha256':digest(p)} for kind,p in [('geotiff',target),('preview',preview)]]
    return {'outputCrs':v['targetCrs'],'width':width,'height':height,'geoTransform':geo_transform,'bandCount':len(stats),'bands':stats,'numericValuesPreserved':True,'resampling':'nearest','clientRadiometricStretchApplied':False,'previewMeaning':'separate display stretch; not numeric radiance','assets':assets,'quality':{'status':'complete','sourceDataQuality':'provider-supplied values and NoData; not an assertion of cloud-free observation'},'warnings':[]}
try:
    request=json.load(sys.stdin)
    print(json.dumps(main(request),ensure_ascii=False,allow_nan=False))
except Exception as e:
    try:
        root=Path(request['directory']).resolve()
        if root.parent==Path(request['expectedParent']):
            (root/'processing-diagnostic.json').write_text(json.dumps({'type':type(e).__name__,'detail':str(e)},ensure_ascii=False,indent=2),encoding='utf-8')
    except Exception:pass
    message=str(e) if isinstance(e,ValueError) else '原始下载已保留，内置栅格处理未通过；请打开任务诊断，修复原因后重试原任务。'
    print(json.dumps({'error':message[:400]},ensure_ascii=False))
