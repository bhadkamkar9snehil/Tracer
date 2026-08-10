const $ = (id) => document.getElementById(id);

const state = {
  atlas: null,
  selectedRunId: "",
  selectedRun: null,
  selectedIndex: -1,
  activeTab: "explanation",
  filterOptionsLoaded: false,
  filterOptions: null,
  requestSerial: 0,
  matrix: { rowHeight: 29, headerHeight: 90, labelWidth: 232, cellWidth: 24 },
};

const COLORS = {
  ink: "#14213d", text: "#25324b", muted: "#667085", line: "#dfe3ea", soft: "#f9fafb",
  accent: "#2264e5", accentSoft: "#eaf1ff", normal: "#258a5b", slow: "#d97706",
  error: "#d92d20", unexpected: "#7c3aed", repeated: "#087ea4", absent: "#cbd2dc",
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindActions();
  await loadAtlas();
}

function bindActions() {
  $("filters").addEventListener("submit", (event) => event.preventDefault());
  $("filter-name").addEventListener("change", () => {
    refreshTypeOptions();
    applyFilters();
  });
  ["filter-type", "filter-status", "filter-sort"].forEach((id) => $(id).addEventListener("change", applyFilters));
  $("sync-data").addEventListener("click", syncData);
  $("export-visible").addEventListener("click", exportVisible);
  $("close-inspector").addEventListener("click", () => $("inspector-panel").classList.remove("open"));
  $("matrix-canvas").addEventListener("click", selectMatrixRow);
  $("matrix-canvas").addEventListener("mousemove", showMatrixTooltip);
  $("matrix-canvas").addEventListener("mouseleave", () => { $("matrix-tooltip").hidden = true; });
  $("matrix-canvas").addEventListener("keydown", navigateMatrix);
  window.addEventListener("resize", debounce(() => state.atlas && renderMatrix(), 100));
  document.querySelectorAll(".inspector-tabs button").forEach((button) => {
    button.addEventListener("click", () => activateInspectorTab(button.dataset.tab));
  });
}

async function loadAtlas() {
  const requestSerial = ++state.requestSerial;
  setLoading(true);
  try {
    const response = await fetch(`/api/atlas${window.location.search}`, { headers: { Accept: "application/json" } });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || `Atlas request failed (${response.status})`);
    if (requestSerial !== state.requestSerial) return;
    state.atlas = payload;
    populateFilterOptions(payload.filters);
    renderAll();
    const requestedRun = new URLSearchParams(location.search).get("run");
    const firstRun = requestedRun || payload.anomalies[0]?.run_id || payload.runs[0]?.run_id;
    if (firstRun) await selectRun(firstRun, false);
  } catch (error) {
    if (requestSerial !== state.requestSerial) return;
    showToast(error.message, true);
    renderFatal(error.message);
  } finally {
    if (requestSerial === state.requestSerial) setLoading(false);
  }
}

function renderAll() {
  renderFreshness();
  renderSummary();
  renderDensity();
  renderInbox();
  renderMatrix();
  renderVariants();
  renderLatency();
}

function populateFilterOptions(filters) {
  const selected = state.filterOptionsLoaded ? currentFilters() : filtersFromUrl();
  state.filterOptions = filters;
  replaceOptions($("filter-name"), "All procedures · normalized steps", filters.names, procedureOption);
  $("filter-name").value = selected.name || "";
  refreshTypeOptions(selected.type || "");
  replaceOptions($("filter-status"), "All outcomes", filters.statuses.map((status) => ({ status })), (item) => ({ label: titleCase(item.status), value: item.status }));
  $("filter-status").value = selected.status || "";
  $("filter-sort").value = selected.sort || "deviation";
  state.filterOptionsLoaded = true;
}

function refreshTypeOptions(preferredValue = $("filter-type").value) {
  if (!state.filterOptions) return;
  const procedure = $("filter-name").value;
  let types = state.filterOptions.types;
  if (procedure && state.filterOptions.cohorts?.length) {
    types = state.filterOptions.cohorts
      .filter((item) => item.name === procedure)
      .map((item) => ({ type: item.type, count: item.count }));
  }
  replaceOptions($("filter-type"), procedure ? "All types in this procedure" : "All types", types, (item) => ({
    label: `${item.type} (${formatNumber(item.count)})`,
    value: item.type,
    title: item.type,
  }));
  $("filter-type").value = [...$("filter-type").options].some((option) => option.value === preferredValue) ? preferredValue : "";
}

