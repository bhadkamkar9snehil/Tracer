/* infrastructure.js - Services (#/services) and Hosts (#/hosts) views */
(function (global) {
    'use strict';

    var el = global.Interactions.el;
    var VB = global.ViewBuilders;
    var F = global.Formatters;

    function ctx() { return global.DLContext || {}; }
    function hostLabel(state, id) { return (state.hostLabels && state.hostLabels[id]) || id; }

    /* ================= Services ================= */
    (function () {
        var VIEW_ID = 'services';
        var containerEl = null;

        function openServiceDrawer(svc) {
            ctx().drawer.open({
                title: svc.role,
                subtitle: F.formatState(svc.state),
                sections: [
                    { title: 'Current values', kv: [
                        ['Availability', F.formatPercent(svc.availabilityPercent)],
                        ['CPU', F.formatPercent(svc.cpuPercent)],
                        ['Memory', F.formatBytes(svc.memoryBytes)],
                        ['Requests', F.formatCompact(svc.requestsPerSec) + '/s'],
                        ['Errors', F.formatCompact(svc.errorsPerSec) + '/s'],
                        ['Last Update', F.formatRelativeTime((global.__DL_NOW__ || Date.now()) + svc.lastUpdateOffsetMs)]
                    ] },
                    { title: 'Technical details', kv: [
                        ['Implementation', svc.implementation || 'Not applicable'],
                        ['Host', hostLabel(ctx().store.getState(), svc.host)],
                        ['Endpoint', svc.endpoint]
                    ] }
                ],
                actions: [
                    { label: 'Investigate', onClick: function () { ctx().router.navigate('investigation/' + svc.id); } },
                    { label: 'Open host', onClick: function () { ctx().router.navigate('hosts'); ctx().store.setFilter('host', svc.host); } },
                    { label: 'Copy details', onClick: function () { global.Interactions.copyText(JSON.stringify(svc, null, 2)); global.Interactions.showToast('Copied'); } }
                ]
            });
        }

        function renderTopology(data, parentEl) {
            var built = VB.panel('Service Topology', { tall: true });
            parentEl.appendChild(built.panel);
            var nodes = data.rows.map(function (r) {
                return { id: r.id, name: r.role, symbolSize: 44, itemStyle: { color: global.ChartFactory.stateColor[r.state] || global.ChartFactory.stateColor.unknown } };
            });
            nodes.push({ id: 'processing', name: 'Processing Engine', symbolSize: 44, itemStyle: { color: global.ChartFactory.palette[0] } });
            nodes.push({ id: 'publishing', name: 'Publishing', symbolSize: 44, itemStyle: { color: global.ChartFactory.palette[0] } });
            var edges = data.topologyEdges.map(function (e) { return { source: e.from, target: e.to }; });
            edges.push({ source: 'object-storage', target: 'processing' });
            edges.push({ source: 'processing', target: 'publishing' });
            var chart = global.ChartFactory.createGraph(built.canvas, {
                layout: 'force',
                nodes: nodes,
                edges: edges,
                onNodeClick: function (nodeData) {
                    var svc = data.rows.filter(function (r) { return r.id === nodeData.id; })[0];
                    if (svc) { openServiceDrawer(svc); }
                    else if (nodeData.id === 'processing') { ctx().router.navigate('processing'); }
                    else if (nodeData.id === 'publishing') { ctx().router.navigate('publishing'); }
                }
            });
            global.ChartRegistry.register('services-topology', chart, VIEW_ID, built.canvas);
        }

        function renderTable(state, data) {
            var built = VB.panel('Services');
            built.canvas.remove();
            var wrap = el('div', 'dl-table-wrap');
            var table = document.createElement('table');
            table.className = 'dl-table';
            var thead = document.createElement('thead');
            var hr = document.createElement('tr');
            ['Role', 'Host', 'State', 'Availability', 'CPU', 'Memory', 'Requests', 'Errors', 'Last Update'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
            thead.appendChild(hr);
            table.appendChild(thead);
            var tbody = document.createElement('tbody');
            data.rows.forEach(function (r) {
                var tr = document.createElement('tr');
                tr.className = 'is-clickable';
                tr.appendChild(el('td', null, r.role));
                tr.appendChild(el('td', null, hostLabel(state, r.host)));
                var stTd = document.createElement('td');
                stTd.appendChild(VB.stateBadge(r.state));
                tr.appendChild(stTd);
                tr.appendChild(el('td', 'num', F.formatPercent(r.availabilityPercent)));
                tr.appendChild(el('td', 'num', F.formatPercent(r.cpuPercent)));
                tr.appendChild(el('td', 'num', F.formatBytes(r.memoryBytes)));
                tr.appendChild(el('td', 'num', F.formatCompact(r.requestsPerSec) + '/s'));
                tr.appendChild(el('td', 'num', F.formatCompact(r.errorsPerSec) + '/s'));
                tr.appendChild(el('td', 'num', F.formatRelativeTime((global.__DL_NOW__ || Date.now()) + r.lastUpdateOffsetMs)));
                tr.addEventListener('click', function () { openServiceDrawer(r); });
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            wrap.appendChild(table);
            built.body.appendChild(wrap);
            return built.panel;
        }

        function renderAvailabilityHistory(state, data) {
            var built = VB.panel('Availability History', { tall: true });
            var rows = data.rows.map(function (r) { return { id: r.id, label: r.role }; });
            var now = global.__DL_NOW__ || Date.now();
            var from = now - global.DLStore.rangeToMs(state.timeRange.id);
            var chart = global.ChartFactory.createStatusHistory(built.canvas, {
                rows: rows, segments: data.availabilityHistory, from: from, to: now
            });
            global.ChartRegistry.register('services-availability', chart, VIEW_ID, built.canvas);
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
            renderTopology(data, containerEl);
            var tableSection = VB.section();
            tableSection.style.marginTop = 'var(--space-4)';
            tableSection.appendChild(renderTable(state, data));
            containerEl.appendChild(tableSection);
            var histSection = VB.section();
            histSection.style.marginTop = 'var(--space-4)';
            histSection.appendChild(renderAvailabilityHistory(state, data));
            containerEl.appendChild(histSection);
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
        global.DLViews.services = view;
    })();

    /* ================= Hosts ================= */
    (function () {
        var VIEW_ID = 'hosts';
        var containerEl = null;

        function renderSummary(data) {
            var s = data.summary;
            return VB.metricStrip([
                { label: 'Hosts Available', value: F.formatInteger(s.hostsAvailable.value) },
                { label: 'CPU', value: F.formatPercent(s.cpuAvgPercent.value) },
                { label: 'Memory', value: F.formatPercent(s.memoryAvgPercent.value) },
                { label: 'Disk', value: F.formatPercent(s.diskUsedPercent.value) },
                { label: 'Network', value: s.networkMbps.value.toFixed(1) + ' Mb/s' },
                { label: 'Stopped Services', value: F.formatInteger(s.stoppedServices.value) }
            ]);
        }

        function renderComparison(state, data) {
            var built = VB.panel('Host Comparison');
            built.canvas.remove();
            var wrap = el('div', 'dl-table-wrap');
            var table = document.createElement('table');
            table.className = 'dl-table';
            var thead = document.createElement('thead');
            var hr = document.createElement('tr');
            ['Host', 'CPU', 'Memory', 'Disk', 'Network Receive', 'Network Send', 'Critical Services'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
            thead.appendChild(hr);
            table.appendChild(thead);
            var tbody = document.createElement('tbody');
            data.hosts.forEach(function (h) {
                var tr = document.createElement('tr');
                tr.className = 'is-clickable';
                tr.appendChild(el('td', null, hostLabel(state, h.id)));
                tr.appendChild(el('td', 'num', F.formatPercent(h.cpu.usedPercent)));
                tr.appendChild(el('td', 'num', F.formatPercent(h.memory.usedPercent)));
                var diskUsed = h.disks.reduce(function (a, d) { return a + d.usedBytes; }, 0);
                var diskFree = h.disks.reduce(function (a, d) { return a + d.freeBytes; }, 0);
                tr.appendChild(el('td', 'num', F.formatPercent((diskUsed / (diskUsed + diskFree)) * 100)));
                tr.appendChild(el('td', 'num', F.formatBytes(h.network.rx) + '/s'));
                tr.appendChild(el('td', 'num', F.formatBytes(h.network.tx) + '/s'));
                tr.appendChild(el('td', 'num', F.formatInteger(h.criticalServices)));
                tr.addEventListener('click', function () { ctx().store.setFilter('host', h.id); });
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            wrap.appendChild(table);
            built.body.appendChild(wrap);
            return built.panel;
        }

        function renderCpuMem(state, data) {
            var cpuBuilt = VB.panel('CPU');
            var cpuSeries = Object.keys(data.cpuHistory).map(function (id, i) {
                return { name: hostLabel(state, id), data: data.cpuHistory[id], color: global.ChartFactory.palette[i] };
            });
            var cpuChart = global.ChartFactory.createLineChart(cpuBuilt.canvas, { unit: '%', series: cpuSeries });
            global.ChartRegistry.register('hosts-cpu', cpuChart, VIEW_ID, cpuBuilt.canvas);
            global.ChartFactory.wireActions(cpuBuilt.actions, cpuChart, { series: cpuSeries, unit: '%', title: 'CPU', filenameBase: 'hosts-cpu', drawer: ctx().drawer });

            var memBuilt = VB.panel('Memory');
            var memSeries = Object.keys(data.memHistory).map(function (id, i) {
                return { name: hostLabel(state, id), data: data.memHistory[id], color: global.ChartFactory.palette[i] };
            });
            var memChart = global.ChartFactory.createLineChart(memBuilt.canvas, { unit: '%', series: memSeries });
            global.ChartRegistry.register('hosts-mem', memChart, VIEW_ID, memBuilt.canvas);
            global.ChartFactory.wireActions(memBuilt.actions, memChart, { series: memSeries, unit: '%', title: 'Memory', filenameBase: 'hosts-memory', drawer: ctx().drawer });

            var grid = VB.grid();
            var c1 = VB.col(12); c1.appendChild(cpuBuilt.panel);
            var c2 = VB.col(12); c2.appendChild(memBuilt.panel);
            grid.appendChild(c1); grid.appendChild(c2);
            return grid;
        }

        function renderDisks(state, data) {
            var built = VB.panel('Disk');
            built.canvas.remove();
            var wrap = el('div', 'dl-table-wrap');
            var table = document.createElement('table');
            table.className = 'dl-table';
            var thead = document.createElement('thead');
            var hr = document.createElement('tr');
            ['Host', 'Drive', 'Used', 'Free', 'Read Rate', 'Write Rate', 'Queue', 'Latency'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
            thead.appendChild(hr);
            table.appendChild(thead);
            var tbody = document.createElement('tbody');
            data.hosts.forEach(function (h) {
                h.disks.forEach(function (d) {
                    var tr = document.createElement('tr');
                    tr.appendChild(el('td', null, hostLabel(state, h.id)));
                    tr.appendChild(el('td', null, d.name));
                    tr.appendChild(el('td', 'num', F.formatBytes(d.usedBytes)));
                    tr.appendChild(el('td', 'num', F.formatBytes(d.freeBytes)));
                    tr.appendChild(el('td', 'num', F.formatBytes(d.readBps) + '/s'));
                    tr.appendChild(el('td', 'num', F.formatBytes(d.writeBps) + '/s'));
                    tr.appendChild(el('td', 'num', d.queue.toFixed(1)));
                    tr.appendChild(el('td', 'num', d.latencyMs.toFixed(1) + ' ms'));
                    tbody.appendChild(tr);
                });
            });
            table.appendChild(tbody);
            wrap.appendChild(table);
            built.body.appendChild(wrap);
            return built.panel;
        }

        function renderNetwork(data) {
            var built = VB.panel('Network');
            var series = [
                { name: 'Receive', data: data.networkHistory.rx },
                { name: 'Send', data: data.networkHistory.tx },
                { name: 'Errors', data: data.networkHistory.errors, color: global.ChartFactory.stateColor.critical },
                { name: 'Drops', data: data.networkHistory.drops, color: global.ChartFactory.stateColor.warning }
            ];
            var chart = global.ChartFactory.createLineChart(built.canvas, { unit: 'bytes', series: series });
            global.ChartRegistry.register('hosts-network', chart, VIEW_ID, built.canvas);
            global.ChartFactory.wireActions(built.actions, chart, { series: series, unit: 'bytes', title: 'Network', filenameBase: 'hosts-network', drawer: ctx().drawer });
            return built.panel;
        }

        function renderFailures(state, data) {
            var built = VB.panel('Service Failures');
            built.canvas.remove();
            if (!data.serviceFailures.length) {
                global.ChartFactory.renderEmptyState(built.body, {});
                return built.panel;
            }
            var list = el('div');
            data.serviceFailures.forEach(function (f) {
                var row = el('div', 'dl-related-link');
                var head = el('strong', null, hostLabel(state, f.host));
                row.appendChild(head);
                row.appendChild(document.createTextNode(' · ' + f.role));
                row.appendChild(el('div', 'dl-provenance', f.count + ' failure' + (f.count > 1 ? 's' : '') + ' · ' + F.formatRelativeTime((global.__DL_NOW__ || Date.now()) + f.lastOffsetMs)));
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
            containerEl.appendChild(renderSummary(data));
            var cmpSection = VB.section();
            cmpSection.style.marginTop = 'var(--space-4)';
            cmpSection.appendChild(renderComparison(state, data));
            containerEl.appendChild(cmpSection);

            var cpuMemGrid = renderCpuMem(state, data);
            cpuMemGrid.style.marginTop = 'var(--space-4)';
            containerEl.appendChild(cpuMemGrid);

            var diskSection = VB.section();
            diskSection.style.marginTop = 'var(--space-4)';
            diskSection.appendChild(renderDisks(state, data));
            containerEl.appendChild(diskSection);

            var grid2 = VB.grid();
            grid2.style.marginTop = 'var(--space-4)';
            var netCol = VB.col(16); netCol.appendChild(renderNetwork(data));
            var failCol = VB.col(8); failCol.appendChild(renderFailures(state, data));
            grid2.appendChild(netCol); grid2.appendChild(failCol);
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
        global.DLViews.hosts = view;
    })();
})(window);
