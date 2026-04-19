/* global L */

const WORLD_SIZE = 15360;
const MIN_ZOOM = 1;
const MAX_ZOOM = 7;
const TILE_BASE = 'https://static.xam.nu/dayz/maps/chernarusplus/1.29';

const state = {
    fileHandle: null,
    config: null,
    activeZoneIdx: -1,
    mapLayer: 'topographic',
    adding: false,
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
    infinite: false,
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
const tileUrl = (type) => `${TILE_BASE}/${type}/{z}/{x}/{y}.jpg`;
let tileLayer = L.tileLayer(tileUrl(state.mapLayer), tileOpts).addTo(map);

// HUD: world coords under cursor
const hud = document.getElementById('coord-hud');
map.on('mousemove', (e) => {
    const [x, z] = fromLatLng(e.latlng);
    hud.textContent = `X:${x.toFixed(1)}  Z:${z.toFixed(1)}`;
});
map.on('mouseout', () => { hud.textContent = ''; });

// ─── Zone layers ──────────────────────────────────────────────────────────────
const zoneLayers = new Map(); // idx → { circle, tooltip, handle }

function buildZoneLayer(idx) {
    const zone = state.config.Zones.Circles[idx];
    const [x, , z] = zone.Center;
    const center = toLatLng(x, z);

    const circle = L.circle(center, {
        radius: zone.Radius,
        color: '#ff6b35',
        fillColor: '#ff6b35',
        fillOpacity: 0.18,
        weight: 2,
        bubblingMouseEvents: false,
    }).addTo(map);

    circle.bindTooltip(zone.Name || '(без имени)', {
        permanent: true, direction: 'top', offset: [0, -4],
        className: 'zone-tooltip',
    });

    circle.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        selectZone(idx);
    });
    circle.on('mousedown', (e) => startDragCenter(idx, e));

    const handle = L.marker(edgePoint(center, zone.Radius), {
        icon: L.divIcon({ className: 'radius-handle', iconSize: [10, 10] }),
        draggable: false, keyboard: false, interactive: true,
    }).addTo(map);
    handle.on('mousedown', (e) => startDragRadius(idx, e));

    zoneLayers.set(idx, { circle, handle });
}

function edgePoint(centerLL, radius) {
    // East edge in world coords = (x + radius, z)
    const [x, z] = fromLatLng(centerLL);
    return toLatLng(x + radius, z);
}

function refreshZoneLayer(idx) {
    const layer = zoneLayers.get(idx);
    if (!layer) return;
    const zone = state.config.Zones.Circles[idx];
    const center = toLatLng(zone.Center[0], zone.Center[2]);
    layer.circle.setLatLng(center);
    layer.circle.setRadius(zone.Radius);
    layer.circle.setTooltipContent(zone.Name || '(без имени)');
    layer.handle.setLatLng(edgePoint(center, zone.Radius));
    // Highlight
    const active = idx === state.activeZoneIdx;
    layer.circle.setStyle({
        color: active ? '#ffcc4d' : '#ff6b35',
        fillColor: active ? '#ffcc4d' : '#ff6b35',
        weight: active ? 3 : 2,
        fillOpacity: active ? 0.3 : 0.18,
    });
}

function removeZoneLayer(idx) {
    const layer = zoneLayers.get(idx);
    if (!layer) return;
    map.removeLayer(layer.circle);
    map.removeLayer(layer.handle);
    zoneLayers.delete(idx);
}

function rebuildAllZoneLayers() {
    for (const idx of [...zoneLayers.keys()]) removeZoneLayer(idx);
    if (!state.config) return;
    for (let i = 0; i < state.config.Zones.Circles.length; i++) buildZoneLayer(i);
}