function replaceOptions(select, emptyLabel, items, formatItem) {
  select.replaceChildren(new Option(emptyLabel, ""));
  items.forEach((item) => {
    const formatted = formatItem(item);
    const option = new Option(formatted.label, formatted.value);
    if (formatted.title) option.title = formatted.title;
    select.append(option);
  });
}

function procedureOption(item) {
  return {
    label: `${truncate(shortProcedure(item.name), 54)} (${formatNumber(item.count)})`,
    value: item.name,
    title: item.name,
  };
}

function renderFreshness() {
  const freshness = state.atlas.freshness;
  const el = $("freshness");
  el.dataset.state = freshness.state;
  const age = freshness.age_seconds == null ? "No cached events" : `${formatAge(freshness.age_seconds)} old`;
  el.innerHTML = `<span class="status-dot"></span><strong>${titleCase(freshness.state)} cache</strong><span>${escapeHtml(formatDate(freshness.watermark))} · ${age}</span>`;
}

function renderSummary() {
  const s = state.atlas.summary;
  const metrics = [
    ["Executions", s.executions, "matching runs"],
    ["Deviated", s.deviated, formatPercent(s.deviation_rate)],
    ["Failed", s.failed, formatPercent(s.failure_rate)],
    ["Slow", s.slow, `${formatPercent(s.slow_rate)} · p95 ${formatMs(s.p95_duration_ms)}`],
  ];
  $("summary-strip").innerHTML = metrics.map(([label, value, note]) => `<div class="metric"><span>${label}</span><strong>${formatNumber(value)}</strong><small>${note}</small></div>`).join("");
}

function renderDensity() {
  const data = state.atlas.density;
  const svg = $("density-chart");
  const width = Math.max(520, svg.clientWidth || 900);
  const height = 66;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  if (!data.length) { svg.innerHTML = ""; return; }
  const max = Math.max(1, ...data.map((d) => d.total));
  const x = (index) => 4 + index * (width - 8) / Math.max(1, data.length - 1);
  const y = (value) => height - 15 - value / max * (height - 24);
  const path = (key) => data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(" ");
  const grid = [0.25,0.5,0.75].map((ratio) => `<line x1="4" x2="${width-4}" y1="${y(max*ratio)}" y2="${y(max*ratio)}" stroke="#e7eaf0"/>`).join("");
  svg.innerHTML = `${grid}<path d="${path("total")}" fill="none" stroke="${COLORS.accent}" stroke-width="1.7"/><path d="${path("deviated")}" fill="none" stroke="${COLORS.slow}" stroke-width="1.4"/><path d="${path("failed")}" fill="none" stroke="${COLORS.error}" stroke-width="1.4"/><text x="4" y="64" fill="${COLORS.muted}" font-size="9">${escapeHtml(formatShortDate(data[0].start))}</text><text x="${width-4}" y="64" text-anchor="end" fill="${COLORS.muted}" font-size="9">${escapeHtml(formatShortDate(data.at(-1).start))}</text>`;
}

function renderInbox() {
  const anomalies = state.atlas.anomalies;
  $("inbox-count").textContent = formatNumber(state.atlas.summary.deviated);
  $("anomaly-list").innerHTML = anomalies.length ? anomalies.map((item) => `
    <button class="anomaly-item ${item.run_id === state.selectedRunId ? "active" : ""}" type="button" role="listitem" data-run="${item.run_id}">
      <i class="severity-icon ${item.severity}" aria-label="${item.severity} severity"></i>
      <span class="anomaly-copy"><strong title="${escapeHtml(item.name)}">${escapeHtml(shortProcedure(item.name))} · ${escapeHtml(item.type || "Unknown")}</strong><p>${escapeHtml(item.reason)}</p><time>${escapeHtml(formatDate(item.start_time))}</time></span>
      <span class="anomaly-score">${item.deviation_score}</span>
    </button>`).join("") : `<div class="empty-list">No explainable deviations match the current filters.</div>`;
  document.querySelectorAll(".anomaly-item").forEach((button) => button.addEventListener("click", () => selectRun(button.dataset.run)));
}

