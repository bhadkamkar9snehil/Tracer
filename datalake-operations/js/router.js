/* router.js - hash parsing, route transitions, view lifecycle, back handling */
(function (global) {
    'use strict';

    var ROUTE_ALIASES = { overview: 'flow' };
    var VALID_ROUTES = ['flow', 'acquisition', 'storage', 'processing', 'quality', 'publishing', 'services', 'hosts', 'logs', 'investigation', 'detail'];

    function sanitizeParam(v) {
        if (v === undefined || v === null) { return v; }
        return String(v).replace(/[^a-zA-Z0-9_\-.:]/g, '');
    }

    function parseHash(hash) {
        var h = (hash || '').replace(/^#\/?/, '');
        var parts = h.split('/').filter(function (p) { return p.length > 0; });
        if (parts.length === 0) { parts = ['flow']; }
        if (ROUTE_ALIASES[parts[0]]) { parts[0] = ROUTE_ALIASES[parts[0]]; }
        return parts;
    }

    function resolveRoute(parts) {
        var routeId = parts[0];
        if (VALID_ROUTES.indexOf(routeId) === -1) { routeId = 'flow'; parts = ['flow']; }
        var params = {};
        if (routeId === 'investigation') { params.componentId = sanitizeParam(parts[1]) || 'object-storage'; }
        if (routeId === 'detail') { params.entityType = sanitizeParam(parts[1]) || 'namespace'; params.entityId = sanitizeParam(parts[2]) || ''; }
        return { routeId: routeId, params: params };
    }

    function Router(config) {
        this.container = config.container;
        this.store = config.store;
        this.dataSource = config.dataSource;
        this.views = config.views;
        this.onRouteChange = config.onRouteChange || function () {};
        this.current = null;
        this._suppress = false;
        this._lastFetchKey = null;
        var self = this;
        this._hashHandler = function () { self._handleHashChange(); };
        global.addEventListener('hashchange', this._hashHandler);
        this._unsubscribe = this.store.subscribe(function (state) { self._handleStoreChange(state); });
    }

    var ROUTE_FETCH = {
        flow: function (ds, state) { return ds.getOverview({ timeRange: state.timeRange }); },
        acquisition: function (ds, state) { return ds.getAcquisition({ timeRange: state.timeRange, filters: state.filters }); },
        storage: function (ds, state) { return ds.getStorage({ timeRange: state.timeRange, filters: state.filters }); },
        processing: function (ds, state) { return ds.getProcessing({ timeRange: state.timeRange }); },
        quality: function (ds, state) { return ds.getQuality({ timeRange: state.timeRange, filters: state.filters }); },
        publishing: function (ds, state) { return ds.getPublishing({ timeRange: state.timeRange }); },
        services: function (ds, state) { return ds.getServices({ timeRange: state.timeRange, filters: state.filters }); },
        hosts: function (ds, state) { return ds.getHosts({ timeRange: state.timeRange, filters: state.filters }); },
        logs: function (ds, state) { return ds.getLogs({ timeRange: state.timeRange, filters: state.filters }); },
        investigation: function (ds, state, params) { return ds.getInvestigation(params.componentId, { timeRange: state.timeRange }); },
        detail: function (ds, state, params) { return Promise.resolve({ entityType: params.entityType, entityId: params.entityId }); }
    };

    Router.prototype.start = function () {
        this._handleHashChange();
    };

    Router.prototype._handleHashChange = function () {
        var parts = parseHash(global.location.hash);
        var resolved = resolveRoute(parts);
        this._transitionTo(resolved.routeId, resolved.params);
    };

    Router.prototype._transitionTo = function (routeId, params) {
        var view = this.views[routeId];
        if (this.current && this.current.view && typeof this.current.view.unmount === 'function') {
            try { this.current.view.unmount(); } catch (e) { global.Logger && global.Logger.error(e); }
        }
        if (global.ChartRegistry && this.current) { global.ChartRegistry.disposeView(this.current.routeId); }
        this._suppress = true;
        this.store.setState({ route: routeId, params: params, selectedEntity: null, drawer: null });
        this._suppress = false;
        this.current = { routeId: routeId, params: params, view: view };
        this.onRouteChange(routeId, params);
        this._load(routeId, params, view, true);
    };

    Router.prototype._load = function (routeId, params, view, isInitialMount) {
        if (!view) { return; }
        var self = this;
        global.__DL_NOW__ = Date.now();
        var state = this.store.getState();
        var fetchKey = routeId + JSON.stringify(params);
        this._lastFetchKey = fetchKey;
        var fetchFn = ROUTE_FETCH[routeId];
        if (isInitialMount && view.mount) {
            view.mount(this.container, state, null);
        }
        if (!fetchFn) { return; }
        fetchFn(this.dataSource, state, params).then(function (data) {
            if (self._lastFetchKey !== fetchKey) { return; }
            if (isInitialMount && view.mount) {
                view.mount(self.container, self.store.getState(), data);
            } else if (view.update) {
                view.update(self.store.getState(), data);
            } else if (view.mount) {
                view.mount(self.container, self.store.getState(), data);
            }
            self.store.setState({ lastUpdatedAt: global.__DL_NOW__ || Date.now() });
        }).catch(function (err) {
            global.Logger && global.Logger.error('route load failed', routeId, err);
            if (view.setError) { view.setError(err); }
        });
    };

    Router.prototype._handleStoreChange = function (state) {
        if (this._suppress || !this.current) { return; }
        var key = JSON.stringify(state.timeRange) + '|' + JSON.stringify(state.filters);
        if (this._lastStateKey === key) { return; }
        this._lastStateKey = key;
        this._load(this.current.routeId, this.current.params, this.current.view, false);
    };

    Router.prototype.navigate = function (routeStr) {
        var clean = String(routeStr || 'flow').replace(/^#\/?/, '');
        if (global.location.hash === '#/' + clean) {
            this._handleHashChange();
        } else {
            global.location.hash = '#/' + clean;
        }
    };

    Router.prototype.refresh = function () {
        if (this.current) { this._load(this.current.routeId, this.current.params, this.current.view, false); }
    };

    Router.prototype.destroy = function () {
        global.removeEventListener('hashchange', this._hashHandler);
        if (this._unsubscribe) { this._unsubscribe(); }
        if (this.current && this.current.view && typeof this.current.view.unmount === 'function') {
            try { this.current.view.unmount(); } catch (e) { /* noop */ }
        }
    };

    global.DLRouter = {
        Router: Router,
        parseHash: parseHash,
        resolveRoute: resolveRoute,
        VALID_ROUTES: VALID_ROUTES
    };
})(window);
