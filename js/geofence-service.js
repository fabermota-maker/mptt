/**
 * Geofence PIB Curitiba — perímetro GPS + regras de estabilidade.
 * Sem Google Maps: point-in-polygon próprio (ray casting).
 */
(function (global) {
  "use strict";

  const DEFAULT_RULES = {
    maximumAccuracyMeters: 30,
    outsideReadingsRequired: 3,
    keepLastValidPosition: true,
    requireInsideGeofence: true,
    snapToNearestEntrance: true,
    allowIndoorGpsPositioning: false,
  };

  /** Ray casting — true se dentro ou sobre a borda. */
  function containsLocation(lat, lng, ring) {
    if (!ring || ring.length < 3 || !isFinite(lat) || !isFinite(lng)) return false;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i].latitude;
      const xi = ring[i].longitude;
      const yj = ring[j].latitude;
      const xj = ring[j].longitude;

      // borda (segmento)
      if (pointOnSegment(lng, lat, xj, yj, xi, yi)) return true;

      const intersect =
        yi > lat !== yj > lat &&
        lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-15) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function pointOnSegment(px, py, x1, y1, x2, y2, eps = 1e-9) {
    const cross = (py - y1) * (x2 - x1) - (px - x1) * (y2 - y1);
    if (Math.abs(cross) > 1e-7) return false;
    const dot = (px - x1) * (x2 - x1) + (py - y1) * (y2 - y1);
    if (dot < 0) return false;
    const len2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
    return dot <= len2 + eps;
  }

  function haversineMeters(aLat, aLng, bLat, bLng) {
    const R = 6371000;
    const toR = Math.PI / 180;
    const dLat = (bLat - aLat) * toR;
    const dLng = (bLng - aLng) * toR;
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function nearestPerimeterPoint(lat, lng, ring) {
    let best = null;
    let bestD = Infinity;
    for (const p of ring || []) {
      const d = haversineMeters(lat, lng, p.latitude, p.longitude);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best ? { point: best, distanceMeters: bestD } : null;
  }

  function createGeofenceService(config = {}) {
    const perimeter = (config.perimeter || []).filter(
      (p) => isFinite(p.latitude) && isFinite(p.longitude),
    );
    const rules = { ...DEFAULT_RULES, ...(config.rules || {}) };
    const mapCenter = config.mapCenter || null;

    let consecutiveOutside = 0;
    let lastValid = null;
    let lastStatus = "CHECKING";

    function evaluate(reading) {
      if (!reading || !isFinite(reading.latitude) || !isFinite(reading.longitude)) {
        return {
          status: "CHECKING",
          message: "Aguardando localização.",
          accepted: false,
          position: lastValid,
          accuracy: null,
          isInside: false,
        };
      }

      const accuracy = reading.accuracy;
      const isInside = containsLocation(reading.latitude, reading.longitude, perimeter);

      if (isFinite(accuracy) && accuracy > rules.maximumAccuracyMeters) {
        lastStatus = "LOW_ACCURACY";
        return {
          status: "LOW_ACCURACY",
          message: "Aguardando uma localização mais precisa.",
          accepted: false,
          position: rules.keepLastValidPosition ? lastValid : null,
          accuracy,
          isInside,
        };
      }

      if (isInside) {
        consecutiveOutside = 0;
        lastValid = {
          latitude: reading.latitude,
          longitude: reading.longitude,
          accuracy: reading.accuracy,
          speed: reading.speed,
          locationBearing: reading.locationBearing,
          timestamp: reading.timestamp,
        };
        lastStatus = "INSIDE";
        return {
          status: "INSIDE",
          message: "Você está dentro da área da PIB Curitiba.",
          accepted: true,
          position: lastValid,
          accuracy,
          isInside: true,
        };
      }

      // fora do perímetro
      if (!rules.requireInsideGeofence) {
        lastValid = { ...reading };
        lastStatus = "OUTSIDE";
        return {
          status: "OUTSIDE",
          message: "Você está fora da área mapeada.",
          accepted: true,
          position: lastValid,
          accuracy,
          isInside: false,
        };
      }

      consecutiveOutside += 1;
      if (consecutiveOutside < rules.outsideReadingsRequired) {
        lastStatus = "CHECKING";
        return {
          status: "CHECKING",
          message: "Confirmando sua localização.",
          accepted: false,
          position: rules.keepLastValidPosition ? lastValid : null,
          accuracy,
          isInside: false,
        };
      }

      lastStatus = "OUTSIDE";
      const snap = rules.snapToNearestEntrance
        ? nearestPerimeterPoint(reading.latitude, reading.longitude, perimeter.filter((p) => p.role === "entrance" || p.role === "corner"))
        : nearestPerimeterPoint(reading.latitude, reading.longitude, perimeter);

      return {
        status: "OUTSIDE",
        message: "Você está fora da área mapeada.",
        accepted: false,
        position: rules.keepLastValidPosition ? lastValid : {
          latitude: reading.latitude,
          longitude: reading.longitude,
          accuracy: reading.accuracy,
          speed: reading.speed,
          locationBearing: reading.locationBearing,
          timestamp: reading.timestamp,
        },
        accuracy,
        isInside: false,
        nearest: snap,
      };
    }

    function reset() {
      consecutiveOutside = 0;
      lastValid = null;
      lastStatus = "CHECKING";
    }

    return {
      perimeter,
      rules,
      mapCenter,
      contains: (lat, lng) => containsLocation(lat, lng, perimeter),
      evaluate,
      reset,
      getLastValid: () => (lastValid ? { ...lastValid } : null),
      getStatus: () => lastStatus,
      nearestEntrance: (lat, lng) =>
        nearestPerimeterPoint(
          lat,
          lng,
          perimeter.filter((p) => p.role === "entrance"),
        ),
    };
  }

  async function loadFromUrl(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Geofence HTTP ${res.status}`);
    const data = await res.json();
    return createGeofenceService(data);
  }

  global.GeofenceService = {
    create: createGeofenceService,
    loadFromUrl,
    containsLocation,
    DEFAULT_RULES,
  };
})(typeof window !== "undefined" ? window : globalThis);
