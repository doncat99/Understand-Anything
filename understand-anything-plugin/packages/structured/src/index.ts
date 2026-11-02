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
  const nodeIndex = new Map(input.nodes.map((node, index) => [node.id, index]));
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
  const relationReferences: { aggregateId: string; relationId: string }[] = [];
  const incident = new Map<string, number[]>();
  input.edges.forEach((edge, index) => {
    if (edge.type === 'contains') return;
    for (const id of new Set([edge.source, edge.target])) {
      const list = incident.get(id) ?? [];
      list.push(index); incident.set(id, list);
    }
  });
  const aggregate = (scene: UnderstandingScene, owner: Map<string, Set<string>>) => {
    const links = new Map<string, { source: string; target: string; relationType: string; relationIds: Set<string> }>();
    const candidates = new Set<number>();
    for (const id of owner.keys()) for (const index of incident.get(id) ?? []) candidates.add(index);
    for (const index of candidates) {
      const edge = input.edges[index]!;
      if (edge.type === 'contains') continue;
      for (const source of owner.get(edge.source) ?? []) for (const target of owner.get(edge.target) ?? []) {
      if (source === target) continue;
      // A direct fact is already visible. Do not add a second synthetic copy.
      if (source === edge.source && target === edge.target) continue;
      const relationType = String((edge as E & { metadata?: { relationType?: string } }).metadata?.relationType ?? edge.type);
      const key = JSON.stringify([source, target, relationType]);
      const link = links.get(key) ?? { source, target, relationType, relationIds: new Set<string>() };
      link.relationIds.add(edge.id ?? `${edge.source}:${edge.type}:${edge.target}:${index}`);
      links.set(key, link);
      }
    }
    for (const link of links.values()) {
      const id = `ua:relation:${JSON.stringify([scene.id, link.source, link.target, link.relationType])}`;
      const preview: string[] = [];
      for (const relationId of link.relationIds) {
        relationReferences.push({ aggregateId: id, relationId });
        if (preview.length < 16) preview.push(relationId);
      }
      edges.push({ id, source: link.source, target: link.target, type: 'group_relation', layer: 'knowledge',
        label: `${link.relationIds.size} ${link.relationType.replaceAll('_', ' ')}`, metadata: { presentationOnly: true, sceneId: scene.id, relationType: link.relationType, relationCount: link.relationIds.size, relationIds: preview, relationReference: id } } as unknown as E);
      connect(link.source, link.target);
    }
  };
  const owner = new Map<string, Set<string>>();
  for (const id of canonical) {
    const visited = new Set([id]);
    const queue = [...groups.get(id)!];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const member = queue[cursor]!;
      if (visited.has(member)) continue;
      visited.add(member);
      const owners = owner.get(member) ?? new Set<string>();
      owners.add(id); owner.set(member, owners);
      for (const child of groups.get(member) ?? []) queue.push(child);
    }
  }

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
          metadata: { presentationOnly: true, understandingGroup: { kind: 'collection', memberCount: members.length }, memberCount: members.length, content: 'Navigation collection. Expand to inspect its contents; this grouping does not assert a semantic relationship.' } } as unknown as N;
        nodes.push(node); byId.set(id, node); children.push(id);
        groups.set(id, new Set(members));
        sceneFor(members, node.label!, id);
      }
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
    const original = byId.get(id)!;
    const enriched = { ...original, metadata: { ...original.metadata, understandingGroup: { kind: 'theme', memberCount: members.length } } };
    nodes[nodeIndex.get(id)!] = enriched;
    byId.set(id, enriched);
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
      for (const id of owner.get(node.id) ?? [node.id]) members.add(id);
      bySource.set(sourceNode, members);
    }
  }
  const grouped = new Set([...groups.values()].flatMap(values => [...values]));
  const canonicalIds = new Set(canonical);
  const groupAliases = new Set([...aliases.values()].flat());
  const ungrouped = input.nodes.filter(node => !grouped.has(node.id) && !canonicalIds.has(node.id) && !groupAliases.has(node.id) && node.type !== 'source');
  const nested = new Set(canonical.flatMap(id => [...groups.get(id)!].filter(member => canonicalIds.has(member) && member !== id)));
  const roots = canonical.filter(id => !nested.has(id));
  // Include a representative of every disconnected cyclic component as well.
  const reachable = new Set<string>();
  const visit = (id: string) => {
    const queue = [id];
    for (let i = 0; i < queue.length; i++) {
      const next = queue[i]!;
      if (reachable.has(next)) continue;
      reachable.add(next);
      for (const child of groups.get(next) ?? []) if (canonicalIds.has(child)) queue.push(child);
    }
  };
  roots.forEach(visit);
  for (const id of canonical) if (!reachable.has(id)) { roots.push(id); visit(id); }
  sceneFor([...roots, ...ungrouped.map(node => node.id)], 'Overview');
  const expandable = new Set(scenes.map(scene => scene.groupId).filter(Boolean));
  // Guided reading follows complete leaf scenes and canonical provenance. No
  // arbitrary concept samples, inferred prerequisites or invented time estimates.
  const sourceNodeIds = new Set(sources.map(source => source.id));
  const learning = scenes.filter(scene => !sourceNodeIds.has(scene.groupId ?? '')).flatMap(scene => {
    const nodeIds = scene.nodeIds.filter(id => id === scene.groupId || !expandable.has(id));
    const knowledge = nodeIds.map(id => byId.get(id)!).filter(node => ['concept', 'claim', 'entity', 'question', 'formula'].includes(node.type));
    const sourceIds = [...new Set(knowledge.flatMap(sourceIdsFor))];
    if (!knowledge.length || !sourceIds.length) return [];
    const focusId = scene.groupId ?? knowledge[0]!.id;
    return [{ id: `reading:${scene.id}`, title: scene.title, focusId, nodeIds, sourceIds,
      objective: `Explore ${scene.title}: inspect the concepts, their recorded relationships and source evidence. Guided reading; no prerequisite or mastery assessment has been inferred.` }];
  });
  for (const node of sources) sceneFor([...(bySource.get(node.id) ?? [])], node.label ?? node.id, node.id);
  for (const scene of scenes) {
    const visible = new Set(scene.nodeIds.filter(id => id !== scene.groupId));
    const frontier = new Map<string, Set<string>>();
    for (const id of visible) frontier.set(id, new Set([id]));
    for (const id of visible) {
      const visited = new Set([id]);
      const queue = [...(groups.get(id) ?? [])];
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const member = queue[cursor]!;
        if (visited.has(member) || visible.has(member) || member === scene.groupId) continue;
        visited.add(member);
        const representatives = frontier.get(member) ?? new Set<string>();
        representatives.add(id); frontier.set(member, representatives);
        for (const child of groups.get(member) ?? []) queue.push(child);
      }
    }
    aggregate(scene, frontier);
  }
  return { nodes, edges, relationReferences, understanding: { protocol: 'understand-anything.scenes.v1' as const, overviewSceneIds: ['overview'], scenes, layers, learning } };
}
