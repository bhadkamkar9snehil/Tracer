/* publishing.js - Publishing view (#/publishing) */
(function (global) {
    'use strict';

    var VIEW_ID = 'publishing';
    var el = global.Interactions.el;
    var VB = global.ViewBuilders;
    var F = global.Formatters;

    var containerEl = null;

    function ctx() { return global.DLContext || {}; }

    function renderSummary(data) {
        var s = data.summary;
        return VB.metricStrip([
            { label: 'Published Datasets', value: F.formatInteger(s.publishedDatasets.value) },
            { label: 'Active Consumers', value: F.formatInteger(s.activeConsumers.value) },
            { label: 'Refresh Success', value: F.formatPercent(s.refreshSuccessPercent.value) },
            { label: 'Refresh Failures', value: F.formatInteger(s.refreshFailures.value) },
            { label: 'Serving Latency', value: F.formatDurationMs(s.servingLatencyMs.value) },
            { label: 'Requests', value: F.formatInteger(s.requests.value) }
        ]);
    }

    function renderGraph(data, parentEl) {
        var built = VB.panel('Datasets and Consumers', { tall: true });
        parentEl.appendChild(built.panel);
        var nodes = [];
        var dCount = data.datasets.length, cCount = data.consumers.length;
        data.datasets.forEach(function (d, i) {
            nodes.push({ id: 'ds:' + d, name: d, x: -180, y: (i - (dCount - 1) / 2) * 70, fixed: true, itemStyle: { color: global.ChartFactory.palette[0] } });
        });
        data.consumers.forEach(function (c, i) {
            nodes.push({ id: 'c:' + c, name: c, x: 180, y: (i - (cCount - 1) / 2) * 70, fixed: true, itemStyle: { color: global.ChartFactory.palette[4] } });
        });
        var edges = data.graphEdges.map(function (e) { return { source: 'ds:' + e.from, target: 'c:' + e.to }; });
        var chart = global.ChartFactory.createGraph(built.canvas, { layout: 'none', nodes: nodes, edges: edges });
        global.ChartRegistry.register('pub-graph', chart, VIEW_ID, built.canvas);
    }

    function renderRefreshTimeline(data) {
        var built = VB.panel('Refresh Timeline');
        var rows = data.refreshTimeline.map(function (r) { return r.dataset; });
        var items = data.refreshTimeline.map(function (r, i) { return { row: i, label: r.dataset, start: 0, duration: r.durationMs, color: global.ChartFactory.palette[i % 8] }; });
        var chart = global.ChartFactory.createRangeBar(built.canvas, { rows: rows, items: items, xType: 'value' });
        global.ChartRegistry.register('pub-refresh', chart, VIEW_ID, built.canvas);
        return built.panel;
    }

    function renderConsumerActivity(data) {
        var built = VB.panel('Consumer Activity');
        var sorted = data.consumerActivity.slice().sort(function (a, b) { return b.requests - a.requests; });
        var chart = global.ChartFactory.createBarChart(built.canvas, {
            horizontal: true, legend: false,
            categories: sorted.map(function (c) { return c.consumer; }),
            series: [{ name: 'Requests', data: sorted.map(function (c) { return c.requests; }) }]
        });
        global.ChartRegistry.register('pub-consumer', chart, VIEW_ID, built.canvas);
        global.ChartFactory.wireActions(built.actions, chart, { filenameBase: 'consumer-activity' });
        return built.panel;
    }

    function renderServingLatency(data) {
        var built = VB.panel('Serving Latency');
        var series = [
            { name: 'P50', data: data.servingLatency.p50 },
            { name: 'P95', data: data.servingLatency.p95, color: global.ChartFactory.stateColor.warning },
            { name: 'P99', data: data.servingLatency.p99, color: global.ChartFactory.stateColor.critical }
        ];
        var chart = global.ChartFactory.createLineChart(built.canvas, { unit: 'ms', series: series });
        global.ChartRegistry.register('pub-latency', chart, VIEW_ID, built.canvas);
        global.ChartFactory.wireActions(built.actions, chart, { series: series, unit: 'ms', title: 'Serving Latency', filenameBase: 'serving-latency', drawer: ctx().drawer });
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
        containerEl.appendChild(renderSummary(data));

        var graphSection = VB.section();
        graphSection.style.marginTop = 'var(--space-4)';
        containerEl.appendChild(graphSection);
        renderGraph(data, graphSection);

        var grid = VB.grid();
        grid.style.marginTop = 'var(--space-4)';
        var refreshCol = VB.col(12);
        refreshCol.appendChild(renderRefreshTimeline(data));
        var consumerCol = VB.col(12);
        consumerCol.appendChild(renderConsumerActivity(data));
        grid.appendChild(refreshCol);
        grid.appendChild(consumerCol);
        containerEl.appendChild(grid);

        var latSection = VB.section();
        latSection.style.marginTop = 'var(--space-4)';
        latSection.appendChild(renderServingLatency(data));
        containerEl.appendChild(latSection);
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
    global.DLViews.publishing = view;
})(window);
