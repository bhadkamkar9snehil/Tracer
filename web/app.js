import * as THREE from "./vendor/three.module.js";

/* ──────────────────────────────────────────────────────────────────
   STATE
   ────────────────────────────────────────────────────────────────── */
const state = {
  summary: null,
  graph: { nodes: [], edges: [], default_focus: null },
  procedures: [],
  analytics: null,
  events: [],
  runtimeLogs: [],
  playback: null,
  selected: null,
  filters: { name: "", type: "", q: "", source: "cache", limit: "200", start: "", end: "", sr_no: "", sub_seq_no: "", step: "" },
  visibleNodeCount: 0,
  visibleEdgeCount: 0,
  viewMode: "workflow",
  wrongMode: false,
  /* Phase 1 — graph readability additions */
  graphScope: "all",
  colorScheme: localStorage.getItem("tracer.colorScheme") || "default",
  focusedNodeId: "",
  hoveredNodeId: "",
  /* Phase 2 — drawer and diagnosis */
  drawerMode: "diagnosis",
  drawerCollapsed: true,
  activeEvidenceId: null,
  activeDiagnosisId: null,
  runtimeStartedAt: "",
  graphNotice: "",
  /* Phase 3 */
  expectedPath: null,
  expectedPathByName: null,
  /* Phase 4 */
  runs: [],
  selectedRunId: null,
  runEvents: [],
  /* Phase 6 */
  playback: {
    active: false,
    interval: null,
    currentIndex: -1
  },
  playbackData: null,
  activeRun: null
};

const $ = (id) => document.getElementById(id);
const fmt = (value) => value === null || value === undefined || value === "" ? "--" : String(value);
const compact = (n) => Number(n || 0).toLocaleString("en-US");
const truncate = (value, max = 34) => {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
};

/* Fixed lane order — never shifts when filters change */
const LANE_ORDER = ["PROCEDURE", "WORKFLOW", "SAP", "API ERROR", "INTERNAL STEP", "TABLE", "UNKNOWN"];
const COLOR_SCHEMES = {
  default: {
    scene: 0x151718, gridMajor: 0x3f464a, gridMinor: 0x25292b,
    focus: 0x4c9fd8, selected: 0xf2f2ef, error: 0xc9443c, warning: 0xd8a13a,
    workflow: 0xe6e3dc, step: 0x8d9698, table: 0x657073, procedure: 0x9aa1a3,
    unknown: 0xd8a13a, readEdge: 0x555b5f, writeEdge: 0xd8a13a,
    callEdge: 0xe6e3dc, staticEdge: 0x3f464a,
  },
  ocean: {
    scene: 0x101719, gridMajor: 0x2f6570, gridMinor: 0x1e363b,
    focus: 0x38bdf8, selected: 0xecfeff, error: 0xfb7185, warning: 0xfacc15,
    workflow: 0x67e8f9, step: 0x94a3b8, table: 0x2dd4bf, procedure: 0xbae6fd,
    unknown: 0xfbbf24, readEdge: 0x38bdf8, writeEdge: 0xfacc15,
    callEdge: 0xa5f3fc, staticEdge: 0x155e75,
  },
  graphite: {
    scene: 0x111315, gridMajor: 0x4b5563, gridMinor: 0x262b30,
    focus: 0xf59e0b, selected: 0xf8fafc, error: 0xef4444, warning: 0xf97316,
    workflow: 0xd1d5db, step: 0x9ca3af, table: 0x6b7280, procedure: 0xe5e7eb,
    unknown: 0xfbbf24, readEdge: 0x64748b, writeEdge: 0xf59e0b,
    callEdge: 0xe5e7eb, staticEdge: 0x374151,
  },
  contrast: {
    scene: 0x050608, gridMajor: 0x68707a, gridMinor: 0x23272f,
    focus: 0x00e5ff, selected: 0xffffff, error: 0xff3b30, warning: 0xffd60a,
    workflow: 0xffffff, step: 0xb7c1cb, table: 0x7dd3fc, procedure: 0xf8fafc,
    unknown: 0xffd60a, readEdge: 0x60a5fa, writeEdge: 0xffd60a,
    callEdge: 0xffffff, staticEdge: 0x475569,
  },
};

let renderer;
let scene;
let camera;
let raycaster;
let pointer;
let graphGroup;
let maxTextureAnisotropy = 1;
let nodeMeshes = [];
let selectedMesh = null;
let nodePositions = new Map();
let cameraTarget = new THREE.Vector3(0, 0, -120);
let cameraSpherical = { radius: 900, theta: 0, phi: 1.1 };
const BASE_CAMERA_FOV = 46;
let referenceGraphHeight = 0;
let dragState = null;

/* ──────────────────────────────────────────────────────────────────
   API
   ────────────────────────────────────────────────────────────────── */
async function api(path, options = {}) {
  const started = performance.now();
  const response = await fetch(path, options);
  const rawText = await response.text();
  let payload = {};

  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = {
      ok: false,
      error: rawText || response.statusText || `HTTP ${response.status}`,
    };
  }

  const failed = !response.ok || payload.ok === false;
  state.runtimeLogs.unshift({
    ts: new Date().toLocaleTimeString(),
    layer: "browser",
    path,
    status: response.status,
    elapsed_ms: Math.round(performance.now() - started),
    source: payload.source || payload.live?.mode || payload.mode || "api",
    error: failed ? (payload.error || response.statusText || "Request failed") : "",
  });
  state.runtimeLogs = state.runtimeLogs.slice(0, 200);
  renderRuntime();

  if (failed) throw new Error(payload.error || response.statusText || `HTTP ${response.status}`);
  return payload;
}

/* ──────────────────────────────────────────────────────────────────
   BOOT
   ────────────────────────────────────────────────────────────────── */
async function boot() {
  applyColorScheme(state.colorScheme);
  setupDrawer();
  setupGraph();
  bindActions();
  setupCameraWidget();
  await loadAll();
}

function currentScheme() {
  return COLOR_SCHEMES[state.colorScheme] || COLOR_SCHEMES.default;
}

function applyColorScheme(name) {
  state.colorScheme = COLOR_SCHEMES[name] ? name : "default";
  localStorage.setItem("tracer.colorScheme", state.colorScheme);
  document.body.dataset.scheme = state.colorScheme;
  if (scene) scene.background = new THREE.Color(currentScheme().scene);
}

async function loadAll() {
  setConnection("LOADING", "");
  try {
    const [summary, workflows, analytics, events, health] = await Promise.all([
      api("/api/trace/summary"),
      api("/api/workflows"),
      api("/api/analytics"),
      api("/api/trace/events?limit=120"),
      api("/api/health"),
    ]);
    state.summary = summary;
    state.graph = workflows.graph;
    state.procedures = workflows.procedures;
    state.analytics = analytics;
    state.events = events.events;
    state.runtimeStartedAt = health.started_at || "";

    /* Phase 1: set default focus from backend or summary */
    state.focusedNodeId = resolveDefaultFocus();
    if (state.graphScope === "focused" && !state.focusedNodeId) {
      state.graphScope = "all";
    }

    setConnection("CACHE FAST", "good");
    renderSummary();
    renderFilters();
    await loadRuns();
    renderGraph();
    renderAnalytics();
    renderEvents();
    renderRuntime();
  } catch (error) {
    setConnection("ERROR", "bad");
    $("inspect-evidence").textContent = error.message;
  }
}

function setConnection(text, cls) {
  const el = $("connection-state");
  el.textContent = text;
  el.className = `state-pill ${cls || ""}`;
}

/* ──────────────────────────────────────────────────────────────────
   FOCUS RESOLUTION  (Phase 1)
   ────────────────────────────────────────────────────────────────── */
function resolveDefaultFocus() {
  /* Backend may provide a default_focus hint */
  if (state.graph.default_focus?.node_id) {
    return state.graph.default_focus.node_id;
  }
  /* Fallback: use top SP name from summary */
  const topName = state.summary?.cache?.top_names?.[0]?.name;
  if (topName) {
    return resolveNodeIdFromName(topName) || topName;
  }
  return "";
}

function resolveNodeIdFromName(name) {
  const exact = state.graph.nodes.find((n) => n.id === name);
  if (exact) return exact.id;
  const lower = name.toLowerCase();
  const match = state.graph.nodes.find((n) => n.id.toLowerCase() === lower || (n.label || "").toLowerCase() === lower);
  return match ? match.id : null;
}

/* ──────────────────────────────────────────────────────────────────
   GRAPH SCOPE (Phase 1)
   ────────────────────────────────────────────────────────────────── */
function graphScopeVisibleIds() {
  const graph = state.graph;
  const allIds = new Set(graph.nodes.map((n) => n.id));

  if (state.graphScope === "all") {
    return allIds;
  }

  if (state.graphScope === "focused") {
    const seed = state.focusedNodeId;
    if (!seed) return allIds;
    /* Use backend hint if available */
    if (state.graph.default_focus?.node_id === seed && state.graph.default_focus?.connected_node_ids) {
      const ids = new Set([seed, ...state.graph.default_focus.connected_node_ids]);
      /* Also add child steps */
      for (const n of graph.nodes) {
        if (n.parent === seed) ids.add(n.id);
      }
      return ids;
    }
    return neighbourhoodIds(new Set([seed]), 1);
  }

  if (state.graphScope === "selected") {
    const seed = state.selected?.id || state.focusedNodeId;
    if (!seed) return allIds;
    return neighbourhoodIds(new Set([seed]), 1);
  }

  if (state.graphScope === "neighbourhood") {
    const seed = state.selected?.id || state.focusedNodeId;
    if (!seed) return allIds;
    return neighbourhoodIds(new Set([seed]), 2);
  }

  return allIds;
}

function neighbourhoodIds(seedIds, depth) {
  const graph = state.graph;
  const result = new Set(seedIds);

  /* Add child steps of seed nodes */
  for (const n of graph.nodes) {
    if (n.parent && seedIds.has(n.parent)) result.add(n.id);
  }

  /* BFS expansion */
  let frontier = new Set(result);
  for (let d = 0; d < depth; d++) {
    const next = new Set();
    for (const edge of graph.edges) {
      if (frontier.has(edge.source) && !result.has(edge.target)) {
        next.add(edge.target);
      }
      if (frontier.has(edge.target) && !result.has(edge.source)) {
        next.add(edge.source);
      }
    }
    /* Add child steps of newly found nodes */
    for (const n of graph.nodes) {
      if (n.parent && next.has(n.parent)) next.add(n.id);
    }
    for (const id of next) result.add(id);
    frontier = next;
    if (next.size === 0) break;
  }
  return result;
}

/* ──────────────────────────────────────────────────────────────────
   EDGE PRIORITY & FILTERING (Phase 1)
   ────────────────────────────────────────────────────────────────── */
function edgePriority(edge) {
  if (edge.priority) return edge.priority;
  const kind = edge.kind || "";
  if (kind === "error") return 90;
  if (kind === "calls") return 80;
  if (kind === "writes") return 75;
  if (kind === "updates") return 60;
  if (kind === "reads") return 40;
  if (kind === "static_step") return 20;
  return 50;
}

function shouldShowEdge(edge, visibleIds) {
  if (!visibleIds.has(edge.source) || !visibleIds.has(edge.target)) return false;
  if (state.graphScope === "all") return true;

  const priority = edgePriority(edge);
  const focusId = state.focusedNodeId;
  const selectedId = state.selected?.id;

  /* Always show edges connected to focused or selected */
  if (edge.source === focusId || edge.target === focusId) return true;
  if (selectedId && (edge.source === selectedId || edge.target === selectedId)) return true;

  /* In focused mode, hide low-priority edges */
  if (state.graphScope === "focused") {
    if (priority < 40) return false; /* hide static_step unless connected to focus */
  }
  return true;
}

/* ──────────────────────────────────────────────────────────────────
   SMART LABELS (Phase 1)
   ────────────────────────────────────────────────────────────────── */
function shouldShowLabel(node, selectNeighbours) {
  const selectedId = state.selected?.id;
  if (selectedId) {
    return selectNeighbours && selectNeighbours.has(node.id);
  }

  if (node.id === state.focusedNodeId) return true;
  if (node.id === state.hoveredNodeId) return true;

  /* Error / unknown / anonymous always show label */
  if (node.kind === "error" || node.kind === "anonymous" || node.kind === "unknown") return true;

  /* Show label if node has high importance (from backend) */
  if (node.importance && node.importance >= 0.5) return true;
  if (node.is_dominant) return true;
  if (node.is_damage) return true;

  if (node.kind && node.kind.startsWith("table") && !isMeaningfulTableName(node.label || node.id)) {
    return false;
  }

  if (state.filters.name && (node.id === state.filters.name || node.parent === state.filters.name)) {
    return node.kind !== "step" || nodeMatchesActiveEvidence(node);
  }

  /* In "all" scope, label the important log objects instead of every small object */
  if (state.graphScope === "all") {
    if (node.kind === "procedure" || node.kind === "workflow") {
      return (node.importance || 0) >= 0.015 || (node.degree || 0) >= 20;
    }
    return false;
  }

  /* In focused/selected/neighbourhood, show most top-level node labels */
  if (node.kind === "step") return nodeMatchesActiveEvidence(node);
  return true;
}

function nodeMatchesActiveEvidence(node) {
  if (!node || node.kind !== "step") return false;
  const rows = state.activeRun ? state.runEvents : state.events;
  return rows.some((event) => {
    const sameParent = !node.parent || !event.name || node.parent === event.name;
    const sameSr = node.sr_no === undefined || node.sr_no === null || Number(node.sr_no) === Number(event.sr_no);
    const sameSub = node.sub_seq_no === undefined || node.sub_seq_no === null || Number(node.sub_seq_no) === Number(event.sub_seq_no);
    const label = String(node.label || "").toLowerCase();
    const step = String(event.step || "").toLowerCase();
    return sameParent && sameSr && sameSub && (!label || !step || label.includes(step) || step.includes(label));
  });
}

function nodeDisplayName(node) {
  if (!node) return "";
  if (node.kind === "step") {
    const prefix = node.sr_no ? `${node.sr_no}${node.sub_seq_no ? `.${node.sub_seq_no}` : ""} ` : "";
    return truncate(`${prefix}${node.label || node.id}`, 42);
  }

  if (node.kind && node.kind.startsWith("table")) {
    if (!isMeaningfulTableName(node.label || node.id)) return "SQL table reference";
    return truncate(cleanObjectName(node.label || node.id.replace(/^table::/, "")), 36);
  }

  if (node.kind === "anonymous") return "<anonymous log rows>";
  if (node.kind === "unknown") return truncate(cleanObjectName(node.label || node.id), 36);
  return truncate(cleanObjectName(node.label || node.id), 38);
}

