/**
 * Conversão GPS (WGS84) ↔ coordenadas SVG do mapa L00.
 */
(function (global) {
  "use strict";

  const DEG = Math.PI / 180;

  function normalizeAngle(deg) {
    return ((deg % 360) + 360) % 360;
  }

  function interpolateAngle(from, to, factor) {
    from = normalizeAngle(from);
    to = normalizeAngle(to);
    let delta = to - from;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    return normalizeAngle(from + delta * factor);
  }

  function localMeters(lat, lng, refLat, refLng) {
    const mPerLat = 110540;
    const mPerLng = 111320 * Math.cos(refLat * DEG);
    return {
      x: (lng - refLng) * mPerLng,
      y: (lat - refLat) * mPerLat,
    };
  }

  function buildTransform(controlPoints) {
    const pts = (controlPoints || []).filter(
      (p) => isFinite(p.latitude) && isFinite(p.longitude) && isFinite(p.svgX) && isFinite(p.svgY),
    );
    if (pts.length < 2) return null;

    const a = pts[0];
    const b = pts[1];
    const gpsA = localMeters(a.latitude, a.longitude, a.latitude, a.longitude);
    const gpsB = localMeters(b.latitude, b.longitude, a.latitude, a.longitude);
    const svgDx = b.svgX - a.svgX;
    const svgDy = b.svgY - a.svgY;
    const gpsDist = Math.hypot(gpsB.x - gpsA.x, gpsB.y - gpsA.y);
    const svgDist = Math.hypot(svgDx, svgDy);
    if (gpsDist < 1 || svgDist < 1) return null;

    const gpsAngle = Math.atan2(gpsB.x, gpsB.y);
    const svgAngle = Math.atan2(svgDx, -svgDy);
    const rotation = svgAngle - gpsAngle;
    const scale = svgDist / gpsDist;

    return {
      originLat: a.latitude,
      originLng: a.longitude,
      originSvgX: a.svgX,
      originSvgY: a.svgY,
      rotation,
      scale,
      mapNorthOffset: normalizeAngle((rotation * 180) / Math.PI),
    };
  }

  function latLngToSvg(lat, lng, transform) {
    if (!transform || !isFinite(lat) || !isFinite(lng)) return null;
    const local = localMeters(lat, lng, transform.originLat, transform.originLng);
    const cos = Math.cos(transform.rotation);
    const sin = Math.sin(transform.rotation);
    const rx = (local.x * cos - local.y * sin) * transform.scale;
    const ry = (local.x * sin + local.y * cos) * transform.scale;
    return {
      x: transform.originSvgX + rx,
      y: transform.originSvgY + ry,
    };
  }

  function isInsideCampus(lat, lng, transform, marginMeters) {
    const pt = latLngToSvg(lat, lng, transform);
    if (!pt) return false;
    const m = marginMeters || 120;
    const units = metersToSvgUnits(m, transform);
    return pt.x >= -units && pt.y >= -units && pt.x <= 1011.56 + units && pt.y <= 862.63 + units;
  }

  function metersToSvgUnits(meters, transform) {
    if (!transform?.scale) return meters;
    return meters * transform.scale;
  }

  function bearingFromMovement(prev, next) {
    if (!prev || !next) return null;
    const a = localMeters(next.latitude, next.longitude, prev.latitude, prev.longitude);
    if (Math.hypot(a.x, a.y) < 0.5) return null;
    return normalizeAngle((Math.atan2(a.x, a.y) * 180) / Math.PI);
  }

  function gpsBearingToMapHeading(gpsBearing, transform) {
    if (gpsBearing == null || !transform) return null;
    return normalizeAngle(gpsBearing + transform.mapNorthOffset);
  }

  function createFromGeoReference(geoRef) {
    const transform = buildTransform(geoRef?.controlPoints);
    return {
      transform,
      geoRef,
      latLngToSvg: (lat, lng) => latLngToSvg(lat, lng, transform),
      isInsideCampus: (lat, lng, marginMeters) => isInsideCampus(lat, lng, transform, marginMeters),
      metersToSvgUnits: (meters) => metersToSvgUnits(meters, transform),
      gpsBearingToMapHeading: (bearing) => gpsBearingToMapHeading(bearing, transform),
    };
  }

  global.GeoTransform = {
    normalizeAngle,
    interpolateAngle,
    buildTransform,
    latLngToSvg,
    createFromGeoReference,
    bearingFromMovement,
  };
})(typeof window !== "undefined" ? window : globalThis);
