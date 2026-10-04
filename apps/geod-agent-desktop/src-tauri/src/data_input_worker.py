"""Normalize user selected vector data. One JSON request/result on stdio.

Run with the same pinned GDAL environment as the connector. Database access
is provided separately by the builtin standard pgEdge MCP runtime.
"""
import csv
import io
import json
import os
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

import geopandas as gpd
import pyogrio
from shapely import from_wkt
from shapely.geometry import mapping, shape

MAX_BYTES = 32 * 1024 * 1024
MAX_FEATURES = 10000


class InputError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


def normalize(geometries, crs):
    if not crs:
        raise InputError("INPUT_CRS_REQUIRED", "数据未声明坐标系，请填写源 EPSG 编号后读取。")
    if not geometries:
        raise InputError("INPUT_EMPTY", "选中的图层没有几何数据。")
    if len(geometries) > MAX_FEATURES:
        raise InputError("INPUT_TOO_LARGE", "要素超过 10,000 个，请筛选较小的范围。")
    if any(g is None or g.is_empty or g.geom_type not in ("Polygon", "MultiPolygon") for g in geometries):
        raise InputError("INPUT_NOT_POLYGON", "裁剪范围需要 Polygon / MultiPolygon；点和线不能直接作为裁剪边界。")
    series = gpd.GeoSeries(geometries, crs=crs).to_crs("EPSG:4326")
    if not series.is_valid.all():
        raise InputError("INPUT_INVALID_GEOMETRY", "存在无效面几何，请修复后导入，原数据未被修改。")
    value = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {}, "geometry": mapping(g)} for g in series
    ]}
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > 8 * 1024 * 1024:
        raise InputError("INPUT_TOO_LARGE", "转换后的边界超过 8 MiB，请缩小输入范围。")
    return value


def unpack(path):
    if path.suffix.lower() not in (".zip", ".kmz"):
        return [path]
    folder = path.parent / (path.stem + "-unpacked")
    folder.mkdir(exist_ok=True)
    total = 0
    files = []
    with zipfile.ZipFile(path) as archive:
        if len(archive.infolist()) > 128:
            raise InputError("INPUT_ARCHIVE_INVALID", "压缩包文件过多。")
        for item in archive.infolist():
            parts = Path(item.filename.replace("\\", "/"))
            if parts.is_absolute() or ".." in parts.parts or ":" in item.filename or (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise InputError("INPUT_ARCHIVE_INVALID", "压缩包包含不安全的路径。")
            total += item.file_size
            if total > MAX_BYTES:
                raise InputError("INPUT_TOO_LARGE", "压缩包展开后超过 32 MiB。")
            target = folder / parts
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(item))
                files.append(target)
    return files


def vector(request):
    paths = []
    for path in request["paths"]:
        paths.extend(unpack(Path(path)))
    extensions = {".geojson", ".json", ".shp", ".gpkg", ".sqlite", ".db", ".kml", ".gml", ".fgb", ".gpx", ".wkt", ".csv"}
    paths = [path for path in paths if path.suffix.lower() in extensions]
    if not paths:
        raise InputError("INPUT_FORMAT_UNSUPPORTED", "未找到支持的矢量数据；Shapefile 请一起选择 .shp / .shx / .dbf / .prj，或提供 ZIP。")
    layers = []
    sources = {}
    read_sources = {}
    for path in paths:
        if path.suffix.lower() == ".gml":
            # WFS 2.0 reports completeness on its collection element. GDAL
            # reads the returned features even when more pages exist.
            with path.open("rb") as stream:
                _, collection = next(ET.iterparse(stream, events=("start",)))
            if collection.tag in ("{http://www.opengis.net/wfs/2.0}FeatureCollection", "{http://www.opengis.net/wfs}FeatureCollection"):
                matched = collection.get("numberMatched", "")
                returned = collection.get("numberReturned", "")
                if collection.get("next") or (matched.isdecimal() and returned.isdecimal() and int(matched) > int(returned)):
                    raise InputError("INPUT_PAGED_RESULT", "在线结果还有下一页，请缩小查询范围后再导入，避免使用不完整边界。")
            # Discover simple features from the supplied GML. Fetching remote
            # schemas can misidentify legacy EPSG URLs and fail offline.
            pyogrio.set_gdal_config_options({"GML_DOWNLOAD_SCHEMA": "NO"})
            # A bounded GDAL 3.12 read can try to resolve this legacy EPSG
            # identifier over HTTP after the last feature. Canonicalize only
            # that standardized URI in memory; retain traditional GML2 axes.
            original = path.read_bytes()
            canonical = re.sub(rb"""(\bsrsName\s*=\s*["'])https?://www\.opengis\.net/gml/srs/epsg\.xml#([0-9]+)(["'])""", rb"\1EPSG:\2\3", original)
            if canonical != original:
                read_sources[path] = canonical
        if path.suffix.lower() in (".wkt", ".csv"):
            name = path.name
            layers.append({"name": name, "geometryType": "WKT", "crs": request.get("sourceCrs"), "featureCount": None})
            sources[name] = (path, None)
        else:
            source = read_sources.get(path, path)
            for layer_name, geometry_type in pyogrio.list_layers(source):
                key = str(layer_name) if len(paths) == 1 else f"{path.name}:{layer_name}"
                info = pyogrio.read_info(source, layer=layer_name)
                layers.append({"name": key, "geometryType": str(geometry_type), "crs": info.get("crs"), "featureCount": int(info["features"])})
                sources[key] = (path, str(layer_name))
    selected = request.get("layer")
    if not selected and len(layers) != 1:
        return {"layers": layers, "selectionRequired": True}
    selected = selected or layers[0]["name"]
    if selected not in sources:
        raise InputError("INPUT_LAYER_NOT_FOUND", "所选图层不存在，请重新读取图层列表。")
    path, layer = sources[selected]
    crs = request.get("sourceCrs")
    if path.suffix.lower() == ".wkt":
        text = path.read_text(encoding="utf-8-sig").strip()
        match = re.match(r"^SRID=(\d+);", text, re.I)
        if match:
            crs = crs or f"EPSG:{match[1]}"
            text = text[match.end():]
        geometries = [from_wkt(text)]
    elif path.suffix.lower() == ".csv":
        rows = list(csv.DictReader(io.StringIO(path.read_text(encoding="utf-8-sig"))))
        if not rows or len(rows) > MAX_FEATURES:
            raise InputError("INPUT_TOO_LARGE", "CSV 为空或超过 10,000 行。")
        field = next((key for key in rows[0] if key.lower() in ("wkt", "geometry", "geom")), None)
        if not field:
            raise InputError("INPUT_NOT_POLYGON", "CSV 范围需要 wkt / geometry / geom 列中的面几何。")
        geometries = [from_wkt(row[field]) for row in rows]
    else:
        # Read one extra feature to detect truncation; never silently clip a dataset.
        frame = pyogrio.read_dataframe(read_sources.get(path, path), layer=layer, max_features=MAX_FEATURES + 1)
        crs = crs or frame.crs
        geometries = list(frame.geometry)
    return {"layers": layers, "selectedLayer": selected, "sourceCrs": str(crs) if crs else None, "geojson": normalize(geometries, crs)}


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        result = vector(request)
    except InputError as error:
        result = {"error": {"code": error.code, "message": error.message}}
    except Exception as error:
        # Driver exceptions can contain a URL token or local path.
        result = {"error": {"code": "INPUT_READ_FAILED", "message": "读取失败。请检查文件配套内容、格式和坐标系。", "type": type(error).__name__}}
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