function renderMatrix() {
  const { runs, steps, result } = state.atlas;
  const canvas = $("matrix-canvas");
  updateMatrixMetrics(steps.length, $("matrix-scroll").clientWidth);
  const { rowHeight, headerHeight, labelWidth, cellWidth } = state.matrix;
  const cssWidth = Math.max($("matrix-scroll").clientWidth, labelWidth + steps.length * cellWidth + 8);
  const cssHeight = headerHeight + runs.length * rowHeight;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.ceil(cssWidth * ratio); canvas.height = Math.ceil(cssHeight * ratio);
  canvas.style.width = `${cssWidth}px`; canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  ctx.fillStyle = "#fff"; ctx.fillRect(0,0,cssWidth,cssHeight);
  drawMatrixHeader(ctx, steps, cssWidth);
  runs.forEach((run, rowIndex) => drawMatrixRow(ctx, run, rowIndex, steps, cssWidth));
  $("matrix-result").textContent = `Showing ${formatNumber(result.shown)} of ${formatNumber(result.total_matching)} executions${result.truncated ? " · limited for interactive inspection" : ""}`;
  $("matrix-subtitle").textContent = result.matrix_mode === "normalized"
    ? "Rows are executions across multiple cohorts. Columns are normalized ordinal positions; filter to one procedure and type for semantic step labels."
    : "Rows are comparable executions. Columns are semantic trace steps from the dominant cohort path.";
}

function drawMatrixHeader(ctx, steps, width) {
  const { headerHeight, labelWidth, cellWidth } = state.matrix;
  const extraWide = state.matrix.rowHeight >= 42;
  const wide = state.matrix.rowHeight >= 38;
  ctx.fillStyle = COLORS.soft; ctx.fillRect(0,0,width,headerHeight);
  ctx.strokeStyle = COLORS.line; ctx.beginPath(); ctx.moveTo(0,headerHeight-.5);ctx.lineTo(width,headerHeight-.5);ctx.stroke();
  ctx.fillStyle = COLORS.ink; ctx.font = `700 ${extraWide ? 14 : wide ? 13 : 12}px Aptos, Segoe UI`; ctx.fillText("EXECUTION / SCORE", 16, headerHeight - 14);
  steps.forEach((step,index) => {
    const x = labelWidth + index * cellWidth + cellWidth/2;
    ctx.save(); ctx.translate(x, headerHeight - 11); ctx.rotate(-Math.PI/3.1); ctx.fillStyle = COLORS.muted; ctx.font = `${extraWide ? 12 : wide ? 11 : 10}px Cascadia Mono, Consolas`; ctx.fillText(truncate(step.label,30),0,0); ctx.restore();
    ctx.strokeStyle = "#edf0f4"; ctx.beginPath();ctx.moveTo(labelWidth+index*cellWidth+.5,0);ctx.lineTo(labelWidth+index*cellWidth+.5,headerHeight);ctx.stroke();
  });
}

