/**
 * DegreeFlowchartPanel
 *
 * Read-only (interactive but not editable) ReactFlow degree flowchart.
 *
 * Props:
 *   graph     — degree requirement graph object (from GET /api/degree-graph/:id)
 *   semesters — student semester-plan array (for completion coloring); pass [] for no coloring
 *   height    — number (px), default 600
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import ReactFlow, {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  useNodesState,
  useEdgesState,
  useReactFlow,
} from 'reactflow';
import 'reactflow/dist/style.css';
import {
  getCourseState,
  getNodeSemanticColor,
  getPlaceholderPalette,
  electiveDisplayLabel,
  MULTI_OPTION_NODE_COLOR,
  columnIdToLabel,
  inferColumnLayout,
} from '../lib/degreePlanEvaluation';
import { getCourseCatalogTitle } from '../api';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------
const COL_WIDTH  = 260;
const ROW_HEIGHT = 148;
const PATH_ROW_HEIGHT = 225; // taller slot for the senior-design path_option node
const HEADER_Y   = -65;

// ---------------------------------------------------------------------------
// Course title lookup — shared cache so every "choose one" node reuses the same
// fetch instead of hitting the search endpoint once per node per course code.
// ---------------------------------------------------------------------------
const _courseTitleCache = new Map();
const _courseTitleFetches = new Map();

function useCourseTitle(code) {
  const [title, setTitle] = useState(() => (code ? _courseTitleCache.get(code) ?? null : null));
  useEffect(() => {
    if (!code) { setTitle(null); return; }
    if (_courseTitleCache.has(code)) { setTitle(_courseTitleCache.get(code)); return; }
    let cancelled = false;
    const pending = _courseTitleFetches.get(code) ?? getCourseCatalogTitle(code)
      .then((res) => res?.data?.title ?? null)
      .catch(() => null)
      .then((t) => { _courseTitleCache.set(code, t); _courseTitleFetches.delete(code); return t; });
    _courseTitleFetches.set(code, pending);
    pending.then((t) => { if (!cancelled) setTitle(t); });
    return () => { cancelled = true; };
  }, [code]);
  return title;
}

// Colors for prerequisite OR-groups ("satisfy one of these"). Applied only to the selected
// node's incoming prereq edges, so each color is unambiguous (one node's groups at a time).
const PREREQ_GROUP_COLORS = ['#16a34a', '#2563eb', '#db2777', '#0891b2', '#ca8a04', '#7c3aed'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getCourseStateForNode(node, semesters) {
  const byCode = getCourseState(node.code ?? node.id, semesters);
  if (byCode !== 'missing') return byCode;
  for (const m of node.matches ?? []) {
    const byMatch = getCourseState(m, semesters);
    if (byMatch !== 'missing') return byMatch;
  }
  return 'missing';
}

function computeDirectNeighbors(selectedId, edges) {
  const prereqs    = new Set();
  const dependents = new Set();
  for (const e of edges) {
    if (e.target === selectedId) prereqs.add(e.source);
    if (e.source === selectedId) dependents.add(e.target);
  }
  return { prereqs, dependents };
}

function computeHighlightSets(selectedId, edges) {
  const prereqsOf    = new Map();
  const dependentsOf = new Map();
  for (const e of edges) {
    if (!dependentsOf.has(e.source)) dependentsOf.set(e.source, new Set());
    if (!prereqsOf.has(e.target))    prereqsOf.set(e.target, new Set());
    dependentsOf.get(e.source).add(e.target);
    prereqsOf.get(e.target).add(e.source);
  }
  function bfs(startId, adjMap) {
    const visited = new Set();
    const queue = [startId];
    while (queue.length) {
      const cur = queue.shift();
      for (const neighbor of adjMap.get(cur) ?? []) {
        if (!visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor); }
      }
    }
    return visited;
  }
  const prereqs    = bfs(selectedId, prereqsOf);
  const dependents = bfs(selectedId, dependentsOf);
  prereqs.delete(selectedId);
  dependents.delete(selectedId);
  return { prereqs, dependents };
}

// Forward longest-depth (prereq=1, coreq=0) per node — used to size choice options.
function forwardDepths(edges) {
  const incoming = new Map();
  const allNodes = new Set();
  for (const e of edges) {
    allNodes.add(e.source); allNodes.add(e.target);
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target).push({ from: e.source, w: e.data?.isCo ? 0 : 1 });
  }
  const memo = new Map(); const stack = new Set();
  function fwd(n) { const c = memo.get(n); if (c != null) return c; if (stack.has(n)) return 0; stack.add(n); let b = 0; for (const { from, w } of incoming.get(n) ?? []) b = Math.max(b, fwd(from) + w); stack.delete(n); memo.set(n, b); return b; }
  for (const n of allNodes) fwd(n);
  return memo;
}

// "Choose one" requirements are not unavoidable bottlenecks — a student picks the
// CHEAPEST option. So before measuring the bottleneck, resolve each choice node to
// its minimum-cost option(s): drop the prereq edges of every strictly-longer option
// (keeping ties so equally-short options still surface as equivalent routes).
function resolveChoiceMinima(edges) {
  const byChoice = new Map(); // choiceNodeId -> Map(optionCode -> edges[])
  let hasOptions = false;
  for (const e of edges) {
    const oc = e.data?.optionCode;
    const cid = e.data?.choiceNodeId;
    if (!oc || !cid) continue;
    hasOptions = true;
    if (!byChoice.has(cid)) byChoice.set(cid, new Map());
    const m = byChoice.get(cid);
    if (!m.has(oc)) m.set(oc, []);
    m.get(oc).push(e);
  }
  if (!hasOptions) return { edges, multiOptionChoices: new Set() };
  const f = forwardDepths(edges);
  const drop = new Set();
  // Choice nodes where ≥2 options tie for the minimum cost — i.e. the bottleneck
  // can run through more than one equally-short option of that "choose one".
  const multiOptionChoices = new Set();
  for (const [cid, optMap] of byChoice) {
    const costs = new Map();
    let best = Infinity;
    for (const [oc, oEdges] of optMap) {
      let cost = 0;
      for (const e of oEdges) cost = Math.max(cost, (f.get(e.source) ?? 0) + (e.data?.isCo ? 0 : 1));
      costs.set(oc, cost);
      best = Math.min(best, cost);
    }
    let survivors = 0;
    for (const [oc, oEdges] of optMap) {
      if (costs.get(oc) > best) for (const e of oEdges) drop.add(e);
      else survivors += 1;
    }
    if (survivors >= 2) multiOptionChoices.add(cid);
  }
  return { edges: edges.filter((e) => !drop.has(e)), multiOptionChoices };
}

// ---------------------------------------------------------------------------
// Degree bottleneck — enumerate the longest dependency chains (critical paths)
// through the prereq DAG. A prereq edge weighs 1 (dependent must be a LATER
// semester); a coreq edge weighs 0 (same semester). Every path of maximum total
// weight is an "equivalent bottleneck route" (e.g. MATH 171→172→221→409→437 vs
// 171→172→300→323→437); the UI pages through them one at a time. Returns the list
// of routes (each an ordered node-id array) and the length (≈ semesters − 1).
// Cycle-safe; route count capped to avoid blow-up on dense graphs.
// "Choose one" requirements should be passed through resolveChoiceMinima() first
// so only the unavoidable (cheapest) option counts.
// ---------------------------------------------------------------------------
function computeBottleneckRoutes(edges, maxRoutes = 40) {
  const incoming = new Map();
  const outgoing = new Map();
  const allNodes = new Set();
  for (const e of edges) {
    allNodes.add(e.source); allNodes.add(e.target);
    const w = e.data?.isCo ? 0 : 1;
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target).push({ from: e.source, w });
    if (!outgoing.has(e.source)) outgoing.set(e.source, []);
    outgoing.get(e.source).push({ to: e.target, w });
  }
  const fMemo = new Map(); const fStack = new Set();
  function fwd(n) { const c = fMemo.get(n); if (c != null) return c; if (fStack.has(n)) return 0; fStack.add(n); let best = 0; for (const { from, w } of incoming.get(n) ?? []) best = Math.max(best, fwd(from) + w); fStack.delete(n); fMemo.set(n, best); return best; }
  const hMemo = new Map(); const hStack = new Set();
  function bwd(n) { const c = hMemo.get(n); if (c != null) return c; if (hStack.has(n)) return 0; hStack.add(n); let best = 0; for (const { to, w } of outgoing.get(n) ?? []) best = Math.max(best, bwd(to) + w); hStack.delete(n); hMemo.set(n, best); return best; }
  let length = 0;
  for (const n of allNodes) { length = Math.max(length, fwd(n)); bwd(n); }
  if (length === 0) return { routes: [], length: 0 }; // no prereqs → no bottleneck
  const f = (n) => fMemo.get(n) ?? 0;
  const h = (n) => hMemo.get(n) ?? 0;

  // Critical subgraph — nodes/edges on SOME longest path.
  const criticalNodes = new Set();
  for (const n of allNodes) if (f(n) + h(n) === length) criticalNodes.add(n);
  const critOut = new Map();
  for (const e of edges) {
    const w = e.data?.isCo ? 0 : 1;
    if (criticalNodes.has(e.source) && criticalNodes.has(e.target) && f(e.source) + w + h(e.target) === length) {
      if (!critOut.has(e.source)) critOut.set(e.source, []);
      const arr = critOut.get(e.source);
      if (!arr.includes(e.target)) arr.push(e.target); // dedup parallel edges (e.g. a course that is a prereq of two paths of one "choose one")
    }
  }
  // Enumerate maximal paths from critical sources (f==0) to sinks (no critical out-edge).
  const routes = [];
  function dfs(node, path, onPath) {
    if (routes.length >= maxRoutes) return;
    const nexts = critOut.get(node) ?? [];
    if (nexts.length === 0) { routes.push([...path]); return; }
    for (const nx of nexts) {
      if (onPath.has(nx)) continue;
      onPath.add(nx); path.push(nx);
      dfs(nx, path, onPath);
      path.pop(); onPath.delete(nx);
    }
  }
  for (const s of [...criticalNodes].filter((n) => f(n) === 0).sort()) {
    if (routes.length >= maxRoutes) break;
    dfs(s, [s], new Set([s]));
  }
  // Dedup identical routes (distinct edge paths can collapse to the same node sequence).
  const seen = new Set();
  const unique = [];
  for (const r of routes) { const k = r.join('>'); if (!seen.has(k)) { seen.add(k); unique.push(r); } }
  return { routes: unique, length };
}

/** Given a route (ordered node ids), the node set + consecutive-edge keys. */
function routeSets(route) {
  const nodeSet = new Set(route);
  const edgeSet = new Set();
  for (let i = 0; i + 1 < route.length; i += 1) edgeSet.add(`${route[i]}->${route[i + 1]}`);
  return { nodeSet, edgeSet };
}

