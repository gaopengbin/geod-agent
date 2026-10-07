"""Export an already retrieved local vector snapshot; no service credentials here."""
import copy
import hashlib
import json
import math
from pathlib import Path
import re
import sys

import geopandas as gpd
import pandas as pd
import pyogrio
from pyproj import CRS, Transformer
from shapely.geometry import mapping, shape, box
from shapely.ops import transform


class ExportError(Exception):
    pass


def unique_name(base, names):
    while base.casefold() in {str(n).casefold() for n in names}:
        base += "_"
    return base


def load_snapshot(request):
    path = Path(request["inputPath"])
    if path.stat().st_size > 32 * 1024 * 1024:
        raise ExportError("在线数据超过 32 MiB")
    data = None
    if path.suffix.lower() in (".json", ".geojson"):
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    if data and data.get("type") in ("FeatureCollection", "Feature"):
        features = data.get("features") if data["type"] == "FeatureCollection" else [data]
        crs = request.get("sourceCrs") or data.get("crs", {}).get("properties", {}).get("name") or "EPSG:4326"
        geometries = [shape(f["geometry"]) if f.get("geometry") else None for f in features]
        if any(not isinstance(f.get("properties", {}), (dict, type(None))) for f in features):
            raise ExportError("要素属性不是有效对象")
        return copy.deepcopy(features), geometries, crs
    arcgis = isinstance(data, dict) and "features" in data and "spatialReference" in data and all(isinstance(f.get("attributes"), dict) for f in data["features"])
    if arcgis and not data["features"]:
        reference = data["spatialReference"]
        return [], [], request.get("sourceCrs") or f"EPSG:{reference.get('latestWkid', reference.get('wkid', 4326))}"
    pyogrio.set_gdal_config_options({"GML_DOWNLOAD_SCHEMA": "NO"})
    source = path
    if path.suffix.lower() == ".gml":
        source = re.sub(rb"""(\bsrsName\s*=\s*["'])https?://www\.opengis\.net/gml/srs/epsg\.xml#([0-9]+)(["'])""", rb"\1EPSG:\2\3", path.read_bytes())
    layers = pyogrio.list_layers(source)
    selected = request.get("storageLayer")
    if len(layers) != 1 and not selected:
        raise ExportError("请指定文件中的一个实际图层")
    frame = pyogrio.read_dataframe(source, layer=selected, max_features=request["maxFeatures"] + 1, fid_as_index=arcgis)
    crs = request.get("sourceCrs") or frame.crs
    if not crs:
        raise ExportError("数据没有声明坐标系，请填写源 EPSG 编号")
    if arcgis:
        original = data["features"]
        if len(frame) != len(original):
            raise ExportError("ArcGIS 实际几何与属性数量不一致")
        oid = next((f["name"] for f in data.get("fields", []) if f.get("type") == "esriFieldTypeOID"), data.get("objectIdFieldName"))
        if oid and any(f["attributes"].get(oid) != index for f, index in zip(original, frame.index)):
            raise ExportError("ArcGIS 实际几何与原始要素 ID 顺序不一致")
        # OGR promotes the object-ID column to FID. Keep every original
        # attribute explicitly, including that ID, instead of dropping it.
        features = [{"type": "Feature", "properties": copy.deepcopy(f["attributes"]), "geometry": None, **({"id": f["attributes"][oid]} if oid and oid in f["attributes"] else {})} for f in original]
        return features, list(frame.geometry), str(crs)
    for name in frame.columns:
        if name != frame.geometry.name and pd.api.types.is_datetime64_any_dtype(frame[name]):
            frame[name] = frame[name].map(lambda v: None if pd.isna(v) else v.isoformat())
    features = json.loads(frame.to_json(drop_id=True))["features"]
    return features, list(frame.geometry), str(crs)


