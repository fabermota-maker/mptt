/**
 * Orquestrador: localização GPS em tempo real + heading + puck + câmera.
 */
(function (global) {
  "use strict";

  const GT = () => (typeof GeoTransform !== "undefined" ? GeoTransform : null);

  /** Fallback se data/geo-reference.json não carregar (GitHub Pages / path). */
  const FALLBACK_GEO = {
    id: "pib-curitiba-campus",
    level: "L00",
    controlPoints: [
      {
        id: "entrada_av_batel",
        label: "Entrada estacionamento Av. Batel",
        latitude: -25.44078,
        longitude: -49.28372,
        svgX: 21.5,
        svgY: 347,
      },
      {
        id: "entrada_pedestre_bento",
        label: "Entrada pedestre Bento Viana 1200",
        latitude: -25.44203,
        longitude: -49.28503,
        svgX: 514.38,
        svgY: 846.6,
      },
    ],
  };

  function createUserLocationSystem(ctx) {
    const {
      overlay,
      viewport,
      canvas,
      locBtn,
      getState,
      setState,
      apply,
      clamp,
      getViewBox,
      getMetersPerUnit,
      toast,
    } = ctx;

    let geo = null;
    let permissions = null;
    let location = null;
    let heading = null;
    let puck = null;
    let camera = null;
    let animId = null;
    let started = false;
    let starting = false;
    let targetSvg = { x: null, y: null };
    let displaySvg = { x: null, y: null };

    const defaultNav = {
      latitude: null,
      longitude: null,
      accuracy: null,
      deviceHeading: null,
      locationBearing: null,
      speed: null,
      isFollowingLocation: false,
      isFollowingHeading: false,
      followMode: "free",
      permissionStatus: "prompt",
      orientationStatus: "prompt",
      cameraBearing: 0,
      gpsAvailable: false,
      headingAvailable: false,
    };

    function initState() {
      const s = getState();
      if (!s.userNav) setState({ userNav: { ...defaultNav } });
    }

    function patchNav(p) {
      const cur = getState().userNav || defaultNav;
      setState({ userNav: { ...cur, ...p } });
      updateLocBtn();
    }

    function metersToSvgUnits(meters) {
      const mpu = getMetersPerUnit?.() || 0.01;
      if (geo?.metersToSvgUnits) return geo.metersToSvgUnits(meters);
      return meters / mpu;
    }

    function updateLocBtn() {
      if (!locBtn) return;
      const mode = getState().userNav?.followMode || "free";
      locBtn.dataset.mode = mode;
      locBtn.classList.toggle("is-follow", mode === "follow");
      locBtn.classList.toggle("is-follow-heading", mode === "follow-heading");
      const labels = {
        free: "Centralizar na minha localização",
        follow: "Seguindo localização (toque p/ seguir direção)",
        "follow-heading": "Seguindo localização e direção (toque p/ liberar)",
      };
      locBtn.title = labels[mode] || labels.free;
      locBtn.setAttribute("aria-pressed", mode !== "free" ? "true" : "false");
    }

    function animateFrame() {
      if (targetSvg.x != null && displaySvg.x != null) {
        const f = 0.2;
        displaySvg.x += (targetSvg.x - displaySvg.x) * f;
        displaySvg.y += (targetSvg.y - displaySvg.y) * f;
        const nav = getState().userNav || {};
        puck?.setPosition(displaySvg.x, displaySvg.y, nav.accuracy, metersToSvgUnits);
        if (nav.isFollowingLocation) {
          camera?.centerOnPoint(displaySvg.x, displaySvg.y);
        }
      }

      const nav = getState().userNav || {};
      if (nav.deviceHeading != null && puck) {
        let mapHeading = geo?.gpsBearingToMapHeading
          ? geo.gpsBearingToMapHeading(nav.deviceHeading)
          : nav.deviceHeading;
        if (nav.locationBearing != null && (nav.speed || 0) > 1.5) {
          mapHeading = GT()?.interpolateAngle(mapHeading, nav.locationBearing, 0.25) ?? mapHeading;
        }
        puck.setHeading(mapHeading, nav.cameraBearing || 0);
      }

      animId = requestAnimationFrame(animateFrame);
    }

    function onLocationUpdate(pos, err) {
      if (err || !pos) {
        if (err?.code === 1) patchNav({ permissionStatus: "denied", gpsAvailable: false });
        else patchNav({ permissionStatus: "unavailable", gpsAvailable: false });
        return;
      }

      if (!geo?.transform) return;
      const svgPt = geo.latLngToSvg(pos.latitude, pos.longitude);
      if (!svgPt) return;

      if (getState().activeLevel && getState().activeLevel !== "L00") {
        puck?.hide();
        return;
      }

      targetSvg = { x: svgPt.x, y: svgPt.y };
      if (displaySvg.x == null) displaySvg = { ...targetSvg };

      let locationBearing = pos.locationBearing;
      if (locationBearing != null && geo.gpsBearingToMapHeading) {
        locationBearing = geo.gpsBearingToMapHeading(locationBearing);
      }

      patchNav({
        latitude: pos.latitude,
        longitude: pos.longitude,
        accuracy: pos.accuracy,
        speed: pos.speed,
        locationBearing,
        permissionStatus: "granted",
        gpsAvailable: true,
      });

      // primeira fix: mostra puck e, se estiver em follow, centraliza
      if (puck && !puck.isVisible()) {
        puck.setPosition(displaySvg.x, displaySvg.y, pos.accuracy, metersToSvgUnits);
      }
    }

    function onHeadingUpdate(h) {
      if (h == null) {
        patchNav({ headingAvailable: false });
        puck?.setHeading(null, 0);
        return;
      }
      patchNav({ deviceHeading: h, headingAvailable: true, orientationStatus: "granted" });
      if (getState().userNav?.isFollowingHeading) {
        camera?.updateCameraHeading(h, geo);
      }
    }

    async function ensurePermissions() {
      permissions = permissions || global.PermissionService?.create?.();
      if (!permissions) return false;

      await permissions.probeGeolocation();
      const loc = await permissions.requestLocationPermission();
      patchNav({ permissionStatus: loc.status });

      if (!loc.ok) {
        toast(loc.status === "denied"
          ? "Permissão de localização negada. Ative nas configurações do navegador."
          : "Localização indisponível. Use HTTPS e ative o GPS.");
        return false;
      }

      const ori = await permissions.requestOrientationPermission();
      patchNav({ orientationStatus: ori.status });
      if (!ori.ok) {
        toast("Bússola indisponível — exibindo apenas o ponto azul.");
      }
      return true;
    }

    async function loadGeo() {
      if (geo?.transform) return true;
      let data = null;
      try {
        const base = document.querySelector('script[src*="user-location"]')?.src;
        const url = base
          ? new URL("../data/geo-reference.json", base).href
          : "data/geo-reference.json";
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) data = await res.json();
      } catch (err) {
        console.warn("geo-reference.json:", err);
      }
      if (!data) data = FALLBACK_GEO;
      geo = GT()?.createFromGeoReference?.(data) || null;
      return !!geo?.transform;
    }

    function ensureServices() {
      if (!puck) puck = global.UserLocationPuck?.create?.(overlay);
      if (!camera) {
        camera = global.MapCameraController?.create?.({
          viewport,
          canvas,
          getState,
          setState,
          apply,
          clamp,
          getViewBox,
        });
      }
      if (!location) {
        location = global.LocationService?.create?.({ positionSmoothing: 0.18 });
        location?.subscribe(onLocationUpdate);
      }
      if (!heading) {
        heading = global.HeadingService?.create?.({ smoothingFactor: 0.18, targetHz: 30 });
        heading?.subscribe(onHeadingUpdate);
      }
      if (!animId) animId = requestAnimationFrame(animateFrame);
    }

    async function start({ silent = false } = {}) {
      if (started || starting) return started;
      starting = true;
      initState();

      try {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
          if (!silent) toast("Geolocalização não suportada neste navegador.");
          return false;
        }

        const geoOk = await loadGeo();
        if (!geoOk) {
          if (!silent) toast("Georreferência do mapa indisponível.");
          return false;
        }

        const ok = await ensurePermissions();
        if (!ok) return false;

        ensureServices();
        location?.start();
        heading?.start();

        document.addEventListener("visibilitychange", onVisibility);
        started = true;
        updateLocBtn();
        if (!silent) toast("Buscando sua localização…");
        return true;
      } finally {
        starting = false;
      }
    }

    async function onLocBtnClick() {
      // 1) ainda não iniciou → pede permissão e liga GPS
      if (!started) {
        const ok = await start();
        if (!ok) return;
        // entra em "seguir" após primeira permissão
        camera?.setFollowMode("follow");
        updateLocBtn();
        toast("Seguindo sua localização.");
        return;
      }

      // 2) GPS ligado mas ainda sem fix → tenta de novo e centra se já tiver
      if (!getState().userNav?.gpsAvailable) {
        const ok = await ensurePermissions();
        if (ok) {
          location?.start();
          toast("Buscando sua localização…");
        }
        return;
      }

      // 3) cicla livre → seguir → seguir+direção
      camera?.cycleFollowMode();
      updateLocBtn();
      const mode = getState().userNav?.followMode;
      if (mode === "follow") {
        if (displaySvg.x != null) camera?.centerOnPoint(displaySvg.x, displaySvg.y);
        toast("Seguindo sua localização.");
      } else if (mode === "follow-heading") {
        toast("Seguindo localização e direção.");
      } else {
        toast("Mapa livre — arraste para navegar.");
      }
    }

    function bindLocBtn() {
      if (!locBtn || locBtn._bound) return;
      locBtn._bound = true;
      locBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onLocBtnClick().catch((err) => console.warn("locBtn:", err));
      });
    }

    function onVisibility() {
      if (document.hidden) heading?.pause();
      else heading?.resume();
    }

    function onMapDragged() {
      camera?.exitFollow();
      updateLocBtn();
    }

    function stop() {
      location?.stop();
      heading?.stop();
      if (animId) cancelAnimationFrame(animId);
      animId = null;
      document.removeEventListener("visibilitychange", onVisibility);
      puck?.hide();
      started = false;
    }

    function getNavigationState() {
      return { ...(getState().userNav || defaultNav) };
    }

    // botão sempre funcional, mesmo se o auto-start falhar
    initState();
    bindLocBtn();
    updateLocBtn();

    return {
      start,
      stop,
      onMapDragged,
      getNavigationState,
      updateLocBtn,
      onLocBtnClick,
    };
  }

  global.UserLocationSystem = { create: createUserLocationSystem };
})(typeof window !== "undefined" ? window : globalThis);
