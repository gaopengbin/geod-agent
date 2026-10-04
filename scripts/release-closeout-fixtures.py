"""Create tiny public, random-marked fixtures for the isolated release smoke."""
from pathlib import Path
import argparse
import json
import sqlite3

parser = argparse.ArgumentParser()
parser.add_argument("folder")
parser.add_argument("marker")
args = parser.parse_args()
folder = Path(args.folder).resolve()
assert folder.name.startswith(".geod-release-closeout-")
assert args.marker.isalnum() and args.marker.startswith("RELEASEDATA")
folder.mkdir(parents=True, exist_ok=False)

stream = f"BT /F1 16 Tf 30 780 Td ({args.marker}PDF) Tj ET".encode("ascii")
objects = [b"<< /Type /Catalog /Pages 2 0 R >>",
           b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
           b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
           b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
           b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"]
pdf = bytearray(b"%PDF-1.4\n")
offsets = []
for index, obj in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf.extend(f"{index} 0 obj\n".encode() + obj + b"\nendobj\n")
xref = len(pdf)
pdf.extend(f"xref\n0 {len(objects)+1}\n0000000000 65535 f \n".encode())
for offset in offsets:
    pdf.extend(f"{offset:010d} 00000 n \n".encode())
pdf.extend(f"trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
(folder / "release-input.pdf").write_bytes(pdf)

with sqlite3.connect(folder / "release.sqlite") as database:
    database.execute("CREATE TABLE release_markers(marker TEXT NOT NULL)")
    database.execute("INSERT INTO release_markers VALUES (?)", (args.marker + "SQL",))

vector = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"name": "Release test range"},
          "geometry": {"type": "Polygon", "coordinates": [[[116.1, 39.6], [116.3, 39.6], [116.3, 39.8], [116.1, 39.8], [116.1, 39.6]]]}}]}
(folder / "range.geojson").write_text(json.dumps(vector), encoding="utf-8")
print(json.dumps({"fixtures": 3, "randomMarker": True, "privateCredentials": False}))