// ---------------------------------------------------------------------------
// Graph builder
// ---------------------------------------------------------------------------
function buildReactFlowGraph(graph, semesters, selectedTrackId = null) {
  if (!graph?.nodes?.length) return { nodes: [], edges: [] };

  // Track-pool filtering — for single-page multi-track majors (e.g. BMEN), show only
  // the student's selected track pool (plus catch-all pools). Other track pools hidden.
  const isTrackBased = Array.isArray(graph.availableTracks) && graph.availableTracks.length > 0;
  const nodeList = isTrackBased
    ? graph.nodes.filter((n) => {
        const isTrackScoped = typeof n.requirementSubtype === 'string' && n.requirementSubtype.startsWith('track_');
        if (!isTrackScoped || n.isCatchAllPool) return true;
        if (!selectedTrackId) return true; // no track chosen yet → show all tracks read-only
        return n.trackId === selectedTrackId;
      })
    : graph.nodes;

  const codeToId = new Map();
  for (const n of nodeList) {
    const rfId = n.id ?? n.code;
    codeToId.set(String(n.code ?? rfId).toUpperCase(), rfId);
    // Don't alias an elective/pool node's option courses to the pool — those are just the
    // list of choices, not the node itself, and aliasing them draws spurious prereq edges
    // into the pool. Choice (cycling) and cross-listed course nodes still alias their codes.
    if (n.requirementType === 'elective') continue;
    for (const m of n.matches ?? []) codeToId.set(String(m).toUpperCase(), rfId);
  }

  // Per-target OR-group coloring: for each node's prereqGroups, give every group that has
  // ≥2 interchangeable alternatives a color index (singletons are plain required prereqs).
  // Keyed "TARGETCODE|SOURCECODE" so the edge builder can tag each prereq edge with its group.
  const prereqGroupColor = new Map();
  for (const n of nodeList) {
    const tgt = String(n.code ?? '').toUpperCase();
    if (!tgt || !Array.isArray(n.prereqGroups)) continue;
    let colorIdx = 0;
    for (const g of n.prereqGroups) {
      if (!Array.isArray(g) || g.length < 2) continue;
      // Only color when the alternatives are 2+ DISTINCT nodes. If they collapse to a single
      // node — a "X / Y" choice box, or only one alternative is in the plan — the OR is
      // internal to that node and needs no edge coloring.
      const distinctNodes = new Set(g.map((c) => codeToId.get(String(c).toUpperCase())).filter(Boolean));
      if (distinctNodes.size < 2) continue;
      for (const c of g) prereqGroupColor.set(`${tgt}|${String(c).toUpperCase()}`, colorIdx);
      colorIdx += 1;
    }
  }

  // Choice-node cycling bookkeeping (populated as nodes are built below).
  const defaultChoiceSelections = {}; // rfNodeId → default active option index
  const choiceOptionCounts = {};      // rfNodeId → number of options (for cycle wraparound)
  const choiceOptionsMap = {};        // rfNodeId → [option codes]

  const hasMissing   = nodeList.some((n) => n.semesterColumn == null);
  const inferredCols = hasMissing ? inferColumnLayout(nodeList, graph.edges ?? []) : null;

  const colMap = new Map();
  for (const n of nodeList) {
    const rfId = n.id ?? n.code;
    let col = n.semesterColumn;
    if (col == null) {
      const idx = inferredCols?.get(rfId) ?? 0;
      col = `__inf_${idx}`;
    }
    if (!colMap.has(col)) colMap.set(col, []);
    colMap.get(col).push(n);
  }

  const cols = [...colMap.keys()].sort((a, b) => {
    const aInf = a.startsWith('__inf_');
    const bInf = b.startsWith('__inf_');
    if (!aInf && !bInf) return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    if (aInf && bInf) return Number(a.slice(6)) - Number(b.slice(6));
    return aInf ? 1 : -1;
  });

  const rfNodes = [];
  for (let ci = 0; ci < cols.length; ci++) {
    const col  = cols[ci];
    const list = colMap.get(col);
    const x    = ci * COL_WIDTH;
    const label = col.startsWith('__inf_')
      ? `Semester ${Number(col.slice(6)) + 1}`
      : columnIdToLabel(col);
    rfNodes.push({
      id: `__col_header_${ci}`, type: 'columnHeader',
      position: { x, y: HEADER_Y }, data: { label },
      selectable: false, draggable: false, connectable: false,
    });
    let yCursor = 0;
    list.forEach((n) => {
      const rfId  = n.id ?? n.code;
      const state = getCourseStateForNode(n, semesters);
      const color = getNodeSemanticColor(n);
      // For multi-option choice nodes, expose each option + student status so the node can
      // be cycled. Compound (bundle) choices cycle by ALTERNATIVE ("PHYS 207+PHYS 227").
      const isCompound = n.requirementType === 'choice' && n.requirementSubtype === 'exact_compound_choice' && Array.isArray(n.alternatives);
      const isChoice = n.requirementType === 'choice' && (n.matches?.length ?? 0) >= 2;
      const isPathOption = n.requirementType === 'path_option';
      const options = isCompound
        ? n.alternatives.map((alt) => (alt.courses ?? []).join('+'))
        : isChoice
          ? n.matches.filter((m) => /^[A-Z]{3,5}\s\d{3}[A-Z]?$/.test(String(m)))
          : [];
      const optionStates = isCompound
        ? n.alternatives.map((alt) => {
            const states = (alt.courses ?? []).map((c) => getCourseState(c, semesters));
            if (states.length && states.every((s) => s === 'completed')) return 'completed';
            if (states.length && states.every((s) => s !== 'missing')) return 'in_progress';
            if (states.some((s) => s !== 'missing')) return 'partial';
            return 'missing';
          })
        : options.map((m) => getCourseState(m, semesters));
      // The option the student has actually placed in their plan (if any).
      const inPlanIdx = optionStates.findIndex((s) => s !== 'missing');
      const selectedOption = (!isCompound && inPlanIdx >= 0) ? options[inPlanIdx] : null;
      if ((isChoice || isCompound) && options.length >= 2) {
        defaultChoiceSelections[rfId] = inPlanIdx >= 0 ? inPlanIdx : 0;
        choiceOptionCounts[rfId] = options.length;
        choiceOptionsMap[rfId] = options;
      }
      // Senior-design path_option: register its paths as cyclable options so the selected
      // path's prereq edges (tagged with the path id) light up.
      const pathIds = (isPathOption && (n.paths?.length ?? 0) >= 2) ? n.paths.map((p) => p.id) : [];
      if (pathIds.length >= 2) {
        defaultChoiceSelections[rfId] = 0;
        choiceOptionCounts[rfId] = pathIds.length;
        choiceOptionsMap[rfId] = pathIds;
      }
      const y = yCursor;
      // Reserve vertical room based on rendered height so tall nodes (compound
      // "choose one" lists each option on its own line; path_option has a path
      // selector + course lists) don't overlap the next node in the column.
      const choiceLines = isCompound ? (n.alternatives?.length ?? 0) : 0;
      yCursor += isPathOption ? PATH_ROW_HEIGHT
        : choiceLines >= 3 ? Math.max(ROW_HEIGHT, 78 + choiceLines * 26 + 44)
        : ROW_HEIGHT;
      rfNodes.push({
        id: rfId, type: n.requirementType === 'path_option' ? 'pathOption' : 'course',
        position: { x, y },
        data: {
          nodeId: rfId,
          code: n.code, title: n.title ?? '',
          creditHours: n.creditHours ?? null,
          requirementType: n.requirementType ?? 'required',
          requirementSubtype: n.requirementSubtype ?? null,
          matches: n.matches ?? [],
          selectedOption,
          options, optionStates,
          alternatives: n.alternatives ?? null,
          optionPrereqs: n.optionPrereqs ?? null,
          optionCoreqs: n.optionCoreqs ?? null,
          activeOptionIdx: defaultChoiceSelections[rfId] ?? 0,
          pickCount: n.pickCount ?? null,
          requiredHours: n.requiredHours ?? null,
          requiredHoursLabel: n.requiredHoursLabel ?? null,
          paths: n.paths ?? [],
          state, color,
        },
      });
    });
  }

  const rfEdges  = [];
  const edgeSeen = new Set();
  const pairCount = new Map();
  for (const e of graph.edges ?? []) {
    const srcId = codeToId.get(String(e.from ?? '').toUpperCase());
    const tgtId = codeToId.get(String(e.to   ?? '').toUpperCase());
    if (!srcId || !tgtId || srcId === tgtId) continue; // skip self-loops (e.g. one choice option is a prereq of another in the same node)
    const pairKey = `${srcId}--${tgtId}`;
    pairCount.set(pairKey, (pairCount.get(pairKey) ?? 0) + 1);
  }
  const pairIndex = new Map();
  for (const e of graph.edges ?? []) {
    const srcId = codeToId.get(String(e.from ?? '').toUpperCase());
    const tgtId = codeToId.get(String(e.to   ?? '').toUpperCase());
    if (!srcId || !tgtId || srcId === tgtId) continue; // skip self-loops (e.g. one choice option is a prereq of another in the same node)
    // Option edges (carry optionCode) belong to a specific choice-node option — keep
    // them distinct so cycling can show only the active option's chain.
    const optionCode = e.optionCode ?? null;
    const key = `${srcId}--${tgtId}--${e.type}${optionCode ? `--${optionCode}` : ''}`;
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    const pairKey = `${srcId}--${tgtId}`;
    const idx = pairIndex.get(pairKey) ?? 0;
    pairIndex.set(pairKey, idx + 1);
    const total = pairCount.get(pairKey) ?? 1;
    const baseCurvature = 0.25;
    const curvature = total > 1 ? baseCurvature + (idx - (total - 1) / 2) * 0.35 : baseCurvature;
    const isCo = e.type === 'corequisite';
    // OR-group color index for this prereq edge (null = plain required prereq / coreq).
    const groupColorIdx = !isCo
      ? (prereqGroupColor.get(`${String(e.to).toUpperCase()}|${String(e.from).toUpperCase()}`) ?? null)
      : null;
    rfEdges.push({
      id: key, source: srcId, target: tgtId, animated: false,
      // pathOptions.curvature (not a top-level prop) is what the v11 bezier edge actually reads.
      type: 'default', pathOptions: { curvature },
      style:     isCo ? { fill: 'none', strokeDasharray: '5,3', stroke: '#9ca3af', strokeWidth: 2 } : { fill: 'none', stroke: '#6b7280', strokeWidth: 1.5 },
      markerEnd: isCo ? { type: 'arrow', color: '#9ca3af' } : { type: 'arrowclosed', color: '#6b7280' },
      // choiceNodeId = the choice node this option edge feeds; used to gate visibility by active option.
      data: { isCo, curvature, optionCode, choiceNodeId: optionCode ? tgtId : null, groupColorIdx },
    });
  }

  return { nodes: rfNodes, edges: rfEdges, defaultChoiceSelections, choiceOptionCounts, choiceOptionsMap };
}

