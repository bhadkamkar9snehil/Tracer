/* quality.js - Quality view (#/quality) */
(function (global) {
    'use strict';

    var VIEW_ID = 'quality';
    var el = global.Interactions.el;
    var VB = global.ViewBuilders;
    var F = global.Formatters;

    var containerEl = null;

    function ctx() { return global.DLContext || {}; }

    function renderSummary(data) {
        var s = data.summary;
        return VB.metricStrip([
            { label: 'Checks Passed', value: F.formatInteger(s.checksPassed.value) },
            { label: 'Checks Failed', value: F.formatInteger(s.checksFailed.value) },
            { label: 'Freshness', value: F.formatDurationSeconds(s.freshnessSec.value) },
            { label: 'Rejected Records', value: F.formatInteger(s.rejectedRecords.value) },
            { label: 'Quarantined Records', value: F.formatInteger(s.quarantinedRecords.value) },
            { label: 'Promotion Success', value: F.formatPercent(s.promotionSuccessPercent.value) }
        ]);
    }

    function renderMatrix(data) {
        var built = VB.panel('Quality Matrix');
        var chart = global.ChartFactory.createHeatmap(built.canvas, {
            rows: data.matrix.rows, cols: data.matrix.cols, cells: data.matrix.cells,
            onCellClick: function (row, col, state) {
                ctx().drawer.open({
                    title: row, subtitle: col + ' · ' + F.formatState(state),
                    sections: [{ title: 'State', kv: [['Metric', col], ['State', F.formatState(state)]] }],
                    actions: [{ label: 'Investigate', onClick: function () { ctx().router.navigate('investigation/quality'); } }]
                });
            }
        });
        global.ChartRegistry.register('qual-matrix', chart, VIEW_ID, built.canvas);
        built.body.appendChild(VB.heatmapLegend());
        return built.panel;
    }

    function renderTrend(data) {
        var built = VB.panel('Failed Check Trend');
        var series = [
            { name: 'Critical', data: data.failedCheckTrend.critical, color: global.ChartFactory.stateColor.critical },
            { name: 'Warning', data: data.failedCheckTrend.warning, color: global.ChartFactory.stateColor.warning }
        ];
        var chart = global.ChartFactory.createLineChart(built.canvas, { unit: '', series: series });
        global.ChartRegistry.register('qual-trend', chart, VIEW_ID, built.canvas);
        global.ChartFactory.wireActions(built.actions, chart, { series: series, title: 'Failed Check Trend', filenameBase: 'failed-check-trend', drawer: ctx().drawer });
        return built.panel;
    }

    function renderFunnel(data) {
        var built = VB.panel('Promotion Flow');
        var chart = global.ChartFactory.createBarChart(built.canvas, {
            horizontal: true, legend: false,
            categories: data.promotionFunnel.map(function (f) { return f.stage; }),
            series: [{ name: 'Records', data: data.promotionFunnel.map(function (f) { return f.count; }) }]
        });
        global.ChartRegistry.register('qual-funnel', chart, VIEW_ID, built.canvas);
        global.ChartFactory.wireActions(built.actions, chart, { filenameBase: 'promotion-flow' });
        return built.panel;
    }

    function renderRuleTable(data) {
        var built = VB.panel('Rules');
        built.canvas.remove();
        var wrap = el('div', 'dl-table-wrap');
        var table = document.createElement('table');
        table.className = 'dl-table';
        var thead = document.createElement('thead');
        var hr = document.createElement('tr');
        ['Rule', 'Dataset', 'State', 'Affected Rows', 'Last Run', 'Duration'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
        thead.appendChild(hr);
        table.appendChild(thead);
        var tbody = document.createElement('tbody');
        data.rules.forEach(function (r) {
            var tr = document.createElement('tr');
            tr.appendChild(el('td', null, r.rule));
            tr.appendChild(el('td', null, r.dataset));
            var stTd = document.createElement('td');
            stTd.appendChild(VB.stateBadge(r.state));
            tr.appendChild(stTd);
            tr.appendChild(el('td', 'num', F.formatInteger(r.affectedRows)));
            tr.appendChild(el('td', 'num', F.formatRelativeTime((global.__DL_NOW__ || Date.now()) + r.lastRunOffsetMs)));
            tr.appendChild(el('td', 'num', F.formatDurationMs(r.durationMs)));
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        built.body.appendChild(wrap);
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

        var matrixSection = VB.section();
        matrixSection.style.marginTop = 'var(--space-4)';
        matrixSection.appendChild(renderMatrix(data));
        containerEl.appendChild(matrixSection);

        var grid = VB.grid();
        grid.style.marginTop = 'var(--space-4)';
        var trendCol = VB.col(12);
        trendCol.appendChild(renderTrend(data));
        var funnelCol = VB.col(12);
        funnelCol.appendChild(renderFunnel(data));
        grid.appendChild(trendCol);
        grid.appendChild(funnelCol);
        containerEl.appendChild(grid);

        var ruleSection = VB.section();
        ruleSection.style.marginTop = 'var(--space-4)';
        ruleSection.appendChild(renderRuleTable(data));
        containerEl.appendChild(ruleSection);
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
    global.DLViews.quality = view;
})(window);
