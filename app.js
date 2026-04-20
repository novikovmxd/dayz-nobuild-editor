/* global L */

const WORLD_SIZE = 15360;
const MIN_ZOOM = 1;
const MAX_ZOOM = 7;
const TILE_BASE = 'https://static.xam.nu/dayz/maps/chernarusplus/1.27';

const state = {
    fileHandle: null,
    config: null,
    active: null,            // { kind: 'circle'|'polygon', idx } | null
    mapLayer: 'satellite',
    addingCircle: false,
    addingPolygon: null,     // { points: [[x,z], ...], poly, markers: [] } | null
    labelsVisible: true,
};

// ─── IndexedDB for file handle persistence ───────────────────────────────────
const idbName = 'nobuild-editor';
function idbGet(key) {
    return new Promise((resolve) => {
        const r = indexedDB.open(idbName, 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => {
            const tx = r.result.transaction('kv', 'readonly');
            const g = tx.objectStore('kv').get(key);
            g.onsuccess = () => resolve(g.result);
            g.onerror = () => resolve(undefined);
        };
        r.onerror = () => resolve(undefined);
    });
}
function idbSet(key, value) {
    return new Promise((resolve) => {
        const r = indexedDB.open(idbName, 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => {
            const tx = r.result.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(value, key);
            tx.oncomplete = () => resolve();
        };
        r.onerror = () => resolve();
    });
}

// ─── Coordinate conversion ────────────────────────────────────────────────────
// World: X=east, Z=north, Y=up (ignored). World range: 0..WORLD_SIZE.
// Leaflet CRS.Simple: latLng(lat, lng), lat=y-axis, lng=x-axis. Default transformation
// flips Y, which matches "north-up" rendering if we use lat=Z.
// Choose CRS so 1 world meter == 1 Leaflet unit. Tiles at zoom 0 cover 256 px,
// scaled to WORLD_SIZE world meters.
const worldCRS = L.extend({}, L.CRS.Simple, {
    // scale(z) = pixels per Leaflet unit at zoom z.
    // We want at zoom MAX_ZOOM: full world (WORLD_SIZE units) = 256 * 2^MAX_ZOOM pixels.
    //   scale(MAX_ZOOM) = 256 * 2^MAX_ZOOM / WORLD_SIZE
    // Using default pattern scale(z) = 2^z * baseScale
    //   baseScale = 256 / WORLD_SIZE
    scale: function (z) { return 256 * Math.pow(2, z) / WORLD_SIZE; },
    zoom: function (s) { return Math.log(s * WORLD_SIZE / 256) / Math.LN2; },
    distance: function (a, b) {
        const dx = b.lng - a.lng, dy = b.lat - a.lat;
        return Math.sqrt(dx * dx + dy * dy);
    },
    transformation: new L.Transformation(1, 0, -1, WORLD_SIZE),
    infinite: true,
});

// world [x, z] (meters, Z=north, grows upward) → Leaflet latLng
// Tile Y-axis grows downward (north tile y=0), CRS transformation flips Y,
// so we pass lat=z directly; the transformation handles the flip.
const toLatLng = (x, z) => L.latLng(z, x);
const fromLatLng = (ll) => [ll.lng, ll.lat];

// ─── Map setup ────────────────────────────────────────────────────────────────
const map = L.map('map', {
    crs: worldCRS,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    zoomControl: true,
    attributionControl: false,
    maxBounds: [[-1000, -1000], [WORLD_SIZE + 1000, WORLD_SIZE + 1000]],
    maxBoundsViscosity: 1.0,
}).setView([WORLD_SIZE / 2, WORLD_SIZE / 2], 3);

L.control.attribution({ prefix: 'Tiles © <a href="https://dayz.xam.nu">xam.nu</a>' }).addTo(map);

const tileOpts = {
    minZoom: 0,
    maxZoom: MAX_ZOOM,
    tileSize: 256,
    noWrap: true,
    bounds: [[0, 0], [WORLD_SIZE, WORLD_SIZE]],
};
const tileUrl = (type) => `${TILE_BASE}/${type}/{z}/{x}/{y}.webp`;
let tileLayer = L.tileLayer(tileUrl(state.mapLayer), tileOpts).addTo(map);

// ─── Location labels (cities, villages, etc.) ────────────────────────────────
// Loaded from xam.nu's map metadata JSON. Coordinates there are in xam.nu's
// Leaflet frame: p[0]=lat, p[1]=lng, with lat = 256*z/size - 256, lng = 256*x/size.
// Inverse: world_x = p[1]*size/256, world_z = (p[0]+256)*size/256.  size=15360
// → multiplier is exactly 60.
const LABEL_MIN_ZOOM = { capital: 1, city: 2, village: 3, local: 5 };
const labelsLayer = L.layerGroup().addTo(map);
const locationMarkers = []; // [{ marker, tier }]

function applyLabelZoomFilter() {
    if (!state.labelsVisible) return;
    const z = map.getZoom();
    for (const { marker, tier } of locationMarkers) {
        const shouldShow = z >= (LABEL_MIN_ZOOM[tier] ?? 99);
        const present = labelsLayer.hasLayer(marker);
        if (shouldShow && !present) labelsLayer.addLayer(marker);
        else if (!shouldShow && present) labelsLayer.removeLayer(marker);
    }
}

function setLabelsVisible(v) {
    state.labelsVisible = v;
    if (v) {
        if (!map.hasLayer(labelsLayer)) map.addLayer(labelsLayer);
        applyLabelZoomFilter();
    } else {
        if (map.hasLayer(labelsLayer)) map.removeLayer(labelsLayer);
    }
}

// POI categories — displayed using xam.nu's own icon sprites (loaded from dayz.xam.nu).
// Icon hashes resolved from xam.nu JS bundle: module "./<faction>-<weight>.webp" → images/<hash>.webp
const XAM_ICON_BASE = 'https://dayz.xam.nu/images/';
const ICON_HASH = {
    'police-high':         '421bcf90.webp',
    'firefighter-high':    'e56f1634.webp',
    'medic-high':          'd1485496.webp',
    'medic-medium':        'd29f5a23.webp',
    'food-waterpump':      '5175d19c.webp',
    'landmark-watertower': '0fbc87b4.webp',
};
const POI_CATEGORIES = {
    police: {
        label: 'Полиция',
        buildings: [
            { key: 'land_city_policestation',    icon: 'police-high',      size: 16 },
            { key: 'land_village_policestation', icon: 'police-high',      size: 16 },
        ],
    },
    fire: {
        label: 'Пожарка',
        buildings: [
            { key: 'land_city_firestation', icon: 'firefighter-high', size: 16 },
            { key: 'land_mil_firestation',  icon: 'firefighter-high', size: 16 },
        ],
    },
    medical: {
        label: 'Медицина',
        buildings: [
            { key: 'land_city_hospital',      icon: 'medic-high',   size: 16 },
            { key: 'land_village_healthcare', icon: 'medic-high',   size: 16 },
            { key: 'land_medical_tent_big',   icon: 'medic-medium', size: 14 },
        ],
    },
    water: {
        label: 'Вода',
        buildings: [
            { key: 'land_misc_well_pump_blue',   icon: 'food-waterpump',      size: 14 },
            { key: 'land_misc_well_pump_yellow', icon: 'food-waterpump',      size: 14 },
            { key: 'land_water_station',         icon: 'landmark-watertower', size: 16 },
        ],
    },
};
const poiLayers = {};         // id → L.layerGroup
const poiVisible = {};        // id → bool
for (const id of Object.keys(POI_CATEGORIES)) {
    poiLayers[id] = L.layerGroup().addTo(map);
    poiVisible[id] = true;
}

async function loadMapData() {
    try {
        const r = await fetch('https://static.xam.nu/dayz/json/chernarusplus/1.29.json');
        if (!r.ok) return;
        const d = await r.json();

        // City / village labels
        for (const loc of d.markers?.locations ?? []) {
            if (!(loc.w in LABEL_MIN_ZOOM) || loc.a === 0) continue;
            const wx = loc.p[1] * 60;
            const wz = (loc.p[0] + 256) * 60;
            const name = loc.s?.[1] || loc.s?.[0] || '';
            if (!name) continue;
            const marker = L.marker(toLatLng(wx, wz), {
                interactive: false, keyboard: false,
                icon: L.divIcon({
                    className: `loc-label loc-${loc.w}`,
                    html: name,
                    iconSize: null,
                }),
                zIndexOffset: -1000,
            });
            locationMarkers.push({ marker, tier: loc.w });
        }
        applyLabelZoomFilter();

        // POI icons — use xam.nu's own sprite images for visual parity
        const icons = d.markers?.icons ?? {};
        for (const [id, cfg] of Object.entries(POI_CATEGORIES)) {
            for (const b of cfg.buildings) {
                const entry = icons[b.key];
                if (!entry?.p) continue;
                const hash = ICON_HASH[b.icon];
                if (!hash) continue;
                const iconUrl = XAM_ICON_BASE + hash;
                const iconSize = b.size || 16;
                const leafletIcon = L.icon({
                    iconUrl,
                    iconSize: [iconSize, iconSize],
                    iconAnchor: [iconSize / 2, iconSize / 2],
                    className: `poi-sprite poi-${id}`,
                });
                for (const pt of entry.p) {
                    const lat = pt?.[0]?.[0];
                    const lng = pt?.[0]?.[1];
                    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
                    const wx = lng * 60;
                    const wz = (lat + 256) * 60;
                    const marker = L.marker(toLatLng(wx, wz), {
                        icon: leafletIcon,
                        keyboard: false,
                        zIndexOffset: -500,
                    });
                    marker.bindTooltip(cfg.label, { direction: 'top', offset: [0, -8], className: 'poi-tooltip' });
                    poiLayers[id].addLayer(marker);
                }
            }
        }
    } catch (err) {
        console.warn('Не удалось загрузить данные карты:', err);
    }
}
loadMapData();
map.on('zoomend', applyLabelZoomFilter);

// HUD: world coords under cursor
const hud = document.getElementById('coord-hud');
map.on('mousemove', (e) => {
    const [x, z] = fromLatLng(e.latlng);
    hud.textContent = `X:${x.toFixed(1)}  Z:${z.toFixed(1)}`;
});
map.on('mouseout', () => { hud.textContent = ''; });

// ─── Zone layers ──────────────────────────────────────────────────────────────
const circleLayers = new Map();  // idx → { shape, handle }
const polygonLayers = new Map(); // idx → { shape, handles: L.marker[] }

const COLOR = { base: '#ff6b35', active: '#ffcc4d' };

function buildCircleLayer(idx) {
    const zone = state.config.Zones.Circles[idx];
    const center = toLatLng(zone.Center[0], zone.Center[2]);

    const shape = L.circle(center, {
        radius: zone.Radius,
        color: COLOR.base, fillColor: COLOR.base, fillOpacity: 0.18,
        weight: 2, bubblingMouseEvents: false,
    }).addTo(map);

    shape.bindTooltip(zone.Name || '(без имени)', {
        permanent: true, direction: 'top', offset: [0, -4], className: 'zone-tooltip',
    });

    shape.on('click', (e) => { L.DomEvent.stopPropagation(e); selectZone('circle', idx); });
    shape.on('mousedown', (e) => startDragCircleCenter(idx, e));

    const handle = L.marker(edgePoint(center, zone.Radius), {
        icon: L.divIcon({ className: 'radius-handle', iconSize: [10, 10] }),
        draggable: false, keyboard: false, interactive: true,
    }).addTo(map);
    handle.on('mousedown', (e) => startDragCircleRadius(idx, e));

    circleLayers.set(idx, { shape, handle });
}

function edgePoint(centerLL, radius) {
    const [x, z] = fromLatLng(centerLL);
    return toLatLng(x + radius, z);
}

function refreshCircleLayer(idx) {
    const layer = circleLayers.get(idx);
    if (!layer) return;
    const zone = state.config.Zones.Circles[idx];
    const center = toLatLng(zone.Center[0], zone.Center[2]);
    layer.shape.setLatLng(center);
    layer.shape.setRadius(zone.Radius);
    layer.shape.setTooltipContent(zone.Name || '(без имени)');
    layer.handle.setLatLng(edgePoint(center, zone.Radius));
    const active = isActive('circle', idx);
    layer.shape.setStyle({
        color: active ? COLOR.active : COLOR.base,
        fillColor: active ? COLOR.active : COLOR.base,
        weight: active ? 3 : 2,
        fillOpacity: active ? 0.3 : 0.18,
    });
}

function removeCircleLayer(idx) {
    const layer = circleLayers.get(idx);
    if (!layer) return;
    map.removeLayer(layer.shape);
    map.removeLayer(layer.handle);
    circleLayers.delete(idx);
}

function buildPolygonLayer(idx) {
    const poly = state.config.Zones.Polygons[idx];
    const latlngs = poly.Points.map(p => toLatLng(p[0], p[2]));

    const shape = L.polygon(latlngs, {
        color: COLOR.base, fillColor: COLOR.base, fillOpacity: 0.18,
        weight: 2, bubblingMouseEvents: false,
    }).addTo(map);

    shape.bindTooltip(poly.Name || '(без имени)', {
        permanent: true, direction: 'top', offset: [0, -4], className: 'zone-tooltip',
    });

    shape.on('click', (e) => { L.DomEvent.stopPropagation(e); selectZone('polygon', idx); });
    shape.on('mousedown', (e) => startDragPolygonBody(idx, e));

    const handles = poly.Points.map((p, vi) => {
        const h = L.marker(toLatLng(p[0], p[2]), {
            icon: L.divIcon({ className: 'vertex-handle', iconSize: [8, 8] }),
            draggable: false, keyboard: false, interactive: true,
        }).addTo(map);
        h.on('mousedown', (e) => startDragPolygonVertex(idx, vi, e));
        return h;
    });

    polygonLayers.set(idx, { shape, handles });
}

function refreshPolygonLayer(idx) {
    const layer = polygonLayers.get(idx);
    if (!layer) return;
    const poly = state.config.Zones.Polygons[idx];
    const latlngs = poly.Points.map(p => toLatLng(p[0], p[2]));
    layer.shape.setLatLngs(latlngs);
    layer.shape.setTooltipContent(poly.Name || '(без имени)');
    layer.handles.forEach((h, i) => h.setLatLng(latlngs[i]));
    const active = isActive('polygon', idx);
    layer.shape.setStyle({
        color: active ? COLOR.active : COLOR.base,
        fillColor: active ? COLOR.active : COLOR.base,
        weight: active ? 3 : 2,
        fillOpacity: active ? 0.3 : 0.18,
    });
}

function removePolygonLayer(idx) {
    const layer = polygonLayers.get(idx);
    if (!layer) return;
    map.removeLayer(layer.shape);
    layer.handles.forEach(h => map.removeLayer(h));
    polygonLayers.delete(idx);
}

function rebuildAllZoneLayers() {
    for (const idx of [...circleLayers.keys()]) removeCircleLayer(idx);
    for (const idx of [...polygonLayers.keys()]) removePolygonLayer(idx);
    if (!state.config) return;
    for (let i = 0; i < state.config.Zones.Circles.length; i++) buildCircleLayer(i);
    for (let i = 0; i < state.config.Zones.Polygons.length; i++) buildPolygonLayer(i);
}

function startDragCircleCenter(idx, e) {
    L.DomEvent.stopPropagation(e);
    if (e.originalEvent) L.DomEvent.preventDefault(e.originalEvent);
    map.dragging.disable();
    const zone = state.config.Zones.Circles[idx];
    const startLL = e.latlng;
    const startCX = zone.Center[0], startCZ = zone.Center[2];
    const onMove = (ev) => {
        const dLng = ev.latlng.lng - startLL.lng;
        const dLat = ev.latlng.lat - startLL.lat;
        zone.Center = [round2(startCX + dLng), 0, round2(startCZ + dLat)];
        refreshCircleLayer(idx);
        if (isActive('circle', idx)) updateZoneCardInputs();
    };
    const onUp = () => { map.off('mousemove', onMove); map.off('mouseup', onUp); map.dragging.enable(); };
    map.on('mousemove', onMove);
    map.on('mouseup', onUp);
    selectZone('circle', idx);
}

function startDragCircleRadius(idx, e) {
    L.DomEvent.stopPropagation(e);
    if (e.originalEvent) L.DomEvent.preventDefault(e.originalEvent);
    map.dragging.disable();
    const zone = state.config.Zones.Circles[idx];
    const onMove = (ev) => {
        const [cx, cz] = [zone.Center[0], zone.Center[2]];
        const [mx, mz] = fromLatLng(ev.latlng);
        zone.Radius = Math.max(5, Math.round(Math.hypot(mx - cx, mz - cz)));
        refreshCircleLayer(idx);
        if (isActive('circle', idx)) updateZoneCardInputs();
    };
    const onUp = () => { map.off('mousemove', onMove); map.off('mouseup', onUp); map.dragging.enable(); };
    map.on('mousemove', onMove);
    map.on('mouseup', onUp);
    selectZone('circle', idx);
}

function startDragPolygonBody(idx, e) {
    L.DomEvent.stopPropagation(e);
    if (e.originalEvent) L.DomEvent.preventDefault(e.originalEvent);
    map.dragging.disable();
    const poly = state.config.Zones.Polygons[idx];
    const startLL = e.latlng;
    const startPoints = poly.Points.map(p => [p[0], p[2]]);
    const onMove = (ev) => {
        const dLng = ev.latlng.lng - startLL.lng;
        const dLat = ev.latlng.lat - startLL.lat;
        poly.Points = startPoints.map(([x, z]) => [round2(x + dLng), 0, round2(z + dLat)]);
        refreshPolygonLayer(idx);
        if (isActive('polygon', idx)) updateZoneCardInputs();
    };
    const onUp = () => { map.off('mousemove', onMove); map.off('mouseup', onUp); map.dragging.enable(); };
    map.on('mousemove', onMove);
    map.on('mouseup', onUp);
    selectZone('polygon', idx);
}

function startDragPolygonVertex(idx, vi, e) {
    L.DomEvent.stopPropagation(e);
    if (e.originalEvent) L.DomEvent.preventDefault(e.originalEvent);
    map.dragging.disable();
    const poly = state.config.Zones.Polygons[idx];
    const onMove = (ev) => {
        const [x, z] = fromLatLng(ev.latlng);
        poly.Points[vi] = [round2(x), 0, round2(z)];
        refreshPolygonLayer(idx);
        if (isActive('polygon', idx)) updateZoneCardInputs();
    };
    const onUp = () => { map.off('mousemove', onMove); map.off('mouseup', onUp); map.dragging.enable(); };
    map.on('mousemove', onMove);
    map.on('mouseup', onUp);
    selectZone('polygon', idx);
}

const round2 = (v) => Math.round(v * 100) / 100;

// ─── Zone selection ───────────────────────────────────────────────────────────
function isActive(kind, idx) {
    return state.active && state.active.kind === kind && state.active.idx === idx;
}

function refreshActiveLayer(prev) {
    if (!prev) return;
    if (prev.kind === 'circle' && prev.idx < (state.config?.Zones?.Circles?.length ?? 0)) refreshCircleLayer(prev.idx);
    if (prev.kind === 'polygon' && prev.idx < (state.config?.Zones?.Polygons?.length ?? 0)) refreshPolygonLayer(prev.idx);
}

function selectZone(kind, idx) {
    const prev = state.active;
    state.active = (kind && idx >= 0) ? { kind, idx } : null;
    refreshActiveLayer(prev);
    if (state.active) {
        if (kind === 'circle') refreshCircleLayer(idx);
        else refreshPolygonLayer(idx);
    }
    renderZoneList();
    if (state.active) {
        if (kind === 'circle') {
            const z = state.config.Zones.Circles[idx];
            map.panTo(toLatLng(z.Center[0], z.Center[2]));
        } else {
            const p = state.config.Zones.Polygons[idx];
            if (p.Points.length) map.panTo(polygonCenter(p.Points));
        }
    }
}

function polygonCenter(points) {
    let sx = 0, sz = 0;
    for (const p of points) { sx += p[0]; sz += p[2]; }
    return toLatLng(sx / points.length, sz / points.length);
}

// ─── Adding new circle ────────────────────────────────────────────────────────
document.getElementById('btn-add-circle').addEventListener('click', () => {
    if (state.addingPolygon) cancelPolygonDraft();
    state.addingCircle = !state.addingCircle;
    document.body.classList.toggle('adding-zone-cursor', state.addingCircle);
    document.getElementById('btn-add-circle').style.background = state.addingCircle ? 'var(--accent)' : '';
    toast(state.addingCircle ? 'Кликни по карте, чтобы создать круг (ESC — отмена)' : 'Отменено');
});

// ─── Adding new polygon ───────────────────────────────────────────────────────
document.getElementById('btn-add-polygon').addEventListener('click', () => {
    if (state.addingCircle) {
        state.addingCircle = false;
        document.body.classList.remove('adding-zone-cursor');
        document.getElementById('btn-add-circle').style.background = '';
    }
    if (state.addingPolygon) {
        cancelPolygonDraft();
    } else {
        state.addingPolygon = { points: [], poly: null, markers: [] };
        document.body.classList.add('adding-zone-cursor');
        document.getElementById('btn-add-polygon').style.background = 'var(--accent)';
        toast('Кликни по карте для точек полигона. Двойной клик — готово, ESC — отмена');
    }
});

function cancelPolygonDraft() {
    if (!state.addingPolygon) return;
    if (state.addingPolygon.poly) map.removeLayer(state.addingPolygon.poly);
    state.addingPolygon.markers.forEach(m => map.removeLayer(m));
    state.addingPolygon = null;
    document.body.classList.remove('adding-zone-cursor');
    document.getElementById('btn-add-polygon').style.background = '';
}

function commitPolygonDraft() {
    if (!state.addingPolygon) return;
    const pts = state.addingPolygon.points;
    if (pts.length < 3) { toast('Минимум 3 точки', 'err'); return; }
    const n = state.config.Zones.Polygons.length + 1;
    state.config.Zones.Polygons.push({
        Name: `Полигон ${n}`,
        Points: pts.map(([x, z]) => [round2(x), 0, round2(z)]),
    });
    const idx = state.config.Zones.Polygons.length - 1;
    cancelPolygonDraft();
    buildPolygonLayer(idx);
    selectZone('polygon', idx);
    renderZoneList();
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (state.addingCircle) {
            state.addingCircle = false;
            document.body.classList.remove('adding-zone-cursor');
            document.getElementById('btn-add-circle').style.background = '';
        }
        if (state.addingPolygon) cancelPolygonDraft();
    }
    if (e.key === 'Enter' && state.addingPolygon) {
        e.preventDefault();
        commitPolygonDraft();
    }
    const typing = document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA';
    if (e.key === 'Delete' && state.active && !typing) {
        deleteActiveZone();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (state.config) saveFile();
    }
});

