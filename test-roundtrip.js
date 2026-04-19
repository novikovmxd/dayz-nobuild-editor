// Round-trip: parse config.json, re-serialize, compare.
import { readFileSync } from 'node:fs';

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
    const parts = Object.keys(cfg).map(k => {
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

const original = readFileSync('../../profiles/R_DACT_D_NoBuildZones/config.json', 'utf-8');
const parsed = JSON.parse(original);
const reserialized = serializeConfig(parsed);

const origStr = JSON.stringify(JSON.parse(original));
const ourStr = JSON.stringify(JSON.parse(reserialized));

if (origStr === ourStr) {
    console.log('✓ semantic round-trip OK (content identical)');
    const norm = s => s.replace(/\r\n/g, '\n');
    if (norm(original) === norm(reserialized)) {
        console.log('✓ byte-identical too (' + original.length + ' bytes)');
    } else {
        console.log(`  whitespace differs: original ${original.length}b, ours ${reserialized.length}b`);
    }
} else {
    console.log('✗ semantic round-trip FAILED');
    console.log('  orig chars:', origStr.length);
    console.log('  ours chars:', ourStr.length);
    process.exit(1);
}
