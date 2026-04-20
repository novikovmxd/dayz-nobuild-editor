/* global L */

const WORLD_SIZE = 15360;
const MIN_ZOOM = 1;
const MAX_ZOOM = 7;
const TILE_BASE = 'https://static.xam.nu/dayz/maps/chernarusplus/1.27';

const state = { mapLayer: 'satellite', labelsVisible: true };

const worldCRS = L.extend({}, L.CRS.Simple, {
    scale: function (z) { return 256 * Math.pow(2, z) / WORLD_SIZE; },
    zoom: function (s) { return Math.log(s * WORLD_SIZE / 256) / Math.LN2; },
    distance: function (a, b) {
        const dx = b.lng - a.lng, dy = b.lat - a.lat;
        return Math.sqrt(dx * dx + dy * dy);
    },
    transformation: new L.Transformation(1, 0, -1, WORLD_SIZE),
    infinite: true,
});

const toLatLng = (x, z) => L.latLng(z, x);
const fromLatLng = (ll) => [ll.lng, ll.lat];

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

// ─── Labels (identical behavior to editor) ───────────────────────────────────
const LABEL_MIN_ZOOM = { capital: 1, city: 2, village: 3, local: 5 };
const labelsLayer = L.layerGroup().addTo(map);
const locationMarkers = [];

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

async function loadLabels() {
    try {
        const r = await fetch('https://static.xam.nu/dayz/json/chernarusplus/1.29.json');
        if (!r.ok) return;
        const d = await r.json();
        for (const loc of d.markers?.locations ?? []) {
            if (!(loc.w in LABEL_MIN_ZOOM) || loc.a === 0) continue;
            const wx = loc.p[1] * 60;
            const wz = (loc.p[0] + 256) * 60;
            const name = loc.s?.[1] || loc.s?.[0] || '';
            if (!name) continue;
            const marker = L.marker(toLatLng(wx, wz), {
                interactive: false, keyboard: false,
                icon: L.divIcon({ className: `loc-label loc-${loc.w}`, html: name, iconSize: null }),
                zIndexOffset: -1000,
            });
            locationMarkers.push({ marker, tier: loc.w });
        }
        applyLabelZoomFilter();
    } catch (err) {
        console.warn('Не удалось загрузить подписи:', err);
    }
}
loadLabels();
map.on('zoomend', applyLabelZoomFilter);

// ─── HUD ─────────────────────────────────────────────────────────────────────
const hud = document.getElementById('coord-hud');
map.on('mousemove', (e) => {
    const [x, z] = fromLatLng(e.latlng);
    hud.textContent = `X:${x.toFixed(1)}  Z:${z.toFixed(1)}`;
});
map.on('mouseout', () => { hud.textContent = ''; });

// ─── Toolbar ─────────────────────────────────────────────────────────────────
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

// ─── Public config (read-only zones) ─────────────────────────────────────────
async function loadPublicConfig() {
    const updatedEl = document.getElementById('updated');
    try {
        const r = await fetch(`./public-config.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) { updatedEl.textContent = 'конфиг не опубликован'; return; }
        const cfg = await r.json();
        const lastMod = r.headers.get('last-modified');
        updatedEl.textContent = lastMod ? `обновлён ${new Date(lastMod).toLocaleString('ru-RU')}` : '';
        for (const z of cfg?.Zones?.Circles ?? []) {
            if (!Array.isArray(z.Center) || typeof z.Radius !== 'number') continue;
            L.circle(toLatLng(z.Center[0], z.Center[2]), {
                radius: z.Radius,
                color: '#ff6b35', fillColor: '#ff6b35', fillOpacity: 0.18,
                weight: 2, interactive: false,
            }).addTo(map);
        }
        for (const p of cfg?.Zones?.Polygons ?? []) {
            if (!p.Points?.length) continue;
            L.polygon(p.Points.map(pt => toLatLng(pt[0], pt[2])), {
                color: '#ff6b35', fillColor: '#ff6b35', fillOpacity: 0.18,
                weight: 2, interactive: false,
            }).addTo(map);
        }
    } catch (err) {
        console.warn('Не удалось загрузить public-config.json:', err);
        updatedEl.textContent = 'ошибка загрузки';
    }
}
loadPublicConfig();
