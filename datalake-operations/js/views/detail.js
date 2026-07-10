/* detail.js - generic entity detail view (#/detail/:entityType/:entityId) */
(function (global) {
    'use strict';

    var VIEW_ID = 'detail';
    var el = global.Interactions.el;
    var VB = global.ViewBuilders;
    var F = global.Formatters;

    var containerEl = null;

    function ctx() { return global.DLContext || {}; }

    function renderNamespace(state, entityId) {
        containerEl.innerHTML = '';
        var loading = VB.panel('Loading');
        global.ChartFactory.renderLoadingSkeleton(loading.canvas);
        containerEl.appendChild(loading.panel);
        ctx().dataSource.getStorage({ timeRange: state.timeRange }).then(function (storageData) {
            if (!containerEl) { return; }
            containerEl.innerHTML = '';
            var ns = storageData.raw.namespaces.filter(function (n) { return n.name === entityId; })[0];
            if (!ns) {
                var empty = VB.panel('Namespace');
                empty.canvas.remove();
                global.ChartFactory.renderEmptyState(empty.body, {});
                containerEl.appendChild(empty.panel);
                return;
            }
            var strip = VB.metricStrip([
                { label: 'Namespace', value: ns.name },
                { label: 'Objects', value: F.formatInteger(ns.objectCount) },
                { label: 'Stored Data', value: F.formatBytes(ns.storedBytes) },
                { label: 'State', value: 'Healthy' }
            ]);
            containerEl.appendChild(strip);

            var built = VB.panel('Namespace Detail');
            built.canvas.remove();
            var dl = el('dl', 'dl-kv-list');
            [['Namespace', ns.name], ['Objects', F.formatInteger(ns.objectCount)], ['Stored Data', F.formatBytes(ns.storedBytes)], ['Latest Activity', '68 s ago']].forEach(function (p) {
                dl.appendChild(el('dt', null, p[0]));
                dl.appendChild(el('dd', null, p[1]));
            });
            built.body.appendChild(dl);
            var link = el('a', 'dl-related-link', '← Back to Storage');
            link.href = '#/storage';
            link.style.marginTop = 'var(--space-4)';
            built.body.appendChild(link);
            containerEl.appendChild(built.panel);
        });
    }

    function renderGeneric(entityType, entityId) {
        containerEl.innerHTML = '';
        var built = VB.panel(entityType.charAt(0).toUpperCase() + entityType.slice(1) + ' Detail');
        built.canvas.remove();
        var dl = el('dl', 'dl-kv-list');
        [['Type', entityType], ['ID', entityId]].forEach(function (p) {
            dl.appendChild(el('dt', null, p[0]));
            dl.appendChild(el('dd', null, p[1]));
        });
        built.body.appendChild(dl);
        var link = el('a', 'dl-related-link', '← Back to Flow');
        link.href = '#/flow';
        link.style.marginTop = 'var(--space-4)';
        built.body.appendChild(link);
        containerEl.appendChild(built.panel);
    }

    function render(state, data) {
        if (!data) {
            containerEl.innerHTML = '';
            var loading = VB.panel('Loading');
            global.ChartFactory.renderLoadingSkeleton(loading.canvas);
            containerEl.appendChild(loading.panel);
            return;
        }
        if (data.entityType === 'namespace') {
            renderNamespace(state, data.entityId);
        } else {
            renderGeneric(data.entityType, data.entityId);
        }
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
    global.DLViews.detail = view;
})(window);
