"""Optional GIS runtime for explicit export CRS; never changes the source CRS label."""
import json
import math
import os
import re
import sys
from contextlib import ExitStack
from pathlib import Path

def target_crs(value, raster=False):
    if raster:
        from rasterio.crs import CRS
        crs = CRS.from_string(value)
        wkt = crs.to_wkt(version="WKT2_2019")
        axes = re.search(r"CS\s*\[\s*\w+\s*,\s*(\d+)", wkt)
        if not axes or axes.group(1) != "2" or wkt.startswith("COMPOUNDCRS"):
            raise ValueError("请选择二维地理或投影坐标系")
    else:
        from pyproj import CRS
        crs = CRS.from_user_input(value)
    if not (crs.is_geographic or crs.is_projected) or (not raster and len(crs.axis_info) != 2):
        raise ValueError("请选择二维地理或投影坐标系")
    return crs

def run(request):
    target = target_crs(request["targetCrs"], request.get("raster", not request.get("validateOnly") and request.get("kind") != "vector"))
    if request.get("validateOnly"):
        return {"crs": target.to_string(), "name": getattr(target,"name",None)}
    if request.get("kind") == "vector":
        import pyogrio
        path=Path(request["path"])
        temporary=path.with_name(path.name+".projected.gpkg")
        try:
            frame=pyogrio.read_dataframe(path,layer="features")
            if str(frame.crs)!="EPSG:4326": raise ValueError("矢量源坐标系与下载计划不一致")
            projected=frame.to_crs(target)
            if any(g is not None and not g.is_empty and not all(math.isfinite(v) for v in g.bounds) for g in projected.geometry):
                raise ValueError("投影不适用于当前范围")
            pyogrio.write_dataframe(projected,temporary,driver="GPKG",layer="features")
            check=pyogrio.read_dataframe(temporary,layer="features")
            if len(check)!=len(projected) or check.crs!=projected.crs or list(check.columns)!=list(projected.columns):
                raise ValueError("矢量转换后的坐标系、字段或数量核验失败")
            if not projected.drop(columns=projected.geometry.name).equals(check.drop(columns=check.geometry.name)):
                raise ValueError("矢量转换后的属性值核验失败")
            for a,b in zip(projected.geometry,check.geometry):
                if (a is None)!=(b is None) or (a is not None and not a.equals_exact(b,1e-8)):
                    raise ValueError("矢量转换后的几何核验失败")
            os.replace(temporary,path)
            return {"crs":target.to_string(),"count":len(check)}
        finally: temporary.unlink(missing_ok=True)
    import rasterio
    from rasterio.enums import Resampling, ColorInterp
    from rasterio.transform import from_bounds
    from rasterio.warp import calculate_default_transform, reproject, transform_bounds
    from rasterio.shutil import copy as raster_copy
    from rasterio.vrt import WarpedVRT
    path = Path(request["path"])
    temporary = path.with_name(path.name + ".projected.tif")
    converted = path.with_name(path.name + ".projected" + path.suffix)
    options = request["options"]
    try:
        with rasterio.Env(GDAL_CACHEMAX=64*1024*1024, PROJ_NETWORK="OFF"), ExitStack() as stack:
            src = stack.enter_context(rasterio.open(path))
            source_crs = src.crs
            source_transform = src.transform
            if path.suffix.lower() != ".tif":
                source_crs = rasterio.crs.CRS.from_epsg(3857)
                box = transform_bounds("EPSG:4326", source_crs, *request["bounds"], densify_pts=21)
                source_transform = from_bounds(*box, src.width, src.height)
                # A plain PNG/JPEG has no dataset georeferencing. Attach the native
                # download grid in a bounded virtual dataset before warping bands.
                src = stack.enter_context(WarpedVRT(src, src_crs=source_crs, src_transform=source_transform,
                    crs=source_crs, transform=source_transform, width=src.width, height=src.height))
            elif source_crs != rasterio.crs.CRS.from_epsg(3857):
                raise ValueError("下载成果的源坐标系与计划不一致")
            bounds = rasterio.transform.array_bounds(src.height, src.width, source_transform)
            affine, width, height = calculate_default_transform(source_crs, target.to_wkt(), src.width, src.height, *bounds)
            if width <= 0 or height <= 0 or width*height > max(src.width*src.height*8, 1048576):
                raise ValueError("目标坐标系产生过大的输出网格，请检查投影带或范围")
            if not all(math.isfinite(v) for v in affine):
                raise ValueError("无法转换到指定坐标系，请检查范围和投影带")
            profile = src.profile.copy()
            for key in ("compress", "predictor", "photometric", "interleave", "blockxsize", "blockysize"):
                profile.pop(key, None)
            profile.update(driver="GTiff", crs=target.to_wkt(), transform=affine, width=width, height=height,
                           tiled=True, blockxsize=256, blockysize=256, BIGTIFF="IF_SAFER")
            compression = options.get("compression", "none")
            if compression != "none": profile["compress"] = compression
            with rasterio.open(temporary, "w", **profile) as dst:
                # Dataset bands keep GDAL's warp memory bounded and alpha/NoData intact.
                alpha = next((i+1 for i,c in enumerate(src.colorinterp) if c == ColorInterp.alpha), 0)
                reproject(source=rasterio.band(src, list(src.indexes)), destination=rasterio.band(dst, list(dst.indexes)),
                          src_transform=source_transform, src_crs=source_crs, dst_transform=affine, dst_crs=target.to_wkt(),
                          src_nodata=src.nodata, dst_nodata=src.nodata, src_alpha=alpha, dst_alpha=alpha,
                          resampling=Resampling[options.get("resampling", "nearest")], warp_mem_limit=64, num_threads=2)
                dst.colorinterp = src.colorinterp
                if options.get("buildPyramid") and path.suffix.lower()==".tif":
                    levels=[n for n in (2,4,8,16) if width//n>=1 and height//n>=1]
                    dst.build_overviews(levels, Resampling.nearest)
            with rasterio.open(temporary) as check:
                if check.crs != rasterio.crs.CRS.from_wkt(target.to_wkt()) or check.shape != (height,width) or check.count != src.count or check.nodata != src.nodata:
                    raise ValueError("转换后的坐标系、尺寸、波段或 NoData 核验失败")
                for _, window in check.block_windows(1): check.read(window=window)
        if path.suffix.lower()==".tif":
            os.replace(temporary, path)
        else:
            raster_copy(temporary, converted, driver="PNG" if path.suffix.lower()==".png" else "JPEG", **({"QUALITY":options.get("jpegQuality",90)} if path.suffix.lower()!=".png" else {}))
            os.replace(converted, path)
            # Georeferencing for images lives in the requested sidecars, not PAM.
            for aux in (Path(str(converted)+".aux.xml"),Path(str(path)+".aux.xml")):
                aux.unlink(missing_ok=True)
        if options.get("generateSidecars") or path.suffix.lower()!=".tif":
            extension={".tif":".tfw",".png":".pgw",".jpg":".jgw"}[path.suffix.lower()]
            path.with_suffix(extension).write_text("\n".join(str(v) for v in (affine.a,affine.d,affine.b,affine.e,affine.c+affine.a/2,affine.f+affine.e/2))+"\n",encoding="utf-8")
            path.with_suffix(".prj").write_text(target.to_wkt(),encoding="utf-8")
        return {"width":width,"height":height,"geoTransform":list(affine)[:6],"crsDefinition":target.to_wkt()}
    finally:
        temporary.unlink(missing_ok=True); converted.unlink(missing_ok=True)

if __name__ == "__main__":
    try: result=run(json.load(sys.stdin))
    except Exception as error: result={"error":str(error)}
    print(json.dumps(result,ensure_ascii=False,allow_nan=False))