function drawMatrixRow(ctx, run, rowIndex, steps, width) {
  const { rowHeight, headerHeight, labelWidth, cellWidth } = state.matrix;
  const extraWide = rowHeight >= 42;
  const wide = rowHeight >= 38;
  const y = headerHeight + rowIndex * rowHeight;
  const selected = run.run_id === state.selectedRunId;
  ctx.fillStyle = selected ? COLORS.accentSoft : rowIndex % 2 ? "#fbfcfd" : "#fff"; ctx.fillRect(0,y,width,rowHeight);
  ctx.strokeStyle = "#edf0f4";ctx.beginPath();ctx.moveTo(0,y+rowHeight-.5);ctx.lineTo(width,y+rowHeight-.5);ctx.stroke();
  ctx.fillStyle = COLORS.ink;ctx.font=`600 ${extraWide ? 14 : wide ? 13 : 12}px Cascadia Mono, Consolas`;ctx.fillText(`${truncate(run.type || "Unknown",22)} · ${run.run_id.slice(0,8)}`,16,y+(extraWide?16:wide?15:14));
  ctx.fillStyle = COLORS.muted;ctx.font=`${extraWide ? 12 : wide ? 11 : 10}px Aptos, Segoe UI`;ctx.fillText(`${formatTime(run.start_time)} · ${formatMs(run.duration_ms)}`,16,y+rowHeight-7);
  ctx.fillStyle = scoreColor(run.deviation_score);ctx.font=`700 ${extraWide ? 16 : wide ? 15 : 14}px Cascadia Mono, Consolas`;ctx.textAlign="right";ctx.fillText(String(run.deviation_score),labelWidth-16,y+Math.round(rowHeight*.63));ctx.textAlign="left";
  run.cells.forEach((cell,index) => drawCell(ctx, cell, labelWidth+index*cellWidth, y, cellWidth, rowHeight));
  if (selected) {
    ctx.save();
    ctx.strokeStyle = "rgba(34,100,229,.46)";
    ctx.strokeRect(.5,y+.5,width-1,rowHeight-1);
    ctx.restore();
  }
}

function updateMatrixMetrics(stepCount, availableWidth) {
  let rowHeight, headerHeight, labelWidth, minimumCellWidth, maximumCellWidth;
  if (innerHeight <= 800 && innerWidth >= 1321) {
    rowHeight = 34; headerHeight = 92; labelWidth = 260; minimumCellWidth = 26; maximumCellWidth = 56;
  } else if (innerHeight <= 800) {
    rowHeight = 32; headerHeight = 88; labelWidth = 240; minimumCellWidth = 24; maximumCellWidth = 50;
  } else if (innerWidth >= 2200) {
    rowHeight = 42; headerHeight = 122; labelWidth = 340; minimumCellWidth = 34; maximumCellWidth = 94;
  } else if (innerWidth >= 1700) {
    rowHeight = 38; headerHeight = 112; labelWidth = 300; minimumCellWidth = 30; maximumCellWidth = 80;
  } else if (innerWidth >= 1321) {
    rowHeight = 36; headerHeight = 106; labelWidth = 280; minimumCellWidth = 27; maximumCellWidth = 64;
  } else {
    rowHeight = 34; headerHeight = 100; labelWidth = 260; minimumCellWidth = 25; maximumCellWidth = 54;
  }
  const usableWidth = Math.max(0, availableWidth - labelWidth - 10);
  const fittedCellWidth = stepCount ? Math.floor(usableWidth / stepCount) : minimumCellWidth;
  const cellWidth = Math.max(minimumCellWidth, Math.min(maximumCellWidth, fittedCellWidth));
  state.matrix = { rowHeight, headerHeight, labelWidth, cellWidth };
}

function drawCell(ctx, cell, x, y, width, height) {
  const cx=x+width/2, cy=y+height/2;
  const scale = height >= 42 ? 1.46 : height >= 38 ? 1.32 : height >= 34 ? 1.16 : 1;
  ctx.strokeStyle="#edf0f4";ctx.beginPath();ctx.moveTo(x+.5,y);ctx.lineTo(x+.5,y+height);ctx.stroke();
  if (cell.state === "normal") { ctx.fillStyle=COLORS.normal;ctx.beginPath();ctx.arc(cx,cy,3.1*scale,0,Math.PI*2);ctx.fill(); }
  else if (cell.state === "slow") { ctx.fillStyle=COLORS.slow;ctx.beginPath();ctx.arc(cx,cy,4.2*scale,0,Math.PI*2);ctx.fill(); }
  else if (cell.state === "missing") { const size=4*scale;ctx.save();ctx.strokeStyle=COLORS.error;ctx.setLineDash([2,2]);ctx.strokeRect(cx-size,cy-size,size*2,size*2);ctx.restore(); }
  else if (cell.state === "unexpected") { const size=3.5*scale;ctx.fillStyle=COLORS.unexpected;ctx.save();ctx.translate(cx,cy);ctx.rotate(Math.PI/4);ctx.fillRect(-size,-size,size*2,size*2);ctx.restore(); }
  else if (cell.state === "repeated") { ctx.strokeStyle=COLORS.repeated;ctx.lineWidth=2;ctx.beginPath();ctx.arc(cx,cy,4*scale,0,Math.PI*2);ctx.stroke();ctx.lineWidth=1; }
  else { ctx.fillStyle=COLORS.absent;ctx.fillRect(cx-2,cy-.5,4,1); }
}

