"""Build a reproducible, offline AreaCity snapshot from its published CSV asset.

Download the versioned ok_geo.csv.7z from GitHub Releases, extract with 7-Zip,
then run: python -X utf8 scripts/prepare-boundary-library.py --input CSV --archive 7Z
No upstream code is executed. GCJ-02 geometry retains all vertices and rings
at the planner's eight-decimal precision; there is no shape simplification.
the native lookup converts only the requested region to WGS84.
"""
import argparse
import csv
import gzip
import hashlib
import json
import struct
from pathlib import Path

VERSION = "2025.251231.260403"
SOURCE = "https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov"
ARCHIVE_SHA256 = "675c3e9b8dec6444994d3ef53259a145304f6a957db8a5e601e55c0b9e61e21a"
COLLECTED_AT = "2026-04-03"


def write_changed(path, content):
    if path.exists() and path.read_bytes() == content:
        return
    temporary = path.with_suffix(path.suffix + ".pending")
    temporary.write_bytes(content)
    temporary.replace(path)


def varint(value):
    value = value * 2 if value >= 0 else -value * 2 - 1
    out = bytearray()
    while value >= 128:
        out.append((value & 127) | 128)
        value >>= 7
    out.append(value)
    return out


def encode(polygon):
    if polygon in ("", "EMPTY"):
        return struct.pack("<I", 0)
    result = bytearray()
    blocks = polygon.split(";")
    result.extend(struct.pack("<I", len(blocks)))
    for block in blocks:
        rings = block.split("~")
        result.extend(struct.pack("<I", len(rings)))
        for ring in rings:
            points = [tuple(round(float(coordinate) * 100_000_000) for coordinate in point.split()) for point in ring.split(",")]
            if points[-1] != points[0]:
                points.append(points[0])
            result.extend(struct.pack("<I", len(points)))
            previous = (0, 0)
            for point in points:
                result.extend(varint(point[0] - previous[0]))
                result.extend(varint(point[1] - previous[1]))
                previous = point
    return result


def build(csv_path, archive, output):
    archive_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
    if archive_hash != ARCHIVE_SHA256:
        raise ValueError("Archive differs from the pinned, verified upstream release")
    csv.field_size_limit(50_000_000)
    output.mkdir(parents=True, exist_ok=True)
    regions, chunks, offsets = [], bytearray(), {}
    maximum_vertices = maximum_parts = empty = 0
    with csv_path.open(encoding="utf-8-sig", newline="") as file:
        for row in csv.DictReader(file):
            polygon = row["polygon"].strip()
            if polygon == "EMPTY" or not polygon:
                empty += 1
            else:
                for block in polygon.split(";"):
                    for ring in block.split("~"):
                        points = [tuple(map(float, point.split())) for point in ring.split(",")]
                        if len(points) < 3 or any(len(point) != 2 or not (72 <= point[0] <= 138 and 0 <= point[1] <= 56) for point in points):
                            raise ValueError(f"Invalid polygon: {row['id']}")
                maximum_vertices = max(maximum_vertices, len(polygon.replace(";", ",").replace("~", ",").split(",")))
                maximum_parts = max(maximum_parts, len(polygon.split(";")))
            digest = hashlib.sha256(polygon.encode()).hexdigest()
            if digest not in offsets:
                compressed = gzip.compress(encode(polygon), compresslevel=9, mtime=0)
                offsets[digest] = (len(chunks), len(compressed))
                chunks.extend(compressed)
            offset, length = offsets[digest]
            regions.append({"id": row["id"], "parent": row["pid"], "level": int(row["deep"]), "name": row["name"], "path": row["ext_path"], "offset": offset, "length": length})
    manifest = {
        "source": SOURCE, "version": VERSION, "collectedAt": COLLECTED_AT,
        "nameSourceVersions": {"nationalPlaceNames": "2025-12-31", "tencent": "2025-11-19"},
        "sourceCrs": "GCJ-02", "archiveSha256": archive_hash,
        "csvSha256": hashlib.sha256(csv_path.read_bytes()).hexdigest(),
        "geometrySha256": hashlib.sha256(chunks).hexdigest(),
        "regionCount": len(regions), "emptyGeometryCount": empty,
        "maximumVertices": maximum_vertices, "maximumParts": maximum_parts,
        "knownMissing": ["和康县", "和安县"],
        "geometryEncoding": "per-region gzip: LE u32 polygons/rings/points then zigzag LEB128 coordinate deltas at 1e8 precision; no simplification",
    }
    write_changed(output / "geometry.bin", chunks)
    write_changed(output / "regions.json", (json.dumps(regions, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
    write_changed(output / "manifest.json", (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode())
    # Exercise the documented '~' hole format, absent in today's main dataset.
    fixture = "116.40 39.90,116.42 39.90,116.42 39.92,116.40 39.92~116.405 39.905,116.415 39.905,116.415 39.915,116.405 39.915"
    write_changed(output / "hole-format-fixture.bin.gz", gzip.compress(encode(fixture), compresslevel=9, mtime=0))
    print(json.dumps({**manifest, "bundledGeometryBytes": len(chunks)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "apps/geod-agent-desktop/src-tauri/data/areacity")
    args = parser.parse_args()
    build(args.input, args.archive, args.output)