function nodeLabelMeta(node) {
  if (!node) return "";
  const lane = laneKey(node).toLowerCase();
  if (node.kind === "step") return `step | ${lane}`;
  if (node.kind && node.kind.startsWith("table")) return `${node.kind.replace("table_", "table ")} | ${lane}`;
  const topType = topTypeForNode(node);
  const count = node.trace_count ? `${compact(node.trace_count)} rows` : "";
  return [lane, topType, count].filter(Boolean).join(" | ");
}

function topTypeForNode(node) {
  const entries = Object.entries(node.types || {});
  if (!entries.length) return "";
  entries.sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));
  return entries[0][0];
}

function cleanObjectName(value) {
  let name = String(value || "").replace(/^table::/i, "");
  name = name.replace(/^\[?dbo\]?\./i, "");
  name = name.replace(/^(XStudio_Xbatch\.dbo\.|XStudio_|XSTUDIO_)/i, "");
  name = name.replace(/^XMES_I_/i, "");
  name = name.replace(/^XMES_/i, "");
  name = name.replace(/(_Usp|_USP|_SP)$/i, "");
  name = name.replace(/^WORKFLOW_/i, "Workflow ");
  name = name.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return name || String(value || "");
}

function isMeaningfulTableName(value) {
  const name = cleanObjectName(value).toLowerCase();
  return Boolean(name && !["dbo", "cur", "api", "batch", "table"].includes(name));
}

/* ──────────────────────────────────────────────────────────────────
   RENDER — SUMMARY / FILTERS
   ────────────────────────────────────────────────────────────────── */
function renderSummary() {
  const live = state.summary.live;
  const cache = state.summary.cache;
  const topName = cache.top_names[0];
  const topType = cache.type_counts[0];
  $("metric-rows").textContent = live.overview?.total_rows ? compact(live.overview.total_rows) : "SQL deferred";
  $("metric-names").textContent = compact(cache.top_names.length);
  const firstSeen = cache.top_names.map((x) => x.first_seen).filter(Boolean).sort()[0];
  const lastSeen = cache.top_names.map((x) => x.last_seen).filter(Boolean).sort().at(-1);
  $("metric-range").textContent = firstSeen ? `${firstSeen} -> ${lastSeen}` : "--";
  $("metric-cache").textContent = compact(cache.cache_rows);
  $("watermark").textContent = cache.watermark || "--";
  const runtimeStarted = $("runtime-started");
  if (runtimeStarted) runtimeStarted.textContent = state.runtimeStartedAt ? shortRuntimeTime(state.runtimeStartedAt) : "--";
  $("dominant-sp").textContent = topName ? `${cleanObjectName(topName.name)} (${compact(topName.trace_count)})` : "--";
  $("dominant-sp").title = topName ? topName.name : "";
  $("dominant-type").textContent = topType ? `${topType.type} (${compact(topType.trace_count)})` : "--";

  const start = $("filter-start");
  const end = $("filter-end");
  const minDate = toDateTimeLocal(firstSeen);
  const maxDate = toDateTimeLocal(lastSeen);
  if (start && end && minDate && maxDate) {
    start.min = minDate;
    start.max = maxDate;
    end.min = minDate;
    end.max = maxDate;
  }
}

function renderFilters() {
  const names = state.summary.cache.top_names;
  const types = state.summary.cache.type_counts;
  fillSelect($("filter-name"), "All procedures", names.map((x) => ({
    value: x.name,
    label: `${cleanObjectName(x.name)} (${compact(x.trace_count)})`,
  })));
  fillSelect($("filter-type"), "All types", types.map((x) => ({
    value: x.type,
    label: `${x.type} (${compact(x.trace_count)})`,
  })));
}

function fillSelect(select, label, options) {
  const current = select.value;
  select.innerHTML = `<option value="">${label}</option>`;
  for (const item of options) {
    const value = typeof item === "object" ? item.value : item;
    const option = document.createElement("option");
    option.value = value;
    option.textContent = typeof item === "object" ? item.label : value;
    option.title = value;
    select.appendChild(option);
  }
  select.value = current;
}

function toDateTimeLocal(value) {
  if (!value) return "";
  const text = String(value).replace(" ", "T");
  return text.slice(0, 16);
}

function normalizeDateFilter(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const normalized = text.replace("T", " ");
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return `${normalized} 00:00:00`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(normalized)) return `${normalized}:00`;
  return normalized;
}

function validateDateRange(start, end) {
  if (!start || !end) return "";
  const startTime = Date.parse(start.replace(" ", "T"));
  const endTime = Date.parse(end.replace(" ", "T"));
  if (Number.isNaN(startTime) || Number.isNaN(endTime)) return "Use YYYY-MM-DD HH:mm for From and To.";
  if (startTime > endTime) return "From must be earlier than To.";
  return "";
}

function hasActiveFilterContext() {
  return Boolean(
    state.selectedRunId ||
    state.filters.name ||
    state.filters.type ||
    state.filters.start ||
    state.filters.end ||
    state.filters.sr_no ||
    state.filters.sub_seq_no ||
    state.filters.step ||
    state.filters.q
  );
}

function expectedContextName() {
  return state.activeRun?.name || state.filters.name || "";
}

function syncExpectedPathContext() {
  const name = expectedContextName();
  if (name) {
    state.expectedPath = buildExpectedPathFromGraph(name);
    state.expectedPathByName = name;
  } else {
    state.expectedPath = null;
    state.expectedPathByName = null;
  }
}

/* ──────────────────────────────────────────────────────────────────
   TABS & ACTIONS
   ────────────────────────────────────────────────────────────────── */
function setupDrawer() {
  for (const button of document.querySelectorAll(".drawer-mode-button")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      document.querySelectorAll(".drawer-mode-button").forEach((btn) => btn.classList.remove("active"));
      document.querySelectorAll(".drawer-panel").forEach((panel) => panel.classList.remove("active"));
      button.classList.add("active");
      const mode = button.dataset.mode;
      const targetPanel = $(`drawer-${mode}`);
      if (targetPanel) targetPanel.classList.add("active");
      state.drawerMode = mode;
      state.drawerCollapsed = false;
      $("diagnostic-drawer").classList.remove("drawer-collapsed");
    });
  }

  const toggleBtn = $("drawer-toggle");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      state.drawerCollapsed = !state.drawerCollapsed;
      $("diagnostic-drawer").classList.toggle("drawer-collapsed", state.drawerCollapsed);
    });
  }
}

function bindActions() {
  $("sync-button").addEventListener("click", async () => {
    const button = $("sync-button");
    const originalText = button.textContent;
    const rawLimit = Number($("filter-limit")?.value || 500);
    const safeLimit = Math.max(10, Math.min(Number.isFinite(rawLimit) ? rawLimit : 500, 5000));

    button.disabled = true;
    button.textContent = "Syncing...";
    try {
      await api(`/api/sync?limit=${safeLimit}&mode=recent`, { method: "POST" });
      await loadAll();
    } catch (error) {
      setConnection("SYNC ERROR", "bad");
      const target = $("inspect-evidence");
      if (target) target.textContent = error.message;
      console.error(error);
    } finally {
      button.disabled = false;
      button.textContent = originalText || "Sync trace rows";
    }
  });
  $("apply-filters").addEventListener("click", applyFilters);
  for (const id of ["filter-source", "filter-limit", "filter-name", "filter-type", "filter-start", "filter-end", "filter-sr", "filter-subseq"]) {
    $(id)?.addEventListener("change", applyFilters);
  }
  $("filter-step").addEventListener("change", applyFilters);
  $("filter-q").addEventListener("change", applyFilters);
  
  $("filter-run").addEventListener("change", async (e) => {
    state.selectedRunId = e.target.value || "";
    if (!state.selectedRunId) {
      state.activeRun = null;
      state.runEvents = [];
      state.playbackData = null;
      await loadFilteredEvents();
      renderPlayback();
      return;
    }
    await loadSelectedRun(state.selectedRunId);
  });

  $("filter-start").addEventListener("keydown", (event) => { if (event.key === "Enter") applyFilters(); });
  $("filter-end").addEventListener("keydown", (event) => { if (event.key === "Enter") applyFilters(); });
  $("filter-step").addEventListener("keydown", (event) => { if (event.key === "Enter") applyFilters(); });
  $("filter-q").addEventListener("keydown", (event) => {
    if (event.key === "Enter") applyFilters();
  });

  /* Graph view mode */
  $("view-mode").addEventListener("change", () => {
    state.viewMode = $("view-mode").value;
    renderGraph();
  });

  const schemeSelect = $("color-scheme");
  if (schemeSelect) {
    schemeSelect.value = state.colorScheme;
    schemeSelect.addEventListener("change", () => {
      applyColorScheme(schemeSelect.value);
      renderGraph();
    });
  }

  /* Phase 1: Graph scope selector */
  $("graph-scope").addEventListener("change", () => {
    state.graphScope = $("graph-scope").value;
    renderGraph();
  });

  /* Phase 1: Map Key button */
  $("open-map-key").addEventListener("click", openMapKeyModal);

  $("view-reset").addEventListener("click", resetCamera);
  $("view-top").addEventListener("click", () => setCamera(900, 0, 0.08));
  $("view-front").addEventListener("click", () => setCamera(900, 0, 1.35));
  $("export-graph").addEventListener("click", exportGraphImage);
  $("run-playback").addEventListener("click", runPlayback);
  $("open-runtime").addEventListener("click", openRuntimeModal);
  $("open-sp-map").addEventListener("click", openSpMapModal);
  $("close-modal").addEventListener("click", closeModal);
  $("modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") closeModal();
  });
  
  const activateWrongMode = async () => {
    state.wrongMode = true;
    const wmBtn = $("wrong-mode");
    if (wmBtn) wmBtn.classList.add("active");
    state.graphScope = "all";
    const graphScope = $("graph-scope");
    if (graphScope) graphScope.value = "all";
    state.drawerCollapsed = false;
    $("diagnostic-drawer").classList.remove("drawer-collapsed");
    const diagBtn = document.querySelector('.drawer-mode-button[data-mode="diagnosis"]');
    if (diagBtn) diagBtn.click();
    await ensureScopedPlaybackForDamage();
    renderAnalytics();
    renderGraph();
  };

  const wmBtn = $("wrong-mode");
  if (wmBtn) wmBtn.addEventListener("click", async () => {
    if (state.wrongMode) {
      state.wrongMode = false;
      wmBtn.classList.remove("active");
      renderAnalytics();
      renderGraph();
    } else {
      await activateWrongMode();
    }
  });

  const topWrong = $("top-wrong-action");
  if (topWrong) topWrong.addEventListener("click", activateWrongMode);
  
  $("playback-play")?.addEventListener("click", () => {
    if (!state.runEvents || state.runEvents.length === 0) return;
    if (state.playback.active) return;
    state.playback.active = true;
    const playbackStatus = $("playback-status");
    if (playbackStatus) playbackStatus.textContent = "Playing...";
    
    const tlBtn = document.querySelector('.drawer-mode-button[data-mode="timeline"]');
    if (tlBtn) tlBtn.click();
    
    state.playback.interval = setInterval(() => {
      state.playback.currentIndex++;
      if (state.playback.currentIndex >= state.runEvents.length) {
        stopPlayback();
        return;
      }
      const event = state.runEvents[state.playback.currentIndex];
      
      const tlEvents = $("timeline-events");
      if (tlEvents) {
        if (state.playback.currentIndex === 0) tlEvents.innerHTML = "";
        const div = document.createElement("div");
        div.style.marginBottom = "0.5rem";
        div.textContent = `[${event.entry_datetime.split(" ")[1]}] ${event.step || event.type}`;
        tlEvents.appendChild(div);
        tlEvents.scrollTop = tlEvents.scrollHeight;
      }
      
      // Match the playback event to an actual graph node by name+sr_no or step text
      const matchedNode = state.graph.nodes.find(n =>
        n.parent === event.name && n.kind === "step" && (
          (event.sr_no != null && Number(n.sr_no) === Number(event.sr_no)) ||
          (event.step && n.label && (String(n.label).toLowerCase().includes(String(event.step).toLowerCase()) || String(event.step).toLowerCase().includes(String(n.label).toLowerCase())))
        )
      );
      state.selected = matchedNode ? { id: matchedNode.id } : null;
      renderGraph();
      
    }, 500);
  });

  $("playback-pause")?.addEventListener("click", () => {
    state.playback.active = false;
    clearInterval(state.playback.interval);
    const playbackStatus = $("playback-status");
    if (playbackStatus) playbackStatus.textContent = "Paused";
  });

  $("playback-stop")?.addEventListener("click", stopPlayback);
}

function stopPlayback() {
  state.playback.active = false;
  clearInterval(state.playback.interval);
  state.playback.currentIndex = -1;
  const statusEl = $("playback-status");
  if (statusEl) statusEl.textContent = "Stopped";
  state.selected = null;
  renderGraph();
}

async function applyFilters() {
  state.filters = {
    name: $("filter-name").value,
    type: $("filter-type").value,
    source: $("filter-source").value,
    limit: $("filter-limit").value,
    start: normalizeDateFilter($("filter-start").value),
    end: normalizeDateFilter($("filter-end").value),
    sr_no: $("filter-sr").value,
    sub_seq_no: $("filter-subseq").value,
    step: $("filter-step").value.trim(),
    q: $("filter-q").value.trim(),
  };

  const rangeError = validateDateRange(state.filters.start, state.filters.end);
  if (rangeError) {
    setFilterStatus(rangeError, "bad");
    return;
  }

  state.selectedRunId = null;
  state.activeRun = null;
  state.runEvents = [];
  state.playbackData = null;
  state.graphNotice = "";

  /* If user selects a specific SP name, auto-switch scope to focused on that SP */
  if (state.filters.name && state.graphScope === "all") {
    state.graphScope = "focused";
    state.focusedNodeId = resolveNodeIdFromName(state.filters.name) || state.filters.name;
    const scope = $("graph-scope");
    if (scope) scope.value = "focused";
  }

  if (!state.filters.name) {
    state.focusedNodeId = "";
    state.selected = null;
    if (state.graphScope === "focused") {
      state.graphScope = "all";
      const scope = $("graph-scope");
      if (scope) scope.value = "all";
    }
  }
  syncExpectedPathContext();

  renderGraph();
  renderFilterStatus();
  try {
    await loadFilteredEvents();
    await loadRuns();
    if (state.wrongMode) {
      await ensureScopedPlaybackForDamage();
      renderAnalytics();
    }
  } catch (error) {
    setConnection("FILTER ERROR", "bad");
    setFilterStatus(error.message, "bad");
    const target = $("inspect-evidence");
    if (target) target.textContent = error.message;
    console.error(error);
  }
}