// ---------------------------------------------------------------------------
// Node components
// ---------------------------------------------------------------------------
function CourseNode({ data }) {
  const { nodeId, code, title, creditHours, state, color, requirementType, requirementSubtype, highlight, matches, selectedOption, pickCount, requiredHours, requiredHoursLabel,
    options, optionStates, activeOptionIdx, onCycle, alternatives, bottleneckOption } = data;
  // Title of the currently-active option in a multi-option "choose one" node — computed
  // unconditionally (Rules of Hooks) even though it's only rendered by that branch below.
  const multiOpts = (options?.length ?? 0) >= 2 ? options : (matches ?? []);
  const isCompoundChoice = requirementType === 'choice' && requirementSubtype === 'exact_compound_choice' && (alternatives?.length ?? 0) > 0;
  const isMultiOptionChoice = requirementType === 'choice' && !isCompoundChoice && multiOpts.length >= 2;
  const activeOptionCode = isMultiOptionChoice ? multiOpts[Math.min(activeOptionIdx ?? 0, multiOpts.length - 1)] : null;
  const activeOptionTitle = useCourseTitle(activeOptionCode);
  const isElective = requirementType === 'elective' && !code;
  const dimmed     = highlight === 'dimmed';
  const selected   = highlight === 'selected';
  const isPrereq   = highlight === 'prereq';
  const isDependent = highlight === 'dependent';
  const isBottleneck = highlight === 'bottleneck';
  // No CSS transform on node content — a transform context offsets where React Flow places
  // edge endpoints, leaving a gap between arrows and the node. Selection is shown via the
  // node's amber border + ring box-shadow instead.
  const wrapStyle = { opacity: dimmed ? 0.2 : 1, transition: 'opacity 0.15s, box-shadow 0.15s' };

  // Shorten common long labels for the compact node preview; full labels appear in tooltip.
  function abbrevOptionLabel(label) {
    if (!label) return label;
    if (/university\s+core\s+curriculum/i.test(label)) return 'UCC';
    return label;
  }

  // ── Compound choice node (e.g. OCNG 451 OR PHYS 207 + PHYS 227) ────────
  // Cyclable like a plain choice, but each step selects a whole ALTERNATIVE; for a bundle,
  // all of its courses' prereq chains light up together.
  if (requirementType === 'choice' && requirementSubtype === 'exact_compound_choice' && alternatives?.length > 0) {
    const total     = alternatives.length;
    const activeIdx = Math.min(activeOptionIdx ?? 0, total - 1);
    const activeInPlan = (optionStates?.[activeIdx] ?? 'missing') !== 'missing';
    // Follow the standard green/teal status scheme: green when a full alternative is
    // completed, teal when one is in progress/partially planned, white otherwise.
    const anyCompleted = (optionStates ?? []).some((s) => s === 'completed');
    const anyActive    = (optionStates ?? []).some((s) => s === 'in_progress' || s === 'partial');
    const cBg     = anyCompleted ? '#dcfce7' : anyActive ? '#ccfbf1' : '#ffffff';
    const cBorder = anyCompleted ? '#16a34a' : anyActive ? '#0d9488' : MULTI_OPTION_NODE_COLOR;
    const cHead   = anyCompleted ? '#14532d' : anyActive ? '#0f766e' : '#374151';
    const altLabel = alternatives.map((alt) => alt.courses.join(' + ')).join(' OR ');
    const tipText = `Required: choose one — ${altLabel}. Click the number to cycle which option's prereq chain is shown.`;
    return (
      <div style={wrapStyle} title={tipText}>
        <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
        <div style={{ position: 'relative', background: cBg, border: `2px solid ${cBorder}`, borderRadius: 8, padding: '8px 12px', minWidth: 150, maxWidth: 240, boxShadow: selected ? `0 0 0 3px ${cBorder}55, 0 2px 8px rgba(0,0,0,.15)` : '0 1px 4px rgba(0,0,0,.1)' }}>
          {total > 1 && (
            <button
              type="button"
              className="nodrag nopan"
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); e.preventDefault(); onCycle?.(nodeId); }}
              title="Click to cycle which option's prereq chain is shown"
              style={{ position: 'absolute', top: -10, right: -10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, padding: 0, borderRadius: '50%', border: `1.5px solid ${activeInPlan ? '#dc2626' : '#f59e0b'}`, background: activeInPlan ? '#fee2e2' : '#fef3c7', color: activeInPlan ? '#b91c1c' : '#b45309', fontSize: 11, fontWeight: 700, cursor: 'pointer', lineHeight: 1, boxShadow: '0 1px 3px rgba(0,0,0,.25)', zIndex: 2 }}
            >{activeIdx + 1}</button>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 11, color: cHead, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Required — choose one</span>
          </div>
          {alternatives.map((alt, i) => {
            const isActive = i === activeIdx;
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: i < alternatives.length - 1 ? 3 : 0 }}>
                {i > 0 && <div style={{ fontSize: 9, fontWeight: 700, color: MULTI_OPTION_NODE_COLOR, marginRight: 2 }}>OR</div>}
                <div style={{ fontSize: 11, color: isActive ? (activeInPlan ? '#b91c1c' : '#b45309') : '#374151', fontWeight: isActive ? 700 : (alt.isBundle ? 600 : 400), borderBottom: isActive ? `2px solid ${activeInPlan ? '#dc2626' : '#f59e0b'}` : '2px solid transparent', paddingBottom: 1 }}>{alt.courses.join(' + ')}</div>
              </div>
            );
          })}
          {creditHours != null && <div style={{ marginTop: 4, fontSize: 10, color: '#9ca3af' }}>{creditHours} hrs</div>}
        </div>
        <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      </div>
    );
  }

  if (isElective) {
    const pool   = matches ?? [];
    const isPool = pool.length > 0;
    if (isPool) {
      const isHoursBased = !!requiredHours;
      // Track/area pools are LOCKED degree requirements (not free electives) — give them a
      // distinct emerald "requirement pool" styling + a kind header so they read as part of
      // the degree, while generic technical/free electives keep the purple elective styling.
      const isTrackPool = requirementSubtype === 'track_pool';
      const isAreaPool  = requirementSubtype === 'area_pool';
      const isLockedPool = isTrackPool || isAreaPool;
      const kindLabel = isTrackPool ? 'Track Requirement' : isAreaPool ? 'Area Requirement' : 'Elective Pool';
      const theme = isLockedPool
        ? { bg: '#fdf2f8', border: '#ec4899', head: '#be185d', body: '#db2777', dim: '#ec4899' }
        : { bg: '#f5f3ff', border: '#7c3aed', head: '#5b21b6', body: '#6d28d9', dim: '#7c3aed' };
      // Show the catalog's exact hour range (e.g. "6-9") when known, else the single number.
      const hoursDisplay = requiredHoursLabel || requiredHours;
      const slotLabel = isHoursBased ? `Select ${hoursDisplay} hrs` : `Pick ${pickCount ?? 1} of ${pool.length}`;
      const abbrevPool = pool.map(abbrevOptionLabel);
      const sep = pool.length <= 5 ? ' / ' : ', ';
      // Display-only: pack as many option codes as fit the box (a few wrapped
      // lines) before collapsing the rest into "+N more", instead of a hard cap
      // of 4 — so the preview fills out to the right like a course title.
      const PREVIEW_CHAR_BUDGET = 90;
      let shownCount = 0;
      let usedChars = 0;
      for (let i = 0; i < abbrevPool.length; i += 1) {
        const addChars = (shownCount === 0 ? 0 : sep.length) + abbrevPool[i].length;
        if (shownCount > 0 && usedChars + addChars > PREVIEW_CHAR_BUDGET) break;
        usedChars += addChars;
        shownCount += 1;
      }
      if (shownCount < 1) shownCount = 1;
      const remainingCount = pool.length - shownCount;
      const preview = abbrevPool.slice(0, shownCount).join(sep) + (remainingCount > 0 ? `${sep}+${remainingCount} more` : '');
      const fullList = pool.join(', ');
      const tipText = `${kindLabel}${title ? ` — ${title}` : ''} · ${isHoursBased ? `Select ${requiredHours} hrs from` : `Pick ${pickCount ?? 1} of`}: ${fullList}`;
      return (
        <div style={wrapStyle} title={tipText}>
          <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
          <div style={{ background: theme.bg, border: `1.5px dashed ${theme.border}`, borderRadius: 8, padding: '8px 12px', minWidth: 160, maxWidth: 240, boxShadow: '0 1px 3px rgba(0,0,0,.06)' }}>
            <div style={{ fontWeight: 700, fontSize: 9, color: theme.dim, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}>
              {kindLabel}
            </div>
            {isLockedPool && title && <div style={{ fontWeight: 700, fontSize: 11, color: theme.head, marginBottom: 2 }}>{title}</div>}
            <div style={{ fontWeight: 700, fontSize: 12, color: theme.head, marginBottom: 3 }}>{slotLabel}</div>
            <div style={{ fontSize: 10, color: theme.body, lineHeight: 1.4 }}>{preview}</div>
            {!isHoursBased && creditHours != null && <div style={{ marginTop: 3, fontSize: 10, color: theme.dim, opacity: 0.7 }}>({creditHours} hrs)</div>}
          </div>
          <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
        </div>
      );
    }
    // A UCC slot reads a generic "UCC" (specific areas like "American History" collapse to
    // it). Every other elective shows an "ELECTIVE" kicker with its full type name below
    // (ENGR Elective / Technical Elective / General Elective …), centered and wrapping onto
    // multiple lines. Box width matches a standard node/column so it never overruns the column.
    const palette = getPlaceholderPalette(title, requirementSubtype);
    const isUcc = requirementSubtype === 'ucc' || /\bUCC\b|university\s*core/i.test(title ?? '');
    const electiveLabel = electiveDisplayLabel(title);
    return (
      <div style={wrapStyle} title={isUcc ? 'University Core Curriculum' : (title || undefined)}>
        <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
        <div style={{ background: palette.bg, border: `1.5px dashed ${palette.border}`, borderRadius: 8, padding: '10px 12px', minWidth: 150, maxWidth: 210, textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,.06)' }}>
          {isUcc ? (
            <div style={{ fontWeight: 700, fontSize: 13, color: palette.text }}>UCC</div>
          ) : (
            <>
              <div style={{ fontWeight: 700, fontSize: 9, color: palette.text, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 1 }}>Elective</div>
              <div style={{ fontWeight: 700, fontSize: 13, color: palette.text, lineHeight: 1.2 }}>{electiveLabel}</div>
            </>
          )}
          {creditHours != null && <div style={{ marginTop: 3, fontSize: 11, color: palette.text, opacity: 0.7 }}>({creditHours} hrs)</div>}
        </div>
        <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      </div>
    );
  }

  let bg = '#ffffff';
  let textColor = '#111827';
  if (state === 'completed')        { bg = '#dcfce7'; textColor = '#14532d'; }
  else if (state === 'in_progress') { bg = '#ccfbf1'; textColor = '#0f766e'; }

  let border;
  if (selected)          border = '2.5px solid #f59e0b';
  else if (isBottleneck) border = '3px solid #dc2626';
  else if (isPrereq)     border = '2.5px solid #3b82f6';
  else if (isDependent)  border = '2.5px solid #a855f7';
  else border = `2px solid ${color}`;

  const boxShadow = selected     ? '0 0 0 3px #fde68a, 0 2px 8px rgba(0,0,0,.15)'
                  : isBottleneck ? '0 0 0 3px #fecaca, 0 2px 8px rgba(0,0,0,.15)'
                  : isPrereq     ? '0 0 0 2px #bfdbfe'
                  : isDependent  ? '0 0 0 2px #e9d5ff'
                  : '0 1px 4px rgba(0,0,0,.1)';

  const badges = {
    completed:   { bg: '#bbf7d0', text: '#14532d', label: 'Done' },
    in_progress: { bg: '#99f6e4', text: '#0f766e', label: 'Active' },
    missing:     { bg: '#f3f4f6', text: '#6b7280', label: 'Not Started' },
  };
  const badge = badges[state] ?? badges.missing;

  // Multi-option choice ("AERO 430 / MATH 401 / MATH 412"): cycle through options with a
  // numbered badge. The active option is underlined — RED if the student has it in their
  // plan (completed/in-progress/planned), AMBER if it's a prospective preview. The option
  // actually in the plan is also marked with a small dot so it's distinguishable from the
  // one whose prereq chain is merely being previewed.
  const opts = multiOpts;
  if (requirementType === 'choice' && opts.length >= 2) {
    const total   = opts.length;
    const activeIdx = Math.min(activeOptionIdx ?? 0, total - 1);
    const activeCode = opts[activeIdx];
    const activeState = optionStates?.[activeIdx] ?? 'missing';
    const activeInPlan = activeState !== 'missing';
    const inPlanCode = selectedOption ?? null;
    const tip = `Choose one of: ${opts.join(', ')} — previewing ${activeCode}${activeInPlan ? ' (in your plan)' : ' (prospective)'}. Click the number to cycle.`;
    return (
      <div style={wrapStyle} title={tip}>
        <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
        <div style={{ position: 'relative', background: bg, border, borderRadius: 8, padding: '8px 10px', minWidth: 150, maxWidth: 240, boxShadow, fontSize: 12, color: textColor }}>
          {/* Numbered cycle badge: 1→2→3→1. nodrag/nopan + stopPropagation keep the
              click from being swallowed by React Flow's node drag/select handlers. */}
          <button
            type="button"
            className="nodrag nopan"
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); onCycle?.(nodeId); }}
            title="Click to cycle which option's prereq chain is shown"
            style={{
              position: 'absolute', top: -10, right: -10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 22, height: 22, padding: 0, borderRadius: '50%', border: `1.5px solid ${activeInPlan ? '#dc2626' : '#f59e0b'}`,
              background: activeInPlan ? '#fee2e2' : '#fef3c7', color: activeInPlan ? '#b91c1c' : '#b45309',
              fontSize: 11, fontWeight: 700, cursor: 'pointer', lineHeight: 1, boxShadow: '0 1px 3px rgba(0,0,0,.25)', zIndex: 2,
            }}
          >{activeIdx + 1}</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }}>
            <span style={{ fontWeight: 700, fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3 }}>Choose one</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', rowGap: 2 }}>
            {opts.map((m, i) => {
              const isActive = i === activeIdx;
              const isInPlan = inPlanCode && m === inPlanCode;
              // The specific option this bottleneck route runs through gets an inner dashed red box.
              const isBottleneckOpt = bottleneckOption && m === bottleneckOption;
              // Active underline color depends on whether the active option is in the plan.
              const underlineColor = isActive ? (activeInPlan ? '#dc2626' : '#f59e0b') : 'transparent';
              return (
                <span key={m} style={{ whiteSpace: 'nowrap' }}>
                  <span style={{
                    fontWeight: isBottleneckOpt || isActive ? 700 : 600,
                    fontSize: 12,
                    color: isBottleneckOpt ? '#b91c1c' : isActive ? (activeInPlan ? '#b91c1c' : '#b45309') : (isInPlan ? '#16a34a' : (color ?? '#374151')),
                    border: isBottleneckOpt ? '1.5px dashed #dc2626' : undefined,
                    borderRadius: isBottleneckOpt ? 4 : undefined,
                    padding: isBottleneckOpt ? '0 3px' : undefined,
                    borderBottom: isBottleneckOpt ? '1.5px dashed #dc2626' : `2px ${isActive ? 'solid' : 'dotted'} ${underlineColor}`,
                    paddingBottom: 1,
                  }}>{m}</span>
                  {/* Green dot marks the option actually in the student's plan */}
                  {isInPlan && <span title="In your plan" style={{ color: '#16a34a', fontSize: 9, marginLeft: 2 }}>&#9679;</span>}
                  {i < opts.length - 1 && <span style={{ color: '#9ca3af', margin: '0 4px' }}>/</span>}
                </span>
              );
            })}
          </div>
          {activeOptionTitle && (
            <div title={activeOptionTitle} style={{ marginTop: 2, lineHeight: 1.3, fontSize: 11, color: '#374151', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {activeOptionTitle}
            </div>
          )}
          <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            {creditHours != null && <span style={{ fontSize: 10, color: '#9ca3af' }}>{creditHours} hrs</span>}
            <span style={{ fontSize: 10, borderRadius: 4, padding: state === 'missing' ? 0 : '1px 5px', marginLeft: 'auto', background: state === 'missing' ? 'transparent' : badge.bg, color: badge.text }}>{badge.label}</span>
          </div>
        </div>
        <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      </div>
    );
  }

  // Cross-listed course \u2014 same class under another department code; show all codes in the
  // title itself (e.g. "CSCE 222/ECEN 222") so it reads as a single normal course node.
  const crossListedAlt = (matches ?? []).filter((m) => m !== code && /^[A-Z]{3,5}\s\d{3}/.test(String(m)));
  const displayCode = crossListedAlt.length > 0 ? [code, ...crossListedAlt].join('/') : code;
  return (
    <div style={wrapStyle}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div style={{ background: bg, border, borderRadius: 8, padding: '8px 10px', minWidth: 150, maxWidth: 210, boxShadow, fontSize: 12, color: textColor }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: state === 'completed' ? '#16a34a' : color }}>{displayCode}</div>
        {title && <div title={title} style={{ marginTop: 2, lineHeight: 1.3, fontSize: 11, color: state === 'completed' ? '#4b7556' : '#374151', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{title}</div>}
        <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {creditHours != null && <span style={{ fontSize: 10, color: state === 'completed' ? '#4b7556' : '#9ca3af' }}>{creditHours} hrs</span>}
          <span style={{ fontSize: 10, borderRadius: 4, padding: state === 'missing' ? 0 : '1px 5px', marginLeft: 'auto', background: state === 'missing' ? 'transparent' : badge.bg, color: badge.text }}>{badge.label}</span>
        </div>
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

function ColumnHeaderNode({ data }) {
  return (
    <div style={{ padding: '5px 12px', textAlign: 'center', minWidth: 150, maxWidth: 210, background: '#e5e7eb', borderRadius: 6, border: '1px solid #d1d5db', fontWeight: 700, fontSize: 12, color: '#374151', userSelect: 'none' }}>
      {data.label}
    </div>
  );
}

function PathOptionNode({ data }) {
  const { nodeId, title, creditHours, paths = [], highlight, activeOptionIdx, onSetOption, bottleneckOption } = data;
  const isBottleneck = highlight === 'bottleneck';
  // In bottleneck mode, force-show the path this route runs through.
  const btIdx       = bottleneckOption ? paths.findIndex((p) => p.id === bottleneckOption) : -1;
  const activeIdx   = btIdx >= 0 ? btIdx : Math.min(activeOptionIdx ?? 0, Math.max(paths.length - 1, 0));
  const dimmed      = highlight === 'dimmed';
  const selected    = highlight === 'selected';
  const activePath  = paths[activeIdx] ?? null;
  const borderColor = selected ? '#f59e0b' : isBottleneck ? '#dc2626' : '#f97316';
  const borderWidth = isBottleneck ? 3 : 2;
  const boxShadow   = selected ? '0 0 0 3px #fde68a, 0 2px 8px rgba(0,0,0,.15)' : isBottleneck ? '0 0 0 3px #fecaca, 0 2px 8px rgba(0,0,0,.15)' : '0 1px 4px rgba(0,0,0,.1)';
  return (
    <div style={{ opacity: dimmed ? 0.2 : 1, transition: 'opacity 0.15s, box-shadow 0.15s' }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div style={{ background: '#fff7ed', border: `${borderWidth}px solid ${borderColor}`, borderRadius: 8, minWidth: 170, maxWidth: 240, boxShadow, overflow: 'hidden' }}>
        <div style={{ background: '#ffedd5', padding: '5px 10px', borderBottom: '1px solid #fdba74' }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#9a3412' }}>{title || 'Senior Design'}</div>
          <div style={{ fontSize: 10, color: '#c2410c', marginTop: 1 }}>Required &#x2014; choose a path</div>
        </div>
        {paths.length > 1 && (
          <div className="nodrag nopan" style={{ display: 'flex', borderBottom: '1px solid #fed7aa' }}>
            {paths.map((path, idx) => (
              <button
                key={path.id ?? idx}
                type="button"
                className="nodrag nopan"
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); onSetOption?.(nodeId, idx); }}
                style={{ flex: 1, padding: '4px 4px', fontSize: 10, lineHeight: 1.3, fontWeight: idx === activeIdx ? 700 : 400, border: 'none', cursor: 'pointer', background: idx === activeIdx ? '#fff7ed' : '#fef3c7', color: idx === activeIdx ? '#9a3412' : '#78350f', borderRight: idx < paths.length - 1 ? '1px solid #fed7aa' : 'none' }}>
                Path {idx + 1}
              </button>
            ))}
          </div>
        )}
        {activePath && (
          <div style={{ padding: '6px 10px', ...(btIdx >= 0 ? { margin: 4, border: '1.5px dashed #dc2626', borderRadius: 6 } : {}) }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: btIdx >= 0 ? '#b91c1c' : '#c2410c', marginBottom: 3, lineHeight: 1.3 }}>{activePath.label}</div>
            {(activePath.courses ?? []).map((c) => <div key={c} style={{ fontSize: 11, color: '#374151', padding: '1px 0' }}>&#x2022; {c}</div>)}
            {(activePath.additionalRequirements ?? []).map((req, i) => <div key={i} style={{ fontSize: 11, color: '#374151', fontStyle: 'italic', padding: '1px 0' }}>+ {req}</div>)}
            {creditHours != null && <div style={{ marginTop: 4, fontSize: 10, color: '#9ca3af' }}>{creditHours} hrs total</div>}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const NODE_TYPES = { course: CourseNode, columnHeader: ColumnHeaderNode, pathOption: PathOptionNode };

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------
function Legend() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: '8px 14px', background: 'var(--color-surface,#fff)', borderBottom: '1px solid var(--color-border)', alignItems: 'center' }}>
      {[
        { label: 'Completed',   bg: '#dcfce7', border: '#16a34a', text: '#14532d' },
        { label: 'In Progress', bg: '#ccfbf1', border: '#0d9488', text: '#0f766e' },
        { label: 'Not Started', bg: '#ffffff', border: '#9ca3af', text: '#374151' },
      ].map((it) => (
        <div key={it.label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
          <div style={{ width: 16, height: 16, borderRadius: 3, background: it.bg, border: `2px solid ${it.border}`, flexShrink: 0 }} />
          <span style={{ color: it.text }}>{it.label}</span>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
        <div style={{ width: 16, height: 16, borderRadius: 3, background: '#f5f3ff', border: '1.5px dashed #7c3aed', flexShrink: 0 }} />
        <span style={{ color: '#5b21b6' }}>Elective pool</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
        <div style={{ width: 16, height: 16, borderRadius: 3, background: '#fdf2f8', border: '1.5px dashed #ec4899', flexShrink: 0 }} />
        <span style={{ color: '#be185d' }}>Track requirement</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
        <div style={{ width: 16, height: 16, borderRadius: 3, background: '#ffffff', border: `2px solid ${MULTI_OPTION_NODE_COLOR}`, flexShrink: 0 }} />
        <span style={{ color: MULTI_OPTION_NODE_COLOR }}>Choose one</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
        <div style={{ width: 16, height: 16, borderRadius: 3, background: '#ffedd5', border: '2px solid #f97316', flexShrink: 0 }} />
        <span style={{ color: '#9a3412' }}>Senior design path</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }} title="When a course is selected, prerequisites you can satisfy interchangeably share an edge color.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
          <div style={{ width: 18, height: 2.5, borderRadius: 2, background: PREREQ_GROUP_COLORS[0] }} />
          <div style={{ width: 18, height: 2.5, borderRadius: 2, background: PREREQ_GROUP_COLORS[1] }} />
        </div>
        <span style={{ color: '#374151' }}>Matching colors = satisfy one</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FlowFitter — auto-fit on mount + F key to re-fit + Shift+F to toggle fullscreen
// ---------------------------------------------------------------------------
function FlowFitter({ onToggleFullscreen }) {
  const { fitView } = useReactFlow();
  // Keep a ref so the keydown handler always has the latest callback without
  // being a useEffect dependency (avoids zoom-reset on every re-render).
  const toggleRef = useRef(onToggleFullscreen);
  useEffect(() => { toggleRef.current = onToggleFullscreen; });

  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.2 }), 50);
    function handleKey(e) {
      const tag = document.activeElement?.tagName;
      const editing = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
      if (editing) return;
      if ((e.key === 'f' || e.key === 'F') && e.shiftKey) {
        toggleRef.current();
      } else if ((e.key === 'f' || e.key === 'F') && !e.shiftKey) {
        fitView({ padding: 0.2, duration: 300 });
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => { clearTimeout(t); document.removeEventListener('keydown', handleKey); };
  }, [fitView]); // fitView is stable; toggleFullscreen is accessed via ref
  return null;
}

// ---------------------------------------------------------------------------
// DegreeFlowchartPanel — exported
// ---------------------------------------------------------------------------
export default function DegreeFlowchartPanel({ graph, semesters = [], height = 600, selectedTrackId = null }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [selectionDepth, setSelectionDepth] = useState(1); // 1 = direct neighbors, 2 = full chain
  const [bottleneckActive, setBottleneckActive] = useState(false); // 'b' = longest dependency chain
  const [bottleneckRouteIdx, setBottleneckRouteIdx] = useState(0); // which equivalent route (←/→)
  const [bottleneckInfo, setBottleneckInfo] = useState(null);      // { courses, semesters, count, index }
  const selectionDepthRef = useRef(1);
  useEffect(() => { selectionDepthRef.current = selectionDepth; }, [selectionDepth]);
  const bottleneckActiveRef = useRef(false);
  useEffect(() => { bottleneckActiveRef.current = bottleneckActive; }, [bottleneckActive]);
  const [fullscreen, setFullscreen] = useState(false);
  // Stable ref for raw edge topology — avoids infinite loop in highlight effect
  const rawEdgesRef = useRef([]);
  // Choice-node cycling: nodeId → active option index, plus metadata (counts + option codes).
  const [choiceSel, setChoiceSel] = useState({});
  const choiceMetaRef = useRef({ counts: {}, options: {} });

  const toggleFullscreen = useCallback(() => setFullscreen((f) => !f), []);

  // Cycle a choice node's active option (1→2→3→1). Drives the underline + prereq edges.
  const cycleChoice = useCallback((nodeId) => {
    setChoiceSel((prev) => {
      const count = choiceMetaRef.current.counts[nodeId] ?? 1;
      const cur = prev[nodeId] ?? 0;
      return { ...prev, [nodeId]: (cur + 1) % count };
    });
  }, []);
  // Directly set a node's active option/path (used by the senior-design path buttons).
  const setChoiceOption = useCallback((nodeId, idx) => {
    setChoiceSel((prev) => ({ ...prev, [nodeId]: idx }));
  }, []);

  // Rebuild graph whenever data changes
  useEffect(() => {
    const { nodes: rfNodes, edges: rfEdges, defaultChoiceSelections, choiceOptionCounts, choiceOptionsMap } =
      buildReactFlowGraph(graph, semesters, selectedTrackId);
    rawEdgesRef.current = rfEdges;
    choiceMetaRef.current = { counts: choiceOptionCounts ?? {}, options: choiceOptionsMap ?? {} };
    setNodes(rfNodes);
    setEdges(rfEdges);
    setSelectedNodeId(null);
    setSelectionDepth(1);
    setBottleneckActive(false);
    setBottleneckRouteIdx(0);
    setChoiceSel(defaultChoiceSelections ?? {});
  }, [graph, semesters, selectedTrackId, setNodes, setEdges]);

  // Map each choice node to its currently-active option code (for edge gating).
  function activeOptionCodes() {
    const out = {};
    for (const [nodeId, idx] of Object.entries(choiceSel)) {
      const opts = choiceMetaRef.current.options[nodeId];
      if (opts?.length) out[nodeId] = opts[idx] ?? opts[0];
    }
    return out;
  }

  // Patch active option index + handlers onto choice and path_option nodes on change.
  useEffect(() => {
    setNodes((nds) => nds.map((n) => {
      const isCyclable = (n.data?.options?.length ?? 0) >= 2 || (n.data?.paths?.length ?? 0) >= 2;
      if (!isCyclable) return n;
      const idx = choiceSel[n.id] ?? 0;
      if (n.data.activeOptionIdx === idx && n.data.onCycle === cycleChoice && n.data.onSetOption === setChoiceOption) return n;
      return { ...n, data: { ...n.data, activeOptionIdx: idx, onCycle: cycleChoice, onSetOption: setChoiceOption } };
    }));
  }, [choiceSel, setNodes, cycleChoice, setChoiceOption]);

  // Apply highlights when selection, depth, or the active choice option changes.
  useEffect(() => {
    const topo = rawEdgesRef.current;
    const activeCode = activeOptionCodes();
    // An option edge is "active" only when it belongs to its choice node's selected option.
    const edgeActive = (e) =>
      !e.data?.optionCode || e.data.optionCode === activeCode[e.data.choiceNodeId];
    const activeTopo = topo.filter(edgeActive);

    // ── Degree bottleneck mode (overrides selection) ──────────────────────────
    if (bottleneckActive) {
      // Full topology (not active-option-filtered) so "choose one" option prereq
      // chains (e.g. CSCE 420/421) are considered. Enumerate equivalent routes and
      // show ONE at a time (←/→ to page through them).
      const { edges: resolved } = resolveChoiceMinima(topo);
      const { routes, length } = computeBottleneckRoutes(resolved);
      const count = routes.length;
      const idx = count ? ((bottleneckRouteIdx % count) + count) % count : 0;
      const route = routes[idx] ?? [];
      const { nodeSet, edgeSet } = routeSets(route);
      // The specific "choose one" option this route runs through, per choice node
      // (from the option-tagged edge on the route) — gets an inner dashed box.
      const routeOption = new Map();
      for (let i = 0; i + 1 < route.length; i += 1) {
        const e = resolved.find((x) => x.source === route[i] && x.target === route[i + 1] && x.data?.optionCode && x.data?.choiceNodeId === route[i + 1]);
        if (e) routeOption.set(route[i + 1], e.data.optionCode);
      }
      setBottleneckInfo({ courses: nodeSet.size, semesters: length + 1, count, index: idx + 1 });
      setNodes((nds) => nds.map((n) => {
        if (n.type === 'columnHeader') return n;
        const onRoute = nodeSet.has(n.id);
        const highlight = onRoute ? 'bottleneck' : 'dimmed';
        const bottleneckOption = onRoute ? (routeOption.get(n.id) ?? null) : null;
        if ((n.data.highlight ?? null) === highlight && (n.data.bottleneckOption ?? null) === bottleneckOption) return n;
        return { ...n, data: { ...n.data, highlight, bottleneckOption } };
      }));
      setEdges(() => topo.map((e) => {
        const isCo = e.data?.isCo;
        if (edgeSet.has(`${e.source}->${e.target}`)) {
          return { ...e, style: { fill: 'none', stroke: '#dc2626', strokeWidth: 2.5, ...(isCo ? { strokeDasharray: '5,3' } : {}) }, markerEnd: { type: isCo ? 'arrow' : 'arrowclosed', color: '#dc2626' } };
        }
        return { ...e, style: { fill: 'none', stroke: '#e5e7eb', strokeWidth: 1, opacity: 0.15, ...(isCo ? { strokeDasharray: '5,3' } : {}) }, markerEnd: undefined };
      }));
      return;
    }

    setNodes((nds) => {
      if (!selectedNodeId) {
        return nds.map((n) => (n.data.highlight || n.data.bottleneckOption ? { ...n, data: { ...n.data, highlight: null, bottleneckOption: null } } : n));
      }
      const { prereqs, dependents } = selectionDepth === 1
        ? computeDirectNeighbors(selectedNodeId, activeTopo)
        : computeHighlightSets(selectedNodeId, activeTopo);
      return nds.map((n) => {
        if (n.type === 'columnHeader') return n;
        let highlight;
        if (n.id === selectedNodeId)   highlight = 'selected';
        else if (prereqs.has(n.id))    highlight = 'prereq';
        else if (dependents.has(n.id)) highlight = 'dependent';
        else                           highlight = 'dimmed';
        const cur = n.data.highlight ?? null;
        return cur === highlight ? n : { ...n, data: { ...n.data, highlight } };
      });
    });
    setEdges(() => {
      // Non-active option edges are always hidden (only the selected option's chain shows).
      const hiddenStyle = { fill: 'none', stroke: 'transparent', strokeWidth: 0, opacity: 0 };
      if (!selectedNodeId) {
        return topo.map((e) => {
          if (!edgeActive(e)) return { ...e, style: hiddenStyle, markerEnd: undefined };
          const isCo = e.data?.isCo;
          return {
            ...e,
            style:     isCo ? { fill: 'none', strokeDasharray: '5,3', stroke: '#9ca3af', strokeWidth: 2 } : { fill: 'none', stroke: '#6b7280', strokeWidth: 1.5 },
            markerEnd: isCo ? { type: 'arrow', color: '#9ca3af' } : { type: 'arrowclosed', color: '#6b7280' },
          };
        });
      }
      const { prereqs, dependents } = selectionDepth === 1
        ? computeDirectNeighbors(selectedNodeId, activeTopo)
        : computeHighlightSets(selectedNodeId, activeTopo);
      const related = new Set([selectedNodeId, ...prereqs, ...dependents]);
      return topo.map((e) => {
        if (!edgeActive(e)) return { ...e, style: hiddenStyle, markerEnd: undefined };
        const connected = selectionDepth === 1
          ? (e.source === selectedNodeId || e.target === selectedNodeId)
          : (related.has(e.source) && related.has(e.target));
        const isCo = e.data?.isCo;
        if (connected) {
          let stroke = isCo ? '#a78bfa' : '#f59e0b';
          // A prereq edge into the selected node that belongs to an OR-group ("choose one")
          // is colored by group so interchangeable alternatives share a color.
          const gci = e.data?.groupColorIdx;
          if (!isCo && gci != null && e.target === selectedNodeId) {
            stroke = PREREQ_GROUP_COLORS[gci % PREREQ_GROUP_COLORS.length];
          }
          return {
            ...e,
            style:     isCo ? { fill: 'none', strokeDasharray: '5,3', stroke, strokeWidth: 2.5 } : { fill: 'none', stroke, strokeWidth: 2 },
            markerEnd: isCo ? { type: 'arrow', color: stroke } : { type: 'arrowclosed', color: stroke },
          };
        }
        return {
          ...e,
          style:     { fill: 'none', stroke: '#d1d5db', strokeWidth: 1, opacity: 0.2, ...(isCo ? { strokeDasharray: '5,3' } : {}) },
          markerEnd: isCo ? { type: 'arrow', color: '#d1d5db' } : { type: 'arrowclosed', color: '#d1d5db' },
        };
      });
    });
  }, [selectedNodeId, selectionDepth, bottleneckActive, bottleneckRouteIdx, choiceSel, setNodes, setEdges]);

  // A key: expand to full chain / deselect. Escape: deselect.
  useEffect(() => {
    function handleKeyDown(evt) {
      const tag = document.activeElement?.tagName;
      const editing = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
      if (evt.key === 'Escape') { setSelectedNodeId(null); setSelectionDepth(1); setBottleneckActive(false); return; }
      if ((evt.key === 'b' || evt.key === 'B') && !editing) {
        // Toggle the degree-bottleneck overlay (shows one longest route at a time).
        setBottleneckActive((v) => !v);
        setBottleneckRouteIdx(0);
        setSelectedNodeId(null);
        setSelectionDepth(1);
        return;
      }
      // While in bottleneck mode, ←/→ page through equivalent routes.
      if (bottleneckActiveRef.current && !editing && (evt.key === 'ArrowRight' || evt.key === 'ArrowLeft')) {
        evt.preventDefault();
        setBottleneckRouteIdx((i) => i + (evt.key === 'ArrowRight' ? 1 : -1));
        return;
      }
      if ((evt.key === 'a' || evt.key === 'A') && !editing) {
        setSelectedNodeId((prev) => {
          if (!prev) return prev;
          if (selectionDepthRef.current === 1) { setSelectionDepth(2); return prev; }
          setSelectionDepth(1); return null;
        });
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  function onNodeClick(_, node) {
    if (node.type === 'columnHeader') return;
    setBottleneckActive(false);
    setSelectionDepth(1);
    setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
  }

  function onPaneClick() {
    setSelectedNodeId(null);
    setSelectionDepth(1);
    setBottleneckActive(false);
  }

  if (!graph?.nodes?.length) {
    return (
      <div style={{ padding: 24, fontSize: 13, color: 'var(--color-text-muted)' }}>
        No flowchart data available for this program.
      </div>
    );
  }

  // Multi-track majors (e.g. BMEN) require a track selection before the flowchart
  // is meaningful — pool courses differ per track and classification is wrong without one.
  if (graph.availableTracks?.length > 0 && !selectedTrackId) {
    return (
      <div style={{ padding: 24, fontSize: 13, color: 'var(--color-text-muted)', textAlign: 'center', lineHeight: 1.7 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text)', marginBottom: 8 }}>
          Select a track to view your degree flowchart
        </div>
        This major has multiple tracks. Choose your track in your{' '}
        <strong>Academic Profile</strong> (Degree Planner → Profile section) and your
        personalized flowchart will appear here.
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-text-muted)' }}>
          Available tracks: {graph.availableTracks.map((t) => t.name).join(', ')}
        </div>
      </div>
    );
  }

  const inner = (
    <div style={fullscreen
      ? { position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', flexDirection: 'column', background: '#fff' }
      : { border: '1px solid var(--color-border)', borderRadius: 8, overflow: 'hidden' }
    }>
      <div style={{ padding: '8px 14px', background: 'var(--color-surface,#fff)', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <strong style={{ fontSize: 14 }}>{graph.title}</strong>
        {(() => {
          const trackName = graph.availableTracks?.find((t) => t.id === selectedTrackId)?.name;
          return trackName ? (
            <span style={{ fontSize: 12, fontWeight: 700, color: '#be185d', background: '#fdf2f8', border: '1px solid #f9a8d4', borderRadius: 12, padding: '2px 10px' }}>
              {trackName} Track
            </span>
          ) : null;
        })()}
        {graph.catalog && <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{graph.catalog}</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {graph.nodes.length} courses &middot; {graph.edges?.length ?? 0} edges
          </span>
          <button
            type="button"
            onClick={toggleFullscreen}
            title={fullscreen ? 'Exit fullscreen (Shift+F)' : 'Fullscreen (Shift+F)'}
            style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-surface,#f9fafb)', color: 'var(--color-text-muted)' }}
          >
            {fullscreen ? '\u2715 Exit Fullscreen' : '\u26f6 Fullscreen'}
          </button>
        </span>
      </div>
      <Legend />
      <div style={{ flex: fullscreen ? 1 : undefined, height: fullscreen ? undefined : height, overflow: 'hidden' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          nodeTypes={NODE_TYPES}
          // In bottleneck mode, ←/→ page through routes; disable React Flow's
          // arrow-key node nudging so no vertices move (mouse dragging still works).
          disableKeyboardA11y={bottleneckActive}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.15}
          maxZoom={2}
          attributionPosition="bottom-right"
        >
          <Background color="#e5e7eb" gap={20} />
          <Controls />
          <FlowFitter onToggleFullscreen={toggleFullscreen} />
          <MiniMap
            nodeColor={(n) => {
              const state = n.data?.state;
              if (state === 'completed')   return '#9ca3af';
              if (state === 'in_progress') return '#34d399';
              if (state === 'missing')     return '#fca5a5';
              return n.data?.color ?? '#93c5fd';
            }}
            maskColor="rgba(240,242,245,0.6)"
          />
        </ReactFlow>
      </div>
      <div style={{ padding: '6px 14px', fontSize: 11, color: 'var(--color-text-muted)', background: 'var(--color-surface,#fff)', borderTop: '1px solid var(--color-border)' }}>
        {bottleneckActive
          ? <span>
              <span style={{ marginRight: 8, padding: '1px 7px', borderRadius: 10, fontSize: 10, fontWeight: 600, background: '#fee2e2', color: '#b91c1c', border: '1px solid #fecaca' }}>
                Degree bottleneck
              </span>
              {bottleneckInfo && bottleneckInfo.count > 0
                ? `Longest chain: ${bottleneckInfo.courses} courses, ~${bottleneckInfo.semesters} semesters${bottleneckInfo.count > 1 ? ` \u00b7 route ${bottleneckInfo.index} of ${bottleneckInfo.count} (\u2190/\u2192 to page)` : ' \u00b7 only route'} \u00b7 `
                : 'No prerequisite chain in this program \u00b7 '}
              B = exit &middot; Esc = exit &middot;
            </span>
          : selectedNodeId
          ? <span>
              <span style={{ marginRight: 8, padding: '1px 7px', borderRadius: 10, fontSize: 10, fontWeight: 600, background: selectionDepth === 1 ? '#eff6ff' : '#f3e8ff', color: selectionDepth === 1 ? '#1d4ed8' : '#7c3aed', border: `1px solid ${selectionDepth === 1 ? '#93c5fd' : '#c4b5fd'}` }}>
                {selectionDepth === 1 ? '1-hop view' : 'Full chain'}
              </span>
              A = toggle full chain &middot; Esc = deselect &middot;
            </span>
          : 'Click a course to highlight prereqs / dependents \u00b7 B = degree bottleneck \u00b7 '}
        F = fit view &middot; Shift+F = {fullscreen ? 'exit' : 'enter'} fullscreen
      </div>
    </div>
  );

  return inner;
}
