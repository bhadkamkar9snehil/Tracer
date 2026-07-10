/* processing.js - Processing view (#/processing). Handles the case where the
   processing engine has no active session without fabricating data. */
(function (global) {
    'use strict';

    var VIEW_ID = 'processing';
    var el = global.Interactions.el;
    var VB = global.ViewBuilders;
    var F = global.Formatters;

    var containerEl = null;

    function ctx() { return global.DLContext || {}; }

    function technicalDrawer(data) {
        ctx().drawer.open({
            title: 'Processing Engine',
            subtitle: 'Technical details',
            sections: [{
                title: 'Technical details',
                kv: [
                    ['Implementation', data.technical.implementation],
                    ['Application', data.technical.application],
                    ['Driver Endpoint', data.technical.driverEndpoint],
                    ['Executor Endpoint', data.technical.executorEndpoint],
                    ['State', F.formatState(data.engineState)]
                ]
            }],
            actions: [{ label: 'Investigate', onClick: function () { ctx().router.navigate('investigation/processing'); } }]
        });
    }

    function renderStateBanner(data) {
        var unavailable = data.engineState === 'unavailable';
        var built = VB.panel('Engine State');
        built.canvas.remove();
        built.body.appendChild(VB.stateInline(data.engineState));
        if (unavailable) {
            var msg = el('div', 'dl-metric-sub', 'No active processing session.');
            msg.style.marginTop = 'var(--space-2)';
            built.body.appendChild(msg);
            var lastUpdate = el('div', 'dl-provenance', 'Last successful update ' + F.formatRelativeTime(data.lastKnownAt));
            lastUpdate.style.marginTop = 'var(--space-1)';
            built.body.appendChild(lastUpdate);
        }
        var techBtn = el('button', 'dl-technical-toggle', 'Technical details');
        techBtn.type = 'button';
        techBtn.style.marginTop = 'var(--space-3)';
        techBtn.addEventListener('click', function () { technicalDrawer(data); });
        built.body.appendChild(techBtn);
        return built.panel;
    }

    function renderSummary(data) {
        var s = data.summary;
        var unavailable = data.engineState === 'unavailable';
        return VB.metricStrip([
            { label: 'Active Jobs', value: F.formatInteger(s.activeJobs.value) },
            { label: 'Queued Jobs', value: F.formatInteger(s.queuedJobs.value) },
            { label: 'Running Tasks', value: F.formatInteger(s.runningTasks.value) },
            { label: 'Failed Tasks', value: F.formatInteger(s.failedTasks.value), sub: unavailable ? 'Last known' : undefined },
            { label: 'Processing Rate', value: s.processingRate ? F.formatCompact(s.processingRate.value) + '/s' : '—', sub: unavailable ? 'No active session' : undefined }
        ]);
    }

    function renderJobTimeline(data) {
        var unavailable = data.engineState === 'unavailable';
        var built = VB.panel('Job Timeline' + (unavailable ? ' (Last Known)' : ''));
        if (!data.lastKnownJobs.length) {
            built.canvas.remove();
            global.ChartFactory.renderEmptyState(built.body, {});
            return built.panel;
        }
        var rows = data.lastKnownJobs.map(function (j) { return j.job; });
        var items = data.lastKnownJobs.map(function (j, i) {
            return { row: i, label: j.stage, start: j.startOffsetMs, duration: j.durationMs, state: j.state };
        });
        var chart = global.ChartFactory.createRangeBar(built.canvas, { rows: rows, items: items, xType: 'value' });
        global.ChartRegistry.register('proc-timeline', chart, VIEW_ID, built.canvas);
        return built.panel;
    }

    function renderStageBreakdown(data) {
        var built = VB.panel('Stage Breakdown');
        if (!data.stageBreakdown.length) {
            built.canvas.remove();
            global.ChartFactory.renderEmptyState(built.body, {});
            return built.panel;
        }
        var categories = data.stageBreakdown.map(function (j) { return j.job; });
        var chart = global.ChartFactory.createBarChart(built.canvas, {
            horizontal: true, stacked: true, categories: categories,
            series: [
                { name: 'Read', data: data.stageBreakdown.map(function (j) { return j.read; }) },
                { name: 'Shuffle', data: data.stageBreakdown.map(function (j) { return j.shuffle; }) },
                { name: 'Compute', data: data.stageBreakdown.map(function (j) { return j.compute; }) },
                { name: 'Write', data: data.stageBreakdown.map(function (j) { return j.write; }) }
            ]
        });
        global.ChartRegistry.register('proc-stage', chart, VIEW_ID, built.canvas);
        return built.panel;
    }

    function renderRateHistory(data) {
        var built = VB.panel('Processing Rate History');
        if (!data.rateHistory) {
            built.canvas.remove();
            global.ChartFactory.renderEmptyState(built.body, { lastUpdate: data.lastKnownAt });
            return built.panel;
        }
        var series = [
            { name: 'Input records/s', data: data.rateHistory.input },
            { name: 'Processed records/s', data: data.rateHistory.processed },
            { name: 'Output records/s', data: data.rateHistory.output }
        ];
        var chart = global.ChartFactory.createLineChart(built.canvas, { unit: '/s', series: series });
        global.ChartRegistry.register('proc-rate', chart, VIEW_ID, built.canvas);
        global.ChartFactory.wireActions(built.actions, chart, { series: series, unit: '/s', title: 'Processing Rate History', filenameBase: 'processing-rate', drawer: ctx().drawer });
        return built.panel;
    }

    function renderFailureAnalysis(data) {
        var built = VB.panel('Failure Analysis');
        var chart = global.ChartFactory.createBarChart(built.canvas, {
            legend: false,
            categories: data.failureAnalysis.map(function (f) { return f.reason; }),
            series: [{ name: 'Failures', data: data.failureAnalysis.map(function (f) { return f.count; }), color: global.ChartFactory.stateColor.critical }]
        });
        global.ChartRegistry.register('proc-failures', chart, VIEW_ID, built.canvas);
        global.ChartFactory.wireActions(built.actions, chart, { filenameBase: 'failure-analysis' });
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
        containerEl.appendChild(renderStateBanner(data));

        var summarySection = VB.section();
        summarySection.style.marginTop = 'var(--space-4)';
        summarySection.appendChild(renderSummary(data));
        containerEl.appendChild(summarySection);

        var grid1 = VB.grid();
        grid1.style.marginTop = 'var(--space-4)';
        var timelineCol = VB.col(24);
        timelineCol.appendChild(renderJobTimeline(data));
        grid1.appendChild(timelineCol);
        containerEl.appendChild(grid1);

        var stageSection = VB.section();
        stageSection.style.marginTop = 'var(--space-4)';
        stageSection.appendChild(renderStageBreakdown(data));
        containerEl.appendChild(stageSection);

        var grid2 = VB.grid();
        grid2.style.marginTop = 'var(--space-4)';
        var rateCol = VB.col(12);
        rateCol.appendChild(renderRateHistory(data));
        var failCol = VB.col(12);
        failCol.appendChild(renderFailureAnalysis(data));
        grid2.appendChild(rateCol);
        grid2.appendChild(failCol);
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
    global.DLViews.processing = view;
})(window);