async function loadFilteredEvents() {
  const query = new URLSearchParams();
  query.set("limit", state.filters.limit || "200");
  query.set("source", state.filters.source || "cache");
  if (state.filters.name) query.set("name", state.filters.name);
  if (state.filters.type) query.set("type", state.filters.type);
  if (state.filters.start) query.set("start", state.filters.start);
  if (state.filters.end) query.set("end", state.filters.end);
  if (state.filters.sr_no) query.set("sr_no", state.filters.sr_no);
  if (state.filters.sub_seq_no) query.set("sub_seq_no", state.filters.sub_seq_no);
  if (state.filters.step) query.set("step", state.filters.step);
  if (state.filters.q) query.set("q", state.filters.q);
  const payload = await api(`/api/trace/events?${query.toString()}`);
  state.events = payload.events || [];
  setConnection(payload.source === "sql-live" ? "LIVE SQL FILTER" : "CACHE FAST", "good");
  setFilterStatus(`${compact(state.events.length)} trace rows matched the current filters.`, "good");
  renderEvents();
  renderGraph();
}

async function loadRuns() {
  const runSelect = $("filter-run");
  if (!runSelect) return;

  const query = new URLSearchParams();
  query.set("limit", "80");
  if (state.filters.name) query.set("name", state.filters.name);
  if (state.filters.type) query.set("type", state.filters.type);
  if (state.filters.start) query.set("start", state.filters.start);
  if (state.filters.end) query.set("end", state.filters.end);

  try {
    const payload = await api(`/api/runs?${query.toString()}`);
    state.runs = payload.runs || [];
    renderRunOptions();
    const rowText = `${compact(state.events.length)} trace rows`;
    const runText = `${compact(state.runs.length)} reconstructed runs`;
    setFilterStatus(`${rowText} and ${runText} matched the current filters.`, "good");
  } catch (error) {
    state.runs = [];
    runSelect.innerHTML = '<option value="">Runs unavailable until server restart</option>';
    setFilterStatus(`${compact(state.events.length)} trace rows matched. Run selector needs the restarted API.`, "bad");
  }
}

function renderRunOptions() {
  const runSelect = $("filter-run");
  if (!runSelect) return;
  runSelect.innerHTML = '<option value="">-- Loose Events --</option>';
  for (const run of state.runs) {
    const option = document.createElement("option");
    option.value = run.run_id;
    option.textContent = `${shortTime(run.start_time)} ${cleanObjectName(run.name)} / ${run.type || "<null>"} (${run.status}, ${compact(run.event_count)} events)`;
    option.title = `${run.start_time} -> ${run.end_time}`;
    runSelect.appendChild(option);
  }
  runSelect.value = state.selectedRunId || "";
}

async function playbackForCurrentContext(runId = "") {
  const query = new URLSearchParams();
  if (runId) query.set("run_id", runId);
  if (state.activeRun?.name || state.filters.name) query.set("name", state.activeRun?.name || state.filters.name);
  if (state.activeRun?.type || state.filters.type) query.set("type", state.activeRun?.type || state.filters.type);
  if (!runId) {
    if (state.filters.start) query.set("start", state.filters.start);
    if (state.filters.end) query.set("end", state.filters.end);
    if (state.filters.sr_no) query.set("sr_no", state.filters.sr_no);
    if (state.filters.sub_seq_no) query.set("sub_seq_no", state.filters.sub_seq_no);
    if (state.filters.step) query.set("step", state.filters.step);
    if (state.filters.q) query.set("q", state.filters.q);
  }
  query.set("limit", state.filters.limit || "300");
  return api(`/api/playback?${query.toString()}`);
}

async function ensureScopedPlaybackForDamage() {
  if (state.selectedRunId) {
    if (!state.playbackData || state.playbackData.context_run_id !== state.selectedRunId) {
      state.playbackData = await playbackForCurrentContext(state.selectedRunId);
      state.playbackData.context_run_id = state.selectedRunId;
    }
    return;
  }
  if (!state.filters.name) return;
  state.playbackData = await playbackForCurrentContext();
}

async function loadSelectedRun(runId) {
  try {
    const payload = await api(`/api/runs/${encodeURIComponent(runId)}`);
    const run = payload.run || {};
    state.activeRun = run;
    state.runEvents = run.events || [];
    state.events = state.runEvents;
    state.filters.name = run.name || state.filters.name;
    state.filters.type = run.type || state.filters.type;
    const nameSelect = $("filter-name");
    const typeSelect = $("filter-type");
    if (nameSelect && run.name && [...nameSelect.options].some((option) => option.value === run.name)) nameSelect.value = run.name;
    if (typeSelect && run.type && [...typeSelect.options].some((option) => option.value === run.type)) typeSelect.value = run.type;
    syncExpectedPathContext();
    state.playbackData = await playbackForCurrentContext(run.run_id);
    state.playbackData.context_run_id = run.run_id;
    if (run.name) {
      state.focusedNodeId = resolveNodeIdFromName(run.name) || run.name;
      state.graphScope = "focused";
      const scope = $("graph-scope");
      if (scope) scope.value = "focused";
    }
    setFilterStatus(`Selected run ${shortTime(run.start_time)} with ${compact(state.runEvents.length)} events. Graph shows SP context.`, "good");
    renderEvents();
    renderPlayback();
    if (state.wrongMode) renderAnalytics();
    renderGraph();
  } catch (error) {
    setConnection("RUN ERROR", "bad");
    setFilterStatus(error.message, "bad");
  }
}

function shortTime(value) {
  if (!value) return "--";
  const text = String(value);
  return text.length >= 16 ? text.slice(5, 16) : text;
}

function shortRuntimeTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  return date.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function setFilterStatus(message, cls = "") {
  const el = $("filter-status");
  if (!el) return;
  el.textContent = message;
  el.className = `filter-status ${cls}`;
}

