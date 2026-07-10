/* investigation.js - Investigation view (#/investigation/:componentId) */
(function (global) {
    'use strict';

    var VIEW_ID = 'investigation';
    var el = global.Interactions.el;
    var VB = global.ViewBuilders;
    var F = global.Formatters;
    var GROUP = 'investigation';

    var containerEl = null;

    function ctx() { return global.DLContext || {}; }

    var COMPONENT_LABELS = {
        'object-storage': 'Object Storage',
        landing: 'Landing', validation: 'Validation', processing: 'Processing',
        curated: 'Curated Data', publishing: 'Publishing', acquisition: 'Acquisition',
        storage: 'Storage', quality: 'Quality', services: 'Services', hosts: 'Hosts', logs: 'Logs'
    };

    function labelFor(id) { return COMPONENT_LABELS[id] || id; }

    function layerNameFor(id) {
        var map = { 'object-storage': 'Storage', storage: 'Storage', processing: 'Processing', acquisition: 'Acquisition', quality: 'Quality', publishing: 'Publishing', services: 'Services', hosts: 'Hosts' };
        return map[id] || (id.charAt(0).toUpperCase() + id.slice(1));
    }

    function componentState(layer) {
        var pool = (global.MockData && global.MockData.eventPool) || [];
        var since = (global.__DL_NOW__ || Date.now()) - 60 * 60 * 1000;
        var worst = 'healthy';
        pool.forEach(function (e) {
            if (e.layer !== layer || e.time < since) { return; }
            if (e.severity === 'critical') { worst = 'critical'; }
            else if (e.severity === 'warning' && worst !== 'critical') { worst = 'warning'; }
        });
        return worst;
    }

    function renderDependencyGraph(componentId, dep, parentEl) {
        var built = VB.panel('Dependency Graph', { tall: true });
        parentEl.appendChild(built.panel);
        var nodes = [];
        var edges = [];
        var upCount = dep.upstream.length || 1;
        var downCount = dep.downstream.length || 1;
        dep.upstream.forEach(function (id, i) {
            nodes.push({ id: id, name: labelFor(id), x: -220, y: (i - (upCount - 1) / 2) * 90, fixed: true, itemStyle: { color: global.ChartFactory.palette[4] } });
            edges.push({ source: id, target: componentId });
        });
        nodes.push({ id: componentId, name: labelFor(componentId), x: 0, y: 0, fixed: true, symbolSize: 60, itemStyle: { color: global.ChartFactory.palette[0] } });
        dep.downstream.forEach(function (id, i) {
            nodes.push({ id: id, name: labelFor(id), x: 220, y: (i - (downCount - 1) / 2) * 90, fixed: true, itemStyle: { color: global.ChartFactory.palette[4] } });
            edges.push({ source: componentId, target: id });
        });
        var chart = global.ChartFactory.createGraph(built.canvas, {
            layout: 'none',
            nodes: nodes,
            edges: edges,
            onNodeClick: function (nodeData) {
                if (nodeData.id !== componentId) { ctx().router.navigate('investigation/' + nodeData.id); }
            }
        });
        global.ChartRegistry.register('inv-graph', chart, VIEW_ID, built.canvas);
    }

    function renderStatePanel(componentId, layer) {
        var built = VB.panel('Current State');
        built.canvas.remove();
        var state = componentState(layer);
        built.body.appendChild(VB.stateInline(state));
        var dl = el('dl', 'dl-kv-list');
        dl.style.marginTop = 'var(--space-3)';
        [['Component', labelFor(componentId)], ['Layer', layer], ['Evaluated over', 'Last 60 min']].forEach(function (p) {
            dl.appendChild(el('dt', null, p[0]));
            dl.appendChild(el('dd', null, p[1]));
        });
        built.body.appendChild(dl);
        return built.panel;
    }

    function renderRelatedEvents(layer) {
        var built = VB.panel('Related Events');
        built.canvas.remove();
        var pool = ((global.MockData && global.MockData.eventPool) || []).filter(function (e) { return e.layer === layer; }).slice(0, 8);
        if (!pool.length) {
            global.ChartFactory.renderEmptyState(built.body, {});
            return built.panel;
        }
        pool.forEach(function (e) {
            var row = el('div', 'dl-related-link', e.summary);
            var sub = el('div', 'dl-provenance', F.formatRelativeTime(e.time));
            row.appendChild(sub);
            built.body.appendChild(row);
        });
        return built.panel;
    }

    function renderCorrelatedMetrics(state, data) {
        var section = VB.section('Correlated Metrics');
        var grid = VB.grid();
        var specs = [
            { key: 'requestRate', title: 'Request Rate', unit: '/s' },
            { key: 'errorRate', title: 'Error Rate', unit: '/s' },
            { key: 'traffic', title: 'Traffic', unit: 'bytes' },
            { key: 'driveLatency', title: 'Drive Latency', unit: 'ms' },
            { key: 'capacity', title: 'Capacity', unit: '%' },
            { key: 'scannerActivity', title: 'Scanner Activity', unit: '' },
            { key: 'hostDiskQueue', title: 'Host Disk Queue', unit: '' },
            { key: 'hostMemory', title: 'Host Memory', unit: '%' }
        ];
        specs.forEach(function (spec, i) {
            var col = VB.col(6);
            var built = VB.panel(spec.title, { compact: true });
            var chart = global.ChartFactory.createLineChart(built.canvas, {
                unit: spec.unit, legend: false,
                series: [{ name: spec.title, data: data.metrics[spec.key] }]
            });
            chart.group = GROUP;
            global.ChartRegistry.register('inv-metric-' + spec.key, chart, VIEW_ID, built.canvas);
            global.ChartFactory.wireActions(built.actions, chart, { filenameBase: 'investigation-' + spec.key });
            col.appendChild(built.panel);
            grid.appendChild(col);
        });
        section.appendChild(grid);
        global.ChartFactory && global.ChartRegistry.connectGroup(GROUP);
        return section;
    }

    function renderTimeline(data) {
        var built = VB.panel('Timeline');
        built.canvas.remove();
        var list = el('div');
        (data.timeline || []).forEach(function (e) {
            var row = el('div', 'dl-event-row');
            row.appendChild(el('div', 'time', F.formatClock(e.time)));
            row.appendChild(el('div', 'layer', e.layer));
            row.appendChild(el('div', null, e.summary));
            row.appendChild(VB.stateBadge(e.state));
            row.appendChild(el('div', 'duration', e.durationMs ? F.formatDurationMs(e.durationMs) : '—'));
            list.appendChild(row);
        });
        built.body.appendChild(list);
        return built.panel;
    }

    function render(state, data) {
        containerEl.innerHTML = '';
        if (!data) {
            var loading = VB.panel('Loading');
            global.ChartFactory.renderLoadingSkeleton(loading.canvas);
            containerEl.appendChild(loading.panel);
            return;
        }
        var componentId = data.componentId;
        var layer = layerNameFor(componentId);

        var topGrid = VB.grid();
        var depCol = VB.col(12);
        var sideCol = VB.col(12);
        topGrid.appendChild(depCol);
        topGrid.appendChild(sideCol);
        containerEl.appendChild(topGrid);

        renderDependencyGraph(componentId, data.dependency, depCol);
        sideCol.appendChild(renderStatePanel(componentId, layer));
        var relatedWrap = el('div');
        relatedWrap.style.marginTop = 'var(--space-4)';
        relatedWrap.appendChild(renderRelatedEvents(layer));
        sideCol.appendChild(relatedWrap);

        var metricsSection = renderCorrelatedMetrics(state, data);
        metricsSection.style.marginTop = 'var(--space-4)';
        containerEl.appendChild(metricsSection);

        var timelineSection = VB.section();
        timelineSection.style.marginTop = 'var(--space-4)';
        timelineSection.appendChild(renderTimeline(data));
        containerEl.appendChild(timelineSection);
    }

    var view = {
        id: VIEW_ID,
        mount: function (container, state, data) { containerEl = container; render(state, data); },
        update: function (state, data) { if (containerEl) { render(state, data); } },
        resize: function () { global.ChartRegistry.resizeAll(); },
        unmount: function () {
            global.ChartRegistry.disposeView(VIEW_ID);
            if (containerEl) { containerEl.innerHTML = ''; }
            containerEl = null;
        }
    };

    global.DLViews = global.DLViews || {};
    global.DLViews.investigation = view;
})(window);
