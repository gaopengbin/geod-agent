const labels: Record<string, string> = { geotiff: "GeoTIFF", mbtiles: "MBTiles", png: "PNG", jpeg: "JPEG", gpkg: "GeoPackage", tiles: "瓦片目录" };
export const outputFormatLabel = (format: string) => labels[format] ?? format;
