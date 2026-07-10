/* data-source.js - normalized fetch interface, mock/API switching, request cancellation, validation */
(function (global) {
    'use strict';

    var DEFAULT_ENDPOINTS = {
        overview: '/api/datalake/overview',
        acquisition: '/api/datalake/acquisition',
        storage: '/api/datalake/storage',
        processing: '/api/datalake/processing',
        quality: '/api/datalake/quality',
        publishing: '/api/datalake/publishing',
        services: '/api/datalake/services',
        hosts: '/api/datalake/hosts',
        logs: '/api/datalake/logs',
        investigation: '/api/datalake/investigation'
    };

    function normalizeStorage(raw, derived) {
        return {
            id: 'object-storage',
            role: 'Object Storage',
            state: raw.clusterHealth === 1 && raw.driveHealth !== 0 ? 'healthy' : (raw.driveHealth === 2 ? 'warning' : 'critical'),
            updatedAt: global.__DL_NOW__ || Date.now(),
            health: {
                cluster: raw.clusterHealth,
                nodesOnline: raw.onlineNodes,
                drivesOnline: raw.onlineDrives,
                drivesTotal: raw.onlineDrives
            },
            capacity: {
                usableTotalBytes: raw.usableCapacityBytes,
                usableFreeBytes: raw.freeCapacityBytes,
                usableUsedBytes: derived.usableUsedBytes,
                managedDataBytes: raw.storedDataBytes
            },
            inventory: {
                namespaces: raw.namespaceCount,
                objects: raw.objectCount
            },
            runtime: {
                uptimeSeconds: raw.serviceUptimeSeconds,
                memoryUsedBytes: raw.memoryUsedBytes,
                memoryTotalBytes: raw.memoryTotalBytes,
                cpuLoadPercent: raw.cpuLoadPercent,
                workers: raw.runtimeWorkers
            },
            scanner: {
                started: raw.scansStarted,
                completed: raw.scansFinished,
                objectsScanned: raw.objectsScanned,
                directoriesScanned: raw.directoriesScanned,
                lastActivitySeconds: 68.4156
            },
            namespaces: raw.namespaces.map(function (n) {
                return { id: n.name, name: n.name, objects: n.objectCount, bytes: n.storedBytes };
            }),
            driveOperations: [
                { operation: 'Rename Data', metricOperation: 'storage.RenameData', latencyMicros: raw.driveLatencyMicros.renameData },
                { operation: 'Delete', metricOperation: 'storage.Delete', latencyMicros: raw.driveLatencyMicros['delete'] },
                { operation: 'Disk Information', metricOperation: 'storage.DiskInfo', latencyMicros: raw.driveLatencyMicros.diskInfo }
            ]
        };
    }

    function normalizeHost(h, hostLabels) {
        return {
            id: h.id,
            label: (hostLabels && hostLabels[h.id]) || h.label,
            state: h.criticalServices > 0 ? 'warning' : 'healthy',
            cpu: h.cpu,
            memory: h.memory,
            disks: h.disks,
            network: h.network,
            services: []
        };
    }

    function AbortableRequest() {
        this._controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    }
    AbortableRequest.prototype.abort = function () {
        if (this._controller) { this._controller.abort(); }
    };
    AbortableRequest.prototype.signal = function () {
        return this._controller ? this._controller.signal : undefined;
    };

    function DataSourceFactory(config) {
        config = config || {};
        var mode = config.mode || 'mock';
        var apiBaseUrl = config.apiBaseUrl || '';
        var endpoints = config.endpoints || DEFAULT_ENDPOINTS;
        var hostLabels = config.hostLabels || {};
        var pending = {};

        function cancelPending(key) {
            if (pending[key]) {
                pending[key].abort();
                delete pending[key];
            }
        }

        function fetchApi(routeKey, params) {
            cancelPending(routeKey);
            var req = new AbortableRequest();
            pending[routeKey] = req;
            var url = apiBaseUrl + (endpoints[routeKey] || ('/api/datalake/' + routeKey));
            var qs = [];
            if (params) {
                for (var k in params) {
                    if (params.hasOwnProperty(k) && params[k] !== undefined && params[k] !== null) {
                        qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
                    }
                }
            }
            if (qs.length) { url += '?' + qs.join('&'); }
            var fetchOpts = { method: 'GET', credentials: 'same-origin' };
            var signal = req.signal();
            if (signal) { fetchOpts.signal = signal; }
            return fetch(url, fetchOpts).then(function (res) {
                if (!res.ok) { throw new Error('Request failed: ' + res.status); }
                return res.json();
            }).then(function (json) {
                delete pending[routeKey];
                return json;
            }).catch(function (err) {
                delete pending[routeKey];
                if (err && err.name === 'AbortError') { throw err; }
                global.Logger && global.Logger.error('DataSource fetch error', routeKey, err);
                throw err;
            });
        }

        function mockPromise(fn) {
            return new Promise(function (resolve) {
                setTimeout(function () {
                    try { resolve(fn()); } catch (e) { global.Logger && global.Logger.error(e); resolve(null); }
                }, 30);
            });
        }

        var api = {
            mode: mode,

            getOverview: function (params) {
                if (mode === 'api') { return fetchApi('overview', params); }
                return mockPromise(function () { return global.MockData.overview(params && params.timeRange); });
            },
            getAcquisition: function (params) {
                if (mode === 'api') { return fetchApi('acquisition', params); }
                return mockPromise(function () { return global.MockData.acquisition(params && params.timeRange); });
            },
            getStorage: function (params) {
                if (mode === 'api') { return fetchApi('storage', params); }
                return mockPromise(function () {
                    var d = global.MockData.storage(params && params.timeRange);
                    d.normalized = normalizeStorage(d.raw, d.derived);
                    return d;
                });
            },
            getProcessing: function (params) {
                if (mode === 'api') { return fetchApi('processing', params); }
                return mockPromise(function () { return global.MockData.processing(params && params.timeRange); });
            },
            getQuality: function (params) {
                if (mode === 'api') { return fetchApi('quality', params); }
                return mockPromise(function () { return global.MockData.quality(params && params.timeRange); });
            },
            getPublishing: function (params) {
                if (mode === 'api') { return fetchApi('publishing', params); }
                return mockPromise(function () { return global.MockData.publishing(params && params.timeRange); });
            },
            getServices: function (params) {
                if (mode === 'api') { return fetchApi('services', params); }
                return mockPromise(function () { return global.MockData.services(params && params.timeRange); });
            },
            getHosts: function (params) {
                if (mode === 'api') { return fetchApi('hosts', params); }
                return mockPromise(function () {
                    var d = global.MockData.hosts(params && params.timeRange);
                    d.normalizedHosts = d.hosts.map(function (h) { return normalizeHost(h, hostLabels); });
                    return d;
                });
            },
            getLogs: function (params) {
                if (mode === 'api') { return fetchApi('logs', params); }
                return mockPromise(function () { return global.MockData.logs(params && params.timeRange, params && params.filters); });
            },
            getInvestigation: function (componentId, params) {
                if (mode === 'api') { return fetchApi('investigation', Object.assign ? Object.assign({ componentId: componentId }, params) : params); }
                return mockPromise(function () { return global.MockData.investigation(componentId, params && params.timeRange); });
            },
            setMode: function (m) { mode = m; api.mode = m; },
            setApiBaseUrl: function (u) { apiBaseUrl = u; },
            setHostLabels: function (labels) { hostLabels = labels || {}; },
            cancelAll: function () {
                for (var k in pending) { if (pending.hasOwnProperty(k)) { cancelPending(k); } }
            }
        };
        return api;
    }

    global.DataSourceFactory = DataSourceFactory;
    global.DataSourceNormalize = {
        storage: normalizeStorage,
        host: normalizeHost
    };
    global.DEFAULT_API_ENDPOINTS = DEFAULT_ENDPOINTS;
})(window);
