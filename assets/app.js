/* JourneyMap Atlas — interactive viewer for JourneyMap region tiles.
 *
 * Coordinate model
 * ----------------
 * JourneyMap writes one 512x512 PNG per world region, named "<rx>,<rz>.png",
 * where a region spans 512x512 blocks. That is exactly a slippy-map tile grid
 * at 1 pixel per block, so we use a Simple CRS with an identity transformation:
 *
 *     LatLng(lat, lng)  ==  LatLng(blockZ, blockX)
 *
 * At zoom 0, one screen pixel is one block and tile coords equal region coords.
 * Leaflet upsamples/downsamples the same PNGs for every other zoom level.
 */

(function () {
  "use strict";

  var TILE = 512;
  var NATIVE_ZOOM = 0;
  var MIN_ZOOM = -4;
  var MAX_ZOOM = 4;
  var LABEL_MIN_ZOOM = 0;

  var CRS = L.extend({}, L.CRS.Simple, {
    transformation: new L.Transformation(1, 0, 1, 0)
  });

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    manifest: null,
    waypoints: [],
    groups: {},
    dim: null,
    layer: null,
    showLabels: true,
    allDims: false,
    search: ""
  };

  var map, tileLayer, gridLayer;
  var markerLayer = L.layerGroup();

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  function dimById(id) {
    return state.manifest.dimensions.filter(function (d) { return d.id === id; })[0];
  }

  function layerById(dim, id) {
    return dim.layers.filter(function (l) { return l.id === id; })[0];
  }

  function defaultLayer(dim) {
    // Prefer a real surface render. Dimensions without one (the Nether has no
    // sky, so JourneyMap never writes day/night there) fall back to the
    // underground slice carrying the most detail, then to topo/biome.
    var byId = {};
    dim.layers.forEach(function (l) { byId[l.id] = l; });
    if (byId.day) return byId.day;
    if (byId.night) return byId.night;

    var caves = dim.layers.filter(function (l) { return l.kind === "cave"; });
    if (caves.length) {
      return caves.slice().sort(function (a, b) {
        return (b.detail || 0) - (a.detail || 0);
      })[0];
    }
    return dim.layers[0];
  }

  function layerBounds(layer) {
    var b = layer.bounds;
    return L.latLngBounds(
      L.latLng(b.minZ * TILE, b.minX * TILE),
      L.latLng((b.maxZ + 1) * TILE, (b.maxX + 1) * TILE)
    );
  }

  function fmt(n) { return Math.round(n).toLocaleString("en-US"); }

  function plural(n, word) {
    return fmt(n) + " " + word + (n === 1 ? "" : "s");
  }

  var toastTimer;
  function toast(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("on"); }, 1600);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast("Copied " + text); },
        function () { toast(text); }
      );
    } else {
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); toast("Copied " + text); }
      catch (e) { toast(text); }
      document.body.removeChild(ta);
    }
  }

  function wpColor(wp) {
    if (wp.death) return "#e05252";
    if (wp.color) return wp.color;
    var g = state.groups[wp.group];
    if (g && g.color) return g.color;
    return "#5eb85e";
  }

  /* ------------------------------------------------------------------ */
  /* grid overlay                                                        */
  /* ------------------------------------------------------------------ */

  var GridLayer = L.GridLayer.extend({
    createTile: function (coords) {
      var canvas = document.createElement("canvas");
      var size = this.getTileSize();
      var ratio = window.devicePixelRatio || 1;
      canvas.width = size.x * ratio;
      canvas.height = size.y * ratio;
      var ctx = canvas.getContext("2d");
      ctx.scale(ratio, ratio);

      // Grid spacing is defined in blocks, so it has to be derived from the
      // tile's own zoom level rather than from its pixel size.
      var pxPerBlock = Math.pow(2, coords.z);
      var blocksPerTile = size.x / pxPerBlock;
      var originX = coords.x * blocksPerTile;
      var originZ = coords.y * blocksPerTile;

      function lines(step, color) {
        if (step * pxPerBlock < 9) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        var bx = Math.ceil(originX / step) * step;
        for (; bx < originX + blocksPerTile; bx += step) {
          var v = Math.round((bx - originX) * pxPerBlock) + 0.5;
          ctx.moveTo(v, 0);
          ctx.lineTo(v, size.y);
        }
        var bz = Math.ceil(originZ / step) * step;
        for (; bz < originZ + blocksPerTile; bz += step) {
          var h = Math.round((bz - originZ) * pxPerBlock) + 0.5;
          ctx.moveTo(0, h);
          ctx.lineTo(size.x, h);
        }
        ctx.stroke();
      }

      lines(16, "rgba(255,255,255,0.06)");    // chunks
      lines(512, "rgba(94,184,94,0.40)");     // regions

      if (512 * pxPerBlock >= 150) {
        ctx.fillStyle = "rgba(230,233,239,0.45)";
        ctx.font = "11px ui-monospace, Menlo, monospace";
        var rx = Math.ceil(originX / 512) * 512;
        for (; rx < originX + blocksPerTile; rx += 512) {
          var rz = Math.ceil(originZ / 512) * 512;
          for (; rz < originZ + blocksPerTile; rz += 512) {
            ctx.fillText(
              "region " + (rx / 512) + ", " + (rz / 512),
              (rx - originX) * pxPerBlock + 6,
              (rz - originZ) * pxPerBlock + 15
            );
          }
        }
      }
      return canvas;
    }
  });

  /* ------------------------------------------------------------------ */
  /* rendering                                                           */
  /* ------------------------------------------------------------------ */

  function renderTiles(fit) {
    var dim = dimById(state.dim);
    var layer = layerById(dim, state.layer) || defaultLayer(dim);
    state.layer = layer.id;

    var bounds = layerBounds(layer);
    // Tiles live in one flat folder as "<dimension>__<layer>__<rx>,<rz>.png".
    var url = "data/tiles/" + dim.id + "__" + layer.id + "__{x},{y}.png";

    if (tileLayer) map.removeLayer(tileLayer);
    tileLayer = L.tileLayer(url, {
      tileSize: TILE,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      minNativeZoom: NATIVE_ZOOM,
      maxNativeZoom: NATIVE_ZOOM,
      noWrap: true,
      bounds: bounds,
      keepBuffer: 3,
      errorTileUrl:
        "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
    }).addTo(map);
    tileLayer.bringToBack();

    var pad = TILE * 2;
    map.setMaxBounds(bounds.pad(0).extend(
      L.latLng(bounds.getSouth() + pad, bounds.getEast() + pad)
    ).extend(
      L.latLng(bounds.getNorth() - pad, bounds.getWest() - pad)
    ));

    if (fit) map.fitBounds(bounds, { animate: false, padding: [24, 24] });
  }

  function visibleWaypoints() {
    var q = state.search.trim().toLowerCase();
    return state.waypoints.filter(function (wp) {
      if (!state.allDims) {
        var dims = wp.dimensions && wp.dimensions.length ? wp.dimensions : [wp.dimension];
        if (dims.indexOf(state.dim) === -1) return false;
      }
      if (q && wp.name.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }

  function waypointLatLng(wp) {
    // A waypoint stored for another dimension is projected into the current
    // one using the 8:1 Nether ratio, the same way the game links portals.
    var from = dimById(wp.dimension);
    var to = dimById(state.dim);
    var x = wp.x, z = wp.z;
    if (from && to && from.id !== to.id) {
      x = x * (from.scale / to.scale);
      z = z * (from.scale / to.scale);
    }
    return L.latLng(z, x);
  }

  function renderMarkers() {
    markerLayer.clearLayers();
    visibleWaypoints().forEach(function (wp) {
      var color = wpColor(wp);
      var projected = wp.dimension !== state.dim;
      var icon = L.divIcon({
        className: "",
        html:
          '<div class="wp-marker' + (state.showLabels ? "" : " hide-label") + '"' +
          ' style="color:' + color + (projected ? ";opacity:.6" : "") + '">' +
          '<div class="pin"></div>' +
          '<div class="lbl">' + escapeHtml(wp.name) + "</div></div>",
        iconSize: [0, 0],
        iconAnchor: [0, 5]
      });
      var m = L.marker(waypointLatLng(wp), { icon: icon, riseOnHover: true });
      m.bindPopup(waypointPopup(wp, projected));
      m.addTo(markerLayer);
      wp._marker = m;
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function waypointPopup(wp, projected) {
    var coords = wp.x + " " + wp.y + " " + wp.z;
    var group = state.groups[wp.group];
    var html =
      '<div class="pop"><h3>' + escapeHtml(wp.name) + "</h3>" +
      '<div class="co">' + escapeHtml(coords) + "</div>" +
      '<div class="meta">' +
      (dimById(wp.dimension) ? dimById(wp.dimension).label : wp.dimension) +
      (group ? " · " + escapeHtml(group.name) : "") +
      (projected ? " · shown at its converted position" : "") +
      "</div>" +
      '<button data-copy="' + escapeHtml(coords) + '">Copy coordinates</button></div>';
    return html;
  }

  function renderWaypointList() {
    var list = $("wp-list");
    var items = visibleWaypoints();
    $("wp-count").textContent = state.waypoints.length ? "(" + items.length + ")" : "";
    list.innerHTML = "";

    if (!state.waypoints.length) {
      list.innerHTML =
        '<div class="empty">No waypoints yet. Any waypoint you set in-game shows up here after the next sync.</div>';
      return;
    }
    if (!items.length) {
      list.innerHTML = state.search
        ? '<div class="empty">No waypoints match &ldquo;' + escapeHtml(state.search) + '&rdquo;.</div>'
        : '<div class="empty">No waypoints in this dimension. Tick &ldquo;all dimensions&rdquo; below to see the other ' +
          (state.waypoints.length === 1 ? 'one' : state.waypoints.length) + '.</div>';
      return;
    }

    items.forEach(function (wp) {
      var btn = document.createElement("button");
      btn.className = "wp-item";
      btn.innerHTML =
        '<span class="dot" style="background:' + wpColor(wp) + '"></span>' +
        '<span class="nm">' + escapeHtml(wp.name) + "</span>" +
        '<span class="co">' + wp.x + ", " + wp.z + "</span>";
      btn.addEventListener("click", function () {
        map.setView(waypointLatLng(wp), Math.max(map.getZoom(), 0), { animate: true });
        if (wp._marker) wp._marker.openPopup();
        document.getElementById("app").classList.remove("nav-open");
      });
      list.appendChild(btn);
    });
  }

  function renderDims() {
    var wrap = $("dims");
    wrap.innerHTML = "";
    state.manifest.dimensions.forEach(function (d) {
      var b = document.createElement("button");
      b.className = "dim-btn";
      b.textContent = d.label;
      b.setAttribute("aria-pressed", d.id === state.dim ? "true" : "false");
      b.addEventListener("click", function () { switchDimension(d.id); });
      wrap.appendChild(b);
    });
  }

  function renderLayers() {
    var dim = dimById(state.dim);
    var wrap = $("layers");
    wrap.innerHTML = "";

    var surface = dim.layers.filter(function (l) { return l.kind === "surface"; });
    var caves = dim.layers.filter(function (l) { return l.kind === "cave"; });

    function addBtn(l) {
      var b = document.createElement("button");
      b.className = "layer-btn";
      b.setAttribute("aria-pressed", l.id === state.layer ? "true" : "false");
      b.innerHTML =
        '<span class="tick"></span><span>' + escapeHtml(l.label) + "</span>" +
        '<span class="count">' + l.tiles.length + "</span>";
      b.addEventListener("click", function () {
        state.layer = l.id;
        renderTiles(false);
        renderLayers();
        writeHash();
      });
      wrap.appendChild(b);
    }

    surface.forEach(addBtn);
    if (caves.length) {
      var h = document.createElement("div");
      h.className = "subhead";
      h.textContent = "Underground slices";
      wrap.appendChild(h);
      caves.forEach(addBtn);
    }
  }

  function switchDimension(id) {
    if (id === state.dim) return;
    var from = dimById(state.dim);
    var to = dimById(id);
    var center = map.getCenter();
    var zoom = map.getZoom();

    state.dim = id;
    state.layer = defaultLayer(to).id;

    renderDims();
    renderLayers();
    renderTiles(false);

    // Keep the equivalent spot in view across the 8:1 Nether ratio, the same
    // conversion the game uses to link portals.
    var ratio = from.scale / to.scale;
    var target = L.latLng(center.lat * ratio, center.lng * ratio);
    var bounds = layerBounds(layerById(to, state.layer));
    if (bounds.contains(target)) {
      // Matching the on-screen scale exactly can land absurdly deep in the
      // Nether, so cap it just past the zoom that would frame the dimension.
      var equivalent = zoom + Math.round(Math.log2(1 / ratio));
      var framed = map.getBoundsZoom(bounds, false, L.point(24, 24));
      map.setView(target, Math.min(equivalent, framed + 1), { animate: false });
    } else {
      map.fitBounds(bounds, { animate: false, padding: [24, 24] });
    }

    renderMarkers();
    renderWaypointList();
    writeHash();
  }

  /* ------------------------------------------------------------------ */
  /* url hash: #dimension/layer/x/z/zoom                                  */
  /* ------------------------------------------------------------------ */

  var hashLock = false;

  function writeHash() {
    if (hashLock) return;
    var c = map.getCenter();
    var hash = "#" + [
      state.dim,
      state.layer,
      Math.round(c.lng),
      Math.round(c.lat),
      map.getZoom()
    ].join("/");
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }

  function readHash() {
    var parts = location.hash.replace(/^#/, "").split("/");
    if (parts.length < 3) return null;
    var dim = dimById(parts[0]);
    if (!dim) return null;
    var layer = layerById(dim, parts[1]) || defaultLayer(dim);
    var x = parseFloat(parts[2]), z = parseFloat(parts[3]);
    var zoom = parseFloat(parts[4]);
    return {
      dim: dim.id,
      layer: layer.id,
      center: isFinite(x) && isFinite(z) ? L.latLng(z, x) : null,
      zoom: isFinite(zoom) ? zoom : null
    };
  }

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */

  function fail(msg) {
    $("world-sub").textContent = msg;
    $("wp-list").innerHTML = '<div class="empty">' + escapeHtml(msg) + "</div>";
  }

  Promise.all([
    fetch("data/manifest.json?" + Date.now()).then(function (r) {
      if (!r.ok) throw new Error("manifest.json missing");
      return r.json();
    }),
    fetch("data/waypoints.json?" + Date.now())
      .then(function (r) { return r.ok ? r.json() : { waypoints: [], groups: [] }; })
      .catch(function () { return { waypoints: [], groups: [] }; })
  ]).then(function (res) {
    var manifest = res[0], wpData = res[1];
    state.manifest = manifest;
    state.waypoints = wpData.waypoints || [];
    (wpData.groups || manifest.waypointGroups || []).forEach(function (g) {
      state.groups[g.id] = g;
    });

    document.title = manifest.title || "JourneyMap Atlas";
    $("world-title").textContent = manifest.world || "JourneyMap Atlas";
    var c = manifest.counts || {};
    $("world-sub").textContent =
      [
        plural(c.dimensions || 0, "dimension"),
        plural(c.tiles || 0, "region"),
        plural(c.waypoints || 0, "waypoint")
      ].join(" · ");

    var when = new Date(manifest.generated || Date.now());
    $("foot-generated").textContent =
      "Synced " + when.toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
      });

    var initial = readHash();
    state.dim = initial ? initial.dim : manifest.dimensions[0].id;
    state.layer = initial ? initial.layer : defaultLayer(dimById(state.dim)).id;

    map = L.map("map", {
      crs: CRS,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      zoomSnap: 0.5,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 90,
      zoomControl: false,
      attributionControl: false,
      maxBoundsViscosity: 0.7
    });

    L.control.zoom({ position: "topright" }).addTo(map);
    markerLayer.addTo(map);

    renderDims();
    renderLayers();
    renderTiles(!(initial && initial.center));

    if (initial && initial.center) {
      map.setView(initial.center, initial.zoom !== null ? initial.zoom : 0);
    }

    renderMarkers();
    renderWaypointList();

    map.on("mousemove", function (e) {
      $("readout").innerHTML =
        "X <b>" + Math.floor(e.latlng.lng) + "</b> &nbsp; Z <b>" +
        Math.floor(e.latlng.lat) + "</b>";
    });

    map.on("mouseout", function () {
      $("readout").innerHTML = "X <b>—</b> &nbsp; Z <b>—</b>";
    });

    map.on("moveend zoomend", writeHash);

    // Twenty waypoints in one valley turn into a wall of text when zoomed out,
    // so labels fade below this zoom and only the dots remain.
    function syncLabelZoom() {
      var el = map.getContainer();
      if (map.getZoom() < LABEL_MIN_ZOOM) el.classList.add("far");
      else el.classList.remove("far");
    }
    map.on("zoomend", syncLabelZoom);
    syncLabelZoom();

    map.on("click", function (e) {
      var x = Math.floor(e.latlng.lng), z = Math.floor(e.latlng.lat);
      var dim = dimById(state.dim);
      var other = state.manifest.dimensions.filter(function (d) {
        return d.id !== dim.id && d.scale !== dim.scale;
      })[0];
      var extra = "";
      if (other) {
        var r = dim.scale / other.scale;
        extra = '<div class="meta">' + other.label + " equivalent: " +
          Math.round(x * r) + ", " + Math.round(z * r) + "</div>";
      }
      L.popup({ closeButton: true })
        .setLatLng(e.latlng)
        .setContent(
          '<div class="pop"><h3>' + x + ", " + z + "</h3>" +
          '<div class="co">' + dim.label + "</div>" + extra +
          '<button data-copy="' + x + " " + z + '">Copy coordinates</button></div>'
        )
        .openOn(map);
    });

    document.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-copy]") : null;
      if (btn) copyText(btn.getAttribute("data-copy"));
    });

    $("wp-search").addEventListener("input", function (e) {
      state.search = e.target.value;
      renderMarkers();
      renderWaypointList();
    });

    $("wp-all-dims").addEventListener("change", function (e) {
      state.allDims = e.target.checked;
      renderMarkers();
      renderWaypointList();
    });

    $("opt-labels").addEventListener("change", function (e) {
      state.showLabels = e.target.checked;
      renderMarkers();
    });

    $("opt-grid").addEventListener("change", function (e) {
      if (e.target.checked) {
        gridLayer = new GridLayer({
          tileSize: TILE,
          minZoom: MIN_ZOOM,
          maxZoom: MAX_ZOOM,
          noWrap: true
        }).addTo(map);
      } else if (gridLayer) {
        map.removeLayer(gridLayer);
        gridLayer = null;
      }
    });

    $("menu-btn").addEventListener("click", function () {
      $("app").classList.toggle("nav-open");
    });

    window.addEventListener("hashchange", function () {
      var h = readHash();
      if (!h) return;
      hashLock = true;
      if (h.dim !== state.dim) {
        state.dim = h.dim;
        state.layer = h.layer;
        renderDims(); renderLayers(); renderTiles(false); renderMarkers(); renderWaypointList();
      } else if (h.layer !== state.layer) {
        state.layer = h.layer;
        renderTiles(false); renderLayers();
      }
      if (h.center) map.setView(h.center, h.zoom !== null ? h.zoom : map.getZoom());
      hashLock = false;
    });

    setTimeout(function () {
      var hint = $("hint");
      if (hint) hint.style.transition = "opacity .6s", hint.style.opacity = "0";
    }, 5000);
  }).catch(function (err) {
    console.error(err);
    fail("Could not load map data (" + err.message + ").");
  });
})();
