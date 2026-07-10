/* navigation.js - header, layer navigation strip, breadcrumb/context strip */
(function (global) {
    'use strict';

    var el = global.Interactions.el;

    var TABS = [
        { id: 'flow', label: 'Flow' },
        { id: 'acquisition', label: 'Acquisition' },
        { id: 'storage', label: 'Storage' },
        { id: 'processing', label: 'Processing' },
        { id: 'quality', label: 'Quality' },
        { id: 'publishing', label: 'Publishing' },
        { id: 'services', label: 'Services' },
        { id: 'hosts', label: 'Hosts' },
        { id: 'logs', label: 'Logs' }
    ];

    var TIME_RANGES = [
        { id: '15m', label: '15 min' },
        { id: '1h', label: '1 hour' },
        { id: '6h', label: '6 hours' },
        { id: '24h', label: '24 hours' },
        { id: '7d', label: '7 days' },
        { id: '30d', label: '30 days' }
    ];

    var REFRESH_OPTIONS = [
        { id: 0, label: 'Off' },
        { id: 15000, label: '15 s' },
        { id: 30000, label: '30 s' },
        { id: 60000, label: '1 min' },
        { id: 300000, label: '5 min' }
    ];

    var ROUTE_LABELS = {
        flow: 'Flow', acquisition: 'Acquisition', storage: 'Storage', processing: 'Processing',
        quality: 'Quality', publishing: 'Publishing', services: 'Services', hosts: 'Hosts',
        logs: 'Logs', investigation: 'Investigation', detail: 'Detail'
    };

    function computeAlerts(mockData, nowMs) {
        var pool = (global.MockData && global.MockData.eventPool) || [];
        var windowMs = 60 * 60 * 1000;
        var since = (nowMs || Date.now()) - windowMs;
        var warning = 0, critical = 0;
        pool.forEach(function (e) {
            if (e.time < since) { return; }
            if (e.severity === 'warning') { warning++; }
            if (e.severity === 'critical') { critical++; }
        });
        return { warning: warning, critical: critical };
    }

    function overallStateFromAlerts(alerts) {
        if (alerts.critical > 0) { return 'critical'; }
        if (alerts.warning > 0) { return 'warning'; }
        return 'healthy';
    }

    function NavigationUI(config) {
        this.headerEl = config.headerEl;
        this.navEl = config.navEl;
        this.contextEl = config.contextEl;
        this.store = config.store;
        this.router = config.router;
        this.drawer = config.drawer;
        this.getExportPayload = config.getExportPayload || function () { return null; };
        this._menuOpen = false;
        this.render();
        var self = this;
        this._unsub = this.store.subscribe(function (state) { self.update(state); });
        this._clockTimer = setInterval(function () { self._tickClock(); }, 1000);
    }

    NavigationUI.prototype.render = function () {
        this._renderHeader();
        this._renderNav();
        this._renderContext();
        this.update(this.store.getState());
    };

    NavigationUI.prototype._renderHeader = function () {
        var self = this;
        this.headerEl.innerHTML = '';
        var left = el('div', 'dl-header-left');
        this.stateEl = el('span', 'dl-state healthy');
        this.stateEl.innerHTML = '<span class="dl-state-dot"></span><span class="dl-state-text">Healthy</span>';
        left.appendChild(this.stateEl);
        this.clockEl = el('span', 'dl-clock', 'Updated —');
        left.appendChild(this.clockEl);
        this.headerEl.appendChild(left);

        var right = el('div', 'dl-header-right');

        var rangeSelect = document.createElement('select');
        rangeSelect.className = 'dl-select dl-btn';
        rangeSelect.setAttribute('aria-label', 'Time range');
        TIME_RANGES.forEach(function (r) {
            var opt = document.createElement('option');
            opt.value = r.id;
            opt.textContent = r.label;
            rangeSelect.appendChild(opt);
        });
        rangeSelect.addEventListener('change', function () {
            self.store.setTimeRange({ id: rangeSelect.value, from: 'now-' + rangeSelect.value, to: 'now' });
        });
        this.rangeSelect = rangeSelect;
        right.appendChild(rangeSelect);

        var refreshSelect = document.createElement('select');
        refreshSelect.className = 'dl-select dl-btn';
        refreshSelect.setAttribute('aria-label', 'Refresh interval');
        REFRESH_OPTIONS.forEach(function (r) {
            var opt = document.createElement('option');
            opt.value = r.id;
            opt.textContent = r.label;
            refreshSelect.appendChild(opt);
        });
        refreshSelect.addEventListener('change', function () {
            self.store.setState({ refreshIntervalMs: Number(refreshSelect.value) });
        });
        this.refreshSelect = refreshSelect;
        right.appendChild(refreshSelect);

        var alertChip = el('button', 'dl-alert-chip');
        alertChip.type = 'button';
        alertChip.addEventListener('click', function () { self._openAlertsDrawer(); });
        this.alertChip = alertChip;
        right.appendChild(alertChip);

        var menu = el('div', 'dl-menu');
        var menuBtn = el('button', 'dl-btn-icon', '⋯');
        menuBtn.type = 'button';
        menuBtn.setAttribute('aria-label', 'More actions');
        var popover = el('div', 'dl-menu-popover');
        var items = [
            { label: 'Technical details', action: function () { self._toggleTechnicalDetails(); } },
            { label: 'Refresh all', action: function () { self.router.refresh(); global.Interactions.showToast('Refreshed'); } },
            { label: 'Copy current state', action: function () { self._copyState(); } },
            { label: 'Export current view', action: function () { self._exportView(); } }
        ];
        items.forEach(function (it) {
            var btn = el('button', 'dl-menu-item', it.label);
            btn.type = 'button';
            btn.addEventListener('click', function () { it.action(); menu.classList.remove('is-open'); });
            popover.appendChild(btn);
        });
        menu.appendChild(menuBtn);
        menu.appendChild(popover);
        menuBtn.addEventListener('click', function (evt) {
            evt.stopPropagation();
            menu.classList.toggle('is-open');
        });
        document.addEventListener('click', function () { menu.classList.remove('is-open'); });
        right.appendChild(menu);

        this.headerEl.appendChild(right);
    };

    NavigationUI.prototype._renderNav = function () {
        var self = this;
        this.navEl.innerHTML = '';
        var scroll = el('div', 'dl-nav-scroll');
        this.tabEls = {};
        TABS.forEach(function (t) {
            var tab = el('button', 'dl-tab', t.label);
            tab.type = 'button';
            tab.addEventListener('click', function () { self.router.navigate(t.id); });
            scroll.appendChild(tab);
            self.tabEls[t.id] = tab;
        });
        this.navEl.appendChild(scroll);
        this.navEl.appendChild(el('div', 'dl-nav-fade'));
    };

    NavigationUI.prototype._renderContext = function () {
        this.contextEl.innerHTML = '';
        this.breadcrumbEl = el('div', 'dl-breadcrumbs');
        this.filterEl = el('div', 'dl-filter-bar');
        this.contextEl.appendChild(this.breadcrumbEl);
        this.contextEl.appendChild(this.filterEl);
    };

    NavigationUI.prototype._tickClock = function () {
        var state = this.store.getState();
        if (state.lastUpdatedAt && global.Formatters) {
            this.clockEl.textContent = 'Updated ' + global.Formatters.formatClock(state.lastUpdatedAt);
        }
    };

    NavigationUI.prototype.update = function (state) {
        var alerts = computeAlerts(null, global.__DL_NOW__);
        this.store._lastAlerts = alerts;
        var overall = overallStateFromAlerts(alerts);
        this.stateEl.className = 'dl-state ' + overall;
        this.stateEl.innerHTML = '<span class="dl-state-dot"></span><span class="dl-state-text">' + (global.Formatters ? global.Formatters.formatState(overall) : overall) + '</span>';

        if (state.lastUpdatedAt && global.Formatters) {
            this.clockEl.textContent = 'Updated ' + global.Formatters.formatClock(state.lastUpdatedAt);
        }

        this.rangeSelect.value = state.timeRange.id;
        this.refreshSelect.value = String(state.refreshIntervalMs);

        this.alertChip.className = 'dl-alert-chip ' + (alerts.critical > 0 ? 'critical' : 'warning');
        var parts = [];
        if (alerts.warning > 0) { parts.push(alerts.warning + ' warning' + (alerts.warning > 1 ? 's' : '')); }
        if (alerts.critical > 0) { parts.push(alerts.critical + ' critical'); }
        this.alertChip.textContent = parts.length ? parts.join(', ') : 'No alerts';

        for (var id in this.tabEls) {
            if (this.tabEls.hasOwnProperty(id)) {
                this.tabEls[id].classList.toggle('is-active', state.route === id);
            }
        }

        this._renderBreadcrumb(state);
        this._renderFilters(state);
    };

    NavigationUI.prototype._renderBreadcrumb = function (state) {
        this.breadcrumbEl.innerHTML = '';
        var self = this;
        var crumbs = [];
        if (state.route === 'investigation' || state.route === 'detail') {
            crumbs.push({ label: '← Back', back: true });
            crumbs.push({ label: ROUTE_LABELS[state.route], current: false });
            if (state.route === 'investigation') {
                crumbs.push({ label: state.params.componentId || '', current: true });
            } else {
                crumbs.push({ label: state.params.entityType + ' / ' + state.params.entityId, current: true });
            }
        } else {
            crumbs.push({ label: ROUTE_LABELS[state.route] || state.route, current: true });
        }
        crumbs.forEach(function (c, i) {
            if (i > 0) { self.breadcrumbEl.appendChild(el('span', 'dl-breadcrumb-sep', '/')); }
            if (c.back) {
                var backBtn = el('button', 'dl-breadcrumb-item', c.label);
                backBtn.type = 'button';
                backBtn.style.cursor = 'pointer';
                backBtn.addEventListener('click', function () { global.history.back(); });
                self.breadcrumbEl.appendChild(backBtn);
            } else {
                self.breadcrumbEl.appendChild(el('span', 'dl-breadcrumb-item' + (c.current ? ' is-current' : ''), c.label));
            }
        });
    };

    NavigationUI.prototype._renderFilters = function (state) {
        this.filterEl.innerHTML = '';
        var self = this;
        ['host', 'status', 'namespace'].forEach(function (key) {
            var val = state.filters[key];
            if (val && val !== 'ALL') {
                var label = key.charAt(0).toUpperCase() + key.slice(1);
                var displayVal = (key === 'host' && state.hostLabels && state.hostLabels[val]) ? state.hostLabels[val] : val;
                var chip = el('span', 'dl-filter-chip');
                chip.appendChild(document.createTextNode(label + ': ' + displayVal + ' '));
                var clearBtn = el('button', null, '×');
                clearBtn.type = 'button';
                clearBtn.setAttribute('aria-label', 'Clear ' + label + ' filter');
                clearBtn.addEventListener('click', function () { self.store.setFilter(key, 'ALL'); });
                chip.appendChild(clearBtn);
                self.filterEl.appendChild(chip);
            }
        });
    };

    NavigationUI.prototype._openAlertsDrawer = function () {
        var pool = (global.MockData && global.MockData.eventPool) || [];
        var alertEvents = pool.filter(function (e) { return e.severity === 'warning' || e.severity === 'critical'; }).slice(0, 20);
        var router = this.router;
        this.drawer.open({
            title: 'Events',
            subtitle: alertEvents.length + ' open',
            sections: [{
                title: 'Recent',
                render: function (container) {
                    alertEvents.forEach(function (e) {
                        var row = el('div', 'dl-related-link');
                        var stateLine = el('div', 'dl-state ' + e.state);
                        stateLine.appendChild(el('span', 'dl-state-dot'));
                        stateLine.appendChild(document.createTextNode(global.Formatters ? global.Formatters.formatState(e.state) : e.state));
                        row.appendChild(stateLine);
                        row.appendChild(el('div', null, e.summary));
                        row.appendChild(el('div', 'dl-provenance', e.layer + ' · ' + (global.Formatters ? global.Formatters.formatRelativeTime(e.time) : '')));
                        container.appendChild(row);
                    });
                }
            }],
            actions: [{ label: 'Open logs', onClick: function () { router.navigate('logs'); } }]
        });
    };

    NavigationUI.prototype._toggleTechnicalDetails = function () {
        var state = this.store.getState();
        this.store.setState({ showTechnicalDetails: !state.showTechnicalDetails });
        global.Interactions.showToast('Technical details ' + (!state.showTechnicalDetails ? 'shown' : 'hidden'));
    };

    NavigationUI.prototype._copyState = function () {
        var state = this.store.getState();
        var payload = {
            route: state.route, params: state.params, filters: state.filters, timeRange: state.timeRange
        };
        global.Interactions.copyText(JSON.stringify(payload, null, 2));
        global.Interactions.showToast('Current state copied');
    };

    NavigationUI.prototype._exportView = function () {
        var payload = this.getExportPayload();
        if (!payload) {
            global.Interactions.showToast('Nothing to export for this view');
            return;
        }
        if (payload.headers && payload.rows) {
            global.Interactions.exportTableCSV(payload.headers, payload.rows, payload.filenameBase || 'view-export');
        } else {
            var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = (payload.filenameBase || 'view-export') + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        }
        global.Interactions.showToast('Export started');
    };

    NavigationUI.prototype.destroy = function () {
        if (this._unsub) { this._unsub(); }
        if (this._clockTimer) { clearInterval(this._clockTimer); }
    };

    global.NavigationUI = NavigationUI;
    global.NAV_TABS = TABS;
    global.NAV_TIME_RANGES = TIME_RANGES;
    global.NAV_REFRESH_OPTIONS = REFRESH_OPTIONS;
})(window);