function matrixLocation(event) {
  const rect = $("matrix-canvas").getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  const row = Math.floor((y - state.matrix.headerHeight) / state.matrix.rowHeight);
  const column = Math.floor((x - state.matrix.labelWidth) / state.matrix.cellWidth);
  return { x,y,row,column };
}

function selectMatrixRow(event) {
  const hit = matrixLocation(event);
  const run = state.atlas.runs[hit.row];
  if (run) selectRun(run.run_id);
}

function showMatrixTooltip(event) {
  const hit = matrixLocation(event); const run=state.atlas.runs[hit.row]; const step=state.atlas.steps[hit.column];
  const tooltip=$("matrix-tooltip");
  if (!run) { tooltip.hidden=true; return; }
  const cell=step ? run.cells[hit.column] : null;
  tooltip.innerHTML = `<strong>${escapeHtml(run.type || "Unknown")} · score ${run.deviation_score}</strong><br>${escapeHtml(cell && step ? `${step.label}: ${titleCase(cell.state)}${cell.duration_ms != null ? ` · ${formatMs(cell.duration_ms)}`:""}` : run.primary_reason)}`;
  tooltip.style.left=`${Math.min(innerWidth-330,event.clientX+14)}px`;tooltip.style.top=`${Math.min(innerHeight-90,event.clientY+12)}px`;tooltip.hidden=false;
}

function navigateMatrix(event) {
  if (!["ArrowDown","ArrowUp","Enter"].includes(event.key)) return;
  event.preventDefault();
  if (event.key === "Enter" && state.selectedIndex >= 0) return selectRun(state.atlas.runs[state.selectedIndex].run_id);
  const delta=event.key==="ArrowDown"?1:-1;
  state.selectedIndex=Math.max(0,Math.min(state.atlas.runs.length-1,(state.selectedIndex<0?0:state.selectedIndex+delta)));
  const run=state.atlas.runs[state.selectedIndex];
  $("matrix-selection").textContent=`${run.type}, ${formatDate(run.start_time)}, deviation ${run.deviation_score}. ${run.primary_reason}`;
  selectRun(run.run_id);
}

function renderVariants() {
  $("variant-list").innerHTML = state.atlas.variants.map((variant,index)=>`<div class="variant-row"><strong>${index+1}</strong><span class="variant-pattern" title="${variant.step_count} steps">${variant.pattern.map((state)=>`<i class="${state}"></i>`).join("")}</span><span>${formatNumber(variant.count)}</span><span>${formatPercent(variant.rate)}</span></div>`).join("") || `<div class="empty-list">No sequence variants available.</div>`;
}

function renderLatency() {
  const items=state.atlas.latency; const globalMax=Math.max(1,...items.map((item)=>item.max_ms));
  $("latency-chart").innerHTML=items.map((item)=>{ const max=100-item.max_ms/globalMax*92, p95=100-item.p95_ms/globalMax*92, p50=100-item.p50_ms/globalMax*92; const visibleLabel=item.step.startsWith("ordinal:")?item.label:item.step; return `<div class="latency-step" title="${escapeHtml(item.label)} · p50 ${formatMs(item.p50_ms)} · p95 ${formatMs(item.p95_ms)} · max ${formatMs(item.max_ms)}"><div class="latency-box" style="--max:${max}%;--p95:${p95}%;--p50:${p50}%"><i class="latency-max"></i></div><label>${escapeHtml(visibleLabel)}</label></div>`;}).join("") || `<div class="empty-list">No latency distribution available.</div>`;
}

