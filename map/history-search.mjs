import { compareRevisionTrees } from './rebuild-model.mjs';

const revisionPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const documentPattern = /^docs\/(?:issues|decisions|spec-driven-dev\/(?:req|design|tasks|dev-report))\/[A-Za-z0-9._-]+\.md$/;
const storyFields = ['question', 'intent', 'specification', 'outcome', 'lesson', 'next', 'record'];
const ignoredWords = new Set(['なぜ', 'いつ', 'どこ', 'どう', 'どの', '何', 'なに', 'です', 'ます', 'した', 'する', 'された', 'され', 'いる', 'ある', 'これ', 'この', 'それ', 'その', '理由', '教え', '教えて', 'ください', 'こと', 'について', 'は', 'が', 'を', 'に', 'の', 'と', 'で', 'も', 'why', 'when', 'where', 'what', 'the', 'was', 'is', 'did']);
const normalize = text => String(text ?? '').normalize('NFKC').toLocaleLowerCase('ja-JP');
const clip = (text, maximum = 220) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum);
const pathOrder = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function historyRevisionLabel(frame) {
  return Number.isSafeInteger(frame?.pr?.number) && frame.pr.number > 0 ? `PR #${frame.pr.number}` : frame?.revision?.slice(0, 7) ?? '未取得';
}

function recordKind(path) {
  return path.startsWith('docs/issues/') ? 'Issue' : path.startsWith('docs/decisions/') ? 'ADR' : path.startsWith('docs/spec-driven-dev/') ? 'SDD' : 'ファイル';
}

function sameRevisionSource(frame, source, files) {
  return source?.revision === frame.revision && documentPattern.test(source.path) && files.has(source.path);
}

function createFrameReference(frame, frameIndex) {
  return { frameIndex, revision: frame.revision, label: historyRevisionLabel(frame), date: frame.date ?? null,
    title: clip(frame.pr?.title || frame.label || 'Gitの記録'),
    prUrl: Number.isSafeInteger(frame.pr?.number) && frame.pr.number > 0 && frame.pr.url === `https://github.com/Joy-Hamada/xozu/pull/${frame.pr.number}` ? frame.pr.url : null };
}

function documentEntries(frame, frameIndex, files) {
  const documents = new Map();
  const addSource = source => {
    if (!sameRevisionSource(frame, source, files)) return null;
    if (!documents.has(source.path)) documents.set(source.path, { id: `record:${frame.revision}:${source.path}`, kind: 'record', path: source.path,
      category: recordKind(source.path), title: clip(source.label || source.path), excerpts: [], ...createFrameReference(frame, frameIndex) });
    const record = documents.get(source.path);
    record.title = clip(source.label || record.title);
    return record;
  };
  for (const source of frame.story?.sources ?? []) addSource(source);
  for (const field of storyFields) {
    const excerpt = frame.story?.[field];
    if (!excerpt || excerpt.basis === 'unknown' || typeof excerpt.text !== 'string') continue;
    const record = addSource(excerpt.source);
    if (record && !record.excerpts.includes(excerpt.text)) record.excerpts.push(clip(excerpt.text));
  }
  return [...documents.values()].map(record => ({ ...record, summary: record.excerpts.join(' / '), basis: 'same-revision-record-excerpt' }));
}

