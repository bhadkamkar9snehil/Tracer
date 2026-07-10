/* storage.js - Storage view (#/storage). Surfaces Object Storage metrics under
   a functional "Storage" heading; implementation name (MinIO) only appears in
   the technical details drawer. */
(function (global) {
    'use strict';

    var VIEW_ID = 'storage';
    var el = global.Interactions.el;
    var VB = global.ViewBuilders;
    var F = global.Formatters;

    var containerEl = null;

    function ctx() { return global.DLContext || {}; }

    function technicalDrawer(raw) {
        ctx().drawer.open({
            title: 'Object Storage',
            subtitle: 'Technical details',
            expanded: false,
            sections: [
                {
                    title: 'Technical details',
                    kv: [
                        ['Role', 'Object Storage'],
                        ['Implementation', 'MinIO'],
                        ['Host', 'VM1'],
                        ['Endpoint', '10.2.8.237:9000'],
                        ['Metrics Endpoint', '/minio/metrics/v3'],
                        ['Metrics Job', 'minio'],
                        ['State', raw.clusterHealth === 1 ? 'UP' : 'DOWN'],
                        ['Last Scrape', F.formatClock(global.__DL_NOW__ || Date.now())],
                        ['Scrape Interval', '30 s']
                    ]
                }
            ],
            actions: [{ label: 'Investigate', onClick: function () { ctx().router.navigate('investigation/object-storage'); } }]
        });
    }

    function renderHeader(state, data) {
        var raw = data.raw, derived = data.derived;
        var healthState = raw.clusterHealth === 1 ? (raw.driveHealth === 2 ? 'warning' : (raw.driveHealth === 0 ? 'critical' : 'healthy')) : 'critical';
        var strip = VB.metricStrip([
            { label: 'Health', value: F.formatState(healthState) },
            { label: 'Usable Capacity', value: F.formatBytes(raw.usableCapacityBytes) },
            { label: 'Free Capacity', value: F.formatBytes(raw.freeCapacityBytes), sub: F.formatPercent(derived.freePercent) + ' free' },
            { label: 'Stored Data', value: F.formatBytes(raw.storedDataBytes) },
            { label: 'Objects', value: F.formatInteger(raw.objectCount) },
            { label: 'Namespaces', value: F.formatInteger(raw.namespaceCount) }
        ]);
        return strip;
    }

    function renderCapacity(data) {
        var raw = data.raw, derived = data.derived;
        var built = VB.panel('Capacity');
        built.canvas.remove();
        global.Interactions.buildChartActionMenu(built.actions, {
            onOpenData: function () {
                global.Interactions.openDataTableDrawer(ctx().drawer, 'Capacity', ['Metric', 'Value'], [
                    ['Usable total', F.formatBytes(raw.usableCapacityBytes)],
                    ['Usable used', F.formatBytes(derived.usableUsedBytes)],
                    ['Usable free', F.formatBytes(raw.freeCapacityBytes)],
                    ['Managed data (namespace)', F.formatBytes(raw.storedDataBytes)],
                    ['Underlying drive use', F.formatBytes(raw.underlyingDriveUsedBytes)]
                ]);
            }
        });
        var bar = el('div', 'dl-capacity-bar');
        var used = el('div', 'used');
        used.style.width = derived.usedPercent + '%';
        var free = el('div', 'free');
        free.style.width = derived.freePercent + '%';
        bar.appendChild(used);
        bar.appendChild(free);
        built.body.appendChild(bar);

        var legend = el('div', 'dl-capacity-legend');
        var usedItem = el('span', null);
        usedItem.innerHTML = '<span class="dl-legend-swatch" style="background:var(--accent-primary)"></span>' +
            F.formatBytes(derived.usableUsedBytes) + ' used';
        var freeItem = el('span', null);
        freeItem.innerHTML = '<span class="dl-legend-swatch" style="background:var(--bg-emphasis);border:1px solid var(--border-primary)"></span>' +
            F.formatBytes(raw.freeCapacityBytes) + ' free · ' + F.formatPercent(derived.usedPercent) + ' used';
        legend.appendChild(usedItem);
        legend.appendChild(freeItem);
        built.body.appendChild(legend);

        var distinction = el('div');
        distinction.style.marginTop = 'var(--space-3)';
        distinction.style.paddingTop = 'var(--space-3)';
        distinction.style.borderTop = '1px solid var(--border-secondary)';
        var managedRow = el('div', 'dl-kv-list');
        managedRow.style.gridTemplateColumns = 'auto auto';
        managedRow.appendChild(el('dt', null, 'Managed objects'));
        managedRow.appendChild(el('dd', null, F.formatBytes(raw.storedDataBytes)));
        managedRow.appendChild(el('dt', null, 'Underlying drive use'));
        managedRow.appendChild(el('dd', null, F.formatBytes(raw.underlyingDriveUsedBytes)));
        distinction.appendChild(managedRow);
        var note = el('div', 'dl-provenance', 'Managed objects reflects the data lake namespace only; underlying drive use includes all physical drive content.');
        note.style.marginTop = 'var(--space-2)';
        distinction.appendChild(note);
        built.body.appendChild(distinction);

        return built.panel;
    }

    function renderStoredTrend(state, data) {
        var built = VB.panel('Stored Data');
        var chart = global.ChartFactory.createLineChart(built.canvas, {
            unit: 'bytes',
            legend: false,
            series: [{ name: 'Stored Data', data: data.storedDataSeries }]
        });
        global.ChartRegistry.register('storage-trend', chart, VIEW_ID, built.canvas);
        global.Interactions.buildChartActionMenu(built.actions, {
            onExportPng: function () { global.Interactions.exportChartPNG(chart, 'stored-data'); },
            onOpenData: function () {
                global.Interactions.openDataTableDrawer(ctx().drawer, 'Stored Data', ['Time', 'Bytes'], data.storedDataSeries.map(function (p) { return [F.formatClock(p[0]), F.formatBytes(p[1])]; }));
            }
        });
        return built.panel;
    }

    function renderNamespaceTable(data) {
        var built = VB.panel('Namespaces');
        built.canvas.remove();
        var wrap = el('div', 'dl-table-wrap');
        var table = document.createElement('table');
        table.className = 'dl-table';
        var thead = document.createElement('thead');
        var hr = document.createElement('tr');
        ['Namespace', 'Objects', 'Stored Data', 'Latest Activity', 'State'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
        thead.appendChild(hr);
        table.appendChild(thead);
        var tbody = document.createElement('tbody');
        data.raw.namespaces.forEach(function (ns) {
            var tr = document.createElement('tr');
            tr.className = 'is-clickable';
            tr.appendChild(el('td', null, ns.name));
            tr.appendChild(el('td', 'num', F.formatInteger(ns.objectCount)));
            tr.appendChild(el('td', 'num', F.formatBytes(ns.storedBytes)));
            tr.appendChild(el('td', null, '68 s ago'));
            var stateTd = document.createElement('td');
            stateTd.appendChild(VB.stateBadge('healthy'));
            tr.appendChild(stateTd);
            tr.addEventListener('click', function () { ctx().router.navigate('detail/namespace/' + ns.name); });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        built.body.appendChild(wrap);
        return built.panel;
    }

    function renderRequestRate(state, data) {
        var built = VB.panel('Request Rate');
        var series = [
            { name: 'Requests/s', data: data.requestRate.requestsPerSec },
            { name: 'Errors/s', data: data.requestRate.errorsPerSec, color: global.ChartFactory.stateColor.critical }
        ];
        var chart = global.ChartFactory.createLineChart(built.canvas, { unit: '/s', series: series });
        global.ChartRegistry.register('storage-request-rate', chart, VIEW_ID, built.canvas);
        global.ChartFactory.wireActions(built.actions, chart, { series: series, unit: '/s', title: 'Request Rate', filenameBase: 'request-rate', drawer: ctx().drawer });
        return built.panel;
    }

    function renderTraffic(state, data) {
        var built = VB.panel('Traffic');
        var series = [
            { name: 'Sent bytes/s', data: data.traffic.sentBytesPerSec },
            { name: 'Received bytes/s', data: data.traffic.receivedBytesPerSec, color: global.ChartFactory.palette[3] }
        ];
        var chart = global.ChartFactory.createLineChart(built.canvas, { unit: 'bytes', series: series });
        global.ChartRegistry.register('storage-traffic', chart, VIEW_ID, built.canvas);
        global.ChartFactory.wireActions(built.actions, chart, { series: series, unit: 'bytes', title: 'Traffic', filenameBase: 'traffic', drawer: ctx().drawer });
        return built.panel;
    }

    function renderOperationTable(data) {
        var built = VB.panel('Request Operations');
        built.canvas.remove();
        var uptimeSec = data.raw.serviceUptimeSeconds;
        var mode = 'total';
        var toggle = el('div', 'dl-filter-bar');
        var totalBtn = el('button', 'dl-btn is-active', 'Total');
        var rateBtn = el('button', 'dl-btn', 'Rate');
        totalBtn.type = 'button'; rateBtn.type = 'button';
        toggle.appendChild(totalBtn);
        toggle.appendChild(rateBtn);
        built.body.appendChild(toggle);

        var wrap = el('div', 'dl-table-wrap');
        var table = document.createElement('table');
        table.className = 'dl-table';
        wrap.appendChild(table);
        built.body.appendChild(wrap);

        function renderTable() {
            table.innerHTML = '';
            var thead = document.createElement('thead');
            var hr = document.createElement('tr');
            var headers = mode === 'total'
                ? ['Operation', 'Requests (total)', 'Errors (total)', 'Error Rate', 'P50', 'P95']
                : ['Operation', 'Requests/s', 'Errors/s', 'Error Rate', 'P50', 'P95'];
            headers.forEach(function (h) { hr.appendChild(el('th', null, h)); });
            thead.appendChild(hr);
            table.appendChild(thead);
            var tbody = document.createElement('tbody');
            data.requestOperations.forEach(function (op, i) {
                var tr = document.createElement('tr');
                var errRate = op.requests > 0 ? (op.errors / op.requests) * 100 : 0;
                var reqDisplay = mode === 'total' ? F.formatInteger(op.requests) : F.formatCompact(op.requests / uptimeSec) + '/s';
                var errDisplay = mode === 'total' ? F.formatInteger(op.errors) : F.formatCompact(op.errors / uptimeSec) + '/s';
                tr.appendChild(el('td', null, op.operation));
                tr.appendChild(el('td', 'num', reqDisplay));
                tr.appendChild(el('td', 'num', errDisplay));
                tr.appendChild(el('td', 'num', F.formatPercent(errRate)));
                tr.appendChild(el('td', 'num', (18 + i * 3) + ' ms'));
                tr.appendChild(el('td', 'num', (40 + i * 6) + ' ms'));
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
        }
        totalBtn.addEventListener('click', function () { mode = 'total'; totalBtn.classList.add('is-active'); rateBtn.classList.remove('is-active'); renderTable(); });
        rateBtn.addEventListener('click', function () { mode = 'rate'; rateBtn.classList.add('is-active'); totalBtn.classList.remove('is-active'); renderTable(); });
        renderTable();

        var note = el('div', 'dl-provenance', 'Totals are cumulative counters since service start. Rate is derived (total ÷ uptime).');
        note.style.marginTop = 'var(--space-2)';
        built.body.appendChild(note);

        return built.panel;
    }

    function renderDriveLatency(data) {
        var built = VB.panel('Drive Operation Latency');
        var ops = data.raw.driveOperations || [
            { operation: 'Rename Data', metricOperation: 'storage.RenameData', latencyMicros: data.driveLatencyMicros.renameData },
            { operation: 'Delete', metricOperation: 'storage.Delete', latencyMicros: data.driveLatencyMicros['delete'] },
            { operation: 'Disk Information', metricOperation: 'storage.DiskInfo', latencyMicros: data.driveLatencyMicros.diskInfo }
        ];
        var categories = ops.map(function (o) { return o.operation; });
        var values = ops.map(function (o) { return o.latencyMicros / 1000; });
        var chart = global.ChartFactory.createBarChart(built.canvas, {
            horizontal: true,
            legend: false,
            categories: categories,
            valueFormatter: function (v) { return v.toFixed(1) + ' ms'; },
            series: [{ name: 'Latency', data: values }]
        });
        global.ChartRegistry.register('storage-drive-latency', chart, VIEW_ID, built.canvas);
        global.ChartFactory.wireActions(built.actions, chart, { filenameBase: 'drive-latency' });
        return built.panel;
    }

    function renderScanner(data) {
        var raw = data.raw;
        var built = VB.panel('Scanner State');
        built.canvas.remove();
        var balance = el('div', 'dl-progress-balance');
        balance.innerHTML = '<span class="value">' + raw.scansFinished + '</span><span>completed / ' + raw.scansStarted + ' started</span>' +
            (raw.scansStarted > raw.scansFinished ? '<span class="dl-state-badge warning">ACTIVE SCAN</span>' : '');
        built.body.appendChild(balance);
        var dl = el('dl', 'dl-kv-list');
        dl.style.marginTop = 'var(--space-3)';
        [['Objects scanned', F.formatInteger(raw.objectsScanned)],
         ['Directories scanned', F.formatInteger(raw.directoriesScanned)],
         ['Last activity', '68 s ago']].forEach(function (p) {
            dl.appendChild(el('dt', null, p[0]));
            dl.appendChild(el('dd', null, p[1]));
        });
        built.body.appendChild(dl);
        return built.panel;
    }

    function renderRuntime(data) {
        var raw = data.raw;
        var built = VB.panel('Runtime');
        built.canvas.remove();
        var dl = el('dl', 'dl-kv-list');
        [['Service Uptime', F.formatDurationSeconds(raw.serviceUptimeSeconds)],
         ['Runtime Workers', F.formatInteger(raw.runtimeWorkers)],
         ['Memory', F.formatBytes(raw.memoryUsedBytes) + ' / ' + F.formatBytes(raw.memoryTotalBytes) + ' (' + F.formatPercent(raw.memoryUsedPercent) + ')'],
         ['CPU Load', F.formatPercent(raw.cpuLoadPercent)]].forEach(function (p) {
            dl.appendChild(el('dt', null, p[0]));
            dl.appendChild(el('dd', null, p[1]));
        });
        built.body.appendChild(dl);
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

        containerEl.appendChild(renderHeader(state, data));

        var techBtn = el('button', 'dl-technical-toggle', 'Technical details');
        techBtn.type = 'button';
        techBtn.style.marginTop = 'var(--space-2)';
        techBtn.style.background = 'none';
        techBtn.addEventListener('click', function () { technicalDrawer(data.raw); });
        containerEl.appendChild(techBtn);

        var grid1 = VB.grid();
        grid1.style.marginTop = 'var(--space-4)';
        var capCol = VB.col(10);
        capCol.appendChild(renderCapacity(data));
        var trendCol = VB.col(14);
        trendCol.appendChild(renderStoredTrend(state, data));
        grid1.appendChild(capCol);
        grid1.appendChild(trendCol);
        containerEl.appendChild(grid1);

        var nsSection = VB.section();
        nsSection.style.marginTop = 'var(--space-4)';
        nsSection.appendChild(renderNamespaceTable(data));
        containerEl.appendChild(nsSection);

        var grid2 = VB.grid();
        grid2.style.marginTop = 'var(--space-4)';
        var reqCol = VB.col(12);
        reqCol.appendChild(renderRequestRate(state, data));
        var trafficCol = VB.col(12);
        trafficCol.appendChild(renderTraffic(state, data));
        grid2.appendChild(reqCol);
        grid2.appendChild(trafficCol);
        containerEl.appendChild(grid2);

        var opSection = VB.section();
        opSection.style.marginTop = 'var(--space-4)';
        opSection.appendChild(renderOperationTable(data));
        containerEl.appendChild(opSection);

        var grid3 = VB.grid();
        grid3.style.marginTop = 'var(--space-4)';
        var latCol = VB.col(12);
        latCol.appendChild(renderDriveLatency(data));
        var scanCol = VB.col(6);
        scanCol.appendChild(renderScanner(data));
        var runtimeCol = VB.col(6);
        runtimeCol.appendChild(renderRuntime(data));
        grid3.appendChild(latCol);
        grid3.appendChild(scanCol);
        grid3.appendChild(runtimeCol);
        containerEl.appendChild(grid3);
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
    global.DLViews.storage = view;
})(window);