async function selectRun(runId, updateUrl=true) {
  if (!runId) return;
  state.selectedRunId=runId;
  state.selectedIndex=state.atlas.runs.findIndex((run)=>run.run_id===runId);
  renderInbox(); renderMatrix();
  if (updateUrl) { const url=new URL(location.href);url.searchParams.set("run",runId);history.replaceState({},"",url); }
  try {
    $("inspector-empty").innerHTML=`<span class="spinner"></span><h2>Loading run evidence</h2>`;
    const response=await fetch(`/api/atlas/runs/${encodeURIComponent(runId)}`);const payload=await response.json();
    if(!response.ok||!payload.ok) throw new Error(payload.error||"Run evidence unavailable");
    state.selectedRun=payload.run; renderInspector();
    if(updateUrl && innerWidth<=1320) $("inspector-panel").classList.add("open");
  } catch(error) { showToast(error.message,true); }
}

function renderInspector() {
  const run=state.selectedRun;
  $("inspector-empty").hidden=true;$("inspector-content").hidden=false;
  $("run-procedure").textContent=`${run.name} · ${run.type}`;
  $("run-title").textContent=run.run_id.slice(0,12);
  $("run-meta").textContent=`${formatDate(run.start_time)} · ${formatMs(run.duration_ms)} · ${run.status}`;
  $("run-score").textContent=run.deviation_score;
  renderExplanation(run);renderWaterfall(run);renderEvidence(run);activateInspectorTab(state.activeTab);
}

function renderExplanation(run) {
  const reasons=run.explanations;
  $("tab-explanation").innerHTML=`<div class="explanation-lead">${escapeHtml(reasons[0]?.text||"This execution matches its dominant cohort pattern.")}</div><ul class="reason-list">${reasons.map((item)=>`<li><i class="${item.severity}"></i><span>${escapeHtml(item.text)}</span></li>`).join("")||"<li><i class=\"low\"></i><span>No explainable deviation was detected.</span></li>"}</ul><div class="cohort-note">Compared with ${formatNumber(run.cohort_runs)} runs sharing this procedure and type. This exact sequence represents ${formatPercent(run.variant_rate)} of that cohort.</div>`;
}

function renderWaterfall(run) {
  $("tab-waterfall").innerHTML=`<table class="data-table"><thead><tr><th style="width:35px">#</th><th>Expected step</th><th style="width:62px">p50</th><th style="width:62px">Actual</th></tr></thead><tbody>${run.waterfall.map((row)=>`<tr class="${row.state}"><td class="mono">${row.ordinal??"+"}</td><td><strong>${escapeHtml(row.label)}</strong><br><span class="mono">${escapeHtml(row.state)}</span></td><td class="mono">${row.p50_ms==null?"—":formatMs(row.p50_ms)}</td><td class="mono">${row.actual_ms==null?"—":formatMs(row.actual_ms)}</td></tr>`).join("")}</tbody></table>`;
}

function renderEvidence(run) {
  $("tab-evidence").innerHTML=`<table class="data-table"><thead><tr><th style="width:76px">Time</th><th style="width:47px">Seq</th><th>Event evidence</th></tr></thead><tbody>${run.events.map((event)=>`<tr><td class="mono">${escapeHtml(formatTime(event.entry_datetime,true))}</td><td class="mono">${event.sr_no??"—"}.${event.sub_seq_no??"—"}</td><td><strong>${escapeHtml(event.step||"Unlabelled")}</strong><div class="event-details">${escapeHtml(event.execution_query||event.details||"")}</div></td></tr>`).join("")}</tbody></table>`;
}

function activateInspectorTab(tab) {
  state.activeTab=tab;
  document.querySelectorAll(".inspector-tabs button").forEach((button)=>{const active=button.dataset.tab===tab;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active));});
  document.querySelectorAll(".tab-panel").forEach((panel)=>panel.classList.toggle("active",panel.id===`tab-${tab}`));
}

async function syncData() {
  const button=$("sync-data");button.disabled=true;button.textContent="Syncing…";
  try { const response=await fetch("/api/sync?limit=5000&mode=incremental",{method:"POST"});const payload=await response.json();if(!response.ok||!payload.ok)throw new Error(payload.error||"SQL sync failed");showToast(`Synced ${formatNumber(payload.inserted)} trace rows.`);await loadAtlas(); }
  catch(error){showToast(`${error.message}. Cached analysis remains available.`,true);} finally{button.disabled=false;button.textContent="Sync";}
}

