import { createHash } from 'node:crypto';

/** Disk-backed organizer. The caller budgets the immutable input. */
export interface IndexedDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
}
export interface IndexedSink {
  node(node: Record<string, unknown>): void;
  edge(edge: Record<string, unknown>): void;
  reference(aggregate: string, relation: string): void;
  scene(scope: string, title: string, ids: string[]): void;
  lesson(ordinal: number, lesson: { id: string; title: string; objective: string; focusId: string; nodeIds: string[]; sourceIds: string[] }): void;
  check(): void;
  /** Host supplies batched writes; SQL-heavy navigation stays in the child. */
  write?(sql: string, ...args: unknown[]): unknown;
}
type Row = Record<string, string | number>;
type NativeRelation = { id: string; source: string; target: string; type: string; direction: string };
export interface IndexedNativeReader {
  topology(after?: string): Promise<{ relations: NativeRelation[]; nextCursor: string | null }>;

}

async function* nativeRelations(native: IndexedNativeReader, sink: Pick<IndexedSink, 'check'>) {
  let after: string | undefined;
  do {
    sink.check();
    const page = await native.topology(after);
    sink.check();
    if (!page || typeof page !== 'object' || Object.keys(page).length !== 2
      || !Object.hasOwn(page, 'relations') || !Object.hasOwn(page, 'nextCursor')) {
      throw new Error('Invalid UA native relation page.');
    }
    if (!Array.isArray(page.relations) || page.relations.length > 128
      || Buffer.byteLength(JSON.stringify(page)) > 262144) throw new Error('UA native relation page exceeds its budget.');
    let previous = after ?? '';
    for (const relation of page.relations) {
      if (!relation || typeof relation !== 'object' || Object.keys(relation).length !== 5
        || Object.entries(relation).some(([key,value]) => !['id','source','target','type','direction'].includes(key)
        || typeof value !== 'string' || !value || Buffer.byteLength(value) > 8192)
        || !relation.id || !relation.source || !relation.target || !relation.type || !relation.direction
        || relation.id <= previous) {
        throw new Error('Invalid UA native relation relation.');
      }
      previous = relation.id;
    }
    if (page.nextCursor !== null && (!page.relations.length || page.nextCursor !== previous)) {
      throw new Error('Invalid UA native relation continuation.');
    }
    for (const relation of page.relations) { sink.check(); yield relation; }
    after = page.nextCursor ?? undefined;
  } while (after);
}

