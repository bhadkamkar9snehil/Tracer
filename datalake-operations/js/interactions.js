/* interactions.js - cross-filtering, keyboard actions, chart-click routing, drawer interactions, export actions */
(function (global) {
    'use strict';

    function el(tag, className, text) {
        var e = document.createElement(tag);
        if (className) { e.className = className; }
        if (text !== undefined) { e.textContent = text; }
        return e;
    }

    function focusableElements(container) {
        return Array.prototype.slice.call(container.querySelectorAll(
            'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
        ));
    }

    function DrawerManager(root, router) {
        this.root = root;
        this.router = router;
        this.overlay = el('div', 'dl-drawer-overlay');
        this.panel = el('div', 'dl-drawer');
        this.panel.setAttribute('role', 'dialog');
        this.panel.setAttribute('aria-modal', 'true');
        this.root.appendChild(this.overlay);
        this.root.appendChild(this.panel);
        this._lastFocused = null;
        var self = this;
        this.overlay.addEventListener('click', function () { self.close(); });
        document.addEventListener('keydown', function (evt) { self._handleKeydown(evt); });
    }

    DrawerManager.prototype._handleKeydown = function (evt) {
        if (evt.key !== 'Escape' && evt.key !== 'Tab') { return; }
        if (!this.root.classList.contains('is-open')) { return; }
        if (evt.key === 'Escape') {
            evt.stopPropagation();
            this.close();
            return;
        }
        if (evt.key === 'Tab') {
            var focusables = focusableElements(this.panel);
            if (!focusables.length) { return; }
            var first = focusables[0];
            var last = focusables[focusables.length - 1];
            if (evt.shiftKey && document.activeElement === first) {
                evt.preventDefault();
                last.focus();
            } else if (!evt.shiftKey && document.activeElement === last) {
                evt.preventDefault();
                first.focus();
            }
        }
    };

    DrawerManager.prototype.open = function (config) {
        this._lastFocused = document.activeElement;
        this.panel.className = 'dl-drawer' + (config.expanded ? ' is-expanded' : '');
        this.panel.innerHTML = '';

        var header = el('div', 'dl-drawer-header');
        var titleWrap = el('div');
        titleWrap.appendChild(el('div', 'dl-drawer-title', config.title || ''));
        if (config.subtitle) { titleWrap.appendChild(el('div', 'dl-drawer-subtitle', config.subtitle)); }
        header.appendChild(titleWrap);
        var closeBtn = el('button', 'dl-btn-icon');
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.textContent = '✕';
        var self = this;
        closeBtn.addEventListener('click', function () { self.close(); });
        header.appendChild(closeBtn);
        this.panel.appendChild(header);

        var body = el('div', 'dl-drawer-body');
        (config.sections || []).forEach(function (section) {
            if (section.hidden) { return; }
            var sec = el('div', 'dl-drawer-section');
            sec.appendChild(el('div', 'dl-drawer-section-title', section.title));
            if (section.render) {
                section.render(sec);
            } else if (section.kv) {
                var dl = el('dl', 'dl-kv-list');
                section.kv.forEach(function (pair) {
                    dl.appendChild(el('dt', null, pair[0]));
                    dl.appendChild(el('dd', null, pair[1]));
                });
                sec.appendChild(dl);
            }
            body.appendChild(sec);
        });
        this.panel.appendChild(body);

        if (config.actions && config.actions.length) {
            var actions = el('div', 'dl-drawer-actions');
            config.actions.forEach(function (a) {
                var btn = el('button', 'dl-btn', a.label);
                btn.type = 'button';
                btn.addEventListener('click', a.onClick);
                actions.appendChild(btn);
            });
            this.panel.appendChild(actions);
        }

        this.root.classList.add('is-open');
        var focusables = focusableElements(this.panel);
        if (focusables.length) { focusables[0].focus(); } else { this.panel.setAttribute('tabindex', '-1'); this.panel.focus(); }
    };

    DrawerManager.prototype.close = function () {
        this.root.classList.remove('is-open');
        if (this._lastFocused && this._lastFocused.focus) {
            try { this._lastFocused.focus(); } catch (e) { /* noop */ }
        }
    };

    DrawerManager.prototype.isOpen = function () {
        return this.root.classList.contains('is-open');
    };

    /* ---- Cross filtering ---- */
    var CrossFilter = {
        apply: function (store, key, value) {
            store.setFilter(key, value);
        },
        clear: function (store) {
            store.clearFilters();
        }
    };

    /* ---- Export helpers ---- */
    function exportChartPNG(chart, filenameBase) {
        if (!chart || chart.isDisposed()) { return; }
        var url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#ffffff' });
        var a = document.createElement('a');
        a.href = url;
        a.download = (filenameBase || 'chart') + '.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    function csvEscape(v) {
        var s = String(v === undefined || v === null ? '' : v);
        if (/[",\n]/.test(s)) { return '"' + s.replace(/"/g, '""') + '"'; }
        return s;
    }

    function exportTableCSV(headers, rows, filenameBase) {
        var lines = [headers.map(csvEscape).join(',')];
        rows.forEach(function (r) { lines.push(r.map(csvEscape).join(',')); });
        var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = (filenameBase || 'table') + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text);
        }
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) { /* noop */ }
        document.body.removeChild(ta);
        return Promise.resolve();
    }

    function buildChartActionMenu(container, opts) {
        opts = opts || {};
        var wrap = el('div', 'chart-actions');
        if (opts.onOpenData) {
            var dataBtn = el('button', 'dl-btn-icon', '⌗');
            dataBtn.type = 'button';
            dataBtn.setAttribute('aria-label', 'Open data');
            dataBtn.title = 'Open data';
            dataBtn.addEventListener('click', opts.onOpenData);
            wrap.appendChild(dataBtn);
        }
        if (opts.onExportPng) {
            var pngBtn = el('button', 'dl-btn-icon', '⤓');
            pngBtn.type = 'button';
            pngBtn.setAttribute('aria-label', 'Export as PNG');
            pngBtn.title = 'Export as PNG';
            pngBtn.addEventListener('click', opts.onExportPng);
            wrap.appendChild(pngBtn);
        }
        container.appendChild(wrap);
        return wrap;
    }

    /* ---- Toasts ---- */
    function showToast(message) {
        var root = document.getElementById('dl-toast-root');
        if (!root) { return; }
        var toast = el('div', 'dl-toast', message);
        root.appendChild(toast);
        setTimeout(function () {
            if (toast.parentNode) { toast.parentNode.removeChild(toast); }
        }, 2600);
    }

    function openDataTableDrawer(drawer, title, headers, rows) {
        drawer.open({
            title: title,
            subtitle: rows.length + ' rows',
            sections: [{
                title: 'Data',
                render: function (container) {
                    var wrap = el('div', 'dl-table-wrap');
                    var table = document.createElement('table');
                    table.className = 'dl-table';
                    var thead = document.createElement('thead');
                    var headRow = document.createElement('tr');
                    headers.forEach(function (h) { headRow.appendChild(el('th', null, h)); });
                    thead.appendChild(headRow);
                    table.appendChild(thead);
                    var tbody = document.createElement('tbody');
                    rows.forEach(function (r) {
                        var tr = document.createElement('tr');
                        r.forEach(function (cellVal) { tr.appendChild(el('td', null, String(cellVal))); });
                        tbody.appendChild(tr);
                    });
                    table.appendChild(tbody);
                    wrap.appendChild(table);
                    container.appendChild(wrap);
                }
            }],
            actions: [{
                label: 'Export CSV',
                onClick: function () { exportTableCSV(headers, rows, title.replace(/\s+/g, '-').toLowerCase()); }
            }]
        });
    }

    global.DrawerManager = DrawerManager;
    global.CrossFilter = CrossFilter;
    global.Interactions = {
        exportChartPNG: exportChartPNG,
        exportTableCSV: exportTableCSV,
        copyText: copyText,
        buildChartActionMenu: buildChartActionMenu,
        openDataTableDrawer: openDataTableDrawer,
        showToast: showToast,
        el: el
    };
})(window);