function exportVisible() {
  if(!state.atlas?.runs?.length)return showToast("There are no visible executions to export.",true);
  const rows=[["run_id","procedure","type","started","duration_ms","status","deviation_score","primary_reason"],...state.atlas.runs.map((run)=>[run.run_id,run.name,run.type,run.start_time,run.duration_ms,run.status,run.deviation_score,run.primary_reason])];
  const csv=rows.map((row)=>row.map(csvCell).join(",")).join("\r\n");const link=document.createElement("a");link.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));link.download=`tracer-executions-${new Date().toISOString().slice(0,10)}.csv`;link.click();URL.revokeObjectURL(link.href);
}

function applyFilters() {
  state.selectedRunId = "";
  state.selectedRun = null;
  updateUrlFromFilters();
  loadAtlas();
}
function updateUrlFromFilters() { const url=new URL(location.href);url.search="";Object.entries(currentFilters()).forEach(([key,value])=>value&&url.searchParams.set(key,value));history.replaceState({},"",url); }
function filtersFromUrl(){const p=new URLSearchParams(location.search);return{name:p.get("name")||"",type:p.get("type")||"",status:p.get("status")||"",sort:p.get("sort")||"deviation"};}
function currentFilters(){return{name:$("filter-name").value,type:$("filter-type").value,status:$("filter-status").value,sort:$("filter-sort").value};}
function setLoading(on){$("loading-state").hidden=!on;}
function renderFatal(message){$("summary-strip").innerHTML=`<div class="empty-list" style="grid-column:1/-1"><strong>Tracer could not build the execution atlas.</strong><br>${escapeHtml(message)}</div>`;}
function showToast(message,error=false){const el=$("toast");el.textContent=message;el.classList.toggle("error",error);el.hidden=false;clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>el.hidden=true,5200);}

function scoreColor(score){return score>=40?COLORS.error:score>=18?COLORS.slow:score>0?COLORS.unexpected:COLORS.normal;}
function shortProcedure(value=""){return value.replace(/^XSTUDIO_WORKFLOW_/i,"Workflow ").replace(/_SP$/i,"").replace(/^XMES_/i,"").replace(/_/g," ");}
function formatNumber(value){return new Intl.NumberFormat().format(Number(value||0));}
function formatPercent(value){return new Intl.NumberFormat(undefined,{style:"percent",maximumFractionDigits:1}).format(Number(value||0));}
function formatMs(value){const n=Number(value||0);return n>=1000?`${(n/1000).toFixed(n>=10000?1:2)} s`:`${n.toFixed(n<10?1:0)} ms`;}
function formatDate(value){if(!value)return"Unknown time";const d=new Date(String(value).replace(" ","T")+(/[zZ]|[+-]\d\d:\d\d$/.test(value)?"":"Z"));return Number.isNaN(d.valueOf())?String(value):new Intl.DateTimeFormat(undefined,{month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}).format(d);}
function formatShortDate(value){if(!value)return"";const d=new Date(value);return new Intl.DateTimeFormat(undefined,{month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(d);}
function formatTime(value,millis=false){if(!value)return"—";const text=String(value).replace("T"," ");const part=text.split(" ")[1]||text;return millis?part.slice(0,12):part.slice(0,8);}
function formatAge(seconds){if(seconds<60)return`${seconds}s`;if(seconds<3600)return`${Math.floor(seconds/60)}m`;if(seconds<86400)return`${Math.floor(seconds/3600)}h`;return`${Math.floor(seconds/86400)}d`;}
function titleCase(value=""){return String(value).replace(/[-_]/g," ").replace(/\b\w/g,(letter)=>letter.toUpperCase());}
function truncate(value,length){return String(value).length>length?`${String(value).slice(0,length-1)}…`:String(value);}
function escapeHtml(value){return String(value??"").replace(/[&<>'"]/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));}
function csvCell(value){const text=String(value??"");return /[",\r\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text;}
function debounce(fn,wait){let timer;return(...args)=>{clearTimeout(timer);timer=setTimeout(()=>fn(...args),wait);};}