/** Input: reference-only ua_catalog, ua_members and ua_sources. Facts stay native. */
export async function organizeIndexed(db: IndexedDatabase, sink: IndexedSink, native: IndexedNativeReader) {
  const rows = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as Row[];
  const one = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as Row | undefined;
  const count = (sql: string, ...args: unknown[]) => Number(one(sql, ...args)?.n ?? 0);
  const run = (sql: string, ...args: unknown[]) => { sink.check(); return sink.write ? sink.write(sql, ...args) : db.prepare(sql).run(...args); };
  function* scan(sql: string, args: unknown[] = []): Generator<Row> {
    let cursor = '';
    while (true) {
      sink.check();
      const page = rows(sql, ...args, cursor);
      if (!page.length) break;
      for (const row of page) yield row;
      cursor = String(page[page.length - 1]!.id);
    }
  }
  db.exec(`CREATE TABLE ua_navigation(parent TEXT,child TEXT,PRIMARY KEY(parent,child));
    CREATE INDEX ua_navigation_child ON ua_navigation(child,parent);
    CREATE TABLE ua_roots(id TEXT PRIMARY KEY);
    CREATE TABLE ua_reachable(id TEXT PRIMARY KEY);
    CREATE TABLE ua_scenes(id TEXT PRIMARY KEY,title TEXT,ids TEXT);
    CREATE TABLE ua_frontier(node TEXT,representative TEXT,PRIMARY KEY(node,representative));
    CREATE TABLE ua_visible(id TEXT PRIMARY KEY);
    CREATE TABLE ua_aggregates(source TEXT,target TEXT,type TEXT,direction TEXT,relation TEXT,PRIMARY KEY(source,target,type,direction,relation));
    CREATE TABLE ua_planned(id TEXT PRIMARY KEY);
    CREATE TABLE ua_covered(source TEXT PRIMARY KEY);
    CREATE TABLE ua_topics(id TEXT PRIMARY KEY);
    CREATE TABLE ua_reading_scopes(id TEXT PRIMARY KEY,topic TEXT);
    INSERT INTO ua_topics SELECT id FROM ua_catalog WHERE type='topic'
      AND json_extract(organization,'$.basis')='grounded-overview-section';
    INSERT INTO ua_navigation SELECT m.parent,m.child FROM ua_members m JOIN ua_catalog n ON n.id=m.child;`);
  // Equal members do not make two native topics semantically equivalent.
  run("INSERT INTO ua_roots SELECT id FROM ua_catalog n WHERE type<>'source' AND NOT EXISTS(SELECT 1 FROM ua_navigation m WHERE m.child=n.id AND m.parent<>n.id)");
  // Include every disconnected cycle, while leaving shared descendants shared.
  const visit = (id: string) => run(`WITH RECURSIVE descendants(id) AS (VALUES(?) UNION SELECT m.child FROM ua_navigation m JOIN descendants d ON m.parent=d.id)
    INSERT OR IGNORE INTO ua_reachable SELECT id FROM descendants`, id);
  for (const row of scan('SELECT id FROM ua_roots WHERE id>? ORDER BY id LIMIT 128')) visit(String(row.id));
  for (const row of scan("SELECT id FROM ua_catalog WHERE type IN ('topic','community','cluster') AND id>? ORDER BY id LIMIT 128")) {
    const id = String(row.id);
    if (!one('SELECT 1 FROM ua_reachable WHERE id=?', id)) { run('INSERT OR IGNORE INTO ua_roots VALUES(?)', id); visit(id); }
  }
  let sequence = 0;
  const addCollection = (members: string[], title: string, readingTopic?: string, navigationOnly = false) => {
    const id = `ua:collection:${sequence++}`;
    const node = { id, type: 'topic', label: title, layer: 'knowledge', metadata: {
      presentationOnly: true, understandingGroup: { kind: 'collection', memberCount: members.length },
      content: 'Navigation collection; this grouping does not assert a semantic relationship.' } };
    run('INSERT INTO ua_catalog(id,type,label,navigationRoot) VALUES(?,?,?,?)', id, node.type, node.label, navigationOnly ? 1 : 0);
    sink.node(node);
    if (readingTopic) run('INSERT INTO ua_reading_scopes VALUES(?,?)', id, readingTopic);
    for (const member of members) run('INSERT INTO ua_navigation VALUES(?,?)', id, member);
    return id;
  };
  // Reserve one slot for a group's own card: a scene always contains <=128 cards.
  const storeScene = (scope: string, title: string, members: string[]) => {
    const ids = scope ? [scope, ...members.filter(id => id !== scope)] : members;
    run('INSERT INTO ua_scenes VALUES(?,?,?)', scope, title, JSON.stringify(ids));
  };
  const sceneFor = (scope: string, title: string, sql: string, args: unknown[]) => {
    let members: string[] = [];
    const capacity = scope ? 127 : 128;
    let childLevel = 0;
    const navigationOnly = !!one('SELECT navigationRoot FROM ua_catalog WHERE id=?', scope)?.navigationRoot;
    const readingTopic = one('SELECT topic FROM ua_reading_scopes WHERE id=?', scope)?.topic as string | undefined;
    // Each level is a disk queue. Never retain all child collections in JS.
    db.exec('CREATE TABLE IF NOT EXISTS ua_queue(level INTEGER,id TEXT,PRIMARY KEY(level,id))');
    run('DELETE FROM ua_queue');
    for (const row of scan(sql, args)) {
      const id = String(row.id);
      if (id === scope) continue;
      members.push(id);
      if (members.length === capacity + 1) {
        const overflow = members.splice(127);
        const child = addCollection(members, `${title} · ${sequence + 1}`, readingTopic, navigationOnly);
        storeScene(child, `${title} · ${sequence}`, members);
        run('INSERT INTO ua_queue VALUES(?,?)', 0, child);
        members = overflow;
      }
    }
    if (!count('SELECT count(*) n FROM ua_queue')) { storeScene(scope, title, members); return; }
    if (members.length) {
      const child = addCollection(members, `${title} · ${sequence + 1}`, readingTopic, navigationOnly);
      storeScene(child, `${title} · ${sequence}`, members);
      run('INSERT INTO ua_queue VALUES(?,?)', 0, child);
    }
    while (count('SELECT count(*) n FROM ua_queue WHERE level=?', childLevel) > capacity) {
      members = [];
      for (const row of scan('SELECT id FROM ua_queue WHERE level=? AND id>? ORDER BY id LIMIT 128', [childLevel])) {
        members.push(String(row.id));
        if (members.length === 127) {
          const child = addCollection(members, `${title} · ${sequence + 1}`, readingTopic, navigationOnly);
          storeScene(child, `${title} · ${sequence}`, members);
          run('INSERT INTO ua_queue VALUES(?,?)', childLevel + 1, child); members = [];
        }
      }
      if (members.length) {
        const child = addCollection(members, `${title} · ${sequence + 1}`, readingTopic, navigationOnly);
        storeScene(child, `${title} · ${sequence}`, members);
        run('INSERT INTO ua_queue VALUES(?,?)', childLevel + 1, child);
      }
      childLevel++;
    }
    storeScene(scope, title, rows('SELECT id FROM ua_queue WHERE level=? ORDER BY id LIMIT 128', childLevel).map(row => String(row.id)));
  };
  for (const row of scan("SELECT id,type,label,organization FROM ua_catalog n WHERE type IN ('topic','community','cluster') AND id NOT LIKE 'ua:collection:%' AND id>? ORDER BY id LIMIT 128")) {
    const id = String(row.id), title = String(row.label);
    const qualified = !!one('SELECT 1 FROM ua_topics WHERE id=?', id);
    sink.node({ id, type: row.type, label: title, layer: 'knowledge', metadata: {
      ...(row.organization ? { organization: JSON.parse(String(row.organization)) } : {}),
      understandingGroup: { kind: qualified ? 'theme' : 'collection', memberCount: count('SELECT count(*) n FROM ua_navigation WHERE parent=?', id) } } });
    if (qualified) run('INSERT INTO ua_reading_scopes VALUES(?,?)', id, id);
    sceneFor(id, title, 'SELECT child AS id FROM ua_navigation WHERE parent=? AND child>? ORDER BY child LIMIT 128', [id]);
  }
  const navigation = (id: string, title: string, sql: string) => {
    const node = { id, type: 'topic', label: title, layer: 'knowledge', metadata: { presentationOnly: true,
      navigationRoot: true, understandingGroup: { kind: 'collection' },
      content: 'Index navigation; this entry is not a semantic theme or a reading course.' } };
    run('INSERT INTO ua_catalog(id,type,label,navigationRoot) VALUES(?,?,?,1)', id, node.type, title);
    for (const row of scan(sql)) run('INSERT INTO ua_navigation VALUES(?,?)', id, row.id);
    sink.node({ ...node, metadata: { ...node.metadata, understandingGroup: { kind: 'collection',
      memberCount: count('SELECT count(*) n FROM ua_navigation WHERE parent=?', id) } } });
    sceneFor(id, title, 'SELECT child AS id FROM ua_navigation WHERE parent=? AND child>? ORDER BY child LIMIT 128', [id]);
  };
  navigation('ua:navigation:content', 'All indexed content', 'SELECT id FROM ua_roots WHERE id>? ORDER BY id LIMIT 128');
  navigation('ua:navigation:sources', 'Sources', "SELECT id FROM ua_catalog WHERE type='source' AND id>? ORDER BY id LIMIT 128");
  for (const [type, title] of [['concept','Concepts'], ['entity','Entities'], ['claim','Facts'], ['conflict','Conflicts'], ['formula','Formulas']]) {
    if (count('SELECT count(*) n FROM ua_catalog WHERE type=?', type)) {
      navigation(`ua:navigation:${type}`, title, `SELECT id FROM ua_catalog WHERE type='${type}' AND id>? ORDER BY id LIMIT 128`);
    }
  }
  // Keep type entries reachable even when there are more themes than one page.
  navigation('ua:navigation:themes', 'Themes', 'SELECT id FROM ua_topics WHERE id>? ORDER BY id LIMIT 128');
  const rootThemes = `SELECT t.id FROM ua_topics t WHERE NOT EXISTS(SELECT 1 FROM ua_navigation m JOIN ua_topics p ON p.id=m.parent WHERE m.child=t.id)`;
  const showThemes = count(`SELECT count(*) n FROM (${rootThemes})`)
    + count("SELECT count(*) n FROM ua_catalog WHERE id LIKE 'ua:navigation:%'") <= 125;
  sceneFor('', 'Overview', `SELECT id FROM (
    SELECT id FROM ua_catalog WHERE id LIKE 'ua:navigation:%'
    ${showThemes ? `UNION ${rootThemes}` : ''}) WHERE id>? ORDER BY id LIMIT 128`, []);
  for (const row of scan("SELECT id,label,source FROM ua_catalog WHERE type='source' AND id>? ORDER BY id LIMIT 128")) {
    if (!row.source) throw new Error('UA source card requires its canonical source reference.');
    sceneFor(String(row.id), String(row.label), 'SELECT node AS id FROM ua_sources WHERE source=? AND node>? ORDER BY node LIMIT 128', [row.source]);
  }
  let lessons = 0;
  for (const row of scan('SELECT id,title,ids FROM ua_scenes WHERE id>? ORDER BY id LIMIT 128')) {
    // The empty overview key is processed separately below.
    processScene(String(row.id), String(row.title), JSON.parse(String(row.ids)) as string[]);
  }
  for (const row of scan(`SELECT n.id,n.label FROM ua_catalog n WHERE n.type IN ('concept','claim','entity','question','formula')
    AND EXISTS(SELECT 1 FROM ua_sources s WHERE s.node=n.id)
    AND NOT EXISTS(SELECT 1 FROM ua_planned p WHERE p.id=n.id) AND n.id>? ORDER BY n.id LIMIT 128`)) {
    const id = String(row.id);
    storeScene(id, String(row.label), []);
    run('INSERT INTO ua_reading_scopes VALUES(?,?)', id, id);
    processScene(id, String(row.label), [id]);
  }
  function processScene(scope: string, title: string, ids: string[]) {
    sink.check(); sink.scene(scope, title, ids);
    if (!one('SELECT 1 FROM ua_reading_scopes WHERE id=?', scope)) return;
    const knowledge = ids.filter(id => one("SELECT 1 FROM ua_catalog WHERE id=? AND type IN ('concept','claim','entity','question','formula')", id));
    if (!knowledge.length) return;
    const placeholders = knowledge.map(() => '?').join(',');
    const sources = rows(`SELECT DISTINCT source FROM ua_sources WHERE node IN (${placeholders}) ORDER BY source LIMIT 129`, ...knowledge).map(row => String(row.source));
    if (sources.length > 128) throw new Error('UA reading scene exceeds 128 source references.');
    if (!sources.length) return;
    const nodeIds = ids.filter(id => id === scope || !one('SELECT 1 FROM ua_scenes WHERE id=?', id));
    sink.lesson(lessons++, { id: `reading:${scope ? `group:${scope}` : 'overview'}`, title, objective: knowledge.map(id => String(one('SELECT label FROM ua_catalog WHERE id=?', id)!.label)).join(' · '), focusId: scope || knowledge[0]!, nodeIds, sourceIds: sources });
    for (const id of knowledge) run('INSERT OR IGNORE INTO ua_planned VALUES(?)', id);
    for (const source of sources) run('INSERT OR IGNORE INTO ua_covered VALUES(?)', source);
  }
  // Only Overview relationships belong to the initial publication. The full
  // navigation and reading catalog above remain complete and independently usable.
  db.exec(`CREATE TEMP TABLE ua_build_relations(id TEXT PRIMARY KEY,source TEXT,target TEXT,type TEXT,direction TEXT);
    CREATE INDEX temp.ua_build_relations_source ON ua_build_relations(source,id);
    CREATE INDEX temp.ua_build_relations_target ON ua_build_relations(target,id);`);
  // Union-find lives on disk too; metrics do not need an eager adjacency graph.
  db.exec(`CREATE TABLE ua_components(id TEXT PRIMARY KEY,parent TEXT,rank INTEGER,connected INTEGER,conceptConnected INTEGER);
    INSERT INTO ua_components SELECT id,id,0,0,0 FROM ua_catalog WHERE type IN ('concept','entity');`);
  const root = (id: string): { id: string; rank: number } | undefined => {
    let row = one('SELECT parent,rank FROM ua_components WHERE id=?', id);
    if (!row) return;
    while (String(row.parent) !== id) { id = String(row.parent); row = one('SELECT parent,rank FROM ua_components WHERE id=?', id)!; }
    return { id, rank: Number(row.rank) };
  };
  let edgeCount = 0;
  for await (const fact of nativeRelations(native, sink)) {
    run('INSERT INTO temp.ua_build_relations VALUES(?,?,?,?,?)', fact.id, fact.source, fact.target, fact.type, fact.direction);
    run('UPDATE ua_components SET connected=1 WHERE id IN (?,?)', fact.source, fact.target);
    const a = root(fact.source), b = root(fact.target);
    if (!a || !b) continue;
    run('UPDATE ua_components SET conceptConnected=1 WHERE id IN (?,?)', fact.source, fact.target);
    edgeCount++;
    if (a.id === b.id) continue;
    const [parent, child] = a.rank >= b.rank ? [a,b] : [b,a];
    run('UPDATE ua_components SET parent=? WHERE id=?', parent.id, child.id);
    if (a.rank === b.rank) run('UPDATE ua_components SET rank=rank+1 WHERE id=?', parent.id);
  }
  // Admitted facts anchor mixed scenes; an edge alone never creates a claim card.
  const overview = one("SELECT title,ids FROM ua_scenes WHERE id=''")!;
  const visible = new Set(JSON.parse(String(overview.ids)) as string[]);
  const addFact = (fact: Row | undefined) => {
    if (!fact) return;
    const ids = [...new Set([fact.id, fact.source, fact.target].map(String))];
    if (visible.size + ids.filter(id => !visible.has(id)).length > 128) return;
    for (const id of ids) visible.add(id);
  };
  // One grounded example per visible theme before filling unrepresented objects.
  for (const theme of [...visible].filter(id => one('SELECT 1 FROM ua_topics WHERE id=?', id))) {
    sink.check();
    addFact(one(`WITH RECURSIVE members(id) AS (VALUES(?) UNION
      SELECT n.child FROM ua_navigation n JOIN members m ON n.parent=m.id)
      SELECT r.id,r.source,r.target FROM temp.ua_build_relations r
      JOIN ua_catalog c ON c.id=r.id AND c.type='claim'
      JOIN ua_catalog s ON s.id=r.source AND s.type IN ('concept','entity')
      JOIN ua_catalog t ON t.id=r.target AND t.type IN ('concept','entity')
      WHERE r.source IN members AND r.target IN members ORDER BY r.id LIMIT 1`, theme));
  }
  let after = '';
  while (visible.size < 128) {
    sink.check();
    const candidates = rows(`SELECT r.id,r.source,r.target FROM temp.ua_build_relations r
      JOIN ua_catalog c ON c.id=r.id AND c.type='claim'
      JOIN ua_catalog s ON s.id=r.source AND s.type IN ('concept','entity')
      JOIN ua_catalog t ON t.id=r.target AND t.type IN ('concept','entity')
      WHERE r.id>? ORDER BY r.id LIMIT 128`, after);
    if (!candidates.length) break;
    for (const fact of candidates) {
      if (!visible.has(String(fact.source)) || !visible.has(String(fact.target))) addFact(fact);
    }
    after = String(candidates.at(-1)!.id);
  }
  // A missing qualified fact must not hide an already admitted source-backed object.
  if (visible.size < 128 && ![...visible].some(id => one("SELECT 1 FROM ua_catalog WHERE id=? AND type IN ('concept','entity','claim')", id))) {
    const object = one(`SELECT c.id FROM ua_catalog c WHERE c.type IN ('concept','entity')
      AND EXISTS(SELECT 1 FROM ua_sources s WHERE s.node=c.id) ORDER BY c.id LIMIT 1`);
    if (object) visible.add(String(object.id));
  }
  const mixed = [...visible].sort();
  run("UPDATE ua_scenes SET ids=? WHERE id=''", JSON.stringify(mixed));
  processScene('', String(overview.title), mixed);
  await organizeIndexedScene(db, sink, '');
  const communitySizes = one("SELECT count(*) AS n,coalesce(min(size),0) AS min,coalesce(max(size),0) AS max FROM (SELECT n.id,count(m.child) AS size FROM ua_catalog n LEFT JOIN ua_members m ON m.parent=n.id WHERE n.type='community' GROUP BY n.id)")!;
  const isolatedNodeCount = count('SELECT count(*) n FROM ua_components WHERE conceptConnected=0');
  return { totalModules: lessons, totalLessons: lessons, estimatedMinutes: 0, strategy: 'theme-reading' as const,
    graphMetrics: { knowledgeNodeCount: count('SELECT count(*) n FROM ua_components'), edgeCount, isolatedNodeCount,
      connectedComponentCount: count('SELECT count(*) n FROM ua_components WHERE id=parent'), communityCount: Number(communitySizes.n),
      minCommunitySize: Number(communitySizes.min), maxCommunitySize: Number(communitySizes.max) },
    coverage: { knowledgeNodeCount: count('SELECT count(*) n FROM ua_components'),
      connectedKnowledgeNodeCount: count('SELECT count(*) n FROM ua_components WHERE connected=1'),
      sourceCount: count("SELECT count(*) n FROM ua_catalog WHERE type='source'"), coveredSourceCount: count('SELECT count(*) n FROM ua_covered'),
      plannedKnowledgeNodeCount: count('SELECT count(*) n FROM ua_planned'),
      unclusteredNodeCount: count("SELECT count(*) n FROM ua_catalog n WHERE type IN ('concept','entity') AND NOT EXISTS(SELECT 1 FROM ua_planned p WHERE p.id=n.id)") } };
}

