/* logs.js - Logs view (#/logs) */
(function (global) {
    'use strict';

    var VIEW_ID = 'logs';
    var el = global.Interactions.el;
    var VB = global.ViewBuilders;
    var F = global.Formatters;

    var containerEl = null;
    var localFilters = { severity: 'ALL', layer: 'ALL', text: '' };
    var lastData = null;
    var tableBody = null;

    function ctx() { return global.DLContext || {}; }

    function openEventDrawer(e) {
        ctx().drawer.open({
            title: e.summary,
            subtitle: F.formatState(e.severity) + ' · ' + e.layer,
            sections: [
                { title: 'State', kv: [
                    ['Timestamp', F.formatClock(e.time)],
                    ['Severity', F.formatState(e.severity)],
                    ['Layer', e.layer],
                    ['Host', ctx().store.getState().hostLabels[e.host] || e.host]
                ] },
                { title: 'Message', kv: [['Summary', e.summary], ['Message', e.message], ['Correlation ID', e.correlationId]] },
                { title: 'Related', render: function (c) {
                    var link = el('a', 'dl-related-link', 'Investigate ' + e.layer);
                    link.href = '#/investigation/' + e.layer.toLowerCase();
                    c.appendChild(link);
                } }
            ],
            actions: [
                { label: 'Investigate', onClick: function () { ctx().router.navigate('investigation/' + e.layer.toLowerCase()); } },
                { label: 'Copy details', onClick: function () { global.Interactions.copyText(JSON.stringify(e, null, 2)); global.Interactions.showToast('Copied'); } }
            ]
        });
    }

    function renderDensity(state, data) {
        var built = VB.panel('Event Density');
        var categories = data.density.map(function (d) { return d.time; });
        function seriesFor(sev) {
            return data.density.map(function (d) { return [d.time, d.counts[sev]]; });
        }
        var series = [
            { name: 'Critical', data: seriesFor('critical'), color: global.ChartFactory.stateColor.critical },
            { name: 'Warning', data: seriesFor('warning'), color: global.ChartFactory.stateColor.warning },
            { name: 'Information', data: seriesFor('information'), color: global.ChartFactory.palette[4] }
        ];
        var chart = global.ChartFactory.createLineChart(built.canvas, { legend: true, smooth: false, series: series });
        global.ChartRegistry.register('logs-density', chart, VIEW_ID, built.canvas);
        global.ChartFactory.wireActions(built.actions, chart, { series: series, title: 'Event Density', filenameBase: 'event-density', drawer: ctx().drawer });
        return built.panel;
    }

    function renderLanes(state, data) {
        var built = VB.panel('Component Lanes', { tall: true });
        var lanes = data.lanes;
        var pool = data.events;
        var seriesData = pool.map(function (e) {
            var idx = lanes.indexOf(e.layer);
            return { value: [e.time, idx >= 0 ? idx : lanes.length], itemStyle: { color: global.ChartFactory.stateColor[e.severity === 'information' ? 'unknown' : e.severity] || global.ChartFactory.stateColor.unknown }, name: e.summary, evt: e };
        });
        var option = {
            animation: true,
            textStyle: { fontFamily: '"Segoe UI", Arial, sans-serif', color: 'var(--text-secondary)' },
            grid: { left: 130, right: 20, top: 20, bottom: 40 },
            tooltip: { trigger: 'item', formatter: function (p) { return p.data.name + '<br/>' + F.formatClock(p.data.value[0]); } },
            xAxis: { type: 'time', axisLabel: { fontSize: 11 } },
            yAxis: { type: 'category', data: lanes, axisLabel: { fontSize: 11 } },
            series: [{ type: 'scatter', symbolSize: 8, data: seriesData }]
        };
        var chart = global.echarts.init(built.canvas, 'dl-light', { renderer: 'svg' });
        chart.setOption(option);
        chart.on('click', function (p) { if (p.data && p.data.evt) { openEventDrawer(p.data.evt); } });
        global.ChartRegistry.register('logs-lanes', chart, VIEW_ID, built.canvas);
        return built.panel;
    }

    function applyLocalFilters(events) {
        return events.filter(function (e) {
            if (localFilters.severity !== 'ALL' && e.severity !== localFilters.severity) { return false; }
            if (localFilters.layer !== 'ALL' && e.layer !== localFilters.layer) { return false; }
            if (localFilters.text) {
                var q = localFilters.text.toLowerCase();
                if (e.summary.toLowerCase().indexOf(q) < 0) { return false; }
            }
            return true;
        });
    }

    function renderFilterBar(state, data, onChange) {
        var bar = el('div', 'dl-filter-bar');

        function selectField(labelText, options, current, onSelect) {
            var field = el('div', 'dl-filter-field');
            field.appendChild(el('label', null, labelText));
            var select = document.createElement('select');
            options.forEach(function (o) {
                var opt = document.createElement('option');
                opt.value = o;
                opt.textContent = o;
                select.appendChild(opt);
            });
            select.value = current;
            select.addEventListener('change', function () { onSelect(select.value); onChange(); });
            field.appendChild(select);
            return field;
        }

        bar.appendChild(selectField('Severity', ['ALL', 'critical', 'warning', 'information'], localFilters.severity, function (v) { localFilters.severity = v; }));
        bar.appendChild(selectField('Layer', ['ALL'].concat(data.lanes), localFilters.layer, function (v) { localFilters.layer = v; }));
        bar.appendChild(selectField('Host', ['ALL', 'VM1', 'VM2'], state.filters.host, function (v) { ctx().store.setFilter('host', v); }));

        var searchField = el('div', 'dl-filter-field');
        searchField.appendChild(el('label', null, 'Search'));
        var input = document.createElement('input');
        input.type = 'search';
        input.className = 'dl-search-input';
        input.placeholder = 'Search summary text';
        input.value = localFilters.text;
        input.addEventListener('input', function () { localFilters.text = input.value; onChange(); });
        searchField.appendChild(input);
        bar.appendChild(searchField);

        return bar;
    }

    function renderEventList(state, data) {
        var built = VB.panel('Events');
        built.canvas.remove();
        var summary = el('div', 'dl-metric-sub');
        built.body.appendChild(summary);
        var listWrap = el('div');
        built.body.appendChild(listWrap);

        function draw() {
            var events = applyLocalFilters(data.events.filter(function (e) {
                return state.filters.host === 'ALL' || e.host === state.filters.host;
            }));
            summary.textContent = events.length + ' events';
            listWrap.innerHTML = '';
            events.slice(0, 200).forEach(function (e) {
                var row = el('div', 'dl-event-row');
                row.setAttribute('tabindex', '0');
                row.appendChild(el('div', 'time', F.formatClock(e.time)));
                var sevWrap = document.createElement('div');
                sevWrap.appendChild(VB.stateBadge(e.severity === 'information' ? 'unknown' : e.severity));
                row.appendChild(sevWrap);
                row.appendChild(el('div', null, e.summary));
                row.appendChild(el('div', 'layer', e.layer + ' · ' + (state.hostLabels[e.host] || e.host)));
                row.appendChild(el('div', 'duration', e.correlationId));
                row.addEventListener('click', function () { openEventDrawer(e); });
                row.addEventListener('keydown', function (evt) { if (evt.key === 'Enter') { openEventDrawer(e); } });
                listWrap.appendChild(row);
            });
        }
        draw();
        built._redraw = draw;
        return built;
    }

    function render(state, data) {
        containerEl.innerHTML = '';
        if (!data) {
            var loading = VB.panel('Loading');
            global.ChartFactory.renderLoadingSkeleton(loading.canvas);
            containerEl.appendChild(loading.panel);
            return;
        }
        lastData = data;

        var grid = VB.grid();
        var densCol = VB.col(24);
        densCol.appendChild(renderDensity(state, data));
        grid.appendChild(densCol);
        containerEl.appendChild(grid);

        var lanesSection = VB.section();
        lanesSection.style.marginTop = 'var(--space-4)';
        lanesSection.appendChild(renderLanes(state, data));
        containerEl.appendChild(lanesSection);

        var filterSection = VB.section();
        filterSection.style.marginTop = 'var(--space-4)';
        var eventListBuilt = renderEventList(state, data);
        var filterBar = renderFilterBar(state, data, function () { eventListBuilt._redraw(); });
        filterSection.appendChild(filterBar);
        containerEl.appendChild(filterSection);

        var listSection = VB.section();
        listSection.style.marginTop = 'var(--space-3)';
        listSection.appendChild(eventListBuilt.panel);
        containerEl.appendChild(listSection);
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
    global.DLViews.logs = view;
})(window);
