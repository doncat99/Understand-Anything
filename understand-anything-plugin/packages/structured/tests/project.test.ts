import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { assembleUnderstanding } from '../src/index.ts';

test('one project overview preserves every document and its actual relationships', () => {
  const sources = Array.from({ length: 90 }, (_, i) => ({ id: `source:${i}`, sourceId: String(i), label: `Document ${i}`, type: 'source' }));
  const concepts = sources.flatMap((source, i) => Array.from({ length: 10 }, (_, j) => ({ id: `n${i}:${j}`, type: 'concept', sourceId: source.sourceId, label: `Concept ${i}:${j}` })));
  const edges = sources.slice(1).map((source, i) => ({ id: `r${i}`, source: sources[i].id, target: source.id, type: 'source_relation' }));
  const result = assembleUnderstanding({ nodes: [...sources, ...concepts], edges });
  assert.equal(result.understanding.overviewSceneIds.length, 1);
  const overview = result.understanding.scenes.find(scene => scene.id === result.understanding.overviewSceneIds[0])!;
  assert.deepEqual(overview.nodeIds, sources.map(source => source.id));
  assert.equal(result.edges.filter(edge => overview.nodeIds.includes(edge.source) && overview.nodeIds.includes(edge.target)).length, 89);
  assert.ok(result.understanding.scenes.some(scene => scene.groupId === 'source:89' && scene.nodeIds.includes('n89:9')));
  assert.equal(result.understanding.learning.length, 90);
  assert.ok(result.understanding.learning.every(lesson => lesson.sourceIds.length && lesson.nodeIds.includes(lesson.focusId)));
});

test('equivalent groups remain navigation, with traceable aggregate relationships', () => {
  const result = assembleUnderstanding({ nodes: [{ id: 'c', type: 'community' }, { id: 't', type: 'topic' }, { id: 'u', type: 'topic' }, { id: 'a', type: 'concept' }, { id: 'b', type: 'concept' }],
    edges: [{ id: 'ca', source: 'c', target: 'a', type: 'contains' }, { id: 'ta', source: 't', target: 'a', type: 'contains' }, { id: 'ub', source: 'u', target: 'b', type: 'contains' }, { id: 'r', source: 'a', target: 'b', type: 'contradicts', evidenceIds: ['e'] }] });
  assert.deepEqual(result.understanding.scenes.find(scene => scene.id === 'overview')!.nodeIds, ['t', 'u']);
  assert.ok(result.edges.some(edge => edge.source === 't' && edge.target === 'u' && edge.type === 'group_relation'));
  assert.deepEqual(result.edges.find(edge => edge.type === 'contradicts')?.evidenceIds, ['e']);
});

test('large details form an expandable hierarchy, never extra overview pages or lost members', () => {
  const nodes = Array.from({ length: 3000 }, (_, i) => ({ id: `n${i}`, label: `Concept ${i}`, type: 'concept' }));
  const edges = nodes.slice(1).map((node, i) => ({ id: `r${i}`, source: nodes[i].id, target: node.id, type: 'related' }));
  const result = assembleUnderstanding({ nodes, edges });
  assert.equal(result.understanding.overviewSceneIds.length, 1);
  assert.ok(result.understanding.scenes.every(scene => scene.nodeIds.length < 3000));
  const reachable = new Set(result.understanding.scenes.flatMap(scene => scene.nodeIds));
  assert.ok(nodes.every(node => reachable.has(node.id)));
  assert.equal(new Set(result.understanding.scenes.map(scene => scene.groupId ?? '')).size, result.understanding.scenes.length);
});
