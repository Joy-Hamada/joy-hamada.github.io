export function selectChangeTrace(frame, path) {
  const trace = frame?.trace;
  if (trace?.schemaVersion !== 1 || trace.revision !== frame.revision || !Array.isArray(trace.nodes) || !Array.isArray(trace.edges)) return null;
  const nodes = new Map(trace.nodes.map(node => [node.id, node]));
  const file = nodes.get(`file:${path}`);
  if (file?.kind !== 'file' || file.revision !== frame.revision) return null;
  const edges = trace.edges.filter(edge => nodes.has(edge.from) && nodes.has(edge.to)
    && (!edge.proof?.revision || edge.proof.revision === frame.revision));
  return { file, nodes, edges, coverage: trace.coverage, fetchedAt: trace.fetchedAt,
    linksFor(id) { return edges.filter(edge => edge.from === id || edge.to === id).map(edge => ({
      edge, target: nodes.get(edge.from === id ? edge.to : edge.from), outgoing: edge.from === id })); },
    recordFor(id) {
      const node = nodes.get(id);
      if (node?.status !== 'collected' || node.revision !== frame.revision) return null;
      return frame.story?.documents?.find(record => record.path === node?.path && record.revision === frame.revision) ?? null;
    } };
}

export const traceLinkLabels = Object.freeze({
  'merged-pr-change': 'PRの変更', 'pr-issue-reference': '取得時の関連', 'document-link': '文書の参照',
  'github-issue-link': 'Issueへの参照', 'github-pr-link': 'PRへの参照', 'file-mention': 'ファイルへの言及',
});
