import { buildLibraryOrbitModel } from './library-orbit-model.mjs';
import { compareRevisionTrees } from './rebuild-model.mjs';

export const libraryGrowthPolicy = 'revision-library-growth-v1';
export const libraryOrnamentSlots = 24;
const fullTurn = Math.PI * 2;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const lexical = (first, second) => first < second ? -1 : first > second ? 1 : 0;
const finiteOr = (value, fallback) => Number.isFinite(value) ? value : fallback;
const mix = (first, second, amount) => first + (second - first) * amount;
const mixPoint = (first, second, amount) => Object.fromEntries(Object.keys(second).map(key => [key, mix(first?.[key] ?? second[key], second[key], amount)]));
const smooth = progress => progress * progress * (3 - 2 * progress);
const kindOrder = { issue: 0, sdd: 1, adr: 2 };

// Historical prose is recognized only for these exact blobs, never for future edits or similar sentences.
const legacyReplacementDeclarations = [
  {"path":"docs/decisions/ADR-0034.md","objectId":"fa8caa96e9c05b601853680df837a8c0b0019402","targetPath":"docs/decisions/ADR-0033.md","line":3,"quote":"ADR0033の既定ビューを置換し、旧ビューは比較用として残す。","content":"# ADR-0034：仮想図書世界による探索を主役にする\n\n2026-11-13 / [Issue37](../issues/ISS-0020.md) / [REQ0023](../spec-driven-dev/req/REQ-0023.md)。状態：採用。中央タワーと同心円書架という目的は本人の既決。描画/段階分けはCodexの委任内判断。ADR0033の既定ビューを置換し、旧ビューは比較用として残す。\n\n| 案 | 利点 | 負担・適する条件 |\n|---|---|---|\n| 従来の構成/差分表のみ | 正確な確認が早い | 世界を育てる楽しさが弱い。検証の対照に残す |\n| **同心円書架＋中央塔、Canvasの奥行き表現** | 実ファイルを本として追え、スマホで世界を移動できる | 大規模時のLODや装飾の意味対応が必要。既存操作/配信を再利用でき、追加依存/費用なし |\n| 本格3D仮想世界 | 自由な視点と没入感 | 描画負荷・操作・保守が増える。2D操作で楽しさが得られない場合に比較する |\n| 初手から生成AIの全文時系列QA | 質問意図に柔軟に対応 | コード本文収録、送信先、料金、引用検証が必要。現在公開素材だけで実装済みとは言えない |\n\n2案目を実装し、検索はまず収録記録の根拠付き時系列案内にする。塔の段/装飾は現在の蔵書数/種類へ対応し、開発の優劣を採点しない。削除や簡素化で世界が縮んでも後退とは扱わない。手触りは自分のPRで増改築する世界と、理由を読む往復で試す。\n\nOZの白い広場・中央の象徴・同心円配置を参照する。作品の画像を配信素材へ取り込まず、既存XOZUロゴ/Set3/独自の幾何描画で構成する。面白さや記憶への効果は未検証。見栄えと同一版再現、欠測表示の正確さを両立できなければ再設計する。戻し方は旧ビュー切替/公開第14版再配置。\n\n先行サービスから、出所へ戻る導線・版を指定した検索・差分/影響の確認を借りる。DeepWikiは構成説明/引用付きQA、Sourcegraphはrepo/branch/commit/diff検索、CodeSeeはコード地図とPRのReview Map/ツアーを既に持つ。地図・差分・ツアー自体が初めてとは主張しない。\n\n出所（公式、参照2026-11-13、ページ更新日不明）：[DeepWiki](https://docs.devin.ai/work-with-devin/deepwiki)、[Sourcegraph Search](https://sourcegraph.com/docs/code-search)、[CodeSee](https://docs.codesee.io/docs/getting-started)、[CodeSee AI](https://docs.codesee.io/docs/ai-in-codesee)。XOZUで検証するのは世界生成による探索意欲と理解・記憶への効果。\n"},
  {"path":"docs/decisions/ADR-0036.md","objectId":"c7b508e60b547b37cd444646ba1208fbf2f3fe23","targetPath":"docs/decisions/ADR-0034.md","line":3,"quote":"ADR0034のCanvas2D既定を置換するが旧書架は互換表示へ残す。","content":"# ADR-0036：中央を注視する3D円形図書館\n\n2026-11-13 / [Issue37](../issues/ISS-0020.md) / [REQ0024](../spec-driven-dev/req/REQ-0024.md)。本人が3Dと周回操作を指定。ADR0034のCanvas2D既定を置換するが旧書架は互換表示へ残す。\n\n| 案 | 利点 | 負担・適する条件 |\n|---|---|---|\n| Canvas2Dの擬似立体 | 軽量で幅広い端末 | 背後/側面を実際に見る体験に限界。GPU不可の代替として残す |\n| **既存Threeで中央固定の透視3D** | 円弧棚と塔の前後/高さが分かり、図書館を巡れる。既存の依存を再利用 | 約2MBの追加配信、WebGL2が必要。描画資源の解放と端末確認が増える |\n| 自由移動の3Dゲーム | 任意の視点で歩ける | 操作と迷子対策が増え、今回の「回って見る」と違う |\n\n2案を採用。ファイル/フォルダ/差分は既存モデルのまま、3Dの造形を追加policyとして分離する。塔は今ある蔵書量に応じて伸縮し、積み上げたPR数やコード品質ではない。過去に戻ると当時の量へ戻り、未来を参照しない。既存の無料公開allowlistと費用範囲を維持する。\n\nカメラは中央軸を注視し、周回・限定俯角・接近だけ。panを設けないことは機能不足ではなく本人の目的に沿う。Threeの[周回操作](https://threejs.org/docs/pages/OrbitControls.html)の考え方を借り、addonの自由panは入れず小さな制約付き入力を既存契約へ接続する。[WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)はWebGL2専用なので初期不可には2Dを明示し、稼働中の故障は成功へ隠さない（公式参照2026-11-13、更新日不明）。\n\n戻す場合は既定rendererとallowlistの今回差分をrevertし、前の公開commit b92e39bの成果物を新commitで復元する。元Git/保存地図は書き換えない。端末の操作感と楽しさ・理解への効果は完成判定と別に評価する。\n"},
];