function buildExpectedPathFromGraph(name) {
  const rootId = resolveNodeIdFromName(name) || name;
  const root = state.graph.nodes.find((node) => node.id === rootId);
  if (!root) return null;

  const nodeById = new Map(state.graph.nodes.map((node) => [node.id, node]));
  const includeIds = new Set([rootId]);
  const includeEdges = [];

  for (const node of state.graph.nodes) {
    if (node.parent === rootId) includeIds.add(node.id);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of state.graph.edges) {
      const sourceIncluded = includeIds.has(edge.source);
      const targetIncluded = includeIds.has(edge.target);
      const isRootEdge = edge.source === rootId || edge.target === rootId;
      const isStepEdge = sourceIncluded || targetIncluded;
      const isExpectedKind = ["static_step", "calls", "reads", "writes", "updates", "error"].includes(edge.kind || "");
      if ((isRootEdge || isStepEdge) && isExpectedKind) {
        includeEdges.push(edge);
        if (nodeById.has(edge.source) && !includeIds.has(edge.source)) {
          includeIds.add(edge.source);
          changed = true;
        }
        if (nodeById.has(edge.target) && !includeIds.has(edge.target)) {
          includeIds.add(edge.target);
          changed = true;
        }
      }
    }
  }

  const dedupedEdges = [];
  const edgeKeys = new Set();
  for (const edge of includeEdges) {
    if (!includeIds.has(edge.source) || !includeIds.has(edge.target)) continue;
    const key = `${edge.source}|${edge.target}|${edge.kind || ""}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    dedupedEdges.push({ ...edge });
  }

  const nodes = [...includeIds]
    .map((id) => nodeById.get(id))
    .filter(Boolean)
    .map((node) => ({ ...node }));

  const steps = nodes
    .filter((node) => node.parent === rootId || node.kind === "step")
    .sort((a, b) => (Number(a.sr_no || 0) - Number(b.sr_no || 0)) || (Number(a.sub_seq_no || 0) - Number(b.sub_seq_no || 0)))
    .map((node, index) => ({
      node_id: node.id,
      ordinal: index + 1,
      sr_no: node.sr_no,
      sub_seq_no: node.sub_seq_no,
      step: node.label,
    }));
  const ordinalById = new Map(steps.map((step) => [step.node_id, step.ordinal]));
  for (const node of nodes) {
    if (node.kind === "step" && ordinalById.has(node.id)) {
      node.ordinal = ordinalById.get(node.id);
    }
  }

  return {
    name: rootId,
    steps: steps.map(({ node_id, ...step }) => step),
    graph: { nodes, edges: dedupedEdges },
  };
}

/* ──────────────────────────────────────────────────────────────────
   THREE.JS SETUP
   ────────────────────────────────────────────────────────────────── */
/*
3D model improvement backlog
----------------------------
Performance:
- Replace per-node mesh and label creation with instanced rendering where shape
  families allow it.
- Cache canvas label textures by text/style and reuse sprites across redraws.
- Reduce hover work by keeping a spatial index or raycast candidate set for
  visible nodes only.
- Add level-of-detail handling for dense graphs and skip fine labels at distance.
- Apply frustum culling and visible-edge pruning before building render objects.

Visual quality:
- Add tuned shadows, ambient occlusion, and optional bloom/glow for selected,
  damaged, and playback-active nodes.
- Draw directional edge arrowheads and edge labels for call/read/write/update
  semantics.
- Smooth camera/view transitions between workflow, steps, damage, and expected
  layouts instead of snapping.

Interaction:
- Support constrained node dragging for manual investigation layouts.
- Add edge hover/selection details, graph search, a minimap, and playback speed
  controls.

Layout:
- Guard expected-step stacking bounds for long paths and compress spacing when
  the path exceeds the visible depth.
- Apply delta coloring consistently across all view modes, not only expected
  path nodes.

Data visualization:
- Add heatmap overlays for trace volume/error intensity, a timeline scrubber,
  parameter/value visualization, and main-graph delta overlays.
*/
/* Memory Leak Prevention */
function clearGroup(group) {
  while (group.children.length > 0) {
    const child = group.children[0];
    group.remove(child);
    disposeObject(child);
  }
}

function disposeObject(obj) {
  if (obj.geometry) {
    obj.geometry.dispose();
  }
  if (obj.material) {
    if (Array.isArray(obj.material)) {
      for (const mat of obj.material) {
        disposeMaterial(mat);
      }
    } else {
      disposeMaterial(obj.material);
    }
  }
  while (obj.children.length > 0) {
    const child = obj.children[0];
    obj.remove(child);
    disposeObject(child);
  }
}

function disposeMaterial(mat) {
  mat.dispose();
  if (mat.map) mat.map.dispose();
  if (mat.lightMap) mat.lightMap.dispose();
  if (mat.bumpMap) mat.bumpMap.dispose();
  if (mat.normalMap) mat.normalMap.dispose();
  if (mat.specularMap) mat.specularMap.dispose();
  if (mat.envMap) mat.envMap.dispose();
}

function setupGraph() {
  const canvas = $("graph-canvas");
  canvas.style.cursor = "grab";
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  maxTextureAnisotropy = renderer.capabilities.getMaxAnisotropy();
  scene = new THREE.Scene();
  scene.background = new THREE.Color(currentScheme().scene);
  camera = new THREE.PerspectiveCamera(BASE_CAMERA_FOV, 1, 1, 5000);
  updateCamera();
  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();
  graphGroup = new THREE.Group();
  scene.add(graphGroup);

  const ambient = new THREE.AmbientLight(0xffffff, 0.65);
  const directional = new THREE.DirectionalLight(0xffffff, 1);
  directional.position.set(200, 500, 300);
  scene.add(ambient, directional);

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerUp);
  canvas.addEventListener("dblclick", onCanvasDoubleClick);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("resize", resizeGraph);

  const frame = document.querySelector(".graph-frame");
  if (frame) {
    const observer = new ResizeObserver(() => {
      resizeGraph();
    });
    observer.observe(frame);
  }

  resizeGraph();
  animate();
}

/* Transitive neighborhood calculator for graph highlight isolation */
function getSelectionNeighborhood(selectedId) {
  const neighborhood = new Set();
  if (!selectedId) return neighborhood;

  neighborhood.add(selectedId);

  const selectedNode = state.graph.nodes.find(n => n.id === selectedId);
  if (!selectedNode) return neighborhood;

  // 1. Identify all "root SPs" associated with the selected node
  const rootSps = new Set();

  if (selectedNode.kind === "step") {
    if (selectedNode.parent) {
      rootSps.add(selectedNode.parent);
    }
  } else if (selectedNode.kind && selectedNode.kind.startsWith("table")) {
    // Find all SPs or step-parents connected to this table
    for (const e of state.graph.edges) {
      if (e.source === selectedId || e.target === selectedId) {
        const otherId = e.source === selectedId ? e.target : e.source;
        const otherNode = state.graph.nodes.find(n => n.id === otherId);
        if (otherNode) {
          if (otherNode.kind === "step" && otherNode.parent) {
            rootSps.add(otherNode.parent);
          } else if (otherNode.kind !== "step" && !otherNode.kind?.startsWith("table")) {
            rootSps.add(otherNode.id);
          }
        }
      }
    }
  } else {
    // For procedure, workflow, error, anonymous, unknown
    rootSps.add(selectedId);
  }

  // 2. For every root SP, we transitively highlight:
  // - The SP itself
  // - All its child steps
  // - All direct connections of the SP itself (e.g. calls to other SPs, reads/writes to tables)
  // - All direct connections of the child steps (e.g. reads/writes/updates to tables)
  for (const rootSpId of rootSps) {
    neighborhood.add(rootSpId);

    // Find all child steps of this SP
    const childStepIds = new Set();
    for (const n of state.graph.nodes) {
      if (n.parent === rootSpId) {
        childStepIds.add(n.id);
        neighborhood.add(n.id);
      }
    }

    // Find direct connections of the SP and its child steps
    for (const e of state.graph.edges) {
      // If edge connects to the SP itself
      if (e.source === rootSpId) {
        neighborhood.add(e.target);
      }
      if (e.target === rootSpId) {
        neighborhood.add(e.source);
      }
      // If edge connects to any of its child steps
      if (childStepIds.has(e.source)) {
        neighborhood.add(e.target);
      }
      if (childStepIds.has(e.target)) {
        neighborhood.add(e.source);
      }
    }
  }

  // 3. Always include direct edges of the selected node itself to ensure they are lit up
  for (const e of state.graph.edges) {
    if (e.source === selectedId) neighborhood.add(e.target);
    if (e.target === selectedId) neighborhood.add(e.source);
  }

  return neighborhood;
}

/* ──────────────────────────────────────────────────────────────────
   RENDER GRAPH
   ────────────────────────────────────────────────────────────────── */
function renderGraph() {
  clearGroup(graphGroup);
  nodeMeshes = [];
  selectedMesh = null;
  nodePositions = new Map();

  state.graphNotice = "";
  const missingExpectedContext = state.viewMode === "expected" && !expectedContextName();
  const unavailableExpectedPath = state.viewMode === "expected" && expectedContextName() && !state.expectedPath;
  let nodes = missingExpectedContext || unavailableExpectedPath ? [] : filteredNodes();
  if (state.viewMode === "expected" && state.expectedPath) {
    nodes = state.expectedPath.graph.nodes;
  }
  if (missingExpectedContext) state.graphNotice = "Select an SP/type/run to view expected path.";
  if (unavailableExpectedPath) state.graphNotice = "Expected path unavailable for the selected context.";
  state.visibleNodeCount = nodes.length;
  const nodeMap = new Map();
  const lanes = laneMap(nodes);
  const maxTrace = Math.max(1, ...nodes.map((n) => n.trace_count || 0));
  const selectedId = state.selected?.id;

  // Compute selected node neighborhood for highlight isolation
  const selectNeighbours = getSelectionNeighborhood(selectedId);

  const resolvedPositions = computeNodePositions(nodes, lanes);

  // Z-bounds calculation
  let minZ = 0;
  let maxZ = 0;
  if (resolvedPositions.size > 0) {
    minZ = Infinity;
    maxZ = -Infinity;
    for (const pos of resolvedPositions.values()) {
      if (pos.z < minZ) minZ = pos.z;
      if (pos.z > maxZ) maxZ = pos.z;
    }
  } else {
    minZ = -1200;
    maxZ = 0;
  }

  const frontBoundary = Math.max(350, maxZ + 100);
  const backBoundary = Math.min(-1200, minZ - 150);
  const bandDepth = frontBoundary - backBoundary;
  const centerZ = (frontBoundary + backBoundary) / 2;

  // Add GridHelper dynamically matching the node bounds
  const gridSize = Math.max(3000, bandDepth);
  const gridDivisions = Math.round(gridSize / 50);
  const scheme = currentScheme();
  const grid = new THREE.GridHelper(gridSize, gridDivisions, scheme.gridMajor, scheme.gridMinor);
  grid.position.set(0, -160, centerZ);
  graphGroup.add(grid);

  nodes.forEach((node, index) => {
    const lane = lanes.get(laneKey(node));
    const depth = depthFor(node);
    const volume = Math.log10((node.trace_count || 0) + 1) / Math.log10(maxTrace + 1);
    const position = resolvedPositions.get(node.id) || new THREE.Vector3(0, 0, 0);
    const mesh = nodeMesh(node, volume, selectNeighbours);
    mesh.position.copy(position);
    mesh.userData = node;
    graphGroup.add(mesh);

    /* Phase 1: smart label visibility */
    if (shouldShowLabel(node, selectNeighbours)) {
      const displayName = nodeDisplayName(node);
      const meta = nodeLabelMeta(node);
      const labelColor = node.id === state.focusedNodeId ? 0x4c9fd8
        : node.kind === "step" ? 0x9aa1a3
        : node.kind === "error" ? 0xc9443c
        : 0xe6e3dc;
      const label = makeLabel(displayName, labelColor, meta);
      label.position.copy(position).add(new THREE.Vector3(0, node.kind === "step" ? 22 : 38, 0));
      graphGroup.add(label);
    }

    nodeMeshes.push(mesh);
    nodeMap.set(node.id, mesh);
    nodePositions.set(node.id, position.clone());
    if (node.id === selectedId) {
      selectedMesh = mesh;
      applySelectedVisual(mesh);
    }
  });

  /* Phase 1: edge filtering with priority */
  const visibleIds = new Set(nodes.map((n) => n.id));
  let edgesToRender = state.graph.edges.filter((e) => shouldShowEdge(e, visibleIds));
  if (state.viewMode === "expected" && state.expectedPath) {
    edgesToRender = state.expectedPath.graph.edges;
  }
  const bundled = bundleEdges(edgesToRender);
  state.visibleEdgeCount = bundled.length;

  for (const edge of bundled) {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) continue;
    graphGroup.add(edgeLine(source.position, target.position, edge, selectNeighbours));
  }

  /* Phase 1: lane floor bands */
  createLaneBands(bandDepth, centerZ, frontBoundary);
  if (state.graphNotice) {
    const notice = makeLabel(state.graphNotice, 0xd8a13a, "expected path");
    notice.position.set(0, 20, -160);
    graphGroup.add(notice);
  }

  renderFilterStatus();
}

/* ──────────────────────────────────────────────────────────────────
   FILTERED NODES (Phase 1: scope-aware)
   ────────────────────────────────────────────────────────────────── */
function filteredNodes() {
  const warningNames = new Set((state.analytics?.anomalies || []).map((a) => a.name).filter(Boolean));
  const graph = state.graph;
  const selectedName = state.filters.name;
  const selectedType = state.filters.type;
  const search = state.filters.q.toLowerCase();
  const stepSearch = state.filters.step.toLowerCase();

  /* Phase 1: start with scope-based visible set instead of all nodes */
  let visibleIds = graphScopeVisibleIds();

  /* Apply filter narrowing on top of scope */
  if (selectedName) {
    const nameIds = relatedNodeIds(selectedName);
    visibleIds = intersectSets(visibleIds, nameIds);
    /* Ensure the focused SP and its neighbourhood are always included */
    for (const id of nameIds) visibleIds.add(id);
  }

  if (selectedType) {
    const matchingProcedures = new Set(
      graph.nodes
        .filter((node) => node.types && Object.prototype.hasOwnProperty.call(node.types, selectedType))
        .map((node) => node.id)
    );
    const typeIds = new Set();
    for (const id of matchingProcedures) {
      for (const related of relatedNodeIds(id)) typeIds.add(related);
    }
    visibleIds = intersectSets(visibleIds, typeIds);
  }

  if (search) {
    const searchIds = new Set();
    for (const node of graph.nodes) {
      const haystack = `${node.id} ${node.label || ""} ${node.kind || ""}`.toLowerCase();
      if (haystack.includes(search)) {
        searchIds.add(node.id);
        if (node.parent) searchIds.add(node.parent);
        for (const related of relatedNodeIds(node.id)) searchIds.add(related);
      }
    }
    visibleIds = intersectSets(visibleIds, searchIds);
  }

  if (stepSearch) {
    const stepIds = new Set();
    for (const node of graph.nodes) {
      const haystack = `${node.id} ${node.label || ""}`.toLowerCase();
      if (haystack.includes(stepSearch)) {
        stepIds.add(node.id);
        if (node.parent) stepIds.add(node.parent);
      }
    }
    visibleIds = intersectSets(visibleIds, stepIds);
  }

  return state.graph.nodes.filter((node) => {
    if (!visibleIds.has(node.id)) return false;
    if (!state.wrongMode) return true;
    return node.kind === "error" || node.kind === "anonymous" || node.kind === "unknown" || warningNames.has(node.id) || warningNames.has(node.parent);
  });
}

/* ──────────────────────────────────────────────────────────────────
   EDGE BUNDLING (Phase 1)
   ────────────────────────────────────────────────────────────────── */
function bundleEdges(edges) {
  const map = new Map();
  for (const edge of edges) {
    const key = `${edge.source}|${edge.target}|${edge.kind}`;
    const existing = map.get(key);
    if (existing) {
      existing.weight = (existing.weight || 1) + (edge.weight || 1);
      existing.count = (existing.count || 1) + 1;
    } else {
      map.set(key, { ...edge, count: 1 });
    }
  }
  return [...map.values()];
}

/* ──────────────────────────────────────────────────────────────────
   LANE BANDS (Phase 1)
   ────────────────────────────────────────────────────────────────── */
function createLaneBands(bandDepth, centerZ, frontBoundary) {
  let laneConfigs = [];

  if (state.viewMode === "workflow") {
    const laneColors = {
      "PROCEDURE": 0x2a3035,
      "WORKFLOW": 0x2d3338,
      "SAP": 0x2f3438,
      "API ERROR": 0x3a2828,
      "INTERNAL STEP": 0x262b2e,
      "TABLE": 0x252a2d,
      "UNKNOWN": 0x302d25,
    };
    const lanes = laneMap();
    for (const [laneName, laneIndex] of lanes.entries()) {
      const x = laneIndex * 190 - (lanes.size - 1) * 95;
      laneConfigs.push({
        name: laneName,
        x: x,
        width: 170,
        color: laneColors[laneName] || 0x252a2d
      });
    }
  } else if (state.viewMode === "steps") {
    laneConfigs = [
      { name: "PROCEDURE STACKS", x: 0, width: 650, color: 0x262b2e },
      { name: "TABLE RUNWAY", x: 380, width: 170, color: 0x252a2d }
    ];
  } else if (state.viewMode === "damage") {
    laneConfigs = [
      { name: "DAMAGED PROCEDURES", x: -200, width: 180, color: 0x3d1d1d },
      { name: "TABLE RUNWAY", x: 0, width: 170, color: 0x252a2d },
      { name: "HEALTHY PROCEDURES", x: 200, width: 180, color: 0x262b2e }
    ];
  } else if (state.viewMode === "expected") {
    laneConfigs = [
      { name: "CALLED PROCEDURES", x: -140, width: 120, color: 0x2a3035 },
      { name: "EXPECTED STEPS", x: 0, width: 120, color: 0x262b2e },
      { name: "TABLE TOUCHES", x: 140, width: 120, color: 0x252a2d }
    ];
  }

  for (const config of laneConfigs) {
    /* Floor band */
    const geometry = new THREE.PlaneGeometry(config.width, bandDepth);
    const material = new THREE.MeshBasicMaterial({
      color: config.color,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
    });
    const plane = new THREE.Mesh(geometry, material);
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(config.x, -158, centerZ);
    graphGroup.add(plane);

    /* Lane label */
    const label = makeLabel(config.name, 0x6a7075);
    label.position.set(config.x, -150, frontBoundary - 50);
    graphGroup.add(label);
  }
}

/* ──────────────────────────────────────────────────────────────────
   POSITIONING
   ────────────────────────────────────────────────────────────────── */
function computeNodePositions(nodes, lanes) {
  const positions = new Map();
  const maxTrace = Math.max(1, ...nodes.map((n) => n.trace_count || 0));

  if (state.viewMode === "expected" && state.expectedPath) {
    const rootName = state.expectedPath.name;
    nodes.forEach(node => {
      if (node.id === rootName) {
        positions.set(node.id, new THREE.Vector3(0, 40, 0)); // Root procedure starts at the front, slightly raised
        return;
      }
      
      let stepOrdinal = 1;
      if (node.kind === "step") {
        stepOrdinal = node.ordinal || parseInt(node.id.split("::expected::")[1]) || parseInt(node.id.split("::step::")[1]) || Number(node.sr_no) || 1;
        // Central runway: X = 0, Y = 0, extending along Z (depth)
        positions.set(node.id, new THREE.Vector3(0, 0, -stepOrdinal * 80));
        return;
      }
      
      // For non-step nodes, find which step connected to them to determine Z alignment
      const parentEdge = state.expectedPath.graph.edges.find(e => e.target === node.id || e.source === node.id);
      if (parentEdge) {
        const stepId = parentEdge.source === node.id ? parentEdge.target : parentEdge.source;
        const stepNode = nodes.find(n => n.id === stepId);
        stepOrdinal = (stepNode && stepNode.ordinal) || parseInt(stepId.split("::expected::")[1]) || parseInt(stepId.split("::step::")[1]) || 1;
      }
      
      const z = -stepOrdinal * 80;
      if (node.kind && node.kind.startsWith("table")) {
        // Tables go to the right
        positions.set(node.id, new THREE.Vector3(140, -40, z));
        return;
      }
      if (node.kind === "procedure" || node.kind === "workflow") {
        // Stored procedure calls go to the left
        positions.set(node.id, new THREE.Vector3(-140, 0, z));
        return;
      }
      
      // Fallback
      positions.set(node.id, new THREE.Vector3(0, 0, z));
    });
    return positions;
  }

  if (state.viewMode === "steps") {
    // 1. Identify all root nodes (procedures, workflows, errors, unknowns, anonymous) and tables
    const roots = [];
    const stepsByParent = new Map();
    const tables = [];

    nodes.forEach(node => {
      if (node.kind === "step") {
        const parentId = node.parent || "unknown_parent";
        if (!stepsByParent.has(parentId)) {
          stepsByParent.set(parentId, []);
        }
        stepsByParent.get(parentId).push(node);
      } else if (node.kind && node.kind.startsWith("table")) {
        tables.push(node);
      } else {
        roots.push(node);
      }
    });

    // Sort roots and tables to be deterministic
    roots.sort((a, b) => (b.trace_count || 0) - (a.trace_count || 0) || a.id.localeCompare(b.id));
    tables.sort((a, b) => (b.trace_count || 0) - (a.trace_count || 0) || a.id.localeCompare(b.id));

    // 2. Position roots in a grid on the floor (Y = -120)
    const cols = 3;
    roots.forEach((root, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const x = (col - (cols - 1) / 2) * 250;
      const z = -50 - row * 250;
      const y = -120;
      positions.set(root.id, new THREE.Vector3(x, y, z));
    });

    // 3. Position steps stacked vertically above their parent root
    stepsByParent.forEach((stepsList, parentId) => {
      // Sort steps by sub_seq_no or sr_no
      stepsList.sort((a, b) => {
        const seqA = Number(a.sub_seq_no || a.sr_no || 0);
        const seqB = Number(b.sub_seq_no || b.sr_no || 0);
        return seqA - seqB;
      });

      const parentPos = positions.get(parentId);
      stepsList.forEach((step, idx) => {
        if (parentPos) {
          // Stack straight up
          positions.set(step.id, new THREE.Vector3(
            parentPos.x,
            parentPos.y + 35 + idx * 25,
            parentPos.z
          ));
        } else {
          // Fallback if parent not found
          positions.set(step.id, new THREE.Vector3(
            350,
            -120 + idx * 25,
            -150
          ));
        }
      });
    });

    // 4. Position tables in a neat lane on the right
    tables.forEach((table, idx) => {
      const x = 380;
      const z = -50 - idx * 70;
      const y = -120;
      positions.set(table.id, new THREE.Vector3(x, y, z));
    });

    return positions;
  }

  if (state.viewMode === "damage") {
    const warningNames = new Set((state.analytics?.anomalies || []).map((a) => a.name).filter(Boolean));
    
    // Helper to check if a procedure is damaged
    function isProcedureDamaged(proc) {
      if (proc.kind === "error" || proc.kind === "anonymous" || proc.kind === "unknown") return true;
      if (warningNames.has(proc.id)) return true;
      return false;
    }

    const damagedProcs = [];
    const healthyProcs = [];
    const stepsByParent = new Map();
    const tables = [];

    nodes.forEach(node => {
      if (node.kind === "step") {
        const parentId = node.parent || "unknown_parent";
        if (!stepsByParent.has(parentId)) {
          stepsByParent.set(parentId, []);
        }
        stepsByParent.get(parentId).push(node);
      } else if (node.kind && node.kind.startsWith("table")) {
        tables.push(node);
      } else {
        if (isProcedureDamaged(node)) {
          damagedProcs.push(node);
        } else {
          healthyProcs.push(node);
        }
      }
    });

    // Sort to be deterministic
    damagedProcs.sort((a, b) => (b.trace_count || 0) - (a.trace_count || 0) || a.id.localeCompare(b.id));
    healthyProcs.sort((a, b) => (b.trace_count || 0) - (a.trace_count || 0) || a.id.localeCompare(b.id));

    // Position Damaged Procedures on the left (X = -160, Y = 0)
    damagedProcs.forEach((proc, idx) => {
      const x = -160;
      const y = 0;
      const z = -50 - idx * 160;
      positions.set(proc.id, new THREE.Vector3(x, y, z));

      // Position their steps further left (X = -240)
      const steps = stepsByParent.get(proc.id) || [];
      steps.sort((a, b) => Number(a.sub_seq_no || a.sr_no || 0) - Number(b.sub_seq_no || b.sr_no || 0));
      steps.forEach((step, sIdx) => {
        positions.set(step.id, new THREE.Vector3(x - 80, y, z - (sIdx + 1) * 35));
      });
    });

    // Position Healthy Procedures on the right (X = 160, Y = 0)
    healthyProcs.forEach((proc, idx) => {
      const x = 160;
      const y = 0;
      const z = -50 - idx * 160;
      positions.set(proc.id, new THREE.Vector3(x, y, z));

      // Position their steps further right (X = 240)
      const steps = stepsByParent.get(proc.id) || [];
      steps.sort((a, b) => Number(a.sub_seq_no || a.sr_no || 0) - Number(b.sub_seq_no || b.sr_no || 0));
      steps.forEach((step, sIdx) => {
        positions.set(step.id, new THREE.Vector3(x + 80, y, z - (sIdx + 1) * 35));
      });
    });

    // Separate tables into affected (connected to damaged) and healthy
    const damagedProcIds = new Set(damagedProcs.map(p => p.id));
    const affectedTables = [];
    const healthyTables = [];

    tables.forEach(table => {
      let isAffected = false;
      for (const e of state.graph.edges) {
        if (e.source === table.id || e.target === table.id) {
          const otherId = e.source === table.id ? e.target : e.source;
          if (damagedProcIds.has(otherId)) {
            isAffected = true;
            break;
          }
          const otherNode = nodes.find(n => n.id === otherId);
          if (otherNode && otherNode.kind === "step" && otherNode.parent && damagedProcIds.has(otherNode.parent)) {
            isAffected = true;
            break;
          }
        }
      }

      if (isAffected) {
        affectedTables.push(table);
      } else {
        healthyTables.push(table);
      }
    });

    // Position Affected Tables in the center (X = 0, Y = 40 - high visibility)
    affectedTables.sort((a, b) => (b.trace_count || 0) - (a.trace_count || 0) || a.id.localeCompare(b.id));
    affectedTables.forEach((table, idx) => {
      positions.set(table.id, new THREE.Vector3(0, 40, -80 - idx * 70));
    });

    // Position Healthy Tables in the center bottom (X = 0, Y = -120)
    healthyTables.sort((a, b) => (b.trace_count || 0) - (a.trace_count || 0) || a.id.localeCompare(b.id));
    healthyTables.forEach((table, idx) => {
      positions.set(table.id, new THREE.Vector3(0, -120, -80 - idx * 70));
    });

    return positions;
  }

  // Workflow mode with semantic rules & collision avoidance
  const laneCenters = new Map();
  const laneCount = lanes.size;
  for (const [laneName, laneIndex] of lanes.entries()) {
    laneCenters.set(laneName, laneIndex * 190 - (laneCount - 1) * 95);
  }

  // Identify direct calls to the focused SP
  const directCalls = new Set();
  if (state.focusedNodeId) {
    for (const e of state.graph.edges) {
      if (e.kind === "calls") {
        if (e.source === state.focusedNodeId) directCalls.add(e.target);
        if (e.target === state.focusedNodeId) directCalls.add(e.source);
      }
    }
  }

  // Separate nodes into three groups to position them in dependencies order:
  // Group 1: SPs, workflows, errors, unknowns
  // Group 2: Steps
  // Group 3: Tables
  const group1 = [];
  const group2 = [];
  const group3 = [];

  for (const node of nodes) {
    if (node.kind === "step") {
      group2.push(node);
    } else if (node.kind && node.kind.startsWith("table")) {
      group3.push(node);
    } else {
      group1.push(node);
    }
  }

  // Placed list for collision avoidance
  const placed = []; // Array of { x, y, z, width, height, depth }

  // Function to place a node using collision avoidance around a target
  function placeNode(node, targetX, targetY, targetZ, searchOptions = {}) {
    const vol = Math.log10((node.trace_count || 0) + 1) / Math.log10(maxTrace + 1);
    const nWidth = node.kind === "step" ? 26 : 46 + vol * 70;
    const nHeight = node.kind === "step" ? 14 : 26 + vol * 32;
    const nDepth = node.kind && node.kind.startsWith("table") ? 38 : 22 + vol * 80;

    let posX = targetX;
    let posY = targetY;
    let posZ = targetZ;
    let found = false;

    // Custom search ranges based on node kind
    const colOffsets = searchOptions.colOffsets || [0, -42, 42];
    const zOffsets = searchOptions.zOffsets || [0, -45, 45, -90, 90];
    const ySearchAttempts = searchOptions.ySearchAttempts || 60;
    const yStep = searchOptions.yStep || 14;

    for (let yAttempt = 0; yAttempt < ySearchAttempts; yAttempt++) {
      // Alternating Y search
      const yOffset = (yAttempt % 2 === 0 ? 1 : -1) * Math.floor((yAttempt + 1) / 2) * yStep;
      const attemptY = targetY + yOffset;

      // Ensure we don't go below the grid floor
      if (attemptY - nHeight * 0.5 < -148) {
        continue;
      }

      for (const xOffset of colOffsets) {
        const attemptX = targetX + xOffset;
        for (const zOffset of zOffsets) {
          const attemptZ = targetZ + zOffset;

          // Check collision with placed nodes
          let collides = false;
          for (const p of placed) {
            const paddingX = Math.max(nWidth, p.width) * 0.5 + 16;
            const paddingY = Math.max(nHeight, p.height) * 0.5 + 12;
            const paddingZ = Math.max(nDepth, p.depth) * 0.5 + 16;

            if (Math.abs(attemptX - p.x) < paddingX &&
                Math.abs(attemptY - p.y) < paddingY &&
                Math.abs(attemptZ - p.z) < paddingZ) {
              collides = true;
              break;
            }
          }

          if (!collides) {
            posX = attemptX;
            posY = attemptY;
            posZ = attemptZ;
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (found) break;
    }

    // Record placement
    const placement = {
      x: posX,
      y: posY,
      z: posZ,
      width: nWidth,
      height: nHeight,
      depth: nDepth
    };
    placed.push(placement);
    positions.set(node.id, new THREE.Vector3(posX, posY, posZ));
  }

  // Position Group 1: SPs, workflows, errors, unknowns
  // Sort them first (focused first, then depth/volume)
  group1.sort((a, b) => {
    if (a.id === state.focusedNodeId) return -1;
    if (b.id === state.focusedNodeId) return 1;
    const depthA = depthFor(a);
    const depthB = depthFor(b);
    if (Math.abs(depthA - depthB) > 0.01) {
      return depthA - depthB;
    }
    const volA = a.trace_count || 0;
    const volB = b.trace_count || 0;
    return volB - volA;
  });

  for (const node of group1) {
    const laneName = laneKey(node);
    const laneCenter = laneCenters.get(laneName) || 0;
    const vol = Math.log10((node.trace_count || 0) + 1) / Math.log10(maxTrace + 1);

    let targetX = laneCenter;
    let targetY = -80 + vol * 360;
    let targetZ = depthFor(node) * -120;
    if (depthFor(node) === 0) {
      const hash = hashNumber(node.id);
      targetZ = -(hash % 4) * 60;
    }

    if (node.id === state.focusedNodeId) {
      // Focused SP: Y = 20, Z = -150, centered in lane
      targetY = 20;
      targetZ = -150;
    } else if (directCalls.has(node.id)) {
      // Direct Calls: Y >= 120, Z = -320
      targetY = 120;
      targetZ = -320;
    } else if (node.kind === "error") {
      // Errors: Y >= 120, Z = -150
      targetY = 120;
      targetZ = -150;
    } else if (node.kind === "anonymous" || node.kind === "unknown") {
      // Unknowns: X = 570, Y = -80, Z = -350
      targetX = 570;
      targetY = -80;
      targetZ = -350;
    }

    placeNode(node, targetX, targetY, targetZ);
  }

  // Position Group 2: Steps
  // Sort by sub_seq_no or sr_no
  group2.sort((a, b) => {
    const seqA = Number(a.sub_seq_no || a.sr_no || 0);
    const seqB = Number(b.sub_seq_no || b.sr_no || 0);
    return seqA - seqB;
  });

  for (const node of group2) {
    const laneName = "INTERNAL STEP";
    const laneCenter = laneCenters.get(laneName) || 190;

    // Get parent position
    const parentPos = positions.get(node.parent);
    let targetY = -80;
    let parentZ = -150;
    if (parentPos) {
      targetY = parentPos.y;
      parentZ = parentPos.z;
    }

    // Ordered rail along Z-axis: targetZ = parentZ - offset
    const offset = Number(node.sub_seq_no || node.sr_no || 1) * 35;
    const targetZ = parentZ - offset;

    // Offset step X based on parent hash to create distinct, non-overlapping sub-rails
    const parentHash = hashNumber(node.parent || "");
    const stepX = laneCenter + ((parentHash % 3) - 1) * 35;

    // Steps form a clean rail, keeping targetY and targetZ exactly
    placeNode(node, stepX, targetY, targetZ, {
      colOffsets: [0],
      zOffsets: [0],
      ySearchAttempts: 1,
    });
  }

  // Position Group 3: Tables
  // Sort tables by trace volume and ID to make the layout deterministic
  group3.sort((a, b) => {
    const volA = a.trace_count || 0;
    const volB = b.trace_count || 0;
    if (volB !== volA) return volB - volA;
    return a.id.localeCompare(b.id);
  });

  // Lay out tables in a structured dual-runway grid in the TABLE lane
  group3.forEach((node, index) => {
    const laneName = "TABLE";
    const laneCenter = laneCenters.get(laneName) || 380;

    // 2 staggered columns in the TABLE lane
    const colIndex = index % 2; // 0, 1
    const rowIndex = Math.floor(index / 2);

    // Compute X: distribute across left/right of the lane Center
    const x = laneCenter + (colIndex === 0 ? -45 : 45);

    // Compute Z: staggered along depth
    const staggerZ = colIndex === 1 ? -60 : 0;
    const z = -50 - rowIndex * 120 + staggerZ;

    // Compute Y: consistent float above ground
    const y = -130;

    positions.set(node.id, new THREE.Vector3(x, y, z));
  });

  return positions;
}

function positionForNode(node, index, lane, laneCount, volume, depth) {
  // Deprecated - computeNodePositions is now used.
  return new THREE.Vector3(0,0,0);
}

function hashNumber(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return hash;
}

function relatedNodeIds(rootId) {
  const ids = new Set([rootId]);
  for (const edge of state.graph.edges) {
    if (edge.source === rootId) ids.add(edge.target);
    if (edge.target === rootId) ids.add(edge.source);
  }
  for (const node of state.graph.nodes) {
    if (node.parent === rootId) {
      ids.add(node.id);
    }
  }
  return ids;
}

function intersectSets(left, right) {
  return new Set([...left].filter((item) => right.has(item)));
}

function filteredEdges(nodeMap) {
  return state.graph.edges.filter((edge) => nodeMap.has(edge.source) && nodeMap.has(edge.target));
}

/* Phase 1: stable lane ordering */
function laneKey(node) {
  if (node.kind === "error") return "API ERROR";
  if (node.kind === "workflow") return "WORKFLOW";
  if (node.kind === "step") return "INTERNAL STEP";
  if (node.kind && node.kind.startsWith("table")) return "TABLE";
  if (node.kind === "anonymous" || node.kind === "unknown") return "UNKNOWN";
  if (node.id.includes("SAP")) return "SAP";
  return "PROCEDURE";
}

function laneMap(nodes) {
  /* Phase 1: use fixed lane order, but only include lanes that have at least one visible node */
  if (!nodes || nodes.length === 0) {
    return new Map(LANE_ORDER.map((lane, index) => [lane, index]));
  }
  const populatedLanes = new Set(nodes.map(n => laneKey(n)));
  const filtered = LANE_ORDER.filter(lane => populatedLanes.has(lane));
  return new Map(filtered.map((lane, index) => [lane, index]));
}

function depthFor(node) {
  if (node.kind === "step") return 2 + Math.min(4, Number(node.sub_seq_no || 1) / 6);
  if (node.kind && node.kind.startsWith("table")) return 4;
  if (node.kind === "error") return 1.5;
  return 0;
}

/* ──────────────────────────────────────────────────────────────────
   NODE COLORS & MESH
   ────────────────────────────────────────────────────────────────── */
function colorFor(node) {
  const scheme = currentScheme();
  if (state.viewMode === "expected" && state.activeRun && state.activeRun.delta && node.kind === "step") {
    const ordinal = parseInt(node.id.split("::expected::")[1]);
    const isMissing = state.activeRun.delta.details?.missing?.some(m => m.ordinal === ordinal);
    if (isMissing) return scheme.error;
    return 0x4aa252; // Green for present
  }

  if (state.selected?.id === node.id) return scheme.selected;
  if (node.id === state.focusedNodeId) return scheme.focus;
  const selectedName = state.filters.name;
  if (selectedName && (node.id === selectedName || node.parent === selectedName)) return scheme.focus;
  if (node.kind === "error") return scheme.error;
  if (node.kind === "anonymous" || node.kind === "unknown") return scheme.unknown;
  if (node.kind === "workflow") return scheme.workflow;
  if (node.kind === "step") return scheme.step;
  if (node.kind && node.kind.startsWith("table")) return scheme.table;
  return scheme.procedure;
}

function nodeMesh(node, volume, selectNeighbours) {
  const visualWeight = Math.sqrt(Math.max(0, Math.min(1, volume)));
  const width = node.kind === "step" ? 30 : 42 + visualWeight * 48;
  const height = node.kind === "step" ? 12 : 24 + visualWeight * 22;
  const depth = node.kind && node.kind.startsWith("table") ? 34 : 22 + visualWeight * 46;
  const geometry = geometryForNode(node, width, height, depth);
  const isFocused = node.id === state.focusedNodeId;
  const isSelected = state.selected?.id === node.id;

  const selectedId = state.selected?.id;
  const inNeighborhood = !selectedId || (selectNeighbours && selectNeighbours.has(node.id));
  
  const baseColor = colorFor(node);
  let color = new THREE.Color(baseColor);
  let opacity = 1.0;

  if (selectedId && !inNeighborhood) {
    opacity = 0.15;
    color.lerp(new THREE.Color(0x222222), 0.7); // Desaturate and darken
  }

  const material = new THREE.MeshStandardMaterial({
    color: color,
    roughness: 0.85,
    metalness: 0.08,
    transparent: opacity < 1.0,
    opacity: opacity,
    emissive: isSelected ? 0x5d6a70 : isFocused ? 0x1a3a55 : 0x000000,
    emissiveIntensity: isSelected ? 0.9 : (isFocused && inNeighborhood) ? 0.5 : 0,
  });
  const mesh = new THREE.Mesh(geometry, material);
  const outline = new THREE.EdgesGeometry(geometry);
  const edgeColor = isSelected ? 0xffffff : (isFocused ? 0x4c9fd8 : 0x111111);
  const line = new THREE.LineSegments(outline, new THREE.LineBasicMaterial({
    color: edgeColor,
    transparent: opacity < 1.0,
    opacity: opacity
  }));
  mesh.add(line);
  return mesh;
}

function geometryForNode(node, width, height, depth) {
  if (node.kind === "workflow") return new THREE.CylinderGeometry(width * 0.45, width * 0.45, Math.max(height, 34), 12);
  if (node.kind === "error") return new THREE.ConeGeometry(width * 0.48, Math.max(height * 1.3, 38), 4);
  if (node.kind === "step") return new THREE.BoxGeometry(width, height, depth);
  if (node.kind === "table_write") return new THREE.CylinderGeometry(width * 0.55, width * 0.55, 16, 6);
  if (node.kind === "table_update") return new THREE.CylinderGeometry(width * 0.52, width * 0.52, 14, 4);
  if (node.kind === "table_read") return new THREE.BoxGeometry(width * 1.25, 10, depth * 0.9);
  if (node.kind === "anonymous" || node.kind === "unknown") return new THREE.OctahedronGeometry(Math.max(width, height, depth) * 0.45);
  return new THREE.BoxGeometry(width, height, depth);
}

/* Phase 1: subtle selection marker — no oversized beacon */
function applySelectedVisual(mesh) {
  mesh.scale.set(1.06, 1.06, 1.06);
  mesh.material.color.setHex(0xf2f2ef);
  mesh.material.emissive.setHex(0x4c9fd8);
  mesh.material.emissiveIntensity = 0.6;

  const params = mesh.geometry.parameters || {};
  const w = (params.width || params.radiusTop * 2 || 50) + 12;
  const h = (params.height || 30) + 12;
  const d = (params.depth || 40) + 12;

  /* Thin white outline ring */
  const ringGeom = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d));
  const ring = new THREE.LineSegments(ringGeom, new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.85,
  }));
  mesh.add(ring);

  /* Small base ring */
  const baseRing = new THREE.RingGeometry(Math.max(w, d) * 0.35, Math.max(w, d) * 0.42, 24);
  const baseMat = new THREE.MeshBasicMaterial({ color: 0x4c9fd8, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
  const base = new THREE.Mesh(baseRing, baseMat);
  base.rotation.x = -Math.PI / 2;
  base.position.y = -(h * 0.5 + 2);
  mesh.add(base);

  /* Subtle vertical accent line (not a 160-unit beacon) */
  const accentGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, h * 0.6, 0),
    new THREE.Vector3(0, h * 0.6 + 35, 0),
  ]);
  const accent = new THREE.Line(accentGeom, new THREE.LineBasicMaterial({
    color: 0x4c9fd8,
    transparent: true,
    opacity: 0.4,
  }));
  mesh.add(accent);
}

/* ──────────────────────────────────────────────────────────────────
   EDGE LINE (Phase 1: semantic styles)
   ────────────────────────────────────────────────────────────────── */
function edgeLine(a, b, edge, selectNeighbours) {
  const geometry = new THREE.BufferGeometry().setFromPoints([a, b]);
  const priority = edgePriority(edge);
  const scheme = currentScheme();
  let color, opacity;

  const selectedId = state.selected?.id;
  const isConnected = selectedId && (
    edge.source === selectedId || 
    edge.target === selectedId ||
    (selectNeighbours && selectNeighbours.has(edge.source) && selectNeighbours.has(edge.target))
  );

  if (edge.kind === "writes" || edge.kind === "updates") {
    color = isConnected ? scheme.warning : scheme.writeEdge;
    opacity = isConnected ? 1.0 : 0.75;
  } else if (edge.kind === "calls") {
    color = isConnected ? scheme.selected : scheme.callEdge;
    opacity = isConnected ? 1.0 : 0.65;
  } else if (edge.kind === "reads") {
    color = isConnected ? scheme.focus : scheme.readEdge;
    opacity = isConnected ? 1.0 : 0.35;
  } else if (edge.kind === "static_step") {
    color = isConnected ? 0x88ff88 : scheme.staticEdge;
    opacity = isConnected ? 1.0 : 0.25;
  } else if (edge.kind === "error") {
    color = scheme.error;
    opacity = isConnected ? 1.0 : 0.8;
  } else {
    color = isConnected ? scheme.selected : scheme.readEdge;
    opacity = isConnected ? 1.0 : 0.5;
  }

  if (selectedId) {
    if (!isConnected) {
      opacity = 0.04; // Extremely dimmed
    }
  } else {
    /* Brighten edges connected to focused */
    const focusId = state.focusedNodeId;
    if (edge.source === focusId || edge.target === focusId) {
      opacity = Math.min(1.0, opacity + 0.3);
    }
  }

  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  const line = new THREE.Line(geometry, material);
  line.userData = edge;
  return line;
}

/* ──────────────────────────────────────────────────────────────────
   LABELS
   ────────────────────────────────────────────────────────────────── */
function makeLabel(text, color, meta = "") {
  const title = truncate(text, 38);
  const sub = truncate(meta, 42);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const cssWidth = 360;
  const cssHeight = sub ? 74 : 54;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cssWidth * pixelRatio);
  canvas.height = Math.round(cssHeight * pixelRatio);
  const ctx = canvas.getContext("2d");
  ctx.scale(pixelRatio, pixelRatio);
  ctx.fillStyle = "rgba(13,14,15,0.84)";
  roundRect(ctx, 0, 0, cssWidth, cssHeight, 8);
  ctx.fill();
  ctx.strokeStyle = "rgba(180,190,194,0.34)";
  ctx.lineWidth = 1.5;
  roundRect(ctx, 0.75, 0.75, cssWidth - 1.5, cssHeight - 1.5, 8);
  ctx.stroke();
  ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  ctx.fillRect(0, 0, 5, cssHeight);
  ctx.font = "700 18px Consolas, Courier New, monospace";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  ctx.fillText(title, 16, sub ? 30 : 36);
  if (sub) {
    ctx.font = "13px Consolas, Courier New, monospace";
    ctx.fillStyle = "#a7aaa9";
    ctx.fillText(sub, 16, 56);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = maxTextureAnisotropy;
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 1000;
  sprite.scale.set(cssWidth * 0.42, cssHeight * 0.42, 1);
  return sprite;
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/* ──────────────────────────────────────────────────────────────────
   POINTER / HOVER / SELECT
   ────────────────────────────────────────────────────────────────── */
function selectGraphNode(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(nodeMeshes, false);
  
  if (!hits.length) {
    // Clicked empty background: clear selection
    if (state.selected) {
      state.selected = null;
      selectedMesh = null;
      renderGraph();
    }
    return;
  }
  
  selectedMesh = hits[0].object;
  const node = selectedMesh.userData;
  state.selected = node;
  renderGraph();

  // Switch tab to evidence inside drawer if it's already open or when opened later
  document.querySelectorAll(".drawer-mode-button").forEach((btn) => btn.classList.remove("active"));
  document.querySelectorAll(".drawer-panel").forEach((panel) => panel.classList.remove("active"));
  const evBtn = document.querySelector('.drawer-mode-button[data-mode="evidence"]');
  if (evBtn) evBtn.classList.add("active");
  const evPanel = $("drawer-evidence");
  if (evPanel) evPanel.classList.add("active");
  state.drawerMode = "evidence";

  populateDrawerNodeEvidence(node);
}

function onCanvasDoubleClick(event) {
  event.preventDefault();
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(nodeMeshes, false);
  
  if (hits.length) {
    const node = hits[0].object.userData;
    cameraTarget.copy(hits[0].object.position);
    updateCamera();
    inspectNode(node);
  }
}

async function populateDrawerNodeEvidence(node) {
  const evContent = $("drawer-evidence-content");
  if (!evContent) return;

  const basicMeta = {
    id: node.id,
    kind: node.kind,
    roles: node.roles,
    shape: shapeName(node),
    traces: node.trace_count,
    log_refs: node.log_ref_count,
    sr_no: node.sr_no,
    sub_seq_no: node.sub_seq_no,
    importance: node.importance,
    severity: node.severity,
    lane: node.lane,
  };

  evContent.textContent = "Loading node evidence...";

  let detailedEvidence = {};

  if (node.kind === "step") {
    detailedEvidence = {
      meaning: "Static expected log point parsed from stored procedure text.",
      selected_step: node,
      matching_visible_events: state.events.filter((event) => event.name === node.parent && (!node.sr_no || event.sr_no === node.sr_no) && (!node.sub_seq_no || event.sub_seq_no === node.sub_seq_no)).slice(0, 20),
    };
  } else if (node.kind?.startsWith("table")) {
    detailedEvidence = {
      meaning: "Table/entity node from parsed SP reads/writes/updates. It is not a stored procedure.",
      table: node.label,
      roles: node.roles || [node.kind],
      related_edges: incidentEdges(node.id).slice(0, 80),
      related_procedures: relatedProcedureIds(node.id),
    };
  } else if (node.kind === "anonymous" || node.kind === "unknown") {
    detailedEvidence = {
      meaning: "Trace source that exists in SQL logs but has weak/no static SP mapping.",
      node,
      recent_visible_events: state.events.filter((event) => (event.name || "<anonymous>") === node.id).slice(0, 20),
    };
  } else {
    try {
      const detail = await api(`/api/workflows/${encodeURIComponent(node.id)}`);
      detailedEvidence = {
        procedure: detail.procedure ? {
          log_ref_count: detail.procedure.log_ref_count,
          calls: detail.procedure.calls,
          reads: detail.procedure.reads.slice(0, 20),
          inserts: detail.procedure.inserts,
          updates: detail.procedure.updates.slice(0, 20),
          steps: detail.procedure.steps.slice(0, 20),
        } : null,
        recent_events: detail.events.slice(0, 10),
      };
    } catch {
      detailedEvidence = { error: "Failed to fetch workflow details", node };
    }
  }

  evContent.textContent = JSON.stringify({
    metadata: basicMeta,
    evidence: detailedEvidence
  }, null, 2);
}

/* Phase 1: hover interaction — show tooltip without opening modal */
function handleHover(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  const px = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  const py = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(new THREE.Vector2(px, py), camera);
  const hits = raycaster.intersectObjects(nodeMeshes, false);
  const tooltip = $("hover-tooltip");

  if (hits.length) {
    renderer.domElement.style.cursor = "pointer";
    const node = hits[0].object.userData;
    const prevHovered = state.hoveredNodeId;
    state.hoveredNodeId = node.id;

    /* Show tooltip */
    const displayName = nodeDisplayName(node);
    const kind = node.kind || "unknown";
    const traces = node.trace_count ? ` | ${compact(node.trace_count)} traces` : "";
    tooltip.textContent = `${displayName} [${kind}]${traces}`;
    tooltip.hidden = false;
    tooltip.style.left = `${event.clientX - rect.left + 14}px`;
    tooltip.style.top = `${event.clientY - rect.top - 8}px`;

    /* Re-render if hovered node changed (for smart label visibility) */
    if (prevHovered !== node.id) {
      renderGraph();
    }
  } else {
    renderer.domElement.style.cursor = "grab";
    if (state.hoveredNodeId) {
      state.hoveredNodeId = "";
      tooltip.hidden = true;
      renderGraph();
    }
  }
}

async function inspectNode(node) {
  state.selected = node;
  openModal("Inspector");
  $("inspect-title").textContent = node.label || node.id;
  $("inspect-meta").innerHTML = kvHtml({
    id: node.id,
    kind: node.kind,
    roles: (node.roles || []).join(", "),
    shape: shapeName(node),
    traces: compact(node.trace_count),
    log_refs: node.log_ref_count,
    sr_no: node.sr_no,
    sub_seq_no: node.sub_seq_no,
    importance: node.importance != null ? (node.importance * 100).toFixed(0) + "%" : undefined,
    severity: node.severity,
    lane: node.lane,
  });
  if (node.kind === "step") {
    $("inspect-evidence").textContent = JSON.stringify({
      meaning: "Static expected log point parsed from stored procedure text.",
      selected_step: node,
      matching_visible_events: state.events.filter((event) => event.name === node.parent && (!node.sr_no || event.sr_no === node.sr_no) && (!node.sub_seq_no || event.sub_seq_no === node.sub_seq_no)).slice(0, 20),
    }, null, 2);
    return;
  }
  if (node.kind?.startsWith("table")) {
    $("inspect-evidence").textContent = JSON.stringify({
      meaning: "Table/entity node from parsed SP reads/writes/updates. It is not a stored procedure.",
      table: node.label,
      roles: node.roles || [node.kind],
      related_edges: incidentEdges(node.id).slice(0, 80),
      related_procedures: relatedProcedureIds(node.id),
    }, null, 2);
    return;
  }
  if (node.kind === "anonymous" || node.kind === "unknown") {
    $("inspect-evidence").textContent = JSON.stringify({
      meaning: "Trace source that exists in SQL logs but has weak/no static SP mapping.",
      node,
      recent_visible_events: state.events.filter((event) => (event.name || "<anonymous>") === node.id).slice(0, 20),
    }, null, 2);
    return;
  }
  try {
    const detail = await api(`/api/workflows/${encodeURIComponent(node.id)}`);
    $("inspect-evidence").textContent = JSON.stringify({
      procedure: detail.procedure ? {
        log_ref_count: detail.procedure.log_ref_count,
        calls: detail.procedure.calls,
        reads: detail.procedure.reads.slice(0, 20),
        inserts: detail.procedure.inserts,
        updates: detail.procedure.updates.slice(0, 20),
        steps: detail.procedure.steps.slice(0, 20),
      } : null,
      recent_events: detail.events.slice(0, 10),
    }, null, 2);
  } catch {
    $("inspect-evidence").textContent = JSON.stringify(node, null, 2);
  }
}

function shapeName(node) {
  if (node.kind === "workflow") return "cylinder";
  if (node.kind === "error") return "pyramid";
  if (node.kind === "step") return "thin block";
  if (node.kind === "table_write") return "hex slab";
  if (node.kind === "table_update") return "diamond slab";
  if (node.kind === "table_read") return "flat slab";
  if (node.kind === "anonymous" || node.kind === "unknown") return "octahedron";
  return "box";
}

function incidentEdges(id) {
  return state.graph.edges.filter((edge) => edge.source === id || edge.target === id);
}

function relatedProcedureIds(id) {
  const ids = new Set();
  for (const edge of incidentEdges(id)) {
    const other = edge.source === id ? edge.target : edge.source;
    const node = state.graph.nodes.find((item) => item.id === other);
    if (node && ["procedure", "workflow", "error"].includes(node.kind)) ids.add(other);
  }
  return [...ids].sort();
}

/* ──────────────────────────────────────────────────────────────────
   MODALS
   ────────────────────────────────────────────────────────────────── */
function openModal(kicker) {
  $("modal-kicker").textContent = kicker;
  $("modal-backdrop").hidden = false;
}

function closeModal() {
  $("modal-backdrop").hidden = true;
}

/* Phase 1: Map Key modal (replaces permanent left-rail legend) */
function openMapKeyModal() {
  openModal("Map Key");
  $("inspect-title").textContent = "Graph Color & Shape Legend";
  $("inspect-meta").innerHTML = "";
  $("inspect-evidence").innerHTML = `
<div class="map-key-grid">
  <div class="map-key-section">
    <h3>Colors</h3>
    <div class="map-key-item"><span class="map-key-swatch" style="background:#9aa1a3"></span> Known SP path</div>
    <div class="map-key-item"><span class="map-key-swatch" style="background:#e6e3dc"></span> Workflow SP</div>
    <div class="map-key-item"><span class="map-key-swatch" style="background:#4c9fd8"></span> Focused / filtered</div>
    <div class="map-key-item"><span class="map-key-swatch" style="background:#f2f2ef"></span> Selected</div>
    <div class="map-key-item"><span class="map-key-swatch" style="background:#c9443c"></span> Error / API path</div>
    <div class="map-key-item"><span class="map-key-swatch" style="background:#d8a13a"></span> Anonymous / unknown</div>
    <div class="map-key-item"><span class="map-key-swatch" style="background:#657073"></span> Table / entity</div>
    <div class="map-key-item"><span class="map-key-swatch" style="background:#8d9698"></span> Internal step</div>
  </div>
  <div class="map-key-section">
    <h3>Shapes</h3>
    <div class="map-key-item">▪ Box = normal SP</div>
    <div class="map-key-item">⬬ Cylinder = workflow SP</div>
    <div class="map-key-item">▲ Pyramid = error/API path</div>
    <div class="map-key-item">▭ Thin block = internal step</div>
    <div class="map-key-item">▬ Flat slab = table read</div>
    <div class="map-key-item">⬡ Hex slab = table write</div>
    <div class="map-key-item">◇ Diamond = table update</div>
    <div class="map-key-item">◆ Octahedron = unknown/anonymous</div>
  </div>
  <div class="map-key-section">
    <h3>Edges</h3>
    <div class="map-key-item"><span class="map-key-swatch" style="background:#e6e3dc"></span> Calls (SP → SP)</div>
    <div class="map-key-item"><span class="map-key-swatch" style="background:#d8a13a"></span> Writes / Updates (SP → Table)</div>
    <div class="map-key-item"><span class="map-key-swatch" style="background:#555b5f"></span> Reads (Table → SP)</div>
    <div class="map-key-item"><span class="map-key-swatch" style="background:#3f464a"></span> Step of (SP → Step)</div>
  </div>
  <div class="map-key-section">
    <h3>Lanes (X axis)</h3>
    <div class="map-key-item">PROCEDURE → WORKFLOW → SAP → ERROR → STEP → TABLE → UNKNOWN</div>
  </div>
  <div class="map-key-section">
    <h3>Axes</h3>
    <div class="map-key-item">X = semantic lane | Y = trace volume | Z = internal depth</div>
  </div>
</div>`;
}

function kvHtml(obj) {
  return Object.entries(obj)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `<div>${escapeHtml(key)}</div><div>${escapeHtml(fmt(value))}</div>`)
    .join("");
}

/* ──────────────────────────────────────────────────────────────────
   CAMERA
   ────────────────────────────────────────────────────────────────── */
function resizeGraph() {
  const frame = document.querySelector(".graph-frame");
  const w = frame.clientWidth;
  const h = frame.clientHeight;
  if (!w || !h) return;
  if (!referenceGraphHeight || h > referenceGraphHeight) {
    referenceGraphHeight = h;
  }
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const heightRatio = clamp(h / referenceGraphHeight, 0.35, 1);
  const baseFov = THREE.MathUtils.degToRad(BASE_CAMERA_FOV);
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(baseFov / 2) * heightRatio));
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}

function onPointerDown(event) {
  dragState = {
    x: event.clientX,
    y: event.clientY,
    theta: cameraSpherical.theta,
    phi: cameraSpherical.phi,
    target: cameraTarget.clone(),
    shift: event.shiftKey,
    button: event.button,
    moved: false,
  };
  renderer.domElement.setPointerCapture(event.pointerId);

  const isPanning = event.button === 1 || event.button === 2 || (event.button === 0 && event.shiftKey);
  if (isPanning) {
    renderer.domElement.style.cursor = "move";
  } else if (event.button === 0) {
    renderer.domElement.style.cursor = "grabbing";
  }
}

function onPointerMove(event) {
  if (!dragState) {
    /* Phase 1: hover detection when not dragging */
    handleHover(event);
    return;
  }
  const dx = event.clientX - dragState.x;
  const dy = event.clientY - dragState.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) dragState.moved = true;

  const isPanning = dragState.button === 1 || dragState.button === 2 || (dragState.button === 0 && dragState.shift);

  if (isPanning) {
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    camera.matrix.extractBasis(right, up, new THREE.Vector3());
    const scale = cameraSpherical.radius * 0.0012;
    cameraTarget.copy(dragState.target)
      .addScaledVector(right, -dx * scale)
      .addScaledVector(up, dy * scale);
  } else if (dragState.button === 0) {
    cameraSpherical.theta = dragState.theta - dx * 0.006;
    cameraSpherical.phi = clamp(dragState.phi + dy * 0.006, 0.08, Math.PI - 0.08);
  }
  updateCamera();
}

function onPointerUp(event) {
  const shouldSelect = dragState && !dragState.moved && dragState.button === 0 && !dragState.shift;
  dragState = null;
  if (shouldSelect && event) selectGraphNode(event);

  if (event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(nodeMeshes, false);
    if (hits.length) {
      renderer.domElement.style.cursor = "pointer";
    } else {
      renderer.domElement.style.cursor = "grab";
    }
  } else {
    renderer.domElement.style.cursor = "grab";
  }
}

function onWheel(event) {
  event.preventDefault();
  const factor = event.deltaY * 0.001;
  cameraSpherical.radius = clamp(cameraSpherical.radius * (1 + factor), 220, 2600);
  updateCamera();
}

function resetCamera() {
  if (state.selected) {
    const mesh = nodeMeshes.find(m => m.userData.id === state.selected.id);
    if (mesh) {
      cameraTarget.copy(mesh.position);
      setCamera(600, cameraSpherical.theta, cameraSpherical.phi);
      return;
    }
  }
  if (state.focusedNodeId) {
    const mesh = nodeMeshes.find(m => m.userData.id === state.focusedNodeId);
    if (mesh) {
      cameraTarget.copy(mesh.position);
      setCamera(700, cameraSpherical.theta, cameraSpherical.phi);
      return;
    }
  }
  cameraTarget = new THREE.Vector3(0, 0, -120);
  setCamera(900, 0, 1.1);
}

function setCamera(radius, theta, phi) {
  cameraSpherical = { radius, theta, phi };
  updateCamera();
}

function updateCamera() {
  if (!camera) return;
  const { radius, theta, phi } = cameraSpherical;
  camera.position.set(
    cameraTarget.x + radius * Math.sin(phi) * Math.sin(theta),
    cameraTarget.y + radius * Math.cos(phi),
    cameraTarget.z + radius * Math.sin(phi) * Math.cos(theta)
  );
  camera.lookAt(cameraTarget);
  camera.updateMatrixWorld();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/* ──────────────────────────────────────────────────────────────────
   FILTER STATUS / OVERLAY (Phase 1: investigation context)
   ────────────────────────────────────────────────────────────────── */
function renderFilterStatus() {
  const scopeLabels = { focused: "Focused SP", selected: "Selected SP", neighbourhood: "Neighbourhood", all: "All System" };
  const scopeLabel = scopeLabels[state.graphScope] || state.graphScope;

  const title = $("graph-overlay-title");
  const info = $("graph-overlay-info");
  if (!title || !info) return;

  const focusName = state.focusedNodeId ? nodeDisplayName(
    state.graph.nodes.find((n) => n.id === state.focusedNodeId) || { id: state.focusedNodeId }
  ) : "";

  if (state.activeRun) {
    title.textContent = `Selected Run - ${cleanObjectName(state.activeRun.name || state.filters.name || "trace")}`;
  } else if (state.graphNotice) {
    title.textContent = "Expected Path";
  } else if (focusName && (state.filters.name || state.graphScope !== "all")) {
    title.textContent = `${scopeLabel} - ${focusName}`;
  } else {
    title.textContent = scopeLabel;
  }

  if (state.graphNotice) {
    info.textContent = state.graphNotice;
    return;
  }

  var overlayParts = [
    `${state.visibleNodeCount} nodes`,
    `${state.visibleEdgeCount} edges`,
    state.filters.source === "sql" ? "LIVE SQL" : "Cache",
  ];
  if (state.activeRun) overlayParts.push("SELECTED RUN EVIDENCE", "GRAPH=SP CONTEXT");
  if (state.wrongMode) overlayParts.push("DAMAGE FILTER");
  if (state.filters.name) overlayParts.push(`SP=${cleanObjectName(state.filters.name)}`);
  if (state.filters.type) overlayParts.push(`TYPE=${state.filters.type}`);
  if (state.filters.start || state.filters.end) overlayParts.push("TIME WINDOW");
  const hiddenForOverlay = state.graph.nodes.length - state.visibleNodeCount;
  if (hiddenForOverlay > 0) overlayParts.push(`${hiddenForOverlay} hidden`);
  info.textContent = overlayParts.join(" | ");
}

/* ──────────────────────────────────────────────────────────────────
   ANALYTICS / EVENTS / RUNTIME
   ────────────────────────────────────────────────────────────────── */
function scopedDiagnosisList() {
  const globalList = state.analytics?.diagnosis || [];
  if (!state.wrongMode) return globalList;

  const scoped = [];
  const deltaDiag = playbackDeltaDiagnosis();
  if (deltaDiag) scoped.push(deltaDiag);
  if (state.selectedRunId) return scoped;
  if (!hasActiveFilterContext()) return globalList;

  for (const diag of globalList) {
    if (diagnosisMatchesScope(diag)) scoped.push(diag);
  }
  return scoped;
}

function playbackDeltaDiagnosis() {
  const playback = state.playbackData;
  if (!playback) return null;
  const delta = playback.delta || {};
  const missing = Number(delta.missing_count || 0);
  const unexpected = Number(delta.unexpected_count || 0);
  if (playback.expected_unavailable) {
    return {
      id: "scoped-expected-unavailable",
      severity: "medium",
      title: "Expected Path Unavailable",
      object_id: state.activeRun?.name || state.filters.name || "selected context",
      object_kind: state.selectedRunId ? "run" : "procedure",
      reason: "Expected path unavailable for this scoped context.",
      primary_evidence: { run_id: state.selectedRunId, name: state.activeRun?.name || state.filters.name, type: state.activeRun?.type || state.filters.type },
      next_action: "Map stored-procedure log points before comparing playback",
      focus_node_ids: [state.activeRun?.name || state.filters.name].filter(Boolean),
    };
  }
  if (missing === 0 && unexpected === 0) return null;
  return {
    id: `scoped-playback-delta-${state.selectedRunId || "filters"}`,
    severity: missing || unexpected ? "high" : "low",
    title: "Expected Path Delta",
    object_id: state.selectedRunId || state.filters.name || "filtered trace",
    object_kind: state.selectedRunId ? "run" : "procedure",
    reason: `${missing} expected steps missing and ${unexpected} unexpected trace rows in the active scope.`,
    primary_evidence: {
      run_id: state.selectedRunId,
      name: state.activeRun?.name || state.filters.name,
      type: state.activeRun?.type || state.filters.type,
      delta,
      missing_expected: (playback.missing_expected || []).slice(0, 10),
      unexpected_actual: (playback.unexpected_actual || []).slice(0, 10),
    },
    next_action: "Review the missing expected steps against the actual trace rows",
    focus_node_ids: [state.activeRun?.name || state.filters.name].filter(Boolean),
  };
}

function diagnosisMatchesScope(diag) {
  const evidence = diag.primary_evidence || {};
  const text = JSON.stringify({ diag, evidence }).toLowerCase();
  const diagName = evidence.name || diag.object_id || "";
  const diagType = evidence.type || "";
  if (state.filters.name && diagName !== state.filters.name) return false;
  if (state.filters.type && diagType && diagType !== state.filters.type) return false;
  if (state.filters.sr_no && String(evidence.sr_no ?? "") !== String(state.filters.sr_no)) return false;
  if (state.filters.sub_seq_no && String(evidence.sub_seq_no ?? "") !== String(state.filters.sub_seq_no)) return false;
  if (state.filters.step && !text.includes(state.filters.step.toLowerCase())) return false;
  if (state.filters.q && !text.includes(state.filters.q.toLowerCase())) return false;
  const evidenceTime = evidence.entry_datetime || evidence.last_seen || evidence.first_seen || "";
  if (evidenceTime) {
    const time = Date.parse(String(evidenceTime).replace(" ", "T"));
    if (state.filters.start && !Number.isNaN(time) && time < Date.parse(state.filters.start.replace(" ", "T"))) return false;
    if (state.filters.end && !Number.isNaN(time) && time > Date.parse(state.filters.end.replace(" ", "T"))) return false;
  }
  return true;
}

function renderAnalytics() {
  const diagnosisList = scopedDiagnosisList();
  const globalCount = state.analytics?.diagnosis?.length || 0;
  $("damage-count").textContent = state.wrongMode ? `${compact(diagnosisList.length)} scoped` : compact(globalCount);
  
  const container = $("diagnosis-container");
  if (!container) return;

  const titleEl = $("drawer-toggle")?.querySelector(".drawer-title");

  if (diagnosisList.length === 0) {
    container.innerHTML = `<div class="compact-item">${state.wrongMode ? "No scoped damage found." : "No damage detected. System is healthy."}</div>`;
    if (titleEl) titleEl.classList.remove("has-damage");
  } else {
    if (titleEl) titleEl.classList.add("has-damage");
    container.innerHTML = diagnosisList.map(diag => `
      <div class="diagnosis-card severity-${diag.severity} ${diag.id === state.activeDiagnosisId ? 'active' : ''}" data-id="${diag.id}">
        <div class="diagnosis-header">
          <h3 class="diagnosis-title">${escapeHtml(diag.title)}</h3>
          <span class="state-pill ${diag.severity === 'high' ? 'bad' : ''}">${diag.severity}</span>
        </div>
        <div class="diagnosis-object">${escapeHtml(diag.object_kind)}: ${escapeHtml(diag.object_id)}</div>
        <div class="diagnosis-reason">${escapeHtml(diag.reason)}</div>
        <div class="diagnosis-action">↳ ${escapeHtml(diag.next_action)}</div>
      </div>
    `).join("");

    container.querySelectorAll(".diagnosis-card").forEach(card => {
      card.addEventListener("click", () => {
        const diag = diagnosisList.find(d => d.id === card.dataset.id);
        if (diag) focusDiagnosis(diag);
      });
    });
  }

  renderPlayback();
  renderRuntime();
}

function focusDiagnosis(diag) {
  state.activeDiagnosisId = diag.id;
  state.activeEvidenceId = diag.id;
  state.focusedNodeId = diag.focus_node_ids?.[0] || diag.object_id;
  state.graphScope = "focused";
  const graphScope = $("graph-scope");
  if (graphScope) graphScope.value = "focused";
  
  document.querySelectorAll(".diagnosis-card").forEach(c => c.classList.remove("active"));
  const card = document.querySelector(`.diagnosis-card[data-id="${diag.id}"]`);
  if (card) card.classList.add("active");

  const evContent = $("drawer-evidence-content");
  if (evContent) {
    evContent.textContent = JSON.stringify(diag.primary_evidence || {}, null, 2);
  }

  const mesh = nodeMeshes.find(m => m.userData.id === state.focusedNodeId);
  if (mesh) {
    state.selected = mesh.userData;
    cameraTarget.copy(mesh.position);
    cameraSpherical.radius = 500;
    updateCamera();
  }
  
  renderGraph();
}

function renderEvents() {
  const container = $("raw-table-container");
  if (container) {
    container.innerHTML = table(
      ["entry_datetime", "name", "type", "sr_no", "sub_seq_no", "step", "execution_query"],
      state.events
    );
  }
}

function renderRuntime() {
  const rows = state.runtimeLogs.map((row) => ({
    ts: row.ts,
    layer: row.layer,
    path: row.path,
    status: row.status,
    elapsed_ms: row.elapsed_ms,
    source: row.source,
    error: row.error || "",
  }));
  const target = $("tab-runtime");
  if (target) target.innerHTML = table(["ts", "layer", "path", "status", "elapsed_ms", "source", "error"], rows);
}

async function openRuntimeModal() {
  try {
    const payload = await api("/api/runtime/logs");
    state.runtimeStartedAt = payload.started_at || state.runtimeStartedAt;
    const serverRows = payload.logs.map((row) => ({ ...row, layer: "python" }));
    // Merge and sort by timestamp so server and browser logs are interleaved chronologically
    const merged = [...serverRows, ...state.runtimeLogs];
    merged.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
    state.runtimeLogs = merged.slice(0, 200);
  } catch {
    // Browser-side runtime logs are still useful if server log fetch fails.
  }
  openModal("Middle Layer Runtime");
  $("inspect-title").textContent = "Python API and browser request log";
  $("inspect-meta").innerHTML = kvHtml({
    browser_events: state.runtimeLogs.filter((row) => row.layer === "browser").length,
    server_events: state.runtimeLogs.filter((row) => row.layer === "python").length,
    started_at: state.runtimeStartedAt || "--",
    purpose: "See what the page requested, source used, status, and latency after refresh/filter/playback.",
  });
  $("inspect-evidence").textContent = JSON.stringify(state.runtimeLogs.slice(0, 120), null, 2);
  renderRuntime();
}

function openSpMapModal() {
  openModal("Static SP Map");
  $("inspect-title").textContent = "Parsed stored-procedure knowledge";
  $("inspect-meta").innerHTML = kvHtml({
    procedures: state.procedures.length,
    source: "Stored-procedure Markdown",
    purpose: "Expected structure used for graph, playback, and delta analysis.",
  });
  $("inspect-evidence").textContent = JSON.stringify(
    state.procedures.map((proc) => ({
      name: proc.name,
      log_refs: proc.log_ref_count,
      calls: proc.calls,
      reads: proc.reads.slice(0, 20),
      inserts: proc.inserts,
      updates: proc.updates.slice(0, 20),
      steps: proc.steps.slice(0, 12),
    })),
    null,
    2
  );
}

/* ──────────────────────────────────────────────────────────────────
   EXPORT / PLAYBACK
   ────────────────────────────────────────────────────────────────── */
function exportGraphImage() {
  renderer.render(scene, camera);
  const link = document.createElement("a");
  link.download = `tracer-graph-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  link.href = renderer.domElement.toDataURL("image/png");
  link.click();
}