map.on('click', (e) => {
    if (!state.config) return;
    const [x, z] = fromLatLng(e.latlng);
    if (x < 0 || x > WORLD_SIZE || z < 0 || z > WORLD_SIZE) return;

    if (state.addingCircle) {
        state.config.Zones.Circles.push({
            Name: `Зона ${state.config.Zones.Circles.length + 1}`,
            Center: [round2(x), 0, round2(z)], Radius: 50,
        });
        const idx = state.config.Zones.Circles.length - 1;
        buildCircleLayer(idx);
        selectZone('circle', idx);
        state.addingCircle = false;
        document.body.classList.remove('adding-zone-cursor');
        document.getElementById('btn-add-circle').style.background = '';
        return;
    }

    if (state.addingPolygon) {
        state.addingPolygon.points.push([x, z]);
        const m = L.marker(e.latlng, {
            icon: L.divIcon({ className: 'draft-vertex', iconSize: [6, 6] }),
            interactive: false, keyboard: false,
        }).addTo(map);
        state.addingPolygon.markers.push(m);
        const latlngs = state.addingPolygon.points.map(([px, pz]) => toLatLng(px, pz));
        if (state.addingPolygon.poly) {
            state.addingPolygon.poly.setLatLngs(latlngs);
        } else if (latlngs.length >= 2) {
            state.addingPolygon.poly = L.polyline(latlngs, {
                color: '#6cb1ff', weight: 2, dashArray: '4 4', className: 'polygon-draft',
            }).addTo(map);
        }
    }
});

