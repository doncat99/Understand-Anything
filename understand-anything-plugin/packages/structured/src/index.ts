export interface UnderstandingScene { id: string; title: string; nodeIds: string[]; groupId?: string }
export interface UnderstandingPresentation {
  protocol: 'understand-anything.scenes.v1';
  overviewSceneIds: string[];
  scenes: UnderstandingScene[];
  layers: { id: string; name: string; description: string; nodeIds: string[] }[];
  learning: { id: string; title: string; focusId: string; nodeIds: string[]; sourceIds: string[]; objective: string }[];
}

/** Organize canonical facts into bounded reading scenes, without inferring new facts. */
export function assembleUnderstanding<N extends { id: string; type: string; label?: string; sourceId?: string; metadata?: Record<string, unknown> }, E extends { id?: string; source: string; target: string; type: string }>(input: { nodes: N[]; edges: E[] }) {
  const byId = new Map(input.nodes.map(node => [node.id, node]));
  const groups = new Map(input.nodes.filter(node => ['community', 'topic', 'cluster'].includes(node.type)).map(node => [node.id, new Set<string>()]));
  for (const edge of input.edges) if (edge.type === 'contains' && groups.has(edge.source) && byId.has(edge.target)) groups.get(edge.source)!.add(edge.target);
  const equivalent = new Map<string, string>();
  const aliases = new Map<string, string[]>();
  for (const [id, members] of groups) {
    if (!members.size) continue;
    const key = JSON.stringify([...members].sort());
    const prior = equivalent.get(key);
    if (!prior) { equivalent.set(key, id); continue; }
    if (byId.get(id)?.type === 'topic' && byId.get(prior)?.type !== 'topic') {
      equivalent.set(key, id);
      aliases.set(id, [prior, ...(aliases.get(prior) ?? [])]);
      aliases.delete(prior);
    } else aliases.set(prior, [...(aliases.get(prior) ?? []), id]);
  }
  const canonical = [...equivalent.values()];
  const scenes: UnderstandingScene[] = [];
  const layers: UnderstandingPresentation['layers'] = [];
  const nodes = [...input.nodes];
  const edges = [...input.edges];
  const containment = new Set(input.edges.filter(edge => edge.type === 'contains').map(edge => JSON.stringify([edge.source, edge.target])));
  const adjacency = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    if (a === b) return;
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b); adjacency.get(b)!.add(a);
  };
  input.edges.forEach(edge => connect(edge.source, edge.target));
  const aggregate = (owner: Map<string, string>, candidates: E[]) => {
    const links = new Map<string, { source: string; target: string; relationIds: string[] }>();
    for (const [index, edge] of candidates.entries()) {
      if (edge.type === 'contains') continue;
      const source = owner.get(edge.source); const target = owner.get(edge.target);
      if (!source || !target || source === target) continue;
      const key = JSON.stringify([source, target]);
      const link = links.get(key) ?? { source, target, relationIds: [] };
      link.relationIds.push(edge.id ?? `${edge.source}:${edge.type}:${edge.target}:${index}`);
      links.set(key, link);
    }
    for (const link of links.values()) {
      edges.push({ id: `ua:relation:${JSON.stringify([link.source, link.target])}`, ...link, type: 'group_relation', layer: 'knowledge',
        label: `${link.relationIds.length} underlying relations`, metadata: { presentationOnly: true, relationIds: link.relationIds } } as unknown as E);
      connect(link.source, link.target);
    }
  };
  const owner = new Map<string, string>();
  for (const id of canonical) for (const member of groups.get(id)!) if (!owner.has(member)) owner.set(member, id);
  aggregate(owner, input.edges);

  // This is a render granularity, not a corpus limit: every member has a child
  // scene and every overview has exactly one root. No knowledge is sampled away.
  const detailCapacity = 128;
  let collectionId = 0;
  const sceneFor = (values: string[], title: string, groupId?: string): void => {
    let ids = [...new Set(values)].filter(id => id !== groupId);
    if (ids.length > detailCapacity) {
      const remaining = new Set(ids);
      const childSize = Math.ceil(Math.sqrt(ids.length));
      const children: string[] = [];
      const parentByMember = new Map<string, string>();
      while (remaining.size) {
        const seed = remaining.values().next().value!;
        const queue = [seed]; remaining.delete(seed);
        const members: string[] = [];
        let cursor = 0;
        while (cursor < queue.length) {
          const current = queue[cursor++]!; members.push(current);
          for (const neighbor of adjacency.get(current) ?? []) {
            if (queue.length >= childSize) break;
            if (remaining.delete(neighbor)) queue.push(neighbor);
          }
        }
        // Disconnected items remain explicit navigation collections, never
        // claims that the underlying concepts are semantically equivalent.
        while (members.length < childSize && remaining.size) {
          const next = remaining.values().next().value!;
          remaining.delete(next); members.push(next);
        }
        const id = `ua:collection:${collectionId++}`;
        const label = members.slice(0, 2).map(member => byId.get(member)?.label ?? member).join(' / ');
        const node = { id, type: 'topic', label: `${label} (${members.length} items)`, layer: 'knowledge',
          metadata: { presentationOnly: true, memberCount: members.length, content: 'Navigation collection. Expand to inspect its contents; this grouping does not assert a semantic relationship.' } } as unknown as N;
        nodes.push(node); byId.set(id, node); children.push(id);
        members.forEach(member => parentByMember.set(member, id));
        sceneFor(members, node.label!, id);
      }
      aggregate(parentByMember, [...edges]);
      ids = children;
      // Very large inputs can require more than one navigation level.
      if (ids.length > detailCapacity) { sceneFor(ids, title, groupId); return; }
    }
    const nodeIds = groupId ? [groupId, ...ids] : ids;
    if (groupId) for (const id of ids) {
      const key = JSON.stringify([groupId, id]);
      if (containment.has(key)) continue;
      containment.add(key);
      edges.push({ id: `ua:contains:${groupId}:${id}`, source: groupId, target: id,
        type: 'contains', layer: 'knowledge', metadata: { presentationOnly: true } } as unknown as E);
    }
    scenes.push({ id: groupId ? `group:${groupId}` : 'overview', title, nodeIds, ...(groupId ? { groupId } : {}) });
  };
  for (const id of canonical) {
    const members = [...groups.get(id)!];
    const name = byId.get(id)?.label ?? id;
    layers.push({ id, name, description: name, nodeIds: members });
    sceneFor([...members, ...(aliases.get(id) ?? [])], name, id);
  }
  const sources = input.nodes.filter(node => node.type === 'source');
  const sourceNodes = new Map(sources.map(node => [node.sourceId ?? node.id.replace(/^source:/, ''), node.id]));
  const sourceIdsFor = (node: N) => [...new Set([...(node.sourceId ? [node.sourceId] : []),
    ...(Array.isArray(node.metadata?.learningSourceIds) ? node.metadata.learningSourceIds.filter((id): id is string => typeof id === 'string') : [])])];
  const bySource = new Map<string, Set<string>>();
  for (const node of input.nodes) if (!['source', 'community', 'topic', 'cluster'].includes(node.type)) {
    for (const source of sourceIdsFor(node)) {
      const sourceNode = sourceNodes.get(source);
      if (!sourceNode) continue;
      const members = bySource.get(sourceNode) ?? new Set<string>();
      members.add(owner.get(node.id) ?? node.id); bySource.set(sourceNode, members);
    }
  }
  for (const node of sources) sceneFor([...(bySource.get(node.id) ?? [])], node.label ?? node.id, node.id);
  const grouped = new Set([...groups.values()].flatMap(values => [...values]));
  const canonicalIds = new Set(canonical);
  const groupAliases = new Set([...aliases.values()].flat());
  const ungrouped = input.nodes.filter(node => !grouped.has(node.id) && !canonicalIds.has(node.id) && !groupAliases.has(node.id) && node.type !== 'source');
  if (sources.length) {
    const withoutSource = ungrouped.filter(node => !sourceIdsFor(node).some(source => sourceNodes.has(source)));
    const sourced = new Set([...bySource.values()].flatMap(values => [...values]));
    sceneFor([...sources.map(node => node.id), ...canonical.filter(id => !sourced.has(id)), ...withoutSource.map(node => node.id)], 'Overview');
  } else sceneFor([...canonical, ...ungrouped.map(node => node.id)], 'Overview');
  // Introductory reading is document-sized, not one mandatory lesson per entity.
  // Each scene retains canonical nodes and links; this is not model-authored teaching.
  const conceptsBySource = new Map<string, N[]>();
  for (const candidate of input.nodes) if (candidate.type === 'concept') for (const source of sourceIdsFor(candidate)) {
    const sourceNode = sourceNodes.get(source);
    if (!sourceNode) continue;
    const candidates = conceptsBySource.get(sourceNode) ?? [];
    candidates.push(candidate); conceptsBySource.set(sourceNode, candidates);
  }
  const learning = sources.map(node => {
    const candidates = conceptsBySource.get(node.id) ?? [];
    candidates.sort((a, b) => (adjacency.get(b.id)?.size ?? 0) - (adjacency.get(a.id)?.size ?? 0) || a.id.localeCompare(b.id));
    return { id: `orientation:${node.id}`, title: node.label ?? node.id, focusId: node.id,
      nodeIds: [node.id, ...candidates.slice(0, 7).map(candidate => candidate.id)], sourceIds: [node.sourceId ?? node.id.replace(/^source:/, '')],
      objective: `Read ${node.label ?? node.id} and inspect its source-backed concepts. This is an orientation, not an assessed course.` };
  });
  return { nodes, edges, understanding: { protocol: 'understand-anything.scenes.v1' as const, overviewSceneIds: ['overview'], scenes, layers, learning } };
}
