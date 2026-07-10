/* overview.js - Flow view (#/flow), the default landing view */
(function (global) {
    'use strict';

    var VIEW_ID = 'flow';
    var el = global.Interactions.el;
    var VB = global.ViewBuilders;

    var NODE_NAV = {
        sources: 'acquisition',
        acquisition: 'acquisition',
        landing: 'storage',
        validation: 'quality',
        processing: 'processing',
        curated: 'storage',
        publishing: 'publishing',
        consumers: 'publishing'
    };

    var containerEl = null;
    var animTimer = null;

    function ctx() { return global.DLContext || {}; }

    function fmtRate(v) { return global.Formatters.formatCompact(v) + '/s'; }

    function renderFlowGraph(state, data) {
        var wrap = el('div', 'dl-flow-wrap');
        var mainRow = el('div');
        mainRow.style.display = 'flex';
        mainRow.style.alignItems = 'stretch';
        mainRow.style.gap = '4px';
        mainRow.style.flexWrap = 'nowrap';
        mainRow.style.overflowX = 'auto';
        mainRow.style.paddingBottom = 'var(--space-2)';

        var reducedMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

        data.stages.forEach(function (stage, i) {
            var node = el('div', 'dl-flow-node');
            node.style.flex = '1 1 0';
            node.style.minWidth = '128px';
            node.style.textAlign = 'left';
            node.setAttribute('tabindex', '0');
            node.setAttribute('role', 'button');
            var stateInline = VB.stateInline(stage.state);
            node.appendChild(el('div', 'dl-metric-sub', stage.label));
            var rateEl = el('div', null, stage.state === 'unavailable' ? '—' : fmtRate(stage.rate));
            rateEl.style.fontSize = '18px';
            rateEl.style.fontWeight = '600';
            rateEl.style.margin = '2px 0';
            node.appendChild(rateEl);
            node.appendChild(stateInline);
            var navTarget = NODE_NAV[stage.id];
            var go = function () { if (navTarget && ctx().router) { ctx().router.navigate(navTarget); } };
            node.addEventListener('click', go);
            node.addEventListener('keydown', function (evt) { if (evt.key === 'Enter') { go(); } });
            mainRow.appendChild(node);

            if (i < data.stages.length - 1) {
                var edge = (data.edges || [])[i];
                var edgeWrap = el('div');
                edgeWrap.style.display = 'flex';
                edgeWrap.style.flexDirection = 'column';
                edgeWrap.style.alignItems = 'center';
                edgeWrap.style.justifyContent = 'center';
                edgeWrap.style.minWidth = '64px';
                edgeWrap.style.position = 'relative';
                var line = el('div');
                line.style.width = '100%';
                line.style.height = '2px';
                line.style.background = 'var(--border-strong)';
                line.style.position = 'relative';
                line.style.overflow = 'hidden';
                if (!reducedMotion) {
                    var marker = el('div');
                    marker.style.position = 'absolute';
                    marker.style.top = '-2px';
                    marker.style.width = '6px';
                    marker.style.height = '6px';
                    marker.style.borderRadius = '50%';
                    marker.style.background = 'var(--accent-primary)';
                    marker.style.opacity = '0.3';
                    marker.style.animation = 'dl-flow-move ' + (5 + (i % 3)) + 's linear infinite';
                    line.appendChild(marker);
                }
                edgeWrap.appendChild(line);
                if (edge) {
                    var edgeLabel = el('div', 'dl-provenance', fmtRate(edge.rate) + ' · ' + edge.latencyMs + ' ms');
                    edgeLabel.style.marginTop = '4px';
                    edgeWrap.appendChild(edgeLabel);
                }
                mainRow.appendChild(edgeWrap);
            }
        });
        wrap.appendChild(mainRow);

        if (!document.getElementById('dl-flow-anim-style')) {
            var styleTag = document.createElement('style');
            styleTag.id = 'dl-flow-anim-style';
            styleTag.textContent = '@keyframes dl-flow-move { from { left: -6px; } to { left: 100%; } }';
            document.head.appendChild(styleTag);
        }

        var supportRow = el('div');
        supportRow.style.display = 'flex';
        supportRow.style.gap = 'var(--space-3)';
        supportRow.style.marginTop = 'var(--space-4)';
        supportRow.style.paddingTop = 'var(--space-3)';
        supportRow.style.borderTop = '1px solid var(--border-secondary)';

        function supportNode(label, target) {
            var n = el('button', 'dl-btn', label);
            n.type = 'button';
            n.addEventListener('click', function () { if (ctx().router) { ctx().router.navigate(target); } });
            return n;
        }
        supportRow.appendChild(supportNode('Object Storage', 'storage'));
        supportRow.appendChild(supportNode('Services', 'services'));
        supportRow.appendChild(supportNode('Hosts', 'hosts'));
        supportRow.appendChild(supportNode('Logs', 'logs'));
        wrap.appendChild(supportRow);

        return wrap;
    }

    function renderTiming(data) {
        var built = VB.panel('Processing Timeline', { tall: false });
        var rows = ['Pipeline'];
        var items = [];
        var cursor = 0;
        (data.timing || []).forEach(function (t, i) {
            items.push({ row: 0, label: t.stage, start: cursor, duration: t.durationMs, color: global.ChartFactory.palette[i % 8] });
            cursor += t.durationMs;
        });
        var totalEl = el('div', 'dl-metric-sub', 'Total ' + global.Formatters.formatDurationMs(data.totalDurationMs));
        built.body.insertBefore(totalEl, built.canvas);
        var chart = global.ChartFactory.createRangeBar(built.canvas, { rows: rows, items: items, xType: 'value' });
        global.ChartRegistry.register('flow-timing', chart, VIEW_ID, built.canvas);
        return built.panel;
    }

    function renderActivity(state, data) {
        var built = VB.panel('Recent Activity');
        built.canvas.remove();
        var list = el('div');
        (data.activity || []).forEach(function (e) {
            var row = el('div', 'dl-event-row');
            row.setAttribute('tabindex', '0');
            row.appendChild(el('div', 'time', global.Formatters.formatClock(e.time)));
            row.appendChild(el('div', 'layer', e.layer));
            row.appendChild(el('div', null, e.summary));
            row.appendChild(VB.stateBadge(e.state));
            row.appendChild(el('div', 'duration', e.durationMs ? global.Formatters.formatDurationMs(e.durationMs) : '—'));
            var open = function () {
                if (ctx().drawer) {
                    ctx().drawer.open({
                        title: e.summary,
                        subtitle: e.layer + ' · ' + global.Formatters.formatClock(e.time),
                        sections: [
                            { title: 'State', kv: [['State', global.Formatters.formatState(e.state)], ['Severity', global.Formatters.formatState(e.severity)], ['Duration', e.durationMs ? global.Formatters.formatDurationMs(e.durationMs) : '—']] },
                            { title: 'Details', kv: [['Host', e.host], ['Correlation ID', e.correlationId], ['Message', e.message]] }
                        ],
                        actions: [{ label: 'Open logs', onClick: function () { ctx().router.navigate('logs'); } }]
                    });
                }
            };
            row.addEventListener('click', open);
            row.addEventListener('keydown', function (evt) { if (evt.key === 'Enter') { open(); } });
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
        var s = data.summary;
        var metricStrip = VB.metricStrip([
            { label: 'Overall Health', value: global.Formatters.formatState(s.overallHealth.value) },
            { label: 'Freshness', value: global.Formatters.formatDurationSeconds(s.freshnessSec.value) },
            { label: 'Input Rate', value: fmtRate(s.inputRate.value), sub: 'records/s' },
            { label: 'Processing Rate', value: fmtRate(s.processingRate.value), sub: 'records/s' },
            { label: 'Stored Data', value: global.Formatters.formatBytes(s.storedDataBytes.value) },
            { label: 'Open Events', value: global.Formatters.formatInteger(s.openEvents.value), onClick: function () { ctx().router.navigate('logs'); } }
        ]);
        containerEl.appendChild(metricStrip);

        var pipelinePanel = VB.panel('Data Flow');
        pipelinePanel.canvas.remove();
        pipelinePanel.body.appendChild(renderFlowGraph(state, data));
        pipelinePanel.panel.style.marginTop = 'var(--space-4)';
        containerEl.appendChild(pipelinePanel.panel);

        var grid = VB.grid();
        grid.style.marginTop = 'var(--space-4)';
        var col1 = VB.col(10);
        col1.appendChild(renderTiming(data));
        var col2 = VB.col(14);
        col2.appendChild(renderActivity(state, data));
        grid.appendChild(col1);
        grid.appendChild(col2);
        containerEl.appendChild(grid);
    }

    var view = {
        id: VIEW_ID,
        mount: function (container, state, data) {
            containerEl = container;
            render(state, data);
        },
        update: function (state, data) {
            if (!containerEl) { return; }
            render(state, data);
        },
        resize: function () {
            global.ChartRegistry.resizeAll();
        },
        unmount: function () {
            if (animTimer) { clearTimeout(animTimer); animTimer = null; }
            global.ChartRegistry.disposeView(VIEW_ID);
            if (containerEl) { containerEl.innerHTML = ''; }
            containerEl = null;
        }
    };

    global.DLViews = global.DLViews || {};
    global.DLViews.flow = view;
})(window);
