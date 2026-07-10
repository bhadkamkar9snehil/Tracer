/* app.js - public embedding API: window.DataLakeUI */
(function (global) {
    'use strict';

    var mounted = false;
    var store, router, drawer, dataSource, nav, resizeObserver, refreshTimer, hostEl;

    function ensureChild(parent, id, tag, cls) {
        var existing = parent.querySelector('#' + id);
        if (existing) { return existing; }
        var e = document.createElement(tag);
        e.id = id;
        if (cls) { e.className = cls; }
        parent.appendChild(e);
        return e;
    }

    function buildSkeleton(element) {
        element.classList.add('dl-app');
        return {
            header: ensureChild(element, 'dl-header', 'header', 'dl-header'),
            nav: ensureChild(element, 'dl-nav', 'nav', 'dl-nav'),
            context: ensureChild(element, 'dl-context-strip', 'div', 'dl-context-strip'),
            view: ensureChild(element, 'dl-view', 'main', 'dl-view'),
            drawerRoot: ensureChild(element, 'dl-drawer-root', 'div', 'dl-drawer-root'),
            tooltipRoot: ensureChild(element, 'dl-tooltip-root', 'div', 'dl-tooltip-root'),
            toastRoot: ensureChild(element, 'dl-toast-root', 'div', 'dl-toast-root')
        };
    }

    function scheduleRefresh() {
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
        var ms = store.getState().refreshIntervalMs;
        if (ms && ms > 0) {
            refreshTimer = setInterval(function () { router.refresh(); }, ms);
        }
    }

    var DataLakeUI = {
        mount: function (element, options) {
            if (!element) { global.Logger && global.Logger.error('DataLakeUI.mount requires a container element'); return; }
            if (mounted) { DataLakeUI.unmount(); }
            options = options || {};
            global.__DL_NOW__ = Date.now();
            hostEl = element;
            var els = buildSkeleton(element);

            var initialRoute = options.initialRoute === 'overview' ? 'flow' : (options.initialRoute || 'flow');
            var initialState = {
                mode: options.mode || 'mock',
                route: initialRoute,
                theme: options.theme || 'light',
                apiBaseUrl: options.apiBaseUrl || '',
                hostLabels: options.hostLabels || {},
                showTechnicalDetails: options.showTechnicalDetails !== false,
                refreshIntervalMs: (options.refreshIntervalMs === undefined) ? 15000 : options.refreshIntervalMs
            };

            store = new global.DLStore.Store(initialState);
            document.documentElement.setAttribute('data-theme', initialState.theme);

            dataSource = global.DataSourceFactory({
                mode: initialState.mode,
                apiBaseUrl: initialState.apiBaseUrl,
                hostLabels: initialState.hostLabels,
                endpoints: options.endpoints
            });

            drawer = new global.DrawerManager(els.drawerRoot, null);

            router = new global.DLRouter.Router({
                container: els.view,
                store: store,
                dataSource: dataSource,
                views: global.DLViews,
                onRouteChange: function () { if (drawer) { drawer.close(); } }
            });

            global.DLContext = { store: store, router: router, drawer: drawer, dataSource: dataSource };

            nav = new global.NavigationUI({
                headerEl: els.header, navEl: els.nav, contextEl: els.context,
                store: store, router: router, drawer: drawer,
                getExportPayload: function () { return null; }
            });

            if (!global.location.hash || global.location.hash === '#') {
                global.location.hash = '#/' + initialRoute;
            }
            router.start();

            DataLakeUI._lastRefreshMs = initialState.refreshIntervalMs;
            scheduleRefresh();
            store.subscribe(function (state) {
                if (state.refreshIntervalMs !== DataLakeUI._lastRefreshMs) {
                    DataLakeUI._lastRefreshMs = state.refreshIntervalMs;
                    scheduleRefresh();
                }
            });

            if (typeof ResizeObserver !== 'undefined') {
                resizeObserver = new ResizeObserver(function () { global.ChartRegistry.resizeAll(); });
                resizeObserver.observe(element);
            } else {
                global.addEventListener('resize', DataLakeUI.resize);
            }

            mounted = true;
        },

        unmount: function () {
            if (!mounted) { return; }
            if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
            if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
            else { global.removeEventListener('resize', DataLakeUI.resize); }
            if (router) { router.destroy(); router = null; }
            if (nav) { nav.destroy(); nav = null; }
            if (global.ChartRegistry) { global.ChartRegistry.disposeAll(); }
            if (hostEl) { hostEl.innerHTML = ''; }
            global.DLContext = null;
            mounted = false;
        },

        resize: function () {
            if (global.ChartRegistry) { global.ChartRegistry.resizeAll(); }
        },

        setData: function (payload) {
            if (!mounted || !payload || !router || !router.current) { return; }
            var view = router.current.view;
            if (view && view.update) {
                view.update(store.getState(), payload);
                store.setState({ lastUpdatedAt: global.__DL_NOW__ || Date.now() });
            }
        },

        setTimeRange: function (range) {
            if (!mounted) { return; }
            var normalized = (typeof range === 'string') ? { id: range, from: 'now-' + range, to: 'now' } : range;
            store.setTimeRange(normalized);
        },

        navigate: function (route) {
            if (!mounted) { return; }
            router.navigate(route);
        },

        refresh: function () {
            if (!mounted) { return; }
            router.refresh();
        }
    };

    global.DataLakeUI = DataLakeUI;
})(window);
