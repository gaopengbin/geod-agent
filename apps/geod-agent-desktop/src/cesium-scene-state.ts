import * as Cesium from 'cesium';

/** Inspect public Cesium state; entity creation alone does not prove model loading. */
export function sceneModels(viewer: Cesium.Viewer) {
  const loaded = new Map<string, Cesium.Model>();
  const walk = (collection: Cesium.PrimitiveCollection) => {
    for (let i = 0; i < collection.length; i++) {
      const primitive: unknown = collection.get(i);
      if (primitive instanceof Cesium.PrimitiveCollection) walk(primitive);
      else if (primitive instanceof Cesium.Model && primitive.id instanceof Cesium.Entity) loaded.set(primitive.id.id, primitive);
    }
  };
  walk(viewer.scene.primitives);
  const camera = viewer.camera;
  const frustum = camera.frustum.computeCullingVolume(camera.positionWC, camera.directionWC, camera.upWC);
  const entities = viewer.entities.values.filter(entity => entity.model);
  return { total: entities.length, truncated: entities.length > 100, items: entities.slice(0, 100).map(entity => {
    const primitive = loaded.get(entity.id), position = scenePosition(entity, viewer.clock.currentTime);
    return { entityId: entity.id, name: entity.name ?? entity.label?.text?.getValue(viewer.clock.currentTime) ?? null,
      show: entity.isShowing, available: entity.isAvailable(viewer.clock.currentTime), position,
      inCameraFrustum: primitive?.ready ? frustum.computeVisibility(primitive.boundingSphere) !== Cesium.Intersect.OUTSIDE : null,
      state: primitive?.ready ? 'ready' : !entity.isShowing ? 'hidden' : 'loading',
      // The model can load successfully while remaining outside the camera.
      loaded: primitive?.ready === true, animated: entity.position?.isConstant === false,
    };
  }) };
}

export function scenePosition(entity: Cesium.Entity | undefined, time: Cesium.JulianDate) {
  const position = entity?.position?.getValue(time);
  if (!position) return null;
  const point = Cesium.Cartographic.fromCartesian(position);
  return { longitude: Cesium.Math.toDegrees(point.longitude), latitude: Cesium.Math.toDegrees(point.latitude), height: point.height };
}

export function sceneClock(viewer: Cesium.Viewer) {
  const clock = viewer.clock;
  return { currentTime: Cesium.JulianDate.toIso8601(clock.currentTime), startTime: Cesium.JulianDate.toIso8601(clock.startTime),
    stopTime: Cesium.JulianDate.toIso8601(clock.stopTime), multiplier: clock.multiplier,
    shouldAnimate: clock.shouldAnimate, canAnimate: clock.canAnimate,
    range: clock.clockRange === Cesium.ClockRange.LOOP_STOP ? 'LOOP_STOP' : clock.clockRange === Cesium.ClockRange.CLAMPED ? 'CLAMPED' : 'UNBOUNDED' };
}

export function terrainType(provider: Cesium.TerrainProvider) {
  return provider instanceof Cesium.EllipsoidTerrainProvider ? 'flat' : provider instanceof Cesium.ArcGISTiledElevationTerrainProvider ? 'arcgis'
    : provider instanceof Cesium.CesiumTerrainProvider ? 'quantizedMesh' : 'other';
}