map.on('dblclick', (e) => {
    if (state.addingPolygon) {
        L.DomEvent.preventDefault(e.originalEvent);
        commitPolygonDraft();
    }
});

function deleteActiveZone() {
    if (!state.config || !state.active) return;
    const { kind, idx } = state.active;
    if (kind === 'circle') state.config.Zones.Circles.splice(idx, 1);
    else state.config.Zones.Polygons.splice(idx, 1);
    state.active = null;
    rebuildAllZoneLayers();
    renderZoneList();
    toast('Удалено');
}

// ─── Panel rendering ─────────────────────────────────────────────────────────
const el = {
    msgBlocked: document.getElementById('msg-blocked'),
    adminBypass: document.getElementById('admin-bypass'),
    blockedList: document.getElementById('blocked-list'),
    blkInput: document.getElementById('blk-input'),
    blkAdd: document.getElementById('blk-add'),
    blkCount: document.getElementById('blk-count'),
    wlList: document.getElementById('whitelist-list'),
    wlInput: document.getElementById('wl-input'),
    wlAdd: document.getElementById('wl-add'),
    wlCount: document.getElementById('wl-count'),
    circleList: document.getElementById('circle-list'),
    polygonList: document.getElementById('polygon-list'),
    circleCount: document.getElementById('circle-count'),
    polygonCount: document.getElementById('polygon-count'),
    zoneCount: document.getElementById('zone-count'),
    fileName: document.getElementById('file-name'),
};

