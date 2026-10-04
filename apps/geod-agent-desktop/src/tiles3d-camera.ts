import * as Cesium from 'cesium';

/** A global source's root sphere is not the extent of a bounded download. */
export function downloadedAreaSphere(bounds?: readonly number[] | null): Cesium.BoundingSphere | null {
  if (!bounds || bounds.length !== 4 || bounds.some(value => !Number.isFinite(value))) return null;
  const [west, south, east, north] = bounds;
  if (west < -180 || west > 180 || east < -180 || east > 180 || south < -90 || north > 90 || south >= north || west === east) return null;
  return Cesium.BoundingSphere.fromRectangle3D(Cesium.Rectangle.fromDegrees(west, south, east, north), Cesium.Ellipsoid.WGS84);
}

export function fitDownloadedTileset(viewer: Cesium.Viewer, model: Cesium.Cesium3DTileset, bounds?: readonly number[] | null) {
  const area = downloadedAreaSphere(bounds);
  if (area) {
    // Leave room for tall buildings in very small urban downloads. The target
    // remains the downloaded geographic area, never the global root sphere.
    viewer.camera.viewBoundingSphere(area, new Cesium.HeadingPitchRange(0, -Math.PI / 3, Math.max(area.radius * 3.2, 1200)));
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    viewer.scene.requestRender();
    return;
  }
  void viewer.zoomTo(model, new Cesium.HeadingPitchRange(0, -Math.PI / 4, Math.max(model.boundingSphere.radius * 3.2, 0.1)));
}
