/* acquisition.js - Acquisition view (#/acquisition) */
(function (global) {
    'use strict';

    var VIEW_ID = 'acquisition';
    var el = global.Interactions.el;
    var VB = global.ViewBuilders;
    var F = global.Formatters;

    var containerEl = null;

    function ctx() { return global.DLContext || {}; }

    function renderSummary(data) {
        var s = data.summary;
        return VB.metricStrip([
            { label: 'Sources Active', value: F.formatInteger(s.sourcesActive.value) },
            { label: 'Input Rate', value: F.formatCompact(s.inputRate.value) + '/s' },
            { label: 'Freshness', value: F.formatDurationSeconds(s.freshnessSec.value) },
            { label: 'Dropped Records', value: F.formatInteger(s.droppedRecords.value) },
            { label: 'Reconnects', value: F.formatInteger(s.reconnects.value) },
            { label: 'Queue Depth', value: F.formatInteger(s.queueDepth.value) }
        ]);
    }

    function renderMatrix(data) {
        var built = VB.panel('Source State');
        var chart = global.ChartFactory.createHeatmap(built.canvas, {
            rows: data.matrix.rows, cols: data.matrix.cols, cells: data.matrix.cells,
            onCellClick: function (row, col, state) {
                ctx().drawer.open({
                    title: row,
                    subtitle: col + ' · ' + F.formatState(state),
                    sections: [{ title: 'State', kv: [['Metric', col], ['State', F.formatState(state)]] }],
                    actions: [{ label: 'Investigate', onClick: function () { ctx().router.navigate('investigation/acquisition'); } }]
                });
            }
        });
        global.ChartRegistry.register('acq-matrix', chart, VIEW_ID, built.canvas);
        built.body.appendChild(VB.heatmapLegend());
        return built.panel;
    }

    function renderInputRate(data) {
        var built = VB.panel('Input Rate', { tall: true });
        var series = Object.keys(data.inputRateSeries).map(function (name, i) {
            return { name: name, data: data.inputRateSeries[name], color: global.ChartFactory.palette[i] };
        });
        var chart = global.ChartFactory.createLineChart(built.canvas, { unit: '/s', series: series, zoom: true });
        global.ChartRegistry.register('acq-input-rate', chart, VIEW_ID, built.canvas);
        global.ChartFactory.wireActions(built.actions, chart, { series: series, unit: '/s', title: 'Input Rate', filenameBase: 'input-rate', drawer: ctx().drawer });
        return built.panel;
    }

    function renderFreshnessDist(data) {
        var built = VB.panel('Freshness Distribution');
        var chart = global.ChartFactory.createBarChart(built.canvas, {
            horizontal: true, legend: false,
            categories: data.freshnessDistribution.map(function (d) { return d.bucket; }),
            series: [{ name: 'Sources', data: data.freshnessDistribution.map(function (d) { return d.count; }) }]
        });
        global.ChartRegistry.register('acq-freshness', chart, VIEW_ID, built.canvas);
        global.ChartFactory.wireActions(built.actions, chart, { filenameBase: 'freshness-distribution' });
        return built.panel;
    }

    function renderQueueRetry(data) {
        var built = VB.panel('Queue and Retry History');
        var series = [
            { name: 'Queued', data: data.queueRetry.queued },
            { name: 'Retried', data: data.queueRetry.retried, color: global.ChartFactory.stateColor.warning }
        ];
        var chart = global.ChartFactory.createLineChart(built.canvas, { unit: '', series: series });
        global.ChartRegistry.register('acq-queue-retry', chart, VIEW_ID, built.canvas);
        global.ChartFactory.wireActions(built.actions, chart, { series: series, title: 'Queue and Retry History', filenameBase: 'queue-retry', drawer: ctx().drawer });
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

        var grid1 = VB.grid();
        grid1.style.marginTop = 'var(--space-4)';
        var matCol = VB.col(24);
        matCol.appendChild(renderMatrix(data));
        grid1.appendChild(matCol);
        containerEl.appendChild(grid1);

        var rateSection = VB.section();
        rateSection.style.marginTop = 'var(--space-4)';
        rateSection.appendChild(renderInputRate(data));
        containerEl.appendChild(rateSection);

        var grid2 = VB.grid();
        grid2.style.marginTop = 'var(--space-4)';
        var freshCol = VB.col(12);
        freshCol.appendChild(renderFreshnessDist(data));
        var queueCol = VB.col(12);
        queueCol.appendChild(renderQueueRetry(data));
        grid2.appendChild(freshCol);
        grid2.appendChild(queueCol);
        containerEl.appendChild(grid2);
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
    global.DLViews.acquisition = view;
})(window);
