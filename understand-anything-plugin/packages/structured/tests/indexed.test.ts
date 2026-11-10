import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { organizeIndexed, organizeIndexedScene } from '../src/indexed.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ua_catalog(id TEXT PRIMARY KEY,type TEXT,label TEXT,organization TEXT,source TEXT,navigationRoot INTEGER DEFAULT 0);
    CREATE TABLE ua_members(parent TEXT,child TEXT,PRIMARY KEY(parent,child)); CREATE INDEX m_child ON ua_members(child);
    CREATE TABLE ua_sources(node TEXT,source TEXT,PRIMARY KEY(node,source));`);
  const node = (id: string, type = 'concept', qualified = type === 'topic') => db.prepare('INSERT INTO ua_catalog(id,type,label,organization) VALUES(?,?,?,?)').run(id, type, id,
    qualified ? JSON.stringify({ basis: 'grounded-overview-section' }) : null);
  const member = (parent: string, child: string) => db.prepare('INSERT INTO ua_members VALUES(?,?)').run(parent, child);
  const relations: Array<{ id: string; source: string; target: string; type: string; direction: string }> = [];
  const fact = (id: string, source: string, target: string, direction = 'forward') => relations.push({ id, source, target, type: 'contradicts', direction });
  const requests: Array<{ nodeId: string; after?: string }> = [];
  const topologyRequests: Array<string | undefined>=[];
  const native = { async topology(after?: string) {
    topologyRequests.push(after);
    const matches=relations.filter(row=>row.id>(after??'')).sort((a,b)=>a.id.localeCompare(b.id));
    const page=matches.slice(0,128);
    return {relations:page,nextCursor:matches.length>page.length?page.at(-1)!.id:null};
  }, async incident(nodeId: string, after?: string) {
    requests.push({ nodeId, after });
    const matches = relations.filter(row => (row.source === nodeId || row.target === nodeId) && row.id > (after ?? '')).sort((a,b) => a.id.localeCompare(b.id));
    const page = matches.slice(0,32);
    return { relations: page, nextCursor: matches.length > page.length ? page.at(-1)!.id : null };
  } };
  const scenes = new Map<string, string[]>(), edges: any[] = [], lessons: any[] = [], refs: string[] = [];
  const sink = { node() {}, edge: (edge: any) => edges.push(edge), reference: (_: string, relation: string) => refs.push(relation),
    scene(scope: string, _: string, ids: string[]) { assert.ok(ids.length <= 128); scenes.set(scope, ids); },
    lesson(_: number, lesson: any) { lessons.push(lesson); }, check() {} };
  return { db, node, member, fact, scenes, edges, lessons, refs, sink, native, requests, topologyRequests };
}
test('indexed scenes retain nested/overlapping rollups, direction, provenance and source-backed reading', async () => {
  const f = fixture();
  for (const id of ['outer','inner','other']) f.node(id, 'topic');
  for (const id of ['a','b','ungrouped']) f.node(id);
  f.member('outer','inner'); f.member('inner','a'); f.member('other','b');
  f.fact('r','a','b'); f.fact('back','a','b','backward'); f.fact('direct','a','ungrouped');
  f.db.prepare('INSERT INTO ua_sources VALUES(?,?)').run('a','pdf');
  const result = await organizeIndexed(f.db as any, f.sink, f.native);
  assert.deepEqual(f.scenes.get(''), ['other','outer','ua:navigation:content','ua:navigation:sources']);
  assert.ok(f.scenes.get('ua:navigation:content')!.includes('ungrouped'));
  const rootEdges = f.edges.filter(edge => edge.metadata?.sceneId === 'overview');
  assert.ok(rootEdges.some(edge => edge.source === 'outer' && edge.target === 'other' && edge.metadata.direction === 'backward'));
  assert.ok(!rootEdges.some(edge => edge.target.startsWith('ua:navigation:')));
  assert.ok(f.lessons.some(lesson => lesson.nodeIds.includes('a') && lesson.sourceIds.includes('pdf')));
  assert.equal(result.coverage.plannedKnowledgeNodeCount, 1);
  assert.ok(f.refs.includes('r')); f.db.close();
});
test('large themes stay fully reachable through bounded collections and cycles remain reachable', async () => {
  const f = fixture(); f.node('theme','topic'); f.node('cycleA','topic'); f.node('cycleB','topic');
  f.member('cycleA','cycleB'); f.member('cycleB','cycleA');
  for (let i=0;i<500;i++) { f.node(`n${i}`); f.member('theme',`n${i}`); }
  await organizeIndexed(f.db as any, f.sink, f.native);
  assert.ok(f.scenes.get('ua:navigation:content')!.includes('cycleA'));
  assert.ok(f.scenes.get('theme')!.length < 128);
  const seen = new Set<string>(); const visit = (id: string) => { if(seen.has(id))return; seen.add(id); for(const child of f.scenes.get(id) ?? []) if(child!==id)visit(child); };
  for(const id of f.scenes.get('')!)visit(id);
  for(let i=0;i<500;i++)assert.ok(seen.has(`n${i}`)); f.db.close();
});
test('equal membership never aliases semantic topics; structural communities do not create lessons', async () => {
  const f = fixture(); f.node('topic', 'topic'); f.node('other-topic','topic'); f.node('community','community'); f.node('a');
  f.member('topic','a'); f.member('other-topic','a'); f.member('community','a');
  f.db.prepare('INSERT INTO ua_catalog(id,type,label,source) VALUES(?,?,?,?)').run('source:card','source','PDF','canonical-pdf');
  f.db.prepare('INSERT INTO ua_sources VALUES(?,?)').run('a','canonical-pdf');
  await organizeIndexed(f.db as any,f.sink,f.native);
  assert.deepEqual(f.scenes.get(''),['other-topic','topic','ua:navigation:content','ua:navigation:sources']);
  assert.deepEqual(f.scenes.get('topic'),['topic','a']);
  assert.deepEqual(f.scenes.get('source:card'),['source:card','a']);
  assert.equal(f.lessons.length,2);
  assert.ok(f.lessons.every(lesson => ['topic','other-topic'].includes(lesson.focusId))); f.db.close();
});

test('unqualified topology stays accessible without fabricated themes or reading modules', async () => {
  const f = fixture(); f.node('legacy-topic','topic',false); f.node('community','community'); f.node('a');
  f.member('legacy-topic','a'); f.member('community','a');
  f.db.prepare('INSERT INTO ua_sources VALUES(?,?)').run('a','pdf');
  const result = await organizeIndexed(f.db as any,f.sink,f.native);
  assert.deepEqual(f.scenes.get(''),['ua:navigation:content','ua:navigation:sources']);
  assert.ok(f.scenes.get('ua:navigation:content')!.includes('legacy-topic'));
  assert.ok(f.scenes.get('community')!.includes('a'));
  assert.equal(result.totalModules,0); assert.equal(f.lessons.length,0); f.db.close();
});

test('catalog construction defers non-overview relationship expansion until that scene is requested', async () => {
  const f = fixture(); f.node('theme','topic'); f.node('a'); f.node('b');
  f.member('theme','a'); f.member('theme','b'); f.fact('r','a','b');
  await organizeIndexed(f.db as any, f.sink, f.native);
  assert.ok(f.scenes.has('theme'));
  assert.equal(f.edges.filter(e => e.metadata?.sceneId === 'group:theme').length, 0);
  await organizeIndexedScene(f.db as any, f.sink, 'theme', f.native);
  assert.equal(f.edges.filter(e => e.type === 'contains' && e.metadata?.sceneId === 'group:theme').length, 2);
  // Direct facts remain canonical and are read by endpoint; no fabricated aggregate.
  assert.equal(f.edges.filter(e => e.type === 'group_relation').length, 0);
  f.db.close();
});

test('native incident pages retain every aggregate reference and exact metrics without a fact table', async () => {
  const f = fixture(); f.node('left','topic'); f.node('right','topic');
  for (const id of ['a','b','isolated']) f.node(id);
  f.member('left','a'); f.member('right','b');
  for (let i=0;i<140;i++) f.fact(`r${String(i).padStart(3,'0')}`,'a','b');
  const result = await organizeIndexed(f.db as any,f.sink,f.native);
  const aggregate = f.edges.find(edge => edge.type === 'group_relation');
  assert.equal(aggregate.metadata.relationCount,140);
  assert.equal(aggregate.metadata.relationIds.length,16);
  assert.equal(f.refs.length,140); assert.equal(new Set(f.refs).size,140);
  assert.deepEqual(result.graphMetrics,{ knowledgeNodeCount:3,edgeCount:140,isolatedNodeCount:1,
    connectedComponentCount:2,communityCount:0,minCommunitySize:0,maxCommunitySize:0 });
  assert.equal(result.coverage.connectedKnowledgeNodeCount,2);
  assert.deepEqual(f.topologyRequests,[undefined,'r127']);
  assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('ua_nodes','ua_facts')").get()!.n,0);
  f.db.close();
});

test('native page failures and cancellation never become an empty successful catalog', async () => {
  const f = fixture(); f.node('a');
  await assert.rejects(organizeIndexed(f.db as any,f.sink,{ ...f.native, async topology() { throw new Error('withdrawn'); } }),/withdrawn/);
  f.db.close();
  const cancelled = fixture(); cancelled.node('a');
  await assert.rejects(organizeIndexed(cancelled.db as any,{...cancelled.sink,check() { throw new Error('cancelled'); }},cancelled.native),/cancelled/);
  assert.equal(cancelled.requests.length,0); cancelled.db.close();
});

test('native topology rejects malformed pages and non-progressing cursors', async () => {
  const relation = { id:'r',source:'a',target:'b',type:'related',direction:'forward' };
  const pages = [
    { relations:[relation],nextCursor:'different' },
    { relations:[],nextCursor:'r' },
    { relations:[{...relation,direction:''}],nextCursor:null },
    { relations:[relation,relation],nextCursor:null },
    { relations:[{...relation,type:'界'.repeat(3000)}],nextCursor:null },
    { relations:Array.from({length:129},(_,i)=>({...relation,id:`r${i}`})),nextCursor:null },
    { relations:[null],nextCursor:null },
    { relations:[],nextCursor:null,extra:'unbound' },
  ];
  for (const page of pages) {
    const f = fixture(); f.node('a');
    await assert.rejects(organizeIndexed(f.db as any,f.sink,{ ...f.native, async topology() { return page as any; } }),/UA native relation/);
    f.db.close();
  }
  const repeated = fixture(); repeated.node('a');
  await assert.rejects(organizeIndexed(repeated.db as any,repeated.sink,{ ...repeated.native, async topology() {
    return { relations:[relation],nextCursor:'r' };
  } }),/Invalid UA native relation relation/);
  repeated.db.close();
});

test('native topology enforces the page byte budget and cancellation after await', async () => {
  const f = fixture(); f.node('a');
  await assert.rejects(organizeIndexed(f.db as any,f.sink,{ ...f.native, async topology() {
    return { relations:Array.from({length:128},(_,i)=>({ id:`r${String(i).padStart(2,'0')}`,source:'a',target:'b',type:'x'.repeat(8192),direction:'forward' })),nextCursor:null };
  } }),/UA native relation page exceeds its budget/);
  f.db.close();
  const cancelled = fixture(); cancelled.node('a'); let withdrawn = false;
  await assert.rejects(organizeIndexed(cancelled.db as any,{...cancelled.sink,check() {
    if (withdrawn) throw new Error('withdrawn after native read');
  }},{ ...cancelled.native, async topology() { withdrawn = true; return { relations:[],nextCursor:null }; } }),/withdrawn after native read/);
  cancelled.db.close();
});

 test('metrics read one topology stream rather than every concept neighborhood', async () => {
  const f=fixture();
  for(let i=0;i<1000;i++)f.node(`n${i}`);
  f.fact('edge','n0','n999');
  let topologyCalls=0;
  const native={...f.native,async topology() {
    topologyCalls++;return {relations:[{id:'edge',source:'n0',target:'n999',type:'contradicts',direction:'forward'}],nextCursor:null};
  }};
  const result=await organizeIndexed(f.db as any,f.sink,native);
  assert.equal(topologyCalls,1);
  // No graph concepts are visible in the initial navigation-only scene.
  assert.equal(f.requests.length,0);
  assert.equal(result.graphMetrics.edgeCount,1);
  assert.equal(result.graphMetrics.connectedComponentCount,999);
  f.db.close();
});

 test('scene incident reads still reject foreign endpoints and oversized pages', async () => {
  for (const relations of [
    [{id:'foreign',source:'outside',target:'elsewhere',type:'relates',direction:'forward'}],
    Array.from({length:33},(_,i)=>({id:`r${String(i).padStart(2,'0')}`,source:'a',target:'b',type:'relates',direction:'forward'})),
  ]) {
    const f=fixture(); f.node('theme','topic'); f.node('a'); f.node('b');
    f.member('theme','a'); f.member('theme','b');
    await organizeIndexed(f.db as any,f.sink,f.native);
    await assert.rejects(organizeIndexedScene(f.db as any,f.sink,'theme',{
      ...f.native,async incident(){return {relations,nextCursor:null};}
    }),/UA native relation/);
    f.db.close();
  }
});
