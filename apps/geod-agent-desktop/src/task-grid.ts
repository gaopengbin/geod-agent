import type { Feature, MultiLineString, MultiPolygon } from "geojson";
import type { PlanTileGrid } from "./api";

type Point = [number, number];

const mercatorY = (latitude: number) => (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2;
const latitudeAt = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;

function rectangle(west: number, south: number, east: number, north: number): Point[][] {
  return [[[west, north], [east, north], [east, south], [west, south], [west, north]]];
}

export function taskGridLines(grids: PlanTileGrid[]): Feature<MultiLineString> {
  const lines: Point[][] = [];
  for (const grid of grids) {
    const [west, south, east, north] = grid.actualBounds;
    const longitudeAt = (column: number) => west + (east - west) * column / grid.columns;
    const northY = mercatorY(north);
    const southY = mercatorY(south);
    const rowLatitude = (row: number) => latitudeAt(northY + (southY - northY) * row / grid.rows);
    for (let column = 0; column <= grid.columns; column++) {
      const longitude = longitudeAt(column);
      lines.push([[longitude, north], [longitude, south]]);
    }
    for (let row = 0; row <= grid.rows; row++) {
      const latitude = rowLatitude(row);
      lines.push([[west, latitude], [east, latitude]]);
    }
  }
  return { type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: lines } };
}

/** Tile order matches geod-core: columns west to east, rows north to south. */
export function taskTileCoverage(grids: PlanTileGrid[], completedTiles: number): Feature<MultiPolygon> {
  const coverage: Point[][][] = [];
  let remaining = Math.max(0, Math.floor(completedTiles));
  for (const grid of grids) {
    const [west, south, east, north] = grid.actualBounds;
    const longitudeAt = (column: number) => west + (east - west) * column / grid.columns;
    const northY = mercatorY(north);
    const southY = mercatorY(south);
    const rowLatitude = (row: number) => latitudeAt(northY + (southY - northY) * row / grid.rows);
    const fetched = Math.min(remaining, grid.tileCount);
    const fullColumns = Math.floor(fetched / grid.rows);
    const partialRows = fetched % grid.rows;
    if (fullColumns > 0) coverage.push(rectangle(west, south, longitudeAt(fullColumns), north));
    if (partialRows > 0) coverage.push(rectangle(longitudeAt(fullColumns), rowLatitude(partialRows), longitudeAt(fullColumns + 1), north));
    remaining -= fetched;
  }
  return { type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: coverage } };
}