function enablePanel(on) {
    [el.msgBlocked, el.adminBypass, el.blkInput, el.blkAdd, el.wlInput, el.wlAdd].forEach(x => x.disabled = !on);
    document.getElementById('btn-save').disabled = !on || !state.fileHandle;
    document.getElementById('btn-download').disabled = !on;
    document.getElementById('btn-add-circle').disabled = !on;
    document.getElementById('btn-add-polygon').disabled = !on;
}

function renderAll() {
    if (!state.config) return;
    el.msgBlocked.value = state.config.MessageOnBlockedDeploy || '';
    el.adminBypass.checked = !!state.config.AdminBypass;
    renderChips(el.blockedList, state.config.BlockedClasses, (list, i) => { list.splice(i, 1); });
    el.blkCount.textContent = state.config.BlockedClasses.length;
    renderChips(el.wlList, state.config.AdminSteam64Whitelist, (list, i) => { list.splice(i, 1); });
    el.wlCount.textContent = state.config.AdminSteam64Whitelist.length;
    renderZoneList();
}

function renderChips(container, arr, onRemove) {
    container.innerHTML = '';
    arr.forEach((v, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<span></span> <button title="Удалить" aria-label="Удалить">×</button>`;
        li.firstElementChild.textContent = v;
        li.querySelector('button').addEventListener('click', () => {
            onRemove(arr, i);
            renderAll();
        });
        container.appendChild(li);
    });
}

function renderZoneList() {
    el.circleList.innerHTML = '';
    el.polygonList.innerHTML = '';
    if (!state.config) {
        el.zoneCount.textContent = '';
        el.circleCount.textContent = '';
        el.polygonCount.textContent = '';
        return;
    }
    const circles = state.config.Zones.Circles;
    const polygons = state.config.Zones.Polygons;
    el.zoneCount.textContent = circles.length + polygons.length;
    el.circleCount.textContent = circles.length;
    el.polygonCount.textContent = polygons.length;

    circles.forEach((zone, i) => {
        const li = document.createElement('li');
        const active = isActive('circle', i);
        li.className = 'zone-item' + (active ? ' active' : '');
        const [x, , z] = zone.Center;
        li.innerHTML = `
            <span class="zname"></span>
            <span class="zmeta">${x.toFixed(0)},${z.toFixed(0)} r=${zone.Radius}</span>
        `;
        li.firstElementChild.textContent = zone.Name || '(без имени)';
        li.addEventListener('click', (e) => {
            if (e.target.closest('.zone-card')) return;
            selectZone('circle', i);
        });
        if (active) li.appendChild(buildCircleCard(i));
        el.circleList.appendChild(li);
    });

    polygons.forEach((poly, i) => {
        const li = document.createElement('li');
        const active = isActive('polygon', i);
        li.className = 'zone-item' + (active ? ' active' : '');
        const c = poly.Points.length ? polygonCentroid(poly.Points) : [0, 0];
        li.innerHTML = `
            <span class="zname"></span>
            <span class="zmeta">${c[0].toFixed(0)},${c[1].toFixed(0)} v=${poly.Points.length}</span>
        `;
        li.firstElementChild.textContent = poly.Name || '(без имени)';
        li.addEventListener('click', (e) => {
            if (e.target.closest('.zone-card')) return;
            selectZone('polygon', i);
        });
        if (active) li.appendChild(buildPolygonCard(i));
        el.polygonList.appendChild(li);
    });
}

function polygonCentroid(points) {
    let sx = 0, sz = 0;
    for (const p of points) { sx += p[0]; sz += p[2]; }
    return [sx / points.length, sz / points.length];
}

function buildCircleCard(idx) {
    const zone = state.config.Zones.Circles[idx];
    const div = document.createElement('div');
    div.className = 'zone-card';
    div.innerHTML = `
        <label>Name</label><input type="text" data-field="Name">
        <label>X</label><input type="number" step="0.01" data-field="X">
        <label>Z</label><input type="number" step="0.01" data-field="Z">
        <label>R, м</label><input type="number" step="1" min="1" data-field="R">
        <div class="zone-card-actions">
            <button class="danger" data-action="del">🗑 Удалить</button>
        </div>
    `;
    div.querySelector('[data-field="Name"]').value = zone.Name || '';
    div.querySelector('[data-field="X"]').value = zone.Center[0];
    div.querySelector('[data-field="Z"]').value = zone.Center[2];
    div.querySelector('[data-field="R"]').value = zone.Radius;

    div.addEventListener('click', (e) => e.stopPropagation());

    div.querySelector('[data-field="Name"]').addEventListener('input', (e) => {
        zone.Name = e.target.value;
        refreshCircleLayer(idx);
        const li = el.circleList.querySelectorAll('.zone-item')[idx];
        if (li) li.querySelector('.zname').textContent = zone.Name || '(без имени)';
    });
    div.querySelector('[data-field="X"]').addEventListener('input', (e) => {
        zone.Center = [parseFloat(e.target.value) || 0, 0, zone.Center[2]];
        refreshCircleLayer(idx);
        updateCircleRowMeta(idx);
    });
    div.querySelector('[data-field="Z"]').addEventListener('input', (e) => {
        zone.Center = [zone.Center[0], 0, parseFloat(e.target.value) || 0];
        refreshCircleLayer(idx);
        updateCircleRowMeta(idx);
    });
    div.querySelector('[data-field="R"]').addEventListener('input', (e) => {
        zone.Radius = Math.max(1, parseInt(e.target.value, 10) || 1);
        refreshCircleLayer(idx);
        updateCircleRowMeta(idx);
    });
    div.querySelector('[data-action="del"]').addEventListener('click', () => deleteActiveZone());
    return div;
}

function buildPolygonCard(idx) {
    const poly = state.config.Zones.Polygons[idx];
    const div = document.createElement('div');
    div.className = 'zone-card';
    div.innerHTML = `
        <label>Name</label><input type="text" data-field="Name">
        <label>Вершин</label><span data-field="V"></span>
        <div class="zone-card-actions">
            <button class="danger" data-action="del">🗑 Удалить</button>
        </div>
    `;
    div.querySelector('[data-field="Name"]').value = poly.Name || '';
    div.querySelector('[data-field="V"]').textContent = poly.Points.length;

    div.addEventListener('click', (e) => e.stopPropagation());

    div.querySelector('[data-field="Name"]').addEventListener('input', (e) => {
        poly.Name = e.target.value;
        refreshPolygonLayer(idx);
        const li = el.polygonList.querySelectorAll('.zone-item')[idx];
        if (li) li.querySelector('.zname').textContent = poly.Name || '(без имени)';
    });
    div.querySelector('[data-action="del"]').addEventListener('click', () => deleteActiveZone());
    return div;
}

function updateZoneCardInputs() {
    if (!state.active) return;
    const { kind, idx } = state.active;
    if (kind === 'circle') {
        const zone = state.config.Zones.Circles[idx];
        const card = el.circleList.querySelector('.zone-card');
        if (!card) return;
        card.querySelector('[data-field="X"]').value = zone.Center[0];
        card.querySelector('[data-field="Z"]').value = zone.Center[2];
        card.querySelector('[data-field="R"]').value = zone.Radius;
        updateCircleRowMeta(idx);
    } else {
        const poly = state.config.Zones.Polygons[idx];
        const card = el.polygonList.querySelector('.zone-card');
        if (card) card.querySelector('[data-field="V"]').textContent = poly.Points.length;
        updatePolygonRowMeta(idx);
    }
}

function updateCircleRowMeta(idx) {
    const li = el.circleList.querySelectorAll('.zone-item')[idx];
    if (!li) return;
    const zone = state.config.Zones.Circles[idx];
    li.querySelector('.zmeta').textContent = `${zone.Center[0].toFixed(0)},${zone.Center[2].toFixed(0)} r=${zone.Radius}`;
}

function updatePolygonRowMeta(idx) {
    const li = el.polygonList.querySelectorAll('.zone-item')[idx];
    if (!li) return;
    const poly = state.config.Zones.Polygons[idx];
    const c = poly.Points.length ? polygonCentroid(poly.Points) : [0, 0];
    li.querySelector('.zmeta').textContent = `${c[0].toFixed(0)},${c[1].toFixed(0)} v=${poly.Points.length}`;
}

// ─── Panel events ─────────────────────────────────────────────────────────────
el.msgBlocked.addEventListener('input', () => { state.config.MessageOnBlockedDeploy = el.msgBlocked.value; });
el.adminBypass.addEventListener('change', () => { state.config.AdminBypass = el.adminBypass.checked ? 1 : 0; });

el.blkAdd.addEventListener('click', () => {
    const v = el.blkInput.value.trim();
    if (!v) return;
    state.config.BlockedClasses.push(v);
    el.blkInput.value = '';
    renderAll();
});
el.blkInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blkAdd.click(); });

el.wlAdd.addEventListener('click', () => {
    const v = el.wlInput.value.trim();
    if (!v) return;
    state.config.AdminSteam64Whitelist.push(v);
    el.wlInput.value = '';
    renderAll();
});
el.wlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.wlAdd.click(); });

// ─── Layer toggle ─────────────────────────────────────────────────────────────
document.getElementById('btn-layer').addEventListener('click', () => {
    state.mapLayer = state.mapLayer === 'topographic' ? 'satellite' : 'topographic';
    map.removeLayer(tileLayer);
    tileLayer = L.tileLayer(tileUrl(state.mapLayer), tileOpts).addTo(map);
    tileLayer.bringToBack();
    document.getElementById('btn-layer').textContent = state.mapLayer === 'topographic' ? '🛰 Спутник' : '🗺 Топо';
});

document.getElementById('btn-labels').addEventListener('click', () => {
    setLabelsVisible(!state.labelsVisible);
    document.getElementById('btn-labels').classList.toggle('off', !state.labelsVisible);
});

document.querySelectorAll('.poi-toggle').forEach(btn => {
    const id = btn.dataset.poi;
    btn.classList.add('active');
    btn.addEventListener('click', () => {
        poiVisible[id] = !poiVisible[id];
        if (poiVisible[id]) map.addLayer(poiLayers[id]);
        else map.removeLayer(poiLayers[id]);
        btn.classList.toggle('active', poiVisible[id]);
    });
});

// ─── Serializer ───────────────────────────────────────────────────────────────
function ind(n) { return '    '.repeat(n); }
function formatFloat(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!Number.isFinite(n)) return '0';
    const s = String(n);
    return s.includes('.') || s.includes('e') ? s : s + '.0';
}
function formatInt(v) {
    const n = typeof v === 'number' ? v : parseInt(v, 10);
    return String(Number.isFinite(n) ? Math.trunc(n) : 0);
}
function formatCenter(arr) {
    const x = formatFloat(arr?.[0] ?? 0);
    const y = formatFloat(arr?.[1] ?? 0);
    const z = formatFloat(arr?.[2] ?? 0);
    return `[${x}, ${y}, ${z}]`;
}
function formatStringArr(arr, depth) {
    if (!arr?.length) return '[]';
    const pad = ind(depth);
    const inner = arr.map(s => ind(depth + 1) + JSON.stringify(s)).join(',\n');
    return `[\n${inner}\n${pad}]`;
}
function formatZone(z, depth) {
    const pad = ind(depth), pad1 = ind(depth + 1);
    const parts = [
        `${pad1}"Name": ${JSON.stringify(z.Name ?? '')}`,
        `${pad1}"Center": ${formatCenter(z.Center)}`,
        `${pad1}"Radius": ${formatInt(z.Radius ?? 0)}`,
    ];
    return `${pad}{\n${parts.join(',\n')}\n${pad}}`;
}
function formatPoint(arr) {
    const x = formatInt(arr?.[0] ?? 0);
    const y = formatInt(arr?.[1] ?? 0);
    const z = formatInt(arr?.[2] ?? 0);
    return `[${x}, ${y}, ${z}]`;
}
function formatPoints(arr, depth) {
    if (!arr?.length) return '[]';
    const pad = ind(depth), pad1 = ind(depth + 1);
    const inner = arr.map(p => pad1 + formatPoint(p)).join(',\n');
    return `[\n${inner}\n${pad}]`;
}
function formatPolygon(p, depth) {
    const pad = ind(depth), pad1 = ind(depth + 1);
    const parts = [
        `${pad1}"Name": ${JSON.stringify(p.Name ?? '')}`,
        `${pad1}"Points": ${formatPoints(p.Points || [], depth + 1)}`,
    ];
    return `${pad}{\n${parts.join(',\n')}\n${pad}}`;
}
function formatDebugCfg(cfg, depth) {
    if (!cfg || typeof cfg !== 'object') return '{}';
    const pad = ind(depth), pad1 = ind(depth + 1);
    const keys = Object.keys(cfg);
    const parts = keys.map(k => {
        const v = cfg[k];
        const val = typeof v === 'number' ? formatInt(v)
            : typeof v === 'string' ? JSON.stringify(v)
            : typeof v === 'boolean' ? String(v)
            : JSON.stringify(v);
        return `${pad1}${JSON.stringify(k)}: ${val}`;
    });
    return `{\n${parts.join(',\n')}\n${pad}}`;
}
function serializeConfig(cfg) {
    const circlesArr = cfg.Zones?.Circles || [];
    const circlesStr = circlesArr.length
        ? `[\n${circlesArr.map(z => formatZone(z, 3)).join(',\n')}\n${ind(2)}]`
        : '[]';
    const polygonsArr = cfg.Zones?.Polygons || [];
    const polygonsStr = polygonsArr.length
        ? `[\n${polygonsArr.map(p => formatPolygon(p, 3)).join(',\n')}\n${ind(2)}]`
        : '[]';
    const zonesBlock = `{\n${ind(2)}"Circles": ${circlesStr},\n${ind(2)}"Polygons": ${polygonsStr}\n${ind(1)}}`;

    const parts = [
        `${ind(1)}"Version": ${JSON.stringify(cfg.Version ?? '1.0')}`,
        `${ind(1)}"MessageOnBlockedDeploy": ${JSON.stringify(cfg.MessageOnBlockedDeploy ?? '')}`,
        `${ind(1)}"AdminBypass": ${formatInt(cfg.AdminBypass ?? 0)}`,
        `${ind(1)}"AdminSteam64Whitelist": ${formatStringArr(cfg.AdminSteam64Whitelist || [], 1)}`,
        `${ind(1)}"BlockedClasses": ${formatStringArr(cfg.BlockedClasses || [], 1)}`,
        `${ind(1)}"DebugCfg": ${formatDebugCfg(cfg.DebugCfg, 1)}`,
        `${ind(1)}"Zones": ${zonesBlock}`,
    ];
    return `{\n${parts.join(',\n')}\n}\n`;
}

// ─── File I/O ─────────────────────────────────────────────────────────────────
const HAS_FSA = !!window.showOpenFilePicker;

async function openFile() {
    try {
        let text;
        if (HAS_FSA) {
            const [handle] = await window.showOpenFilePicker({
                types: [{ description: 'NoBuildZones config', accept: { 'application/json': ['.json'] } }],
            });
            state.fileHandle = handle;
            await idbSet('lastHandle', handle);
            const file = await handle.getFile();
            text = await file.text();
            el.fileName.textContent = handle.name;
        } else {
            const input = document.createElement('input');
            input.type = 'file'; input.accept = '.json';
            const file = await new Promise((res, rej) => {
                input.onchange = () => input.files[0] ? res(input.files[0]) : rej(new Error('no file'));
                input.click();
            });
            text = await file.text();
            el.fileName.textContent = file.name + ' (download-only)';
        }
        const parsed = JSON.parse(text);
        normalizeConfig(parsed);
        state.config = parsed;
        state.active = null;
        enablePanel(true);
        document.getElementById('btn-save').disabled = !state.fileHandle;
        renderAll();
        rebuildAllZoneLayers();
        const nC = parsed.Zones?.Circles?.length || 0;
        const nP = parsed.Zones?.Polygons?.length || 0;
        toast(`Загружено: ${nC} кругов, ${nP} полигонов`, 'ok');
    } catch (err) {
        if (err.name === 'AbortError') return;
        console.error(err);
        toast('Ошибка: ' + err.message, 'err');
    }
}

function normalizeConfig(cfg) {
    cfg.Version ??= '1.0';
    cfg.MessageOnBlockedDeploy ??= '';
    cfg.AdminBypass ??= 0;
    cfg.AdminSteam64Whitelist ??= [];
    cfg.BlockedClasses ??= [];
    cfg.DebugCfg ??= { Enabled: 0, DrawDistance: 500, PersistSeconds: 10 };
    cfg.Zones ??= {};
    cfg.Zones.Circles ??= [];
    cfg.Zones.Polygons ??= [];
}

async function saveFile() {
    if (!state.fileHandle || !state.config) return;
    try {
        const text = serializeConfig(state.config);
        const perm = await state.fileHandle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
            const req = await state.fileHandle.requestPermission({ mode: 'readwrite' });
            if (req !== 'granted') { toast('Нет прав на запись', 'err'); return; }
        }
        const writable = await state.fileHandle.createWritable();
        await writable.write(text);
        await writable.close();
        toast('Сохранено ✓', 'ok');
    } catch (err) {
        console.error(err);
        toast('Ошибка: ' + err.message, 'err');
    }
}

function downloadFile() {
    if (!state.config) return;
    const text = serializeConfig(state.config);
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'config.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Скачано', 'ok');
}

document.getElementById('btn-open').addEventListener('click', openFile);
document.getElementById('btn-save').addEventListener('click', saveFile);
document.getElementById('btn-download').addEventListener('click', downloadFile);

// ─── Toast ────────────────────────────────────────────────────────────────────
const toastEl = document.getElementById('toast');
let toastTimer;
function toast(msg, kind) {
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 2200);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
(async function init() {
    // Try restoring file handle from previous session
    if (HAS_FSA) {
        const h = await idbGet('lastHandle');
        if (h && typeof h.queryPermission === 'function') {
            state.fileHandle = h;
            el.fileName.textContent = h.name + ' (нажми «Открыть» чтобы подтвердить)';
        }
    }
    enablePanel(false);
})();