def write_gpkg(features, geometries, output, target="EPSG:4326"):
    rows = [f.get("properties") or {} for f in features]
    names = list(dict.fromkeys(k for row in rows for k in row))
    if any(not isinstance(n, str) or not n or "\0" in n for n in names):
        raise ExportError("数据包含无效的属性字段名")
    # SQLite treats names without case sensitivity. Preserve the full original
    # property objects in GeoJSON and fail rather than silently rename columns.
    if len({n.casefold() for n in names}) != len(names):
        raise ExportError("GeoPackage 不支持仅大小写不同的重复字段；请选择 GeoJSON")
    columns, encodings = {}, {}
    for name in names:
        values = [row.get(name) for row in rows]
        present = [v for v in values if v is not None]
        if any(isinstance(v, (dict, list)) for v in present):
            columns[name] = [json.dumps(v, ensure_ascii=False, separators=(",", ":")) if v is not None else None for v in values]
            encodings[name] = "json-text"
        elif present and all(isinstance(v, bool) for v in present):
            columns[name] = pd.array(values, dtype="boolean")
        elif present and all(isinstance(v, int) and not isinstance(v, bool) for v in present):
            if all(-(2**63) <= v < 2**63 for v in present):
                columns[name] = pd.array(values, dtype="Int64")
            else:
                columns[name] = [str(v) if v is not None else None for v in values]
                encodings[name] = "decimal-text"
        elif present and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in present):
            columns[name] = values
        elif all(isinstance(v, str) for v in present):
            columns[name] = pd.array(values, dtype="string")
        else:
            columns[name] = [json.dumps(v, ensure_ascii=False, separators=(",", ":")) if v is not None else None for v in values]
            encodings[name] = "json-text"
    source_id = None
    if any("id" in f for f in features):
        source_id = unique_name("__geod_source_id", names)
        columns[source_id] = [json.dumps(f["id"], ensure_ascii=False) if "id" in f else None for f in features]
        encodings[source_id] = "geojson-feature-id-json"
    geometry_name = unique_name("__geod_geometry", columns)
    fid_name = unique_name("__geod_fid", [*columns, geometry_name])
    frame = pd.DataFrame(columns, index=range(len(features)))
    frame[geometry_name] = gpd.GeoSeries(geometries, crs=target, index=frame.index)
    frame = gpd.GeoDataFrame(frame, geometry=geometry_name, crs=target)
    pyogrio.write_dataframe(frame, output, driver="GPKG", layer="features", geometry_type="Unknown", layer_options={"FID": fid_name, "GEOMETRY_NAME": geometry_name})
    actual = pyogrio.read_info(output, layer="features", force_feature_count=True)
    if actual["features"] != len(features) or set(actual["fields"]) != set(columns):
        raise ExportError("GeoPackage 重新读取的字段或要素数量不一致")
    readback = pyogrio.read_dataframe(output, layer="features")
    # GeoPandas calls its active geometry "geometry" on read. Read attributes
    # separately so a user's ordinary field with that name is not shadowed.
    attributes = pyogrio.read_dataframe(output, layer="features", read_geometry=False)
    if len(readback) != len(features) or CRS(readback.crs) != CRS(target):
        raise ExportError("GeoPackage 坐标系核验失败")
    for i, geometry in enumerate(geometries):
        got = readback.geometry.iloc[i]
        if (geometry is None) != (got is None) or (geometry is not None and not geometry.equals_exact(got, 1e-9)):
            raise ExportError("GeoPackage 几何核验失败")
    for name, expected in columns.items():
        for wanted, got in zip(expected, attributes[name]):
            if wanted is None or wanted is pd.NA or (isinstance(wanted, float) and math.isnan(wanted)):
                if not pd.isna(got):
                    raise ExportError("GeoPackage 空属性核验失败")
            elif pd.isna(got) or wanted != got:
                raise ExportError("GeoPackage 属性核验失败")
    return encodings, source_id


