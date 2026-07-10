/* charts.js - ECharts theme registration, ChartFactory, ChartRegistry, tooltip helpers, linked groups */
(function (global) {
    'use strict';

    var PALETTE = ['#2463a7', '#4e7f72', '#9b6b3e', '#6a70a8', '#7d8792', '#b8584c', '#488095', '#81714d'];

    var STATE_COLOR = {
        healthy: '#2c7a55',
        warning: '#a66512',
        critical: '#b83a3a',
        unknown: '#64717e',
        unavailable: '#64717e'
    };

    function readCssVar(name, fallback) {
        try {
            var v = getComputedStyle(document.documentElement).getPropertyValue(name);
            return (v && v.trim()) || fallback;
        } catch (e) { return fallback; }
    }

    var echartsLib = global.echarts;

    if (echartsLib && echartsLib.registerTheme) {
        echartsLib.registerTheme('dl-light', {
            color: PALETTE,
            backgroundColor: 'transparent',
            textStyle: {},
            categoryAxis: { axisLine: { lineStyle: { color: '#c3cbd2' } } }
        });
    }

    function deepMerge(base, patch) {
        if (!patch) { return base; }
        var out = {};
        var k;
        for (k in base) { if (base.hasOwnProperty(k)) { out[k] = base[k]; } }
        for (k in patch) {
            if (!patch.hasOwnProperty(k)) { continue; }
            if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
                out[k] = deepMerge(base[k], patch[k]);
            } else {
                out[k] = patch[k];
            }
        }
        return out;
    }

    function commonOption() {
        return {
            animation: true,
            animationDuration: 350,
            animationDurationUpdate: 250,
            color: PALETTE,
            textStyle: {
                fontFamily: '"Segoe UI", Arial, sans-serif',
                color: readCssVar('--text-secondary', '#56616d')
            },
            grid: {
                left: 52,
                right: 20,
                top: 42,
                bottom: 40,
                containLabel: false
            },
            tooltip: {
                trigger: 'axis',
                appendToBody: true,
                confine: true,
                backgroundColor: readCssVar('--text-primary', '#17202a'),
                borderWidth: 0,
                textStyle: { color: '#ffffff', fontSize: 12 }
            }
        };
    }

    function timeSpan(series) {
        var min = Infinity, max = -Infinity;
        for (var s = 0; s < series.length; s++) {
            var d = series[s].data || [];
            for (var i = 0; i < d.length; i++) {
                var t = Array.isArray(d[i]) ? d[i][0] : null;
                if (t === null) { continue; }
                if (t < min) { min = t; }
                if (t > max) { max = t; }
            }
        }
        if (min === Infinity) { return 0; }
        return max - min;
    }

    function axisLabelFormatterFactory(span) {
        return function (value) {
            return global.Formatters ? global.Formatters.formatTimestamp(value, span) : String(value);
        };
    }

    function initChart(el, theme, option) {
        var chart = echartsLib.init(el, theme || 'dl-light', { renderer: 'svg' });
        chart.setOption(option);
        return chart;
    }

    function tooltipAxisFormatter(unit, span) {
        return function (params) {
            if (!params || !params.length) { return ''; }
            var t = params[0].axisValueLabel || (global.Formatters ? global.Formatters.formatTimestamp(params[0].value[0], span) : '');
            var lines = ['<div style="font-weight:600;margin-bottom:4px;">' + t + '</div>'];
            for (var i = 0; i < params.length; i++) {
                var p = params[i];
                var v = Array.isArray(p.value) ? p.value[1] : p.value;
                var vLabel = (global.Formatters && unit === 'bytes') ? global.Formatters.formatBytes(v) : (global.Formatters ? global.Formatters.formatCompact(v) : v);
                lines.push('<div>' + p.marker + ' ' + p.seriesName + ': <strong>' + vLabel + (unit && unit !== 'bytes' ? (' ' + unit) : '') + '</strong></div>');
            }
            return lines.join('');
        };
    }

    var ChartFactory = {
        palette: PALETTE,
        stateColor: STATE_COLOR,

        createLineChart: function (el, opts) {
            opts = opts || {};
            var series = opts.series || [];
            var span = timeSpan(series);
            var option = deepMerge(commonOption(), {
                legend: opts.legend === false ? undefined : { top: 0, right: 0, itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 11 } },
                grid: { top: opts.legend === false ? 30 : 46 },
                xAxis: {
                    type: 'time',
                    axisLine: { lineStyle: { color: readCssVar('--chart-axis', '#9aa5af') } },
                    axisLabel: { formatter: axisLabelFormatterFactory(span), fontSize: 11 },
                    splitLine: { show: false }
                },
                yAxis: {
                    type: 'value',
                    axisLine: { show: false },
                    axisLabel: { fontSize: 11, formatter: opts.yFormatter || function (v) { return global.Formatters ? global.Formatters.formatCompact(v) : v; } },
                    splitLine: { lineStyle: { color: readCssVar('--chart-grid', '#e7ebef') } }
                },
                tooltip: { formatter: tooltipAxisFormatter(opts.unit, span) },
                series: series.map(function (s, i) {
                    return deepMerge({
                        type: 'line',
                        name: s.name,
                        data: s.data,
                        showSymbol: false,
                        smooth: opts.smooth !== false,
                        lineStyle: { width: 2 },
                        color: s.color || PALETTE[i % PALETTE.length]
                    }, s.overrides);
                })
            });
            if (opts.zoom && series.length && series[0].data && series[0].data.length > 60) {
                option.dataZoom = [{ type: 'inside' }];
                if (opts.zoomSlider) { option.dataZoom.push({ type: 'slider', height: 16, bottom: 4 }); }
            }
            return initChart(el, opts.theme, option);
        },

        createBarChart: function (el, opts) {
            opts = opts || {};
            var horizontal = !!opts.horizontal;
            var categories = opts.categories || [];
            var series = (opts.series || []).map(function (s, i) {
                return deepMerge({
                    type: 'bar',
                    name: s.name,
                    data: s.data,
                    stack: opts.stacked ? 'stack1' : undefined,
                    barMaxWidth: 28,
                    color: s.color || PALETTE[i % PALETTE.length]
                }, s.overrides);
            });
            var catAxis = {
                type: 'category',
                data: categories,
                axisLine: { lineStyle: { color: readCssVar('--chart-axis', '#9aa5af') } },
                axisLabel: { fontSize: 11 },
                splitLine: { show: false }
            };
            var valAxis = {
                type: 'value',
                axisLine: { show: false },
                axisLabel: { fontSize: 11, formatter: opts.valueFormatter || function (v) { return global.Formatters ? global.Formatters.formatCompact(v) : v; } },
                splitLine: { lineStyle: { color: readCssVar('--chart-grid', '#e7ebef') } }
            };
            var option = deepMerge(commonOption(), {
                legend: opts.legend === false ? undefined : { top: 0, right: 0, itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 11 } },
                grid: { top: opts.legend === false ? 30 : 46, left: horizontal ? 120 : 52 },
                xAxis: horizontal ? valAxis : catAxis,
                yAxis: horizontal ? catAxis : valAxis,
                tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
                series: series
            });
            return initChart(el, opts.theme, option);
        },

        createHeatmap: function (el, opts) {
            opts = opts || {};
            var rows = opts.rows || [];
            var cols = opts.cols || [];
            var cells = opts.cells || [];
            /* ECharts heatmap requires a numeric third dimension for its internal
               range calculations - a string state value there silently produces
               zero rendered cells, even with itemStyle.color set explicitly per
               item. Encode state as a numeric code and keep the label on a
               separate "state" field for tooltips/clicks. */
            var STATE_CODE = { healthy: 0, warning: 1, critical: 2, unknown: 3 };
            var data = [];
            for (var r = 0; r < rows.length; r++) {
                for (var c = 0; c < cols.length; c++) {
                    var state = (cells[r] && cells[r][c]) || 'unknown';
                    data.push({
                        value: [c, r, STATE_CODE.hasOwnProperty(state) ? STATE_CODE[state] : STATE_CODE.unknown],
                        state: state,
                        itemStyle: { color: STATE_COLOR[state] || STATE_COLOR.unknown }
                    });
                }
            }
            var option = deepMerge(commonOption(), {
                grid: { left: 120, right: 20, top: 30, bottom: 30 },
                tooltip: {
                    trigger: 'item',
                    formatter: function (p) {
                        var st = p.data.state;
                        return rows[p.value[1]] + ' · ' + cols[p.value[0]] + '<br/><strong>' + (global.Formatters ? global.Formatters.formatState(st) : st) + '</strong>';
                    }
                },
                xAxis: { type: 'category', data: cols, splitArea: { show: true }, axisLabel: { fontSize: 11 } },
                yAxis: { type: 'category', data: rows, splitArea: { show: true }, axisLabel: { fontSize: 11 } },
                series: [{
                    type: 'heatmap',
                    data: data,
                    itemStyle: { borderColor: readCssVar('--bg-surface', '#fff'), borderWidth: 2 },
                    emphasis: { itemStyle: { borderColor: readCssVar('--text-primary', '#17202a'), borderWidth: 1 } }
                }]
            });
            var chart = initChart(el, opts.theme, option);
            if (opts.onCellClick) {
                chart.on('click', function (p) {
                    if (p.componentType === 'series') { opts.onCellClick(rows[p.value[1]], cols[p.value[0]], p.data.state); }
                });
            }
            return chart;
        },

        createGraph: function (el, opts) {
            opts = opts || {};
            /* Graph edges reference nodes by "name" in ECharts, but callers key
               nodes/edges by stable "id" strings. Use id as the internal name
               for correct edge resolution and keep the friendly label in
               "value" for display. */
            var nodes = (opts.nodes || []).map(function (n) {
                var out = {};
                for (var k in n) { if (n.hasOwnProperty(k)) { out[k] = n[k]; } }
                out.id = n.id;
                out.name = n.id;
                out.value = n.name;
                return out;
            });
            var option = deepMerge(commonOption(), {
                tooltip: { trigger: 'item', formatter: function (p) { return p.dataType === 'edge' ? '' : (p.data.value || p.data.name); } },
                series: [{
                    type: 'graph',
                    layout: opts.layout || 'none',
                    roam: opts.roam !== false,
                    symbolSize: opts.symbolSize || 36,
                    force: deepMerge({ repulsion: 420, edgeLength: 130, gravity: 0.15, friction: 0.5, layoutAnimation: true }, opts.force),
                    label: { show: true, fontSize: 11, position: 'bottom', color: readCssVar('--text-primary', '#17202a'), formatter: function (p) { return p.data.value || p.data.name; } },
                    edgeSymbol: opts.edgeSymbol || ['none', 'arrow'],
                    edgeSymbolSize: 6,
                    emphasis: { focus: 'adjacency', lineStyle: { width: 3 } },
                    lineStyle: { color: readCssVar('--border-strong', '#b7c0c8'), curveness: opts.curveness || 0 },
                    data: nodes,
                    links: opts.edges || [],
                    categories: opts.categories || []
                }]
            });
            var chart = initChart(el, opts.theme, option);
            if (opts.onNodeClick) {
                chart.on('click', function (p) {
                    if (p.dataType === 'node') { opts.onNodeClick(p.data); }
                });
            }
            return chart;
        },

        createGauge: function (el, opts) {
            opts = opts || {};
            var option = deepMerge(commonOption(), {
                series: [{
                    type: 'gauge',
                    min: opts.min || 0,
                    max: opts.max || 100,
                    progress: { show: true, width: 12 },
                    axisLine: { lineStyle: { width: 12 } },
                    pointer: { show: false },
                    axisTick: { show: false },
                    splitLine: { show: false },
                    axisLabel: { show: false },
                    detail: { valueAnimation: true, fontSize: 22, formatter: opts.formatter || '{value}%' },
                    data: [{ value: opts.value || 0 }]
                }]
            });
            return initChart(el, opts.theme, option);
        },

        createStatusHistory: function (el, opts) {
            opts = opts || {};
            var rows = opts.rows || [];
            var segments = opts.segments || {};
            var from = opts.from, to = opts.to;
            var data = [];
            for (var r = 0; r < rows.length; r++) {
                var segs = segments[rows[r].id] || [];
                for (var i = 0; i < segs.length; i++) {
                    data.push({
                        name: rows[r].label,
                        value: [r, segs[i].start, segs[i].end, segs[i].state],
                        itemStyle: { color: STATE_COLOR[segs[i].state] || STATE_COLOR.unknown }
                    });
                }
            }
            var option = deepMerge(commonOption(), {
                grid: { left: 130, right: 20, top: 20, bottom: 30 },
                tooltip: {
                    formatter: function (p) {
                        var v = p.value;
                        return p.name + '<br/>' + (global.Formatters ? global.Formatters.formatState(v[3]) : v[3]);
                    }
                },
                xAxis: { type: 'time', min: from, max: to, axisLabel: { fontSize: 11 } },
                yAxis: { type: 'category', data: rows.map(function (r) { return r.label; }), axisLabel: { fontSize: 11 } },
                series: [{
                    type: 'custom',
                    renderItem: function (params, api) {
                        var rowIdx = api.value(0);
                        var start = api.coord([api.value(1), rowIdx]);
                        var end = api.coord([api.value(2), rowIdx]);
                        var height = api.size([0, 1])[1] * 0.5;
                        return {
                            type: 'rect',
                            shape: { x: start[0], y: start[1] - height / 2, width: Math.max(2, end[0] - start[0]), height: height },
                            style: api.style()
                        };
                    },
                    encode: { x: [1, 2], y: 0 },
                    data: data
                }]
            });
            return initChart(el, opts.theme, option);
        },

        createRangeBar: function (el, opts) {
            opts = opts || {};
            var rows = opts.rows || [];
            var items = opts.items || [];
            var data = items.map(function (it) {
                return {
                    name: it.label || '',
                    value: [it.row, it.start, it.start + it.duration, it.state],
                    itemStyle: { color: it.color || STATE_COLOR[it.state] || PALETTE[0] }
                };
            });
            var option = deepMerge(commonOption(), {
                grid: { left: 150, right: 20, top: 20, bottom: 30 },
                tooltip: {
                    formatter: function (p) {
                        var v = p.value;
                        var dur = v[2] - v[1];
                        return p.name + (global.Formatters ? ('<br/>' + global.Formatters.formatDurationMs(dur)) : '');
                    }
                },
                xAxis: opts.xType === 'time' ? { type: 'time', axisLabel: { fontSize: 11 } } : { type: 'value', axisLabel: { fontSize: 11, formatter: function (v) { return global.Formatters ? global.Formatters.formatDurationMs(v) : v; } } },
                yAxis: { type: 'category', data: rows, axisLabel: { fontSize: 11 } },
                series: [{
                    type: 'custom',
                    renderItem: function (params, api) {
                        var rowIdx = api.value(0);
                        var start = api.coord([api.value(1), rowIdx]);
                        var end = api.coord([api.value(2), rowIdx]);
                        var height = api.size([0, 1])[1] * 0.55;
                        return {
                            type: 'rect',
                            shape: { x: start[0], y: start[1] - height / 2, width: Math.max(2, end[0] - start[0]), height: height, r: 2 },
                            style: api.style()
                        };
                    },
                    encode: { x: [1, 2], y: 0 },
                    data: data
                }]
            });
            return initChart(el, opts.theme, option);
        },

        createTimeline: function (el, opts) {
            return ChartFactory.createRangeBar(el, deepMerge({ xType: 'time' }, opts));
        },

        /* Wires the compact chart-action menu (Export PNG / Open data) onto a
           chart's heading. `opts.series` is the same [{name,data:[[t,v]...]}]
           array passed to createLineChart/createBarChart, reused here to build
           a plain data table for the "Open data" accessibility action (see
           section 31: chart data must be reachable without relying on the
           rendered graphic). */
        wireActions: function (actionsEl, chart, opts) {
            opts = opts || {};
            var seriesList = opts.series || [];
            global.Interactions.buildChartActionMenu(actionsEl, {
                onExportPng: function () { global.Interactions.exportChartPNG(chart, opts.filenameBase || 'chart'); },
                onOpenData: (opts.drawer && seriesList.length) ? function () {
                    var headers = ['Time'].concat(seriesList.map(function (s) { return s.name; }));
                    var timeMap = {};
                    seriesList.forEach(function (s) {
                        (s.data || []).forEach(function (pt) {
                            var t = pt[0];
                            if (!timeMap[t]) { timeMap[t] = {}; }
                            timeMap[t][s.name] = pt[1];
                        });
                    });
                    var times = Object.keys(timeMap).map(Number).sort(function (a, b) { return a - b; });
                    var rows = times.map(function (t) {
                        var row = [global.Formatters.formatTimestamp(t, times[times.length - 1] - times[0])];
                        seriesList.forEach(function (s) {
                            var v = timeMap[t][s.name];
                            row.push(v === undefined ? '' : (opts.unit === 'bytes' ? global.Formatters.formatBytes(v) : global.Formatters.formatCompact(v)));
                        });
                        return row;
                    });
                    global.Interactions.openDataTableDrawer(opts.drawer, opts.title || 'Chart data', headers, rows);
                } : undefined
            });
        },

        renderLoadingSkeleton: function (el) {
            el.innerHTML = '<div class="dl-chart-loading"><div class="dl-skeleton"></div><div class="dl-skeleton"></div><div class="dl-skeleton"></div></div>';
        },
        renderEmptyState: function (el, opts) {
            opts = opts || {};
            var lastUpdate = opts.lastUpdate ? ('Last update ' + (global.Formatters ? global.Formatters.formatRelativeTime(opts.lastUpdate) : '')) : '';
            el.innerHTML = '<div class="dl-empty-state"><div>No data in selected period</div>' +
                (lastUpdate ? '<div class="dl-provenance">' + lastUpdate + '</div>' : '') + '</div>';
        },
        renderErrorState: function (el, opts) {
            opts = opts || {};
            var wrap = document.createElement('div');
            wrap.className = 'dl-error-state';
            var msg = document.createElement('div');
            msg.textContent = 'Data unavailable';
            wrap.appendChild(msg);
            if (opts.lastGood) {
                var sub = document.createElement('div');
                sub.className = 'dl-provenance';
                sub.textContent = 'Last successful update ' + (global.Formatters ? global.Formatters.formatClock(opts.lastGood) : '');
                wrap.appendChild(sub);
            }
            if (opts.onRetry) {
                var btn = document.createElement('button');
                btn.className = 'dl-btn retry-btn';
                btn.type = 'button';
                btn.textContent = 'Retry';
                btn.addEventListener('click', opts.onRetry);
                wrap.appendChild(btn);
            }
            el.innerHTML = '';
            el.appendChild(wrap);
        }
    };

    function el(tag, className, text) {
        var e = document.createElement(tag);
        if (className) { e.className = className; }
        if (text !== undefined) { e.textContent = text; }
        return e;
    }

    var ViewBuilders = {
        metricStrip: function (metrics) {
            var strip = el('div', 'dl-metric-strip');
            metrics.forEach(function (m) {
                var tile = el('div', 'dl-metric-tile' + (m.onClick ? ' is-clickable' : ''));
                tile.appendChild(el('div', 'dl-metric-label', m.label));
                tile.appendChild(el('div', 'dl-metric-value', m.value));
                if (m.sub) { tile.appendChild(el('div', 'dl-metric-sub', m.sub)); }
                if (m.onClick) {
                    tile.addEventListener('click', m.onClick);
                    tile.setAttribute('tabindex', '0');
                    tile.setAttribute('role', 'button');
                    tile.addEventListener('keydown', function (evt) { if (evt.key === 'Enter') { m.onClick(evt); } });
                }
                strip.appendChild(tile);
            });
            return strip;
        },
        panel: function (title, opts) {
            opts = opts || {};
            var panel = el('div', 'dl-chart-panel' + (opts.className ? (' ' + opts.className) : ''));
            var heading = el('div', 'chart-heading');
            heading.appendChild(el('h2', null, title));
            var actions = el('div', 'chart-actions');
            heading.appendChild(actions);
            panel.appendChild(heading);
            var body = el('div', 'dl-chart-body');
            var canvas = el('div', 'dl-chart-canvas' + (opts.tall ? ' is-tall' : '') + (opts.compact ? ' is-compact' : ''));
            body.appendChild(canvas);
            panel.appendChild(body);
            return { panel: panel, canvas: canvas, actions: actions, body: body, heading: heading };
        },
        section: function (title) {
            var sec = el('div', 'dl-view-section');
            if (title) { sec.appendChild(el('div', 'dl-section-title', title)); }
            return sec;
        },
        grid: function (className) {
            return el('div', 'dl-grid' + (className ? (' ' + className) : ''));
        },
        col: function (span, extraClass) {
            var d = el('div', 'dl-col-span-' + span + (extraClass ? (' ' + extraClass) : ''));
            d.style.gridColumn = 'span ' + span;
            return d;
        },
        stateBadge: function (state) {
            var b = el('span', 'dl-state-badge ' + state, global.Formatters ? global.Formatters.formatState(state) : state);
            return b;
        },
        stateInline: function (state) {
            var s = el('span', 'dl-state ' + state);
            s.innerHTML = '<span class="dl-state-dot"></span>' + (global.Formatters ? global.Formatters.formatState(state) : state);
            return s;
        },
        heatmapLegend: function () {
            var legend = el('div', 'dl-heatmap-legend');
            ['healthy', 'warning', 'critical', 'unknown'].forEach(function (state) {
                var item = el('span', null);
                item.style.display = 'inline-flex';
                item.style.alignItems = 'center';
                item.style.marginRight = '12px';
                var swatch = el('span', 'dl-legend-swatch');
                swatch.style.background = ChartFactory.stateColor[state];
                item.appendChild(swatch);
                item.appendChild(document.createTextNode(global.Formatters ? global.Formatters.formatState(state) : state));
                legend.appendChild(item);
            });
            return legend;
        }
    };

    global.ViewBuilders = ViewBuilders;

    /* ---- ChartRegistry ---- */
    var registry = {};
    var resizeObservers = {};

    function debounce(fn, wait) {
        var t = null;
        return function () {
            var args = arguments, ctx = this;
            if (t) { clearTimeout(t); }
            t = setTimeout(function () { fn.apply(ctx, args); }, wait);
        };
    }

    var ChartRegistry = {
        register: function (id, instance, viewId, el) {
            if (registry[id]) { ChartRegistry.dispose(id); }
            registry[id] = { instance: instance, viewId: viewId, el: el };
            if (el && typeof ResizeObserver !== 'undefined') {
                var debounced = debounce(function () {
                    if (instance && !instance.isDisposed()) { instance.resize(); }
                }, 80);
                var ro = new ResizeObserver(debounced);
                ro.observe(el);
                resizeObservers[id] = ro;
            }
            return instance;
        },
        get: function (id) {
            return registry[id] ? registry[id].instance : null;
        },
        resizeAll: function () {
            for (var id in registry) {
                if (registry.hasOwnProperty(id)) {
                    var inst = registry[id].instance;
                    if (inst && !inst.isDisposed()) { inst.resize(); }
                }
            }
        },
        dispose: function (id) {
            var entry = registry[id];
            if (!entry) { return; }
            if (resizeObservers[id]) { resizeObservers[id].disconnect(); delete resizeObservers[id]; }
            if (entry.instance && !entry.instance.isDisposed()) { entry.instance.dispose(); }
            delete registry[id];
        },
        disposeView: function (viewId) {
            for (var id in registry) {
                if (registry.hasOwnProperty(id) && registry[id].viewId === viewId) {
                    ChartRegistry.dispose(id);
                }
            }
        },
        disposeAll: function () {
            for (var id in registry) {
                if (registry.hasOwnProperty(id)) { ChartRegistry.dispose(id); }
            }
        },
        connectGroup: function (groupName) {
            if (echartsLib && echartsLib.connect) { echartsLib.connect(groupName); }
        }
    };

    global.ChartFactory = ChartFactory;
    global.ChartRegistry = ChartRegistry;
})(window);