async function runPlayback() {
  try {
    if (!expectedContextName()) {
      state.playbackData = null;
      renderPlayback("Select an SP/type/run to view expected path.");
      const timelineBtn = document.querySelector('.drawer-mode-button[data-mode="timeline"]');
      if (timelineBtn) timelineBtn.click();
      return;
    }
    const payload = await playbackForCurrentContext(state.selectedRunId || "");
    state.playbackData = payload;
    if (state.selectedRunId) state.playbackData.context_run_id = state.selectedRunId;
    state.runEvents = Array.isArray(payload.actual) ? payload.actual : [];
    state.playback.currentIndex = -1;
    renderPlayback();
    const timelineBtn = document.querySelector('.drawer-mode-button[data-mode="timeline"]');
    if (timelineBtn) timelineBtn.click();
  } catch (error) {
    setConnection("PLAYBACK ERROR", "bad");
    const target = $("drawer-evidence-content") || $("inspect-evidence");
    if (target) target.textContent = error.message;
    console.error(error);
  }
}

function renderPlayback(emptyMessage = "Choose an SP/type/time filter and click Playback.") {
  const timelineTarget = $("timeline-events");
  const oldTabTarget = $("tab-playback");
  const evidenceTarget = $("drawer-evidence-content");
  const playback = state.playbackData;

  if (!playback || !Array.isArray(playback.expected) || !Array.isArray(playback.actual)) {
    const empty = `<div class="compact-item">${escapeHtml(emptyMessage)}</div>`;
    if (oldTabTarget) oldTabTarget.innerHTML = empty;
    if (timelineTarget) timelineTarget.innerHTML = empty;
    return;
  }

  const rows = [];
  for (const item of playback.expected.slice(0, 120)) {
    rows.push({ lane: "expected", time: "", sr_no: item.sr_no, sub_seq_no: item.sub_seq_no, step: item.step });
  }
  for (const item of playback.actual.slice(0, 120)) {
    rows.push({ lane: "actual", time: item.entry_datetime, sr_no: item.sr_no, sub_seq_no: item.sub_seq_no, step: item.step });
  }
  const delta = playback.delta || { expected_count: 0, actual_count: 0, missing_count: 0, unexpected_count: 0 };
  const expectedNote = playback.expected_unavailable
    ? `<div class="compact-item warning">Expected path unavailable.</div>`
    : "";
  const html = `
    ${expectedNote}
    <div class="compact-item">
      Expected ${compact(delta.expected_count)} | Actual ${compact(delta.actual_count)} |
      Missing ${compact(delta.missing_count)} | Unexpected ${compact(delta.unexpected_count)}
    </div>
    ${table(["lane", "time", "sr_no", "sub_seq_no", "step"], rows)}
  `;
  if (oldTabTarget) oldTabTarget.innerHTML = html;
  if (timelineTarget) timelineTarget.innerHTML = html;
  if (evidenceTarget) {
    evidenceTarget.textContent = JSON.stringify({
      delta,
      likely_transitions: (playback.transitions || []).slice(0, 12),
      parameter_profiles: playback.parameter_profiles || {},
      missing_expected: (playback.missing_expected || []).slice(0, 20),
      unexpected_actual: (playback.unexpected_actual || []).slice(0, 20),
    }, null, 2);
  }
}