/** Expand one catalog scene. Call in a cancellable child, with atomic cache publication. */
export async function organizeIndexedScene(db: IndexedDatabase, sink: Pick<IndexedSink, 'edge' | 'reference' | 'check' | 'write'>, scope: string) {
  const rows = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as Row[];
  const run = (sql: string, ...args: unknown[]) => { sink.check(); return sink.write ? sink.write(sql, ...args) : db.prepare(sql).run(...args); };
  const scene = db.prepare('SELECT ids FROM ua_scenes WHERE id=?').get(scope) as { ids: string } | undefined;
  if (!scene) throw new Error('UA scene is not in this catalog.');
  const ids = JSON.parse(scene.ids) as string[];
  const sceneId = scope ? `group:${scope}` : 'overview';
  run('DELETE FROM ua_frontier'); run('DELETE FROM ua_visible'); run('DELETE FROM ua_aggregates');
  for (const id of ids) if (id !== scope) run('INSERT INTO ua_visible VALUES(?)', id);
  for (const id of ids) if (id !== scope) {
    const node = db.prepare('SELECT navigationRoot FROM ua_catalog WHERE id=?').get(id) as { navigationRoot: number };
    if (node.navigationRoot) continue;
    run(`WITH RECURSIVE descendants(id) AS (VALUES(?) UNION SELECT m.child FROM ua_navigation m JOIN descendants d ON m.parent=d.id
      WHERE NOT EXISTS(SELECT 1 FROM ua_visible v WHERE v.id=m.child) AND m.child<>?)
      INSERT OR IGNORE INTO ua_frontier SELECT id,? FROM descendants`, id, scope, id);
    if (scope) sink.edge({ id: `ua:contains:${scope}:${id}`, source: scope, target: id, type: 'contains', layer: 'knowledge', metadata: { presentationOnly: true, sceneId } });
  }
  // Source/target indexes reuse the build's single native topology traversal.
  if (db.prepare('SELECT 1 FROM ua_frontier WHERE node<>representative LIMIT 1').get()) {
    run(`INSERT OR IGNORE INTO ua_aggregates
      SELECT a.representative,b.representative,r.type,r.direction,r.id
      FROM ua_frontier a JOIN temp.ua_build_relations r ON r.source=a.node
      JOIN ua_frontier b ON b.node=r.target
      WHERE a.representative<>b.representative
      AND (a.representative<>r.source OR b.representative<>r.target)`);
  }
  // Aggregate once. Paginating an expression over GROUP BY repeated the entire
  // aggregation for every page. A disk table gives the continuation an index.
  db.exec('DROP TABLE IF EXISTS ua_links; CREATE TABLE ua_links(source TEXT,target TEXT,type TEXT,direction TEXT,n INTEGER,PRIMARY KEY(source,target,type,direction))');
  run('INSERT INTO ua_links SELECT source,target,type,direction,count(*) FROM ua_aggregates GROUP BY source,target,type,direction');
  let cursor = ['', '', '', ''];
  for (;;) {
    sink.check();
    const links = rows('SELECT * FROM ua_links WHERE (source,target,type,direction)>(?,?,?,?) ORDER BY source,target,type,direction LIMIT 128', ...cursor);
    if (!links.length) break;
    for (const link of links) {
      const aggregate = `ua:relation:${createHash('sha256').update(JSON.stringify([sceneId,link.source,link.target,link.type,link.direction])).digest('hex')}`;
      const args = [link.source,link.target,link.type,link.direction];
      const preview = rows('SELECT relation FROM ua_aggregates WHERE source=? AND target=? AND type=? AND direction=? ORDER BY relation LIMIT 16', ...args).map(r => String(r.relation));
      sink.edge({ id: aggregate,source:link.source,target:link.target,type:'group_relation',layer:'knowledge',label:`${link.n} ${String(link.type).replaceAll('_',' ')}`,
        metadata: { presentationOnly:true,sceneId,direction:link.direction,relationType:link.type,relationCount:link.n,relationIds:preview,relationReference:aggregate } });
      let last = '';
      for (;;) {
        sink.check();
        const refs = rows('SELECT relation FROM ua_aggregates WHERE source=? AND target=? AND type=? AND direction=? AND relation>? ORDER BY relation LIMIT 128', ...args,last);
        if (!refs.length) break;
        for (const ref of refs) sink.reference(aggregate,String(ref.relation));
        last = String(refs.at(-1)!.relation);
      }
    }
    const end = links.at(-1)!;
    cursor = [end.source,end.target,end.type,end.direction].map(String);
  }
}

/** Release native relation addresses before committing the presentation artifact. */
export function closeIndexedBuild(db: IndexedDatabase) {
  db.exec('DROP TABLE temp.ua_build_relations');
}
