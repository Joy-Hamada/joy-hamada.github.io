export const mapPaletteVersion = 'category-activity-hex-1';
export const defaultMapPaletteId = 'set3';
export const mapPaletteActivityScale = Object.freeze({ low: 0, base: 2, high: 8, transform: 'log1p' });
export const mapPaletteCategorySlots = Object.freeze({ apps: 0, lib: 1, docs: 2, tests: 3, scripts: 4, assets: 5, infra: 6, '.github': 7, '.agents': 8, '.claude': 9 });
export const mapPaletteNeutralColors = Object.freeze({ unknown: '#A7ABAE', absent: '#B9BFC1', aggregate: '#DAD9D2' });

const nordicRows = [
  ['オールドローズ', 'C4A0A4', 'D98C95', 'E67787'],
  ['テラコッタ', 'C29E95', 'D88A78', 'E6765D'],
  ['アプリコット', 'CEB19E', 'E0A176', 'EC914E'],
  ['ウォームサンド', 'D0C2AA', 'D8B982', 'DCB05A'],
  ['セージグリーン', 'A9BAA6', '93BA8E', '7FB979'],
  ['ユーカリ', '9AB5AD', '77B7A5', '51B69E'],
  ['スレートティール', '8DABB0', '63ABB8', '29AABD'],
  ['ダスティブルー', '91A4B8', '759FCB', '5A9ADA'],
  ['モーヴラベンダー', 'ADA2BA', 'AD95CA', 'AC88D5'],
  ['ダスティプラム', 'B69CAB', 'C489AD', 'CC78AE'],
];
const twilightRows = [
  ['コーラルピンク', 'CDA5A7', 'E58F95', 'F47886'],
  ['ピーチ', 'D5B1A6', 'EC9E86', 'FB8A68'],
  ['ハニーゴールド', 'D9C3AA', 'E7B77B', 'F1AB4A'],
  ['ピスタチオ', 'BEC5A9', 'B5C284', 'ADBF5F'],
  ['シーフォームミント', 'A7C2B1', '85C5A0', '61C590'],
  ['アクア', '9ABCBB', '6ABEBE', '23BFBF'],
  ['セルリアンスカイ', '94B3C3', '66B3D7', '25B0E4'],
  ['ペリウィンクル', '99A8C6', '81A0E4', '6C97F9'],
  ['アメジスト', 'ACA1C2', 'AB92D9', 'AA83EB'],
  ['オーキッドローズ', 'C3A3B8', 'D38EBF', 'DD79C2'],
];

function hexChannels(hex) {
  return [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function channelsHex(channels) {
  return `#${channels.map(value => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function interpolateHex(start, end, fraction) {
  if (fraction <= 0) return start;
  if (fraction >= 1) return end;
  const startChannels = hexChannels(start); const endChannels = hexChannels(end);
  return channelsHex(startChannels.map((channel, index) => channel + (endChannels[index] - channel) * fraction));
}

function intensifyHex(hex) {
  const channels = hexChannels(hex);
  const grey = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  return channelsHex(channels.map(channel => grey + (channel - grey) * 1.25));
}

function freezeSwatches(rows) {
  return Object.freeze(rows.map(([label, low, base, high]) => Object.freeze({ label, low: `#${low}`, base: `#${base}`, high: `#${high}` })));
}

// Grey is reserved for missing/absent observations; the palest yellow is omitted to keep ten categories.
const set3Bases = ['#8DD3C7', '#BEBADA', '#FB8072', '#80B1D3', '#FDB462', '#B3DE69', '#FCCDE5', '#BC80BD', '#CCEBC5', '#FFED6F'];
const set3Swatches = Object.freeze(set3Bases.map((base, index) => Object.freeze({ label: `Set3 ${index + 1}`,
  low: interpolateHex('#B8B8B2', base, .55), base, high: intensifyHex(base) })));

export const mapPaletteOptions = Object.freeze([
  Object.freeze({ id: 'a', label: 'A · 北欧・ボタニカル', version: mapPaletteVersion,
    source: 'user-provided-2026-11-12', description: '本人指定の10色。編集活動に合わせ、指定の低彩度・基準・高彩度を結びます。', swatches: freezeSwatches(nordicRows) }),
  Object.freeze({ id: 'b', label: 'B · トワイライト・ガラスタイル', version: mapPaletteVersion,
    source: 'user-provided-2026-11-12', description: '本人指定の10色。編集活動に合わせ、指定の低彩度・基準・高彩度を結びます。', swatches: freezeSwatches(twilightRows) }),
  Object.freeze({ id: 'set3', label: 'ColorBrewer 地図色', version: mapPaletteVersion,
    source: 'https://colorbrewer2.org/export/colorbrewer.json', attribution: 'Cynthia Brewer, Mark Harrower and The Pennsylvania State University',
    description: 'Set3の12色から灰色 #D9D9D9 と最淡黄 #FFFFB3 を除く10色。基準色は原色、低・高彩度はXOZU独自調整です。色覚・コントラストの適合保証はありません。',
    swatches: set3Swatches }),
]);
const palettesById = new Map(mapPaletteOptions.map(palette => [palette.id, palette]));

export function normalizeMapPaletteId(id) {
  return palettesById.has(id) ? id : defaultMapPaletteId;
}

function categorySlot(category) {
  if (Object.hasOwn(mapPaletteCategorySlots, category)) return mapPaletteCategorySlots[category];
  let hash = 2166136261;
  for (let index = 0; index < category.length; index += 1) hash = Math.imul(hash ^ category.charCodeAt(index), 16777619);
  return (hash >>> 0) % 10;
}

function measuredMean(activity) {
  if (typeof activity === 'number') return Number.isFinite(activity) && activity >= 0 ? activity : null;
  if (activity?.status !== 'measured' || !Number.isFinite(activity.meanChanges) || activity.meanChanges < 0) return null;
  return activity.meanChanges;
}

export function colorForMapPalette(node, { activity, state } = {}, requestedPalette = defaultMapPaletteId) {
  const paletteId = normalizeMapPaletteId(requestedPalette); const palette = palettesById.get(paletteId);
  const path = typeof node?.path === 'string' ? node.path : null;
  const category = path?.split('/')[0] ?? null;
  const slot = category ? categorySlot(category) : null;
  const meanChanges = measuredMean(activity);
  const isAbsent = state?.presentFiles === 0 || state?.presence === 'absent-before-first-observation' || state?.presence === 'absent-after-observation';
  let status; let hex; let intensity = null;
  if (isAbsent) { status = 'absent'; hex = mapPaletteNeutralColors.absent; }
  else if (path === null || meanChanges === null || state === null) { status = 'unknown'; hex = mapPaletteNeutralColors.unknown; }
  else if (path === '') { status = 'aggregate'; hex = mapPaletteNeutralColors.aggregate; }
  else {
    status = 'measured';
    // The scale never follows a later frame's maximum; otherwise future edits would recolor the past.
    intensity = Math.log1p(Math.min(mapPaletteActivityScale.high, meanChanges)) / Math.log1p(mapPaletteActivityScale.high);
    const swatch = palette.swatches[slot];
    hex = intensity <= .5 ? interpolateHex(swatch.low, swatch.base, intensity * 2)
      : interpolateHex(swatch.base, swatch.high, (intensity - .5) * 2);
  }
  const [r, g, b] = hexChannels(hex);
  return { hex, css: hex, r, g, b, slot, category, paletteId, version: mapPaletteVersion, status, meanChanges, intensity };
}
