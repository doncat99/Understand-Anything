#!/usr/bin/env python3
"""Assemble a Understand Anything graph from a Semantica snapshot.

This is the structured-input boundary used by OntoScience.  It deliberately
does not infer identity from labels: Semantica IDs are the graph IDs and
evidence IDs are retained as lineage metadata.  Model-produced batches may
add concepts and claims, but they cannot replace canonical Semantica nodes.

Usage: python assemble-semantica-graph.py input.json output.json
"""

import json
import sys
from datetime import datetime, timezone

NODE_TYPES = {"article", "entity", "topic", "claim", "source", "concept", "question", "formula", "document"}
EDGE_TYPES = {"cites", "contradicts", "builds_on", "exemplifies", "categorized_under", "authored_by", "related", "similar_to", "supported_by", "depends_on", "used_by", "contains", "raises", "addresses", "links_to"}


def rows(value):
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def text(value, fallback=""):
    return value.strip() if isinstance(value, str) and value.strip() else fallback


def evidence_meta(ids, evidence_by_id):
    refs = []
    for evidence_id in ids if isinstance(ids, list) else []:
        if not isinstance(evidence_id, str):
            continue
        evidence = evidence_by_id.get(evidence_id)
        if not evidence:
            continue
        refs.append({"id": evidence_id, "quote": text(evidence.get("quote")), "sourceId": evidence.get("sourceId"), "locator": evidence.get("locator")})
    return [ref for ref in refs if ref["quote"]]


def node_from(row, evidence_by_id, node_type="entity"):
    node_id = text(row.get("id"))
    name = text(row.get("canonical_name"), text(row.get("name"), node_id))
    if not node_id or not name:
        return None
    evidence_ids = row.get("evidence_ids", row.get("evidenceIds", []))
    evidence = evidence_meta(evidence_ids, evidence_by_id)
    node = {
        "id": node_id,
        "name": name,
        "summary": text(row.get("description"), text(row.get("summary"), name)),
        "tags": [node_type],
        "type": node_type if node_type in NODE_TYPES else "entity",
        "knowledgeMeta": {
            "semanticaId": node_id,
            "evidenceIds": [item for item in evidence_ids if isinstance(item, str)],
            **({"evidence": evidence} if evidence else {}),
        },
    }
    if isinstance(row.get("complexity"), str) and row["complexity"] in {"simple", "moderate", "complex"}:
        node["complexity"] = row["complexity"]
    return node


def assemble(payload):
    snapshot = payload.get("snapshot") if isinstance(payload.get("snapshot"), dict) else payload
    evidence_by_id = {item.get("id"): item for item in rows(snapshot.get("evidence_spans")) if isinstance(item.get("id"), str)}
    nodes = {}
    for entity in rows(payload.get("entities", snapshot.get("entities", []))):
        node = node_from(entity, evidence_by_id, "entity")
        if node:
            nodes[node["id"]] = node
    for document in rows(payload.get("documents", snapshot.get("document_representations", []))):
        node = node_from(document, evidence_by_id, "document")
        if node:
            nodes[node["id"]] = node
    for item in rows(payload.get("categories", snapshot.get("categories", []))):
        node = node_from(item, evidence_by_id, "topic")
        if node:
            nodes[node["id"]] = node
    # Analysis batches are additive and are keyed by their supplied stable ID.
    for batch in rows(payload.get("analysisBatches")):
        for item in rows(batch.get("nodes")):
            node_id = text(item.get("id"))
            kind = text(item.get("type"), "entity").lower()
            if node_id and node_id not in nodes and kind in NODE_TYPES:
                node = dict(item)
                node["type"] = kind
                node.setdefault("name", node_id)
                node.setdefault("summary", node["name"])
                node.setdefault("tags", [kind])
                nodes[node_id] = node
    edges = []
    seen = set()
    def add_edge(item):
        source = text(item.get("source"), text(item.get("source_entity_id")))
        target = text(item.get("target"), text(item.get("target_entity_id")))
        kind = text(item.get("type"), "related").lower()
        if source not in nodes or target not in nodes or kind not in EDGE_TYPES or source == target:
            return
        key = (source, target, kind)
        if key in seen:
            return
        seen.add(key)
        edge = {"id": text(item.get("id"), f"edge:{source}:{kind}:{target}"), "source": source, "target": target, "type": kind, "direction": "forward", "weight": float(item.get("confidence", item.get("weight", 0.5)) or 0.5)}
        evidence = evidence_meta(item.get("evidence_ids", item.get("evidenceIds", [])), evidence_by_id)
        if evidence:
            edge["evidence"] = evidence
        edges.append(edge)
    for item in rows(payload.get("relations", snapshot.get("relations", []))) + rows(snapshot.get("assertions")):
        add_edge(item)
    for batch in rows(payload.get("analysisBatches")):
        for item in rows(batch.get("edges")):
            add_edge(item)
    layers = []
    for category in rows(payload.get("categories")):
        members = [item for item in category.get("nodeIds", category.get("entityIds", [])) if item in nodes]
        if members:
            layers.append({"id": text(category.get("id"), f"layer:{text(category.get('name'), 'uncategorized').lower().replace(' ', '-') }"), "name": text(category.get("name"), "Uncategorized"), "description": text(category.get("description")), "nodeIds": members})
    tour = payload.get("tour") if isinstance(payload.get("tour"), list) else []
    return {"version": "1.0.0", "kind": "knowledge", "protocol": "understand-anything.semantica-graph.v1", "project": payload.get("project", {}), "generatedAt": datetime.now(timezone.utc).isoformat(), "snapshotId": payload.get("snapshot", {}).get("snapshot_id", payload.get("snapshot", {}).get("snapshotId")), "nodes": list(nodes.values()), "edges": edges, "layers": layers, "tour": tour}


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: assemble-semantica-graph.py input.json output.json")
    with open(sys.argv[1], encoding="utf-8") as handle:
        payload = json.load(handle)
    graph = assemble(payload)
    with open(sys.argv[2], "w", encoding="utf-8") as handle:
        json.dump(graph, handle, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