export function buildHistorySearchIndex(frames) {
  if (!Array.isArray(frames) || !frames.length || frames.length > 65) throw new Error('search-history-unavailable');
  const revisions = new Set();
  const files = new Map();
  const entries = [];
  const references = [];
  const eventsByPath = new Map();
  for (const [frameIndex, frame] of frames.entries()) {
    if (!revisionPattern.test(frame?.revision) || revisions.has(frame.revision)) throw new Error('search-history-invalid-revision');
    revisions.add(frame.revision);
    const reference = createFrameReference(frame, frameIndex); references.push(reference);
    const comparison = compareRevisionTrees(frameIndex ? frames[frameIndex - 1] : null, frame);
    const present = new Map(frame.files.map(file => [file.path, file]));
    for (const file of present.values()) {
      if (!files.has(file.path)) files.set(file.path, { id: `file:${file.path}`, kind: 'file', path: file.path, title: file.path,
        category: recordKind(file.path), firstFrameIndex: frameIndex, basis: 'git-inventory', ...reference });
      const entry = files.get(file.path);
      entry.frameIndex = frameIndex; entry.revision = frame.revision; entry.label = reference.label; entry.date = reference.date;
      entry.existsAtLatest = frameIndex === frames.length - 1;
    }
    const addEvent = change => {
      if (!eventsByPath.has(change.path)) eventsByPath.set(change.path, []);
      eventsByPath.get(change.path).push({ ...reference, ...change, fromRevision: comparison.fromRevision,
        fromLabel: frameIndex ? references[frameIndex - 1].label : null, toRevision: frame.revision,
        comparisonBasis: frameIndex ? 'previous-displayed-revision' : 'uncompared-baseline',
        issues: [...new Set([...(frame.pr?.issues ?? []), ...(frame.story?.documentIssues ?? [])]
          .filter(issue => Number.isSafeInteger(issue.number) && issue.number > 0 && issue.url === `https://github.com/Joy-Hamada/xozu/issues/${issue.number}`)
          .map(issue => issue.number))],
        recordPaths: (frame.story?.sources ?? []).filter(source => sameRevisionSource(frame, source, present)).map(source => source.path) });
    };
    if (!frameIndex) for (const file of present.values()) addEvent({ path: file.path, status: 'baseline', beforeBytes: null, afterBytes: file.bytes, byteDelta: null });
    for (const change of comparison.changes) addEvent({ path: change.path, status: change.status, beforeBytes: change.before?.bytes ?? null,
      afterBytes: change.after?.bytes ?? null, byteDelta: change.byteDelta, contentChanged: change.contentChanged, modeChanged: change.modeChanged });
    for (const path of comparison.unexplainedGitChanges) addEvent({ path, status: 'unknown', beforeBytes: present.get(path).bytes, afterBytes: present.get(path).bytes, byteDelta: null });
    if (frame.pr) entries.push({ id: `pr:${frame.revision}`, kind: 'pr', path: '', category: 'PR', ...reference,
      summary: `PR #${frame.pr.number} · ${reference.title}`, basis: 'github-pr-title',
      issueNumbers: [...new Set([...(frame.pr.issues ?? []), ...(frame.story?.documentIssues ?? [])].filter(issue => Number.isSafeInteger(issue.number) && issue.number > 0 && issue.url === `https://github.com/Joy-Hamada/xozu/issues/${issue.number}`).map(issue => issue.number))] });
    entries.push(...documentEntries(frame, frameIndex, present));
  }
  for (const entry of files.values()) {
    entry.title = entry.path;
    const events = eventsByPath.get(entry.path) ?? [];
    entry.eventCount = events.length;
    entry.summary = `${recordKind(entry.path)} · ${events.length}時点${entry.existsAtLatest ? '' : ' · 最新版には存在しない'}`;
    entries.push(entry);
  }
  return { entries, eventsByPath, references, frameCount: frames.length, latestRevision: frames.at(-1).revision,
    scope: 'record-titles-excerpts-and-file-history', codeContent: 'unavailable' };
}

function queryTerms(query) {
  const normalized = normalize(query);
  const explicit = normalized.match(/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+|[a-z0-9_-]+\.[a-z0-9_-]+/g) ?? [];
  const segments = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter('ja', { granularity: 'word' }).segment(normalized)]
    .filter(segment => segment.isWordLike).map(segment => segment.segment) : normalized.split(/[\s。、!?！？「」『』()（）]+/);
  return [...new Set([...explicit, ...segments.filter(word => word.length > 1 && !ignoredWords.has(word))])].slice(0, 20);
}

export function searchProjectHistory(index, query, { limit = 30 } = {}) {
  if (!index || !Array.isArray(index.entries)) throw new Error('search-history-unavailable');
  const requested = clip(query, 300);
  if (!requested) return { status: 'idle', query: '', total: null, results: [], truncated: false };
  const terms = queryTerms(requested);
  const normalized = normalize(requested);
  const prNumber = normalized.match(/(?:pr|プルリク(?:エスト)?)\s*#?\s*(\d+)/)?.[1];
  const issueNumber = normalized.match(/(?:issue|イシュー)\s*#?\s*(\d+)/)?.[1];
  const matches = [];
  for (const entry of index.entries) {
    const fields = [normalize(entry.path), normalize(entry.title), normalize(entry.summary), normalize(entry.category)];
    let score = fields.reduce((sum, field, fieldIndex) => sum + (field.includes(normalized) ? [30, 15, 6, 3][fieldIndex] : 0), 0);
    const matchedTerms = terms.filter(term => fields.some(field => field.includes(term)));
    score += matchedTerms.reduce((sum, term) => sum + fields.reduce((value, field, fieldIndex) => value + (field.includes(term) ? [8, 4, 2, 1][fieldIndex] : 0), 0), 0);
    if (prNumber) {
      if (entry.kind !== 'pr' || entry.label !== `PR #${Number(prNumber)}`) continue;
      score += 50;
    }
    if (issueNumber) {
      if (!entry.issueNumbers?.includes(Number(issueNumber))) continue;
      score += 40;
    }
    if (score > 0) matches.push({ ...entry, score, matchedTerms });
  }
  matches.sort((a, b) => b.score - a.score || b.frameIndex - a.frameIndex || pathOrder(a.id, b.id));
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(60, limit)) : 30;
  return { status: 'ready', query: requested, total: matches.length, results: matches.slice(0, boundedLimit), truncated: matches.length > boundedLimit };
}

export function traceFileHistory(index, path) {
  if (!index?.eventsByPath || typeof path !== 'string') throw new Error('search-history-unavailable');
  const events = index.eventsByPath.get(path);
  return { status: events ? 'recorded' : 'not-found', path, events: events ? events.map(event => ({ ...event, issues: [...event.issues], recordPaths: [...event.recordPaths] })) : [],
    scope: 'previous-displayed-revisions', codeContent: 'unavailable', renameTracking: 'unavailable' };
}