/* ──────────────────────────────────────────────────────────────────
   UTILITIES
   ────────────────────────────────────────────────────────────────── */
function table(columns, rows) {
  if (!rows.length) return `<div class="compact-item">No rows available. Sync the latest trace rows if the cache is empty.</div>`;
  return `
    <table class="data-table">
      <thead><tr>${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
      <tbody>
        ${rows.map((row) => `<tr class="${row._class || ""}">${columns.map((c) => `<td>${escapeHtml(fmt(row[c])).slice(0, 500)}</td>`).join("")}</tr>`).join("")}
      </tbody>
    </table>
  `;
}

function heatmapHtml(items) {
  if (!items.length) return `<div class="compact-item">No step gaps found in cached rows.</div>`;
  return `
    <div class="heat-grid">
      ${items.map((item) => `
        <div class="heat-cell severity-medium">
          <strong>${escapeHtml(item.name)}</strong><br />
          ${escapeHtml(item.type)}<br />
          Sr ${fmt(item.sr_no)} | missing ${fmt(item.missing_count)}
        </div>
      `).join("")}
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setupCameraWidget() {
  function bindCameraWidgetButton(id, actionFn) {
    const btn = $(id);
    if (!btn) return;

    let active = false;
    let timer = null;

    const start = (e) => {
      e.preventDefault();
      if (active) return;
      active = true;
      actionFn();
      timer = setInterval(actionFn, 50);
    };

    const stop = () => {
      if (!active) return;
      active = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    btn.addEventListener("pointerdown", start);
    btn.addEventListener("pointerup", stop);
    btn.addEventListener("pointerleave", stop);
    window.addEventListener("pointerup", stop);
  }

  // Bind Pan Buttons
  bindCameraWidgetButton("cam-pan-up", () => {
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    camera.matrix.extractBasis(right, up, new THREE.Vector3());
    cameraTarget.addScaledVector(up, cameraSpherical.radius * 0.008);
    updateCamera();
  });
  
  bindCameraWidgetButton("cam-pan-down", () => {
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    camera.matrix.extractBasis(right, up, new THREE.Vector3());
    cameraTarget.addScaledVector(up, -cameraSpherical.radius * 0.008);
    updateCamera();
  });

  bindCameraWidgetButton("cam-pan-left", () => {
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    camera.matrix.extractBasis(right, up, new THREE.Vector3());
    cameraTarget.addScaledVector(right, -cameraSpherical.radius * 0.008);
    updateCamera();
  });

  bindCameraWidgetButton("cam-pan-right", () => {
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    camera.matrix.extractBasis(right, up, new THREE.Vector3());
    cameraTarget.addScaledVector(right, cameraSpherical.radius * 0.008);
    updateCamera();
  });

  // Bind Orbit Buttons
  bindCameraWidgetButton("cam-rot-up", () => {
    cameraSpherical.phi = clamp(cameraSpherical.phi - 0.015, 0.08, Math.PI - 0.08);
    updateCamera();
  });

  bindCameraWidgetButton("cam-rot-down", () => {
    cameraSpherical.phi = clamp(cameraSpherical.phi + 0.015, 0.08, Math.PI - 0.08);
    updateCamera();
  });

  bindCameraWidgetButton("cam-rot-left", () => {
    cameraSpherical.theta += 0.015;
    updateCamera();
  });

  bindCameraWidgetButton("cam-rot-right", () => {
    cameraSpherical.theta -= 0.015;
    updateCamera();
  });

  // Bind Zoom Buttons
  bindCameraWidgetButton("cam-zoom-in", () => {
    cameraSpherical.radius = clamp(cameraSpherical.radius - cameraSpherical.radius * 0.012, 220, 2600);
    updateCamera();
  });

  bindCameraWidgetButton("cam-zoom-out", () => {
    cameraSpherical.radius = clamp(cameraSpherical.radius + cameraSpherical.radius * 0.012, 220, 2600);
    updateCamera();
  });
}

boot();
