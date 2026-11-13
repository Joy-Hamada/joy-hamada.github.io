const recordPattern = /^docs\/(?:issues|decisions|spec-driven-dev\/(?:req|design|tasks|dev-report))\/[A-Za-z0-9._-]+\.md$/;
const issuePattern = /^docs\/issues\//;
const sddPattern = /^docs\/spec-driven-dev\//;
const adrPattern = /^docs\/decisions\//;
const maximumOriginalBytes = 256 * 1024;

function recordChange(frame, path) {
  if (frame.changes?.status !== 'measured') return 'unknown';
  if (frame.changes.added.includes(path)) return 'added';
  if (frame.changes.modified.includes(path)) return 'modified';
  return 'unchanged';
}

function recordGroup(frame, records, pattern) {
  const measured = frame.changes?.status === 'measured';
  const changes = Object.fromEntries(['added', 'modified', 'deleted'].map(kind => [kind, measured ? frame.changes[kind].filter(path => pattern.test(path)) : []]));
  const selected = records.filter(record => pattern.test(record.path));
  const changedCount = changes.added.length + changes.modified.length + changes.deleted.length;
  return { records: selected, status: !measured ? 'unknown' : changedCount ? 'updated' : selected.length ? 'unchanged' : 'unknown',
    changedCount, changes, comparisonRevision: frame.changes?.comparisonRevision ?? null };
}

/** Presentation data only. Callers render original Markdown as text, never executable HTML. */
export function buildMobileRecords(frame) {
  const files = new Set((frame.files ?? []).map(file => file.path));
  const seen = new Set(); let rejected = 0;
  const records = [];
  for (const document of frame.story?.documents ?? []) {
    if (!recordPattern.test(document?.path) || document.revision !== frame.revision || !files.has(document.path) || seen.has(document.path)
      || typeof document.content !== 'string' || document.content.includes('\0') || new TextEncoder().encode(document.content).length > maximumOriginalBytes) { rejected += 1; continue; }
    seen.add(document.path);
    records.push({ path: document.path, revision: frame.revision, kind: document.kind, label: document.label || document.path,
      content: document.content, change: recordChange(frame, document.path), relationBasis: document.relationBasis ?? 'same-revision-document-reference' });
  }
  const relatedPaths = Array.isArray(frame.story?.relatedDocumentPaths) ? new Set(frame.story.relatedDocumentPaths) : null;
  const issueRecords = records.filter(record => issuePattern.test(record.path) && (!relatedPaths || relatedPaths.has(record.path)));
  const question = frame.story?.question;
  const questionSource = question?.source;
  const validQuestion = questionSource && questionSource.revision === frame.revision && issuePattern.test(questionSource.path)
    && files.has(questionSource.path) && (!relatedPaths || relatedPaths.has(questionSource.path)) && question.basis !== 'unknown' && typeof question.text === 'string';
  const summary = validQuestion ? question.text : issueRecords[0]?.label ?? 'Issue未取得';
  const coverage = frame.story?.documentCoverage;
  return {
    revision: frame.revision,
    issue: { summary, basis: validQuestion ? 'same-revision-issue-excerpt' : issueRecords.length ? 'same-revision-issue-title' : 'unknown',
      records: issueRecords, relatedIssues: [...new Map([...(frame.pr?.issues ?? []), ...(frame.story?.documentIssues ?? [])]
        .filter(issue => Number.isSafeInteger(issue.number) && issue.number > 0 && issue.url === `https://github.com/Joy-Hamada/xozu/issues/${issue.number}`)
        .map(issue => [issue.number, { number: issue.number, url: issue.url }])).values()] },
    sdd: recordGroup(frame, records, sddPattern), adr: recordGroup(frame, records, adrPattern),
    coverage: { status: rejected ? 'partial' : coverage?.status ?? (records.length ? 'selected' : 'unknown'), selected: records.length,
      omitted: coverage?.omitted ?? 0, unavailable: (coverage?.unavailable ?? 0) + rejected, unexamined: coverage?.unexamined ?? 0,
      limit: coverage?.limit ?? null, candidateLimit: coverage?.candidateLimit ?? null },
  };
}