def export(request):
    target = CRS(request.get("targetCrs") or "EPSG:4326")
    if target != CRS("EPSG:4326") and request["outputs"] != ["gpkg"]:
        raise ExportError("GeoJSON 固定为 WGS84；其他坐标系请选择 GeoPackage")
    features, geometries, crs = load_snapshot(request)
    if len(features) > request["maxFeatures"]:
        raise ExportError("要素超过计划上限，未导出截断的数据")
    expected = request.get("expectedFeatures")
    if expected is not None and expected != len(features):
        raise ExportError("实际读取的要素数量与服务结果不一致")
    source_count = len(features)
    transformer = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    geometries = [transform(transformer.transform, g) if g is not None else None for g in geometries]
    if any(g is not None and (not g.is_valid or (not g.is_empty and (not all(math.isfinite(v) for v in g.bounds) or g.bounds[0] < -180 or g.bounds[2] > 180 or g.bounds[1] < -90 or g.bounds[3] > 90))) for g in geometries):
        raise ExportError("几何无效或转换后的坐标超出 WGS84 范围")
    mask = shape(request["boundary"]) if request.get("boundary") else box(*request["bounds"]) if request.get("bounds") else None
    if mask is not None:
        selected = [i for i, g in enumerate(geometries) if g is not None and not g.is_empty and g.intersects(mask)]
        features = [features[i] for i in selected]
        geometries = [geometries[i] for i in selected]
    for feature, geometry in zip(features, geometries):
        feature["geometry"] = mapping(geometry) if geometry is not None else None
        feature.pop("bbox", None)
    collection = {"type": "FeatureCollection", "features": features}
    directory = Path(request["directory"])
    warnings, fields = [], list(dict.fromkeys(k for f in features for k in (f.get("properties") or {})))
    encodings, source_id = {}, None
    outputs = []
    if "geojson" in request["outputs"]:
        path = directory / "features.geojson"
        encoded = json.dumps(collection, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        path.write_text(encoded, encoding="utf-8")
        if json.loads(path.read_text(encoding="utf-8")) != json.loads(encoded):
            raise ExportError("GeoJSON 重新读取核验失败")
        outputs.append((path, "geojson"))
    if "gpkg" in request["outputs"]:
        path = directory / "features.gpkg"
        projection=Transformer.from_crs("EPSG:4326",target,always_xy=True)
        projected=[transform(projection.transform,g) if g is not None else None for g in geometries]
        if any(g is not None and not g.is_empty and not all(math.isfinite(v) for v in g.bounds) for g in projected):
            raise ExportError("指定投影不适用于当前范围")
        encodings, source_id = write_gpkg(features, projected, path, target)
        outputs.append((path, "gpkg"))
        if encodings:
            warnings.append("GeoPackage 的复杂属性及原始要素 ID 按清单中的编码保存为文本；GeoJSON 保留原属性对象。")
    preview = directory / "preview.geojson"
    preview.write_text(json.dumps({"type": "FeatureCollection", "features": features[:1000]}, ensure_ascii=False, allow_nan=False, separators=(",", ":")), encoding="utf-8")
    outputs.append((preview, "preview"))
    bounds = None
    nonempty = [g for g in geometries if g is not None and not g.is_empty]
    if nonempty:
        bounds = [min(g.bounds[0] for g in nonempty), min(g.bounds[1] for g in nonempty), max(g.bounds[2] for g in nonempty), max(g.bounds[3] for g in nonempty)]
    assets = []
    for path, kind in outputs:
        if path.stat().st_size > 256 * 1024 * 1024:
            raise ExportError("单个导出文件超过 256 MiB")
        assets.append({"path": path.name, "kind": kind, "size": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    return {"featureCount": len(features), "sourceFeatureCount": source_count, "sourceCrs": str(CRS(crs)), "outputCrs": target.to_string(), "bounds": bounds, "fields": fields, "geometryTypes": sorted({g.geom_type for g in geometries if g is not None}), "previewFeatureCount": min(1000, len(features)), "previewTruncated": len(features) > 1000, "fieldEncodings": encodings, "sourceIdField": source_id, "warnings": warnings, "assets": assets}


if __name__ == "__main__":
    try:
        result = export(json.load(sys.stdin))
    except ExportError as error:
        result = {"error": str(error)}
    except Exception as error:
        result = {"error": "在线数据导出或核验失败，请检查字段、几何和坐标系", "type": type(error).__name__}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")))