function pathHash(path) {
  let hash = 2166136261;
  for (let index = 0; index < path.length; index += 1) hash = Math.imul(hash ^ path.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function recordType(path) {
  if (/^docs\/issues\/ISS-\d{4}\.md$/.test(path)) return { kind: 'issue', recordType: 'issue' };
  if (/^docs\/spec-driven-dev\/req\/REQ-\d{4}\.md$/.test(path)) return { kind: 'sdd', recordType: 'req' };
  if (/^docs\/spec-driven-dev\/design\/DES-\d{4}\.md$/.test(path)) return { kind: 'sdd', recordType: 'des' };
  if (/^docs\/decisions\/ADR-\d{4}\.md$/.test(path)) return { kind: 'adr', recordType: 'adr' };
  return null;
}

function collectVerifiedDocuments(frame, documents) {
  const available = new Map(), rejected = new Set(), inventory = new Set(frame.files.map(file => file.path));
  if (!Array.isArray(documents)) return { available, rejected };
  for (const document of documents) {
    if (!document || !inventory.has(document.path) || !recordType(document.path)) continue;
    if (rejected.has(document.path)) continue;
    if (available.has(document.path) || document.revision !== frame.revision || typeof document.content !== 'string' || document.content.includes('\0')) {
      available.delete(document.path); rejected.add(document.path); continue;
    }
    available.set(document.path, document);
  }
  return { available, rejected };
}

function readReplacementDeclaration(record) {
  if (record.source.status !== 'ready') return { status: record.source.status, basis: null };
  const legacy = legacyReplacementDeclarations.find(declaration => declaration.path === record.path
    && declaration.objectId === record.objectId && declaration.content === record.content
    && record.content.split(/\r?\n/)[declaration.line - 1]?.includes(declaration.quote));
  if (legacy) return { status: 'verified', basis: 'legacy-exact-blob', targetPath: legacy.targetPath, line: legacy.line, quote: legacy.quote };
  const unsupported = reason => ({ status: 'not-supported', basis: null, reason });
  const lines = record.content.split(/\r?\n/);
  if (lines[0] !== '---') return unsupported('missing-frontmatter');
  const closing = lines.findIndex((line, index) => index > 0 && line === '---');
  if (closing < 0) return unsupported('unclosed-frontmatter');
  const declarations = new Map();
  for (let index = 1; index < closing; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^#/.test(line)) continue;
    // A small explicit schema avoids interpreting YAML aliases, collections or prose as decisions.
    const scalar = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(?:([A-Za-z0-9_-]+)|"([^"\r\n]*)"|'([^'\r\n]*)')[ \t]*$/.exec(line);
    if (!scalar) return unsupported('non-scalar-frontmatter');
    if (declarations.has(scalar[1])) return unsupported('duplicate-frontmatter-key');
    declarations.set(scalar[1], { value: scalar[2] ?? scalar[3] ?? scalar[4], line: index + 1, quote: line });
  }
  const status = declarations.get('status'), supersedes = declarations.get('supersedes');
  if (!status) return unsupported('missing-status');
  if (status.value !== 'accepted') return { status: 'not-accepted', basis: 'frontmatter', declaredStatus: status.value };
  if (!supersedes || !/^ADR-\d{4}$/.test(supersedes.value)) return unsupported('missing-or-unsupported-supersedes');
  return { status: 'verified', basis: 'frontmatter', targetPath: `docs/decisions/${supersedes.value}.md`, line: supersedes.line, quote: supersedes.quote };
}

export function buildLibraryGrowth(frame, { world = buildLibraryOrbitModel(frame), documents = frame.story?.documents } = {}) {
  const { available, rejected } = collectVerifiedDocuments(frame, documents);
  const hasDocuments = Array.isArray(documents);
  const records = frame.files.filter(file => recordType(file.path)).sort((first, second) => lexical(first.path, second.path)).map(file => {
    const document = available.get(file.path);
    return {
      id: file.path, path: file.path, ...recordType(file.path), revision: frame.revision, objectId: file.objectId,
      label: typeof document?.label === 'string' ? document.label : file.path.split('/').at(-1).replace(/\.md$/, ''),
      content: document?.content ?? null,
      source: { path: file.path, revision: frame.revision, status: document ? 'ready' : rejected.has(file.path) ? 'invalid' : hasDocuments ? 'unavailable' : 'not-loaded' },
    };
  });
  const recordsByPath = new Map(records.map(record => [record.path, record]));
  const groups = new Map();
  for (const record of records) {
    const slot = pathHash(record.path) % libraryOrnamentSlots;
    const id = `ornament:${record.kind}:${slot}`;
    if (!groups.has(id)) {
      const angle = slot * fullTurn / libraryOrnamentSlots - Math.PI / 2;
      groups.set(id, { id, kind: record.kind, slot,
        position: { x: Math.cos(angle) * 91, y: world.tower.height * (.28 + kindOrder[record.kind] * .22), z: Math.sin(angle) * 91 },
        records: [], count: 0, label: record.kind === 'issue' ? 'Issue' : record.kind.toUpperCase() });
    }
    const group = groups.get(id); group.records.push(record); group.count += 1;
  }
  const branches = [];
  for (const record of records.filter(record => record.kind === 'adr')) {
    const declaration = readReplacementDeclaration(record);
    record.declaration = declaration;
    if (declaration.status !== 'verified') continue;
    if (declaration.targetPath === record.path || !recordsByPath.has(declaration.targetPath)) {
      record.declaration = { status: 'not-supported', basis: declaration.basis, reason: declaration.targetPath === record.path ? 'self-replacement' : 'target-not-in-revision' };
      continue;
    }
    const hash = pathHash(record.path), angle = hash / 4294967296 * fullTurn;
    const height = world.tower.height * (.42 + ((hash >>> 8) % 5) * .07);
    branches.push({
      id: `branch:${record.path}->${declaration.targetPath}`, relation: 'specification-supersedes-not-git-branch',
      sourcePath: record.path, targetPath: declaration.targetPath, label: `${record.label} → ${recordsByPath.get(declaration.targetPath).label}`,
      position: { x: Math.cos(angle) * 46, y: height, z: Math.sin(angle) * 46 },
      tip: { x: Math.cos(angle) * 125, y: height + 30, z: Math.sin(angle) * 125 },
      proof: { revision: frame.revision, line: declaration.line, quote: declaration.quote, path: record.path, basis: declaration.basis },
    });
  }
  const loaded = records.filter(record => record.source.status === 'ready').length;
  const status = !hasDocuments ? 'not-loaded' : loaded === records.length ? 'complete' : 'partial';
  const declarations = records.filter(record => record.kind === 'adr').map(record => record.declaration);
  const declarationCount = status => declarations.filter(declaration => declaration.status === status).length;
  const branchDeclarations = { total: declarations.length, verified: declarationCount('verified'),
    notAccepted: declarationCount('not-accepted'), notSupported: declarationCount('not-supported'),
    notLoaded: declarationCount('not-loaded'), unavailable: declarationCount('unavailable'), invalid: declarationCount('invalid') };
  const branchesStatus = !hasDocuments ? 'not-loaded' : branchDeclarations.notLoaded + branchDeclarations.unavailable + branchDeclarations.invalid > 0 ? 'partial'
    : branchDeclarations.notSupported > 0 ? 'not-supported' : 'complete';
  return {
    policy: libraryGrowthPolicy, revision: frame.revision, records,
    ornaments: [...groups.values()].sort((first, second) => lexical(first.id, second.id)),
    branches: branches.sort((first, second) => lexical(first.id, second.id)),
    coverage: { status, total: records.length, loaded, notLoaded: hasDocuments ? 0 : records.length,
      unavailable: records.filter(record => record.source.status === 'unavailable').length, invalid: rejected.size,
      branchesStatus, branchDeclarations, branchMeaning: 'explicit-recorded-replacement-only' },
  };
}

function inventoryFrame(world) {
  return { revision: world.revision, files: world.library.books.map(node => ({ path: node.path, bytes: node.bytes, objectId: node.objectId, mode: node.mode, kind: node.kind })) };
}

function pairById(before = [], after = []) {
  const first = new Map(before.map(entry => [entry.id, entry])), second = new Map(after.map(entry => [entry.id, entry]));
  return [...new Set([...first.keys(), ...second.keys()])].sort(lexical).map(id => ({ id, before: first.get(id) ?? null, after: second.get(id) ?? null }));
}

function ornamentInventory(group) {
  return JSON.stringify(group.records.map(record => [record.path, record.objectId]).sort(([first], [second]) => lexical(first, second)));
}

export function buildLibraryTransition(fromWorld, toWorld, { comparison = null } = {}) {
  const observed = comparison ?? compareRevisionTrees(fromWorld ? inventoryFrame(fromWorld) : null, inventoryFrame(toWorld));
  const changes = new Map(observed.changes.map(change => [change.path, change.status]));
  return {
    from: fromWorld, to: toWorld,
    comparison: { status: observed.status, fromRevision: observed.fromRevision, toRevision: observed.toRevision },
    books: pairById(fromWorld?.books, toWorld.books).map(pair => ({ ...pair, status: observed.status === 'unknown' ? 'uncompared' : changes.get(pair.id) ?? (pair.after ? 'unchanged' : 'deleted') })),
    shelves: pairById(fromWorld?.shelves, toWorld.shelves),
    ornaments: pairById(fromWorld?.growth?.ornaments, toWorld.growth?.ornaments).map(pair => ({ ...pair,
      status: !pair.before ? 'added' : !pair.after ? 'deleted' : ornamentInventory(pair.before) !== ornamentInventory(pair.after) ? 'modified' : 'unchanged' })),
    branches: pairById(fromWorld?.growth?.branches, toWorld.growth?.branches),
  };
}

function sampleAppearance(pair, progress) {
  const fromOpacity = finiteOr(pair.before?.opacity, pair.before ? 1 : 0);
  return { opacity: mix(fromOpacity, pair.after ? 1 : 0, progress), selectable: Boolean(pair.after), status: pair.status ?? (pair.before ? pair.after ? 'unchanged' : 'deleted' : 'added') };
}

function shortestAngle(first, second, progress) {
  const difference = ((second - first + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI;
  return first + difference * progress;
}

function sampleBooks(transition, progress) {
  return transition.books.filter(pair => progress < 1 || pair.after).map(pair => {
    const target = pair.after ?? pair.before, origin = pair.before ?? target;
    const appearance = sampleAppearance(pair, progress);
    const startSize = pair.before?.size ?? { ...target.size, height: 0 };
    const endSize = pair.after?.size ?? { ...target.size, height: 0 };
    const size = mixPoint(startSize, endSize, progress);
    const position = mixPoint(origin.position, target.position, progress);
    const startBase = origin.position.y - origin.size.height / 2, endBase = target.position.y - target.size.height / 2;
    position.y = mix(startBase, endBase, progress) + size.height / 2;
    return { ...target, ...appearance, size, position, yaw: shortestAngle(origin.yaw, target.yaw, progress),
      pulse: pair.status === 'modified' ? Math.sin(progress * Math.PI) : 0 };
  });
}

function sampleShelves(transition, progress) {
  return transition.shelves.filter(pair => progress < 1 || pair.after).map(pair => {
    const target = pair.after ?? pair.before, origin = pair.before ?? target;
    return { ...target, ...sampleAppearance(pair, progress),
      ...Object.fromEntries(['innerRadius','outerRadius','startAngle','endAngle','baseY','height'].map(key => [key, mix(origin[key], target[key], progress)])),
      scale: mix(pair.before?.scale ?? (pair.before ? 1 : 0), pair.after ? 1 : 0, progress) };
  });
}

function sampleOrnaments(pairs, progress, branch = false) {
  return pairs.filter(pair => progress < 1 || pair.after).map(pair => {
    const target = pair.after ?? pair.before, origin = pair.before ?? target;
    return { ...target, ...sampleAppearance(pair, progress), position: mixPoint(origin.position, target.position, progress),
      ...(branch ? { tip: mixPoint(origin.tip, target.tip, progress) } : {}),
      pulse: pair.status === 'modified' ? Math.sin(progress * Math.PI) : 0,
      scale: mix(pair.before?.scale ?? (pair.before ? 1 : 0), pair.after ? 1 : 0, progress) };
  });
}

export function sampleLibraryTransition(transition, progress) {
  const amount = smooth(clamp(finiteOr(progress, 0), 0, 1));
  const before = transition.from ?? transition.to, after = transition.to;
  const tiers = pairById(before.tower.tiers.map((tier, index) => ({ ...tier, id: String(index) })), after.tower.tiers.map((tier, index) => ({ ...tier, id: String(index) })));
  const tower = { ...after.tower, height: mix(before.tower.height, after.tower.height, amount), radius: mix(before.tower.radius, after.tower.radius, amount),
    tiers: tiers.filter(pair => amount < 1 || pair.after).map(pair => {
      const target = pair.after ?? pair.before, origin = pair.before ?? target;
      return { ...target, ...sampleAppearance(pair, amount),
        ...Object.fromEntries(['y','height','bottomRadius','topRadius'].map(key => [key, mix(origin[key], target[key], amount)])),
        scale: mix(pair.before?.scale ?? (pair.before ? 1 : 0), pair.after ? 1 : 0, amount) };
    }) };
  return { ...after, books: sampleBooks(transition, amount), shelves: sampleShelves(transition, amount), tower,
    target: mixPoint(before.target, after.target, amount), radius: mix(before.radius, after.radius, amount),
    growth: { ...after.growth, ornaments: sampleOrnaments(transition.ornaments, amount), branches: sampleOrnaments(transition.branches, amount, true) },
    transition: { progress: amount, comparison: transition.comparison } };
}