function startDragCenter(idx, e) {
    L.DomEvent.stopPropagation(e);
    if (e.originalEvent) L.DomEvent.preventDefault(e.originalEvent);
    map.dragging.disable();
    const zone = state.config.Zones.Circles[idx];
    const startLL = e.latlng;
    const startCX = zone.Center[0];
    const startCZ = zone.Center[2];

    const onMove = (ev) => {
        const dLng = ev.latlng.lng - startLL.lng;
        const dLat = ev.latlng.lat - startLL.lat;
        zone.Center = [round2(startCX + dLng), 0, round2(startCZ + dLat)];
        refreshZoneLayer(idx);
        if (idx === state.activeZoneIdx) updateZoneCardInputs();
    };
    const onUp = () => {
        map.off('mousemove', onMove);
        map.off('mouseup', onUp);
        map.dragging.enable();
    };
    map.on('mousemove', onMove);
    map.on('mouseup', onUp);
    selectZone(idx);
}

function startDragRadius(idx, e) {
    L.DomEvent.stopPropagation(e);
    if (e.originalEvent) L.DomEvent.preventDefault(e.originalEvent);
    map.dragging.disable();
    const zone = state.config.Zones.Circles[idx];
    const onMove = (ev) => {
        const [cx, cz] = [zone.Center[0], zone.Center[2]];
        const [mx, mz] = fromLatLng(ev.latlng);
        const r = Math.max(5, Math.round(Math.hypot(mx - cx, mz - cz)));
        zone.Radius = r;
        refreshZoneLayer(idx);
        if (idx === state.activeZoneIdx) updateZoneCardInputs();
    };
    const onUp = () => {
        map.off('mousemove', onMove);
        map.off('mouseup', onUp);
        map.dragging.enable();
    };
    map.on('mousemove', onMove);
    map.on('mouseup', onUp);
    selectZone(idx);
}

const round2 = (v) => Math.round(v * 100) / 100;

// ─── Zone selection ───────────────────────────────────────────────────────────
function selectZone(idx) {
    const prev = state.activeZoneIdx;
    state.activeZoneIdx = idx;
    if (prev >= 0 && prev < state.config.Zones.Circles.length) refreshZoneLayer(prev);
    if (idx >= 0) refreshZoneLayer(idx);
    renderZoneList();
    if (idx >= 0) {
        const zone = state.config.Zones.Circles[idx];
        map.panTo(toLatLng(zone.Center[0], zone.Center[2]));
    }
}

// ─── Adding new zone ──────────────────────────────────────────────────────────
document.getElementById('btn-add-zone').addEventListener('click', () => {
    state.adding = !state.adding;
    document.body.classList.toggle('adding-zone-cursor', state.adding);
    document.getElementById('btn-add-zone').style.background = state.adding ? 'var(--accent)' : '';
    toast(state.adding ? 'Кликни по карте, чтобы создать зону (ESC — отмена)' : 'Отменено');
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.adding) {
        state.adding = false;
        document.body.classList.remove('adding-zone-cursor');
        document.getElementById('btn-add-zone').style.background = '';
    }
    if (e.key === 'Delete' && state.activeZoneIdx >= 0 && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        deleteZone(state.activeZoneIdx);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (state.config) saveFile();
    }
});

map.on('click', (e) => {
    if (!state.adding || !state.config) return;
    const [x, z] = fromLatLng(e.latlng);
    if (x < 0 || x > WORLD_SIZE || z < 0 || z > WORLD_SIZE) return;
    state.config.Zones.Circles.push({
        Name: `Зона ${state.config.Zones.Circles.length + 1}`,
        Center: [round2(x), 0, round2(z)],
        Radius: 50,
    });
    const idx = state.config.Zones.Circles.length - 1;
    buildZoneLayer(idx);
    selectZone(idx);
    state.adding = false;
    document.body.classList.remove('adding-zone-cursor');
    document.getElementById('btn-add-zone').style.background = '';
});

function deleteZone(idx) {
    if (!state.config || idx < 0) return;
    state.config.Zones.Circles.splice(idx, 1);
    state.activeZoneIdx = -1;
    rebuildAllZoneLayers();
    renderZoneList();
    toast('Зона удалена');
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
    zoneList: document.getElementById('zone-list'),
    zoneCount: document.getElementById('zone-count'),
    fileName: document.getElementById('file-name'),
};

