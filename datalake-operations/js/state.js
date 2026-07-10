/* state.js - central store, subscriptions, filters, time range, route, state evaluation */
(function (global) {
    'use strict';

    function nowMs() { return Date.now(); }

    function rangeToMs(rangeId) {
        var map = {
            '15m': 15 * 60 * 1000,
            '1h': 60 * 60 * 1000,
            '6h': 6 * 60 * 60 * 1000,
            '24h': 24 * 60 * 60 * 1000,
            '7d': 7 * 24 * 60 * 60 * 1000,
            '30d': 30 * 24 * 60 * 60 * 1000
        };
        return map[rangeId] || map['6h'];
    }

    function defaultState() {
        return {
            route: 'flow',
            params: {},
            filters: {
                host: 'ALL',
                status: 'ALL',
                namespace: 'ALL'
            },
            timeRange: {
                id: '6h',
                from: 'now-6h',
                to: 'now'
            },
            selectedEntity: null,
            theme: 'light',
            mode: 'mock',
            apiBaseUrl: '',
            hostLabels: {},
            showTechnicalDetails: true,
            refreshIntervalMs: 15000,
            refreshState: 'idle',
            lastUpdatedAt: null,
            overallState: 'unknown',
            alerts: { warning: 0, critical: 0 },
            drawer: null
        };
    }

    function Store(initial) {
        this._state = mergeDeep(defaultState(), initial || {});
        this._listeners = [];
    }

    function isPlainObject(v) {
        return v !== null && typeof v === 'object' && !Array.isArray(v);
    }

    function mergeDeep(base, patch) {
        var out = {};
        var k;
        for (k in base) { if (base.hasOwnProperty(k)) { out[k] = base[k]; } }
        for (k in patch) {
            if (!patch.hasOwnProperty(k)) { continue; }
            if (isPlainObject(patch[k]) && isPlainObject(out[k])) {
                out[k] = mergeDeep(out[k], patch[k]);
            } else {
                out[k] = patch[k];
            }
        }
        return out;
    }

    Store.prototype.getState = function () {
        return this._state;
    };

    Store.prototype.setState = function (patch) {
        this._state = mergeDeep(this._state, patch);
        this._emit();
        return this._state;
    };

    Store.prototype.subscribe = function (fn) {
        this._listeners.push(fn);
        var self = this;
        return function unsubscribe() {
            var idx = self._listeners.indexOf(fn);
            if (idx >= 0) { self._listeners.splice(idx, 1); }
        };
    };

    Store.prototype._emit = function () {
        for (var i = 0; i < this._listeners.length; i++) {
            try {
                this._listeners[i](this._state);
            } catch (e) {
                if (global.Logger) { global.Logger.error('state listener error', e); }
            }
        }
    };

    Store.prototype.setTimeRange = function (range) {
        this.setState({ timeRange: range });
    };

    Store.prototype.setFilter = function (key, value) {
        var patch = { filters: {} };
        patch.filters[key] = value;
        this.setState(patch);
    };

    Store.prototype.clearFilters = function () {
        this.setState({ filters: { host: 'ALL', status: 'ALL', namespace: 'ALL' } });
    };

    /* ---- StateEvaluator ---- */
    var ORDER_DEFAULT = ['critical', 'unavailable', 'warning', 'unknown', 'healthy'];
    var ORDER_UNAVAIL_FIRST = ['unavailable', 'critical', 'warning', 'unknown', 'healthy'];

    var StateEvaluator = {
        evaluateMetric: function (metric, thresholds) {
            if (metric === null || metric === undefined) { return 'unavailable'; }
            thresholds = thresholds || {};
            if (thresholds.equals) {
                for (var key in thresholds.equals) {
                    if (thresholds.equals.hasOwnProperty(key) && metric === Number(key)) {
                        return thresholds.equals[key];
                    }
                }
            }
            if (typeof thresholds.critical === 'number') {
                if (thresholds.direction === 'lower-worse' ? metric < thresholds.critical : metric > thresholds.critical) {
                    return 'critical';
                }
            }
            if (typeof thresholds.warning === 'number') {
                if (thresholds.direction === 'lower-worse' ? metric < thresholds.warning : metric > thresholds.warning) {
                    return 'warning';
                }
            }
            return 'healthy';
        },
        combine: function (states, unavailableOutranksCritical) {
            var order = unavailableOutranksCritical ? ORDER_UNAVAIL_FIRST : ORDER_DEFAULT;
            var worstIdx = order.length - 1;
            var found = false;
            for (var i = 0; i < states.length; i++) {
                var s = states[i] || 'unknown';
                var idx = order.indexOf(s);
                if (idx === -1) { idx = order.indexOf('unknown'); }
                if (idx < worstIdx) { worstIdx = idx; }
                found = true;
            }
            if (!found) { return 'unknown'; }
            return order[worstIdx];
        }
    };

    var Logger = {
        _quiet: (global.location && global.location.search && global.location.search.indexOf('debug=1') === -1),
        info: function () { if (!Logger._quiet && global.console) { console.info.apply(console, arguments); } },
        warn: function () { if (global.console) { console.warn.apply(console, arguments); } },
        error: function () { if (global.console) { console.error.apply(console, arguments); } }
    };

    global.Logger = Logger;
    global.StateEvaluator = StateEvaluator;
    global.DLStore = {
        Store: Store,
        rangeToMs: rangeToMs,
        nowMs: nowMs,
        defaultState: defaultState
    };
})(window);
