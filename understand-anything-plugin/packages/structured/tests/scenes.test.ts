import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { assembleUnderstanding } from '../src/index.ts';

test('semantic overview is bounded without losing membership, identity or evidence', () => {
  const nodes = Array.from({ length: 30000 }, (_, i) => ({ id: `n${i}`, type: 'concept', evidenceIds: [`e${i}`] }));
  const groups = Array.from({ length: 5000 }, (_, i) => ({ id: `g${i}`, type: 'community' }));
  const edges = nodes.map((node, i) => ({ id: `m${i}`, source: `g${Math.floor(i / 6)}`, target: node.id, type: 'contains' }));
  const result = assembleUnderstanding({ nodes: [...groups, ...nodes], edges });
  assert.ok(result.nodes.length >= 35000);
  assert.equal(result.understanding.overviewSceneIds.length, 1);
  assert.ok(result.understanding.scenes.every(scene => scene.nodeIds.length <= 129));
  assert.deepEqual(new Set(result.understanding.scenes.flatMap(scene => scene.nodeIds)), new Set(result.nodes.map(node => node.id)));
  assert.deepEqual(result.nodes.find(node => node.id === 'n29999')?.evidenceIds, ['e29999']);
  assert.equal(result.understanding.layers[0].nodeIds.length, 6);
});

test('preserves relation semantics and deduplicates equivalent topic/community navigation', () => {
  const result = assembleUnderstanding({ nodes: [{ id: 'c', type: 'community' }, { id: 't', type: 'topic' }, { id: 'a', type: 'concept' }, { id: 'b', type: 'concept' }],
    edges: [{ source: 'c', target: 'a', type: 'contains' }, { source: 't', target: 'a', type: 'contains' }, { source: 'a', target: 'b', type: 'contradicts', evidenceIds: ['e'] }] });
  assert.equal(result.understanding.layers.length, 1);
  assert.equal(result.understanding.layers[0].id, 't');
  assert.ok(result.understanding.scenes.some(scene => scene.nodeIds.includes('b')));
  assert.deepEqual(result.edges.find(edge => edge.type === 'contradicts')?.evidenceIds, ['e']);
});