function enablePanel(on) {
    [el.msgBlocked, el.adminBypass, el.blkInput, el.blkAdd, el.wlInput, el.wlAdd].forEach(x => x.disabled = !on);
    document.getElementById('btn-save').disabled = !on || !state.fileHandle;
    document.getElementById('btn-download').disabled = !on;
    document.getElementById('btn-add-zone').disabled = !on;
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
    el.zoneList.innerHTML = '';
    if (!state.config) { el.zoneCount.textContent = ''; return; }
    const zones = state.config.Zones.Circles;
    el.zoneCount.textContent = zones.length;
    zones.forEach((zone, i) => {
        const li = document.createElement('li');
        li.className = 'zone-item' + (i === state.activeZoneIdx ? ' active' : '');
        const [x, , z] = zone.Center;
        li.innerHTML = `
            <span class="zname"></span>
            <span class="zmeta">${x.toFixed(0)},${z.toFixed(0)} r=${zone.Radius}</span>
        `;
        li.firstElementChild.textContent = zone.Name || '(без имени)';
        li.addEventListener('click', (e) => {
            if (e.target.closest('.zone-card')) return;
            selectZone(i);
        });
        if (i === state.activeZoneIdx) li.appendChild(buildZoneCard(i));
        el.zoneList.appendChild(li);
    });
}

function buildZoneCard(idx) {
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
        refreshZoneLayer(idx);
        const li = el.zoneList.querySelectorAll('.zone-item')[idx];
        if (li) li.querySelector('.zname').textContent = zone.Name || '(без имени)';
    });
    div.querySelector('[data-field="X"]').addEventListener('input', (e) => {
        zone.Center = [parseFloat(e.target.value) || 0, 0, zone.Center[2]];
        refreshZoneLayer(idx);
        updateZoneListRowMeta(idx);
    });
    div.querySelector('[data-field="Z"]').addEventListener('input', (e) => {
        zone.Center = [zone.Center[0], 0, parseFloat(e.target.value) || 0];
        refreshZoneLayer(idx);
        updateZoneListRowMeta(idx);
    });
    div.querySelector('[data-field="R"]').addEventListener('input', (e) => {
        zone.Radius = Math.max(1, parseInt(e.target.value, 10) || 1);
        refreshZoneLayer(idx);
        updateZoneListRowMeta(idx);
    });
    div.querySelector('[data-action="del"]').addEventListener('click', () => deleteZone(idx));
    return div;
}

function updateZoneCardInputs() {
    const idx = state.activeZoneIdx;
    if (idx < 0) return;
    const zone = state.config.Zones.Circles[idx];
    const card = el.zoneList.querySelector('.zone-card');
    if (!card) return;
    card.querySelector('[data-field="X"]').value = zone.Center[0];
    card.querySelector('[data-field="Z"]').value = zone.Center[2];
    card.querySelector('[data-field="R"]').value = zone.Radius;
    updateZoneListRowMeta(idx);
}

function updateZoneListRowMeta(idx) {
    const li = el.zoneList.querySelectorAll('.zone-item')[idx];
    if (!li) return;
    const zone = state.config.Zones.Circles[idx];
    li.querySelector('.zmeta').textContent = `${zone.Center[0].toFixed(0)},${zone.Center[2].toFixed(0)} r=${zone.Radius}`;
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
    const zonesArr = cfg.Zones?.Circles || [];
    const circlesStr = zonesArr.length
        ? `[\n${zonesArr.map(z => formatZone(z, 3)).join(',\n')}\n${ind(2)}]`
        : '[]';
    const zonesBlock = `{\n${ind(2)}"Circles": ${circlesStr}\n${ind(1)}}`;

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
        state.activeZoneIdx = -1;
        enablePanel(true);
        document.getElementById('btn-save').disabled = !state.fileHandle;
        renderAll();
        rebuildAllZoneLayers();
        toast(`Загружено: ${parsed.Zones?.Circles?.length || 0} зон`, 'ok');
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
