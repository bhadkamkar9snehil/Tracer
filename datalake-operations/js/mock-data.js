/* mock-data.js - deterministic seeded mock dataset with provenance metadata.
   provenance values: observed | derived | prototype | last-known
   Only Object Storage cluster metrics below are grounded in the supplied
   real sample. Everything else (throughput, freshness, processing,
   acquisition volumes, host telemetry, publishing/quality figures) is a
   representative prototype value and is isolated here so it can be
   swapped for a live source without touching view code. */
(function (global) {
    'use strict';

    function SeededRandom(seed) {
        this.state = (seed >>> 0) || 1;
    }
    SeededRandom.prototype.next = function () {
        this.state |= 0;
        this.state = (this.state + 0x6D2B79F5) | 0;
        var t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    SeededRandom.prototype.range = function (min, max) {
        return min + this.next() * (max - min);
    };

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    function buildTimestamps(points, intervalMs, endTime) {
        var end = endTime || global.__DL_NOW__ || Date.now();
        var out = [];
        for (var i = 0; i < points; i++) {
            out.push(end - (points - 1 - i) * intervalMs);
        }
        return out;
    }

    function pointsForRangeMs(rangeMs) {
        var fiveMin = 5 * 60 * 1000;
        var n = Math.round(rangeMs / fiveMin);
        return clamp(n, 30, 120);
    }

    function generateSeries(opts) {
        var points = opts.points;
        var startValue = opts.startValue;
        var endValue = (opts.endValue === undefined) ? startValue : opts.endValue;
        var variation = (opts.variation === undefined) ? 0.05 : opts.variation;
        var rnd = new SeededRandom(opts.seed || 1);
        var out = [];
        for (var i = 0; i < points; i++) {
            var t = points <= 1 ? 1 : i / (points - 1);
            var base = startValue + (endValue - startValue) * t;
            var noise = (rnd.next() * 2 - 1) * variation * Math.abs(base || 1);
            var v = base + noise;
            if (opts.nonNegative !== false) { v = Math.max(0, v); }
            out.push(v);
        }
        if (points > 0 && opts.anchorEnd !== false) { out[points - 1] = endValue; }
        return out;
    }

    function generateCumulativeSeries(opts) {
        var points = opts.points;
        var endValue = opts.endValue;
        var rnd = new SeededRandom(opts.seed || 1);
        var weights = [];
        var sum = 0;
        var i;
        for (i = 0; i < points; i++) {
            var w = rnd.next() + 0.15;
            weights.push(w);
            sum += w;
        }
        var out = [];
        var acc = 0;
        for (i = 0; i < points; i++) {
            acc += (weights[i] / sum) * endValue;
            out.push(Math.round(acc));
        }
        if (points > 0) { out[points - 1] = endValue; }
        return out;
    }

    function seriesForRange(timeRange, points0, seed, startValue, endValue, variation) {
        var rangeMs = (global.DLStore && global.DLStore.rangeToMs(timeRange && timeRange.id)) || (6 * 60 * 60 * 1000);
        var points = points0 || pointsForRangeMs(rangeMs);
        var intervalMs = rangeMs / (points - 1 || 1);
        var timestamps = buildTimestamps(points, intervalMs);
        var values = generateSeries({ points: points, startValue: startValue, endValue: endValue, variation: variation, seed: seed });
        var out = [];
        for (var i = 0; i < points; i++) { out.push([timestamps[i], values[i]]); }
        return out;
    }

    /* ---------------------------------------------------------------- */
    /* Observed Object Storage sample (verbatim from supplied metrics)   */
    /* ---------------------------------------------------------------- */
    var OBSERVED_STORAGE_RAW = {
        clusterHealth: 1,
        driveHealth: 1,
        onlineNodes: 1,
        onlineDrives: 1,
        usableCapacityBytes: 5368690241536,
        freeCapacityBytes: 2876961931264,
        underlyingDriveUsedBytes: 2491728310272,
        storedDataBytes: 243414333,
        objectCount: 30,
        namespaceCount: 1,
        memoryTotalBytes: 220199854080,
        memoryUsedBytes: 94834704384,
        memoryUsedPercent: 43.06756,
        cpuLoadPercent: 0.11,
        runtimeWorkers: 498,
        serviceUptimeSeconds: 2048.661043,
        scansStarted: 34,
        scansFinished: 34,
        directoriesScanned: 112,
        objectsScanned: 60,
        driveLatencyMicros: {
            'delete': 310,
            'diskInfo': 108,
            'renameData': 10478
        },
        namespaces: [
            { name: 'data', objectCount: 30, storedBytes: 243414333 }
        ]
    };

    var usableUsedBytes = OBSERVED_STORAGE_RAW.usableCapacityBytes - OBSERVED_STORAGE_RAW.freeCapacityBytes;
    var usedPercent = (usableUsedBytes / OBSERVED_STORAGE_RAW.usableCapacityBytes) * 100;
    var freePercent = 100 - usedPercent;

    var REQUEST_OPERATIONS_OBSERVED = [
        { operation: 'GetBucketLocation', requests: 32, errors: 1 },
        { operation: 'GetBucketPolicy', requests: 17, errors: 17 },
        { operation: 'GetBucketTagging', requests: 17, errors: 17 },
        { operation: 'GetBucketVersioning', requests: 9, errors: 0 },
        { operation: 'ListObjectVersions', requests: 1, errors: 0 },
        { operation: 'ListObjectsV2', requests: 9, errors: 0 }
    ];

    var SERVICES_OBSERVED = [
        { id: 'metrics-store', role: 'Metrics Store', implementation: 'Prometheus', host: 'VM2', endpoint: '127.0.0.1:9090' },
        { id: 'log-store', role: 'Log Store', implementation: 'Loki', host: 'VM2', endpoint: '127.0.0.1:3100' },
        { id: 'visualization', role: 'Visualization Service', implementation: 'Grafana', host: 'VM2', endpoint: '127.0.0.1:3000' },
        { id: 'telemetry-collector', role: 'Telemetry Collector', implementation: 'Alloy', host: 'VM2', endpoint: '127.0.0.1:12345' },
        { id: 'object-storage', role: 'Object Storage', implementation: 'MinIO', host: 'VM1', endpoint: '10.2.8.237:9000' },
        { id: 'windows-metrics-vm1', role: 'Windows Metrics Agent', implementation: 'Telegraf', host: 'VM1', endpoint: '10.2.8.237:9273' },
        { id: 'windows-metrics-vm2', role: 'Windows Metrics Agent', implementation: 'Telegraf', host: 'VM2', endpoint: '127.0.0.1:9273' },
        { id: 'service-state-vm1', role: 'Service State Collector', host: 'VM1', endpoint: '10.2.8.237:9275' },
        { id: 'service-state-vm2', role: 'Service State Collector', host: 'VM2', endpoint: '127.0.0.1:9275' }
    ];

    var ACQUISITION_SOURCES = ['Historian', 'Relational Source', 'File Intake', 'OPC UA Gateway', 'Scheduled Imports'];

    var LAYERS = ['Acquisition', 'Storage', 'Processing', 'Quality', 'Publishing', 'Services', 'Hosts'];

    function buildEventPool(count, seed) {
        var rnd = new SeededRandom(seed);
        var templates = [
            { layer: 'Storage', text: 'Usage scan completed', sev: 'info', state: 'healthy', durMs: 10500 },
            { layer: 'Publishing', text: 'Dataset refreshed', sev: 'info', state: 'healthy', durMs: 1200 },
            { layer: 'Quality', text: 'Schema validation warning', sev: 'warning', state: 'warning', durMs: 420 },
            { layer: 'Acquisition', text: 'Source reconnected', sev: 'info', state: 'healthy', durMs: 640 },
            { layer: 'Processing', text: 'Job queued', sev: 'info', state: 'healthy', durMs: 0 },
            { layer: 'Services', text: 'Telemetry collector restarted', sev: 'warning', state: 'warning', durMs: 3200 },
            { layer: 'Hosts', text: 'CPU threshold recovered', sev: 'info', state: 'healthy', durMs: 0 },
            { layer: 'Storage', text: 'Namespace listing refreshed', sev: 'info', state: 'healthy', durMs: 820 },
            { layer: 'Quality', text: 'Freshness check failed', sev: 'critical', state: 'critical', durMs: 90 },
            { layer: 'Acquisition', text: 'Queue backlog cleared', sev: 'info', state: 'healthy', durMs: 15000 },
            { layer: 'Processing', text: 'Task retried', sev: 'warning', state: 'warning', durMs: 2100 },
            { layer: 'Publishing', text: 'Consumer request latency elevated', sev: 'warning', state: 'warning', durMs: 0 }
        ];
        var out = [];
        var end = global.__DL_NOW__ || Date.now();
        var hour = 60 * 60 * 1000;
        /* Distribute events across a realistic window so time-range filters and
           the header's "last 60 minutes" alert count behave meaningfully instead
           of clustering everything within seconds of "now". A handful of
           specific, mixed-severity events are pinned inside the last hour
           (matching the spec's "2 warnings, 1 critical" style example); the
           rest spread across the last 3 days for 24h/7d/30d ranges. */
        var recentTemplateIdx = [2, 5, 8];
        for (var i = 0; i < count; i++) {
            var tpl, offsetMs;
            if (i < recentTemplateIdx.length) {
                tpl = templates[recentTemplateIdx[i]];
                offsetMs = Math.round(rnd.range(60 * 1000, 50 * 60 * 1000));
            } else if (i < 15) {
                tpl = templates[i % templates.length];
                offsetMs = Math.round(rnd.range(hour, 6 * hour));
            } else {
                tpl = templates[i % templates.length];
                offsetMs = Math.round(rnd.range(6 * hour, 72 * hour));
            }
            var t = end - offsetMs;
            out.push({
                id: 'evt-' + i,
                time: t,
                layer: tpl.layer,
                summary: tpl.text,
                severity: tpl.sev,
                state: tpl.state,
                durationMs: tpl.durMs,
                host: (i % 2 === 0) ? 'VM1' : 'VM2',
                service: tpl.layer,
                correlationId: 'corr-' + (1000 + i),
                message: tpl.text + '.',
                provenance: 'prototype'
            });
        }
        out.sort(function (a, b) { return b.time - a.time; });
        return out;
    }

    var EVENT_POOL = buildEventPool(48, 7);

    function wrapObserved(value, source) {
        return { value: value, provenance: 'observed', source: source };
    }
    function wrapDerived(value, source) {
        return { value: value, provenance: 'derived', source: source };
    }
    function wrapPrototype(value) {
        return { value: value, provenance: 'prototype' };
    }

    var MockData = {
        SeededRandom: SeededRandom,
        generateSeries: generateSeries,
        generateCumulativeSeries: generateCumulativeSeries,
        seriesForRange: seriesForRange,
        buildTimestamps: buildTimestamps,
        pointsForRangeMs: pointsForRangeMs,

        observedStorageRaw: OBSERVED_STORAGE_RAW,
        derivedStorage: {
            usableUsedBytes: usableUsedBytes,
            usedPercent: usedPercent,
            freePercent: freePercent
        },
        requestOperationsObserved: REQUEST_OPERATIONS_OBSERVED,
        servicesObserved: SERVICES_OBSERVED,
        acquisitionSources: ACQUISITION_SOURCES,
        layers: LAYERS,
        eventPool: EVENT_POOL,

        wrapObserved: wrapObserved,
        wrapDerived: wrapDerived,
        wrapPrototype: wrapPrototype,

        /* -------- Flow / overview -------- */
        overview: function (timeRange) {
            var rangeMs = (global.DLStore && global.DLStore.rangeToMs(timeRange && timeRange.id)) || 21600000;
            var end = global.__DL_NOW__ || Date.now();
            return {
                summary: {
                    overallHealth: wrapDerived('healthy'),
                    freshnessSec: wrapPrototype(12),
                    inputRate: wrapPrototype(1842),
                    processingRate: wrapPrototype(1790),
                    storedDataBytes: wrapObserved(OBSERVED_STORAGE_RAW.storedDataBytes, 'minio_cluster_usage_objects_total_bytes'),
                    openEvents: wrapPrototype(3)
                },
                stages: [
                    { id: 'sources', label: 'Sources', state: 'healthy', rate: 1842, backlog: 0, latencyMs: 0, freshnessSec: 4 },
                    { id: 'acquisition', label: 'Acquisition', state: 'healthy', rate: 1842, backlog: 12, latencyMs: 34, freshnessSec: 6 },
                    { id: 'landing', label: 'Landing', state: 'healthy', rate: 1842, backlog: 0, latencyMs: 85, freshnessSec: 12 },
                    { id: 'validation', label: 'Validation', state: 'warning', rate: 1820, backlog: 4, latencyMs: 420, freshnessSec: 18 },
                    { id: 'processing', label: 'Processing', state: 'unavailable', rate: 0, backlog: 0, latencyMs: 1180, freshnessSec: null },
                    { id: 'curated', label: 'Curated', state: 'healthy', rate: 1790, backlog: 0, latencyMs: 0, freshnessSec: 40 },
                    { id: 'publishing', label: 'Publishing', state: 'healthy', rate: 1790, backlog: 0, latencyMs: 92, freshnessSec: 52 },
                    { id: 'consumers', label: 'Consumers', state: 'healthy', rate: 1765, backlog: 0, latencyMs: 0, freshnessSec: 60 }
                ],
                edges: [
                    { from: 'sources', to: 'acquisition', rate: 1842, latencyMs: 34 },
                    { from: 'acquisition', to: 'landing', rate: 1842, latencyMs: 51 },
                    { from: 'landing', to: 'validation', rate: 1820, latencyMs: 420 },
                    { from: 'validation', to: 'processing', rate: 1800, latencyMs: 1180 },
                    { from: 'processing', to: 'curated', rate: 1790, latencyMs: 0 },
                    { from: 'curated', to: 'publishing', rate: 1790, latencyMs: 92 },
                    { from: 'publishing', to: 'consumers', rate: 1765, latencyMs: 0 }
                ],
                timing: [
                    { stage: 'Acquire', durationMs: 34 },
                    { stage: 'Land', durationMs: 51 },
                    { stage: 'Validate', durationMs: 420 },
                    { stage: 'Process', durationMs: 1180 },
                    { stage: 'Publish', durationMs: 92 }
                ],
                totalDurationMs: 1777,
                activity: EVENT_POOL.slice(0, 12)
            };
        },

        /* -------- Acquisition -------- */
        acquisition: function (timeRange) {
            var rangeMs = (global.DLStore && global.DLStore.rangeToMs(timeRange && timeRange.id)) || 21600000;
            var points = pointsForRangeMs(rangeMs);
            var sourceSeries = {};
            var seedBase = 100;
            var rates = { Historian: 820, Relational: 410, Files: 340, Gateway: 272 };
            var key;
            for (key in rates) {
                if (rates.hasOwnProperty(key)) {
                    sourceSeries[key] = seriesForRange(timeRange, points, seedBase++, rates[key] * 0.9, rates[key], 0.12);
                }
            }
            return {
                summary: {
                    sourcesActive: wrapPrototype(5),
                    inputRate: wrapPrototype(1842),
                    freshnessSec: wrapPrototype(12),
                    droppedRecords: wrapPrototype(3),
                    reconnects: wrapPrototype(1),
                    queueDepth: wrapPrototype(214)
                },
                matrix: {
                    rows: ACQUISITION_SOURCES,
                    cols: ['Availability', 'Freshness', 'Throughput', 'Errors', 'Queue'],
                    cells: [
                        ['healthy', 'healthy', 'healthy', 'healthy', 'healthy'],
                        ['healthy', 'healthy', 'healthy', 'warning', 'warning'],
                        ['healthy', 'warning', 'healthy', 'healthy', 'healthy'],
                        ['warning', 'healthy', 'healthy', 'healthy', 'critical'],
                        ['healthy', 'healthy', 'healthy', 'healthy', 'healthy']
                    ]
                },
                inputRateSeries: sourceSeries,
                freshnessDistribution: [
                    { bucket: '< 15 s', count: 3 },
                    { bucket: '15-30 s', count: 1 },
                    { bucket: '30-60 s', count: 1 },
                    { bucket: '1-5 min', count: 0 },
                    { bucket: '> 5 min', count: 0 }
                ],
                queueRetry: {
                    queued: seriesForRange(timeRange, points, 201, 180, 214, 0.2),
                    retried: seriesForRange(timeRange, points, 202, 8, 3, 0.4)
                }
            };
        },

        /* -------- Storage -------- */
        storage: function (timeRange) {
            var rangeMs = (global.DLStore && global.DLStore.rangeToMs(timeRange && timeRange.id)) || 21600000;
            var points = pointsForRangeMs(rangeMs);
            var storedSeries = seriesForRange(timeRange, points, 42, 238000000, OBSERVED_STORAGE_RAW.storedDataBytes, 0.006);
            return {
                raw: OBSERVED_STORAGE_RAW,
                derived: {
                    usableUsedBytes: usableUsedBytes,
                    usedPercent: usedPercent,
                    freePercent: freePercent
                },
                storedDataSeries: storedSeries,
                requestRate: {
                    requestsPerSec: seriesForRange(timeRange, points, 301, 4, 6, 0.3),
                    errorsPerSec: seriesForRange(timeRange, points, 302, 0.6, 1.1, 0.4)
                },
                traffic: {
                    sentBytesPerSec: seriesForRange(timeRange, points, 303, 12000, 18400, 0.25),
                    receivedBytesPerSec: seriesForRange(timeRange, points, 304, 5200, 7100, 0.25)
                },
                requestOperations: REQUEST_OPERATIONS_OBSERVED,
                driveLatencyMicros: OBSERVED_STORAGE_RAW.driveLatencyMicros
            };
        },

        /* -------- Processing -------- */
        processing: function (timeRange) {
            var lastKnownAt = (global.__DL_NOW__ || Date.now()) - 18 * 60 * 1000;
            return {
                engineState: 'unavailable',
                lastKnownAt: lastKnownAt,
                summary: {
                    activeJobs: wrapPrototype(0),
                    queuedJobs: wrapPrototype(0),
                    runningTasks: wrapPrototype(0),
                    failedTasks: wrapPrototype(2),
                    processingRate: null
                },
                lastKnownJobs: [
                    { job: 'curate_daily_batch', stage: 'Write', startOffsetMs: -1600, durationMs: 1180, state: 'succeeded' },
                    { job: 'validate_incoming', stage: 'Compute', startOffsetMs: -3200, durationMs: 420, state: 'succeeded' },
                    { job: 'reindex_namespace', stage: 'Shuffle', startOffsetMs: -5400, durationMs: 2650, state: 'failed' }
                ],
                stageBreakdown: [
                    { job: 'curate_daily_batch', read: 220, shuffle: 140, compute: 610, write: 210 },
                    { job: 'validate_incoming', read: 80, shuffle: 40, compute: 260, write: 40 },
                    { job: 'reindex_namespace', read: 900, shuffle: 1200, compute: 400, write: 550 }
                ],
                rateHistory: null,
                failureAnalysis: [
                    { reason: 'Data read', count: 1 },
                    { reason: 'Transformation', count: 0 },
                    { reason: 'Validation', count: 0 },
                    { reason: 'Write', count: 1 },
                    { reason: 'Resource', count: 0 },
                    { reason: 'Timeout', count: 0 }
                ],
                technical: {
                    implementation: 'Apache Spark',
                    application: 'SparkSQL',
                    driverEndpoint: 'job="spark-sql-driver"',
                    executorEndpoint: 'job="spark-sql-executors"'
                }
            };
        },

        /* -------- Quality -------- */
        quality: function (timeRange) {
            var rangeMs = (global.DLStore && global.DLStore.rangeToMs(timeRange && timeRange.id)) || 21600000;
            var points = pointsForRangeMs(rangeMs);
            return {
                summary: {
                    checksPassed: wrapPrototype(58),
                    checksFailed: wrapPrototype(3),
                    freshnessSec: wrapPrototype(12),
                    rejectedRecords: wrapPrototype(14),
                    quarantinedRecords: wrapPrototype(2),
                    promotionSuccessPercent: wrapPrototype(96.4)
                },
                matrix: {
                    rows: ['data'].concat(ACQUISITION_SOURCES.slice(0, 3)),
                    cols: ['Freshness', 'Completeness', 'Validity', 'Uniqueness', 'Schema'],
                    cells: [
                        ['healthy', 'healthy', 'healthy', 'healthy', 'warning'],
                        ['healthy', 'warning', 'healthy', 'healthy', 'healthy'],
                        ['warning', 'healthy', 'critical', 'healthy', 'healthy'],
                        ['healthy', 'healthy', 'healthy', 'healthy', 'healthy']
                    ]
                },
                failedCheckTrend: {
                    critical: seriesForRange(timeRange, points, 401, 0, 1, 0.6),
                    warning: seriesForRange(timeRange, points, 402, 2, 3, 0.4)
                },
                promotionFunnel: [
                    { stage: 'Landed', count: 1842 },
                    { stage: 'Validated', count: 1820 },
                    { stage: 'Accepted', count: 1806 },
                    { stage: 'Curated', count: 1790 },
                    { stage: 'Published', count: 1790 }
                ],
                rules: [
                    { rule: 'Freshness under 60s', dataset: 'data', state: 'healthy', affectedRows: 0, lastRunOffsetMs: -40000, durationMs: 120 },
                    { rule: 'Non-null primary key', dataset: 'data', state: 'healthy', affectedRows: 0, lastRunOffsetMs: -50000, durationMs: 85 },
                    { rule: 'Schema drift check', dataset: 'data', state: 'warning', affectedRows: 6, lastRunOffsetMs: -60000, durationMs: 240 },
                    { rule: 'Duplicate key scan', dataset: 'data', state: 'critical', affectedRows: 14, lastRunOffsetMs: -90000, durationMs: 410 }
                ]
            };
        },

        /* -------- Publishing -------- */
        publishing: function (timeRange) {
            var rangeMs = (global.DLStore && global.DLStore.rangeToMs(timeRange && timeRange.id)) || 21600000;
            var points = pointsForRangeMs(rangeMs);
            return {
                summary: {
                    publishedDatasets: wrapPrototype(4),
                    activeConsumers: wrapPrototype(7),
                    refreshSuccessPercent: wrapPrototype(98.1),
                    refreshFailures: wrapPrototype(1),
                    servingLatencyMs: wrapPrototype(92),
                    requests: wrapPrototype(214)
                },
                datasets: ['data', 'curated_events', 'daily_rollup', 'quality_summary'],
                consumers: ['Report A', 'Report B', 'API Gateway', 'Analytics App'],
                graphEdges: [
                    { from: 'data', to: 'Report A', rate: 12, lastAccessOffsetMs: -30000 },
                    { from: 'data', to: 'API Gateway', rate: 48, lastAccessOffsetMs: -5000 },
                    { from: 'curated_events', to: 'Analytics App', rate: 30, lastAccessOffsetMs: -12000 },
                    { from: 'daily_rollup', to: 'Report B', rate: 6, lastAccessOffsetMs: -120000 },
                    { from: 'quality_summary', to: 'API Gateway', rate: 9, lastAccessOffsetMs: -20000 }
                ],
                refreshTimeline: [
                    { dataset: 'data', durationMs: 1200 },
                    { dataset: 'curated_events', durationMs: 2400 },
                    { dataset: 'daily_rollup', durationMs: 5200 },
                    { dataset: 'quality_summary', durationMs: 800 }
                ],
                consumerActivity: [
                    { consumer: 'API Gateway', requests: 122 },
                    { consumer: 'Analytics App', requests: 64 },
                    { consumer: 'Report A', requests: 18 },
                    { consumer: 'Report B', requests: 10 }
                ],
                servingLatency: {
                    p50: seriesForRange(timeRange, points, 501, 60, 92, 0.15),
                    p95: seriesForRange(timeRange, points, 502, 140, 210, 0.15),
                    p99: seriesForRange(timeRange, points, 503, 260, 340, 0.15)
                }
            };
        },

        /* -------- Services -------- */
        services: function (timeRange) {
            var rangeMs = (global.DLStore && global.DLStore.rangeToMs(timeRange && timeRange.id)) || 21600000;
            var points = pointsForRangeMs(rangeMs);
            var rnd = new SeededRandom(600);
            var rows = [];
            var i;
            for (i = 0; i < SERVICES_OBSERVED.length; i++) {
                var svc = SERVICES_OBSERVED[i];
                var state = 'healthy';
                if (svc.id === 'telemetry-collector') { state = 'warning'; }
                rows.push({
                    id: svc.id,
                    role: svc.role,
                    implementation: svc.implementation || null,
                    host: svc.host,
                    endpoint: svc.endpoint,
                    state: state,
                    availabilityPercent: state === 'warning' ? 98.2 : 99.9,
                    cpuPercent: Math.round(rnd.range(1, 18) * 10) / 10,
                    memoryBytes: Math.round(rnd.range(80, 900)) * 1024 * 1024,
                    requestsPerSec: Math.round(rnd.range(1, 40)),
                    errorsPerSec: Math.round(rnd.range(0, 2) * 10) / 10,
                    lastUpdateOffsetMs: -Math.round(rnd.range(2, 60)) * 1000
                });
            }
            var historyStates = ['healthy', 'warning', 'unavailable', 'unknown'];
            var history = {};
            for (i = 0; i < rows.length; i++) {
                var segRnd = new SeededRandom(700 + i);
                var segs = [];
                var t0 = (global.__DL_NOW__ || Date.now()) - rangeMs;
                var cursor = t0;
                var end = global.__DL_NOW__ || Date.now();
                while (cursor < end) {
                    var dur = Math.round(segRnd.range(0.15, 0.4) * rangeMs);
                    var s = 'healthy';
                    var roll = segRnd.next();
                    if (rows[i].id === 'telemetry-collector' && roll > 0.75) { s = 'warning'; }
                    else if (roll > 0.94) { s = 'warning'; }
                    segs.push({ start: cursor, end: Math.min(cursor + dur, end), state: s });
                    cursor += dur;
                }
                history[rows[i].id] = segs;
            }
            return {
                rows: rows,
                topologyEdges: [
                    { from: 'windows-metrics-vm1', to: 'metrics-store' },
                    { from: 'windows-metrics-vm2', to: 'metrics-store' },
                    { from: 'service-state-vm1', to: 'metrics-store' },
                    { from: 'service-state-vm2', to: 'metrics-store' },
                    { from: 'telemetry-collector', to: 'log-store' },
                    { from: 'metrics-store', to: 'visualization' },
                    { from: 'log-store', to: 'visualization' },
                    { from: 'object-storage', to: 'metrics-store' }
                ],
                availabilityHistory: history
            };
        },

        /* -------- Hosts -------- */
        hosts: function (timeRange) {
            var rangeMs = (global.DLStore && global.DLStore.rangeToMs(timeRange && timeRange.id)) || 21600000;
            var points = pointsForRangeMs(rangeMs);
            var hosts = [
                {
                    id: 'VM1', label: 'Data Node',
                    cpu: { usedPercent: 29.64 },
                    memory: { usedBytes: 94834704384, totalBytes: 220199854080, usedPercent: 43.06756 },
                    disks: [
                        { name: 'C:', usedBytes: 420000000000, freeBytes: 180000000000, readBps: 3200000, writeBps: 5400000, queue: 0.4, latencyMs: 3.1 },
                        { name: 'D:', usedBytes: 2491728310272, freeBytes: 2876961931264, readBps: 8100000, writeBps: 12400000, queue: 1.1, latencyMs: 10.5 }
                    ],
                    network: { rx: 1200000, tx: 3400000, errors: 0, drops: 0 },
                    criticalServices: 0
                },
                {
                    id: 'VM2', label: 'Operations Node',
                    cpu: { usedPercent: 14.2 },
                    memory: { usedBytes: 51200000000, totalBytes: 137438953472, usedPercent: 37.26 },
                    disks: [
                        { name: 'C:', usedBytes: 210000000000, freeBytes: 90000000000, readBps: 900000, writeBps: 1400000, queue: 0.2, latencyMs: 2.4 }
                    ],
                    network: { rx: 640000, tx: 980000, errors: 0, drops: 0 },
                    criticalServices: 1
                }
            ];
            var cpuHistory = {
                VM1: seriesForRange(timeRange, points, 801, 24, 29.64, 0.18),
                VM2: seriesForRange(timeRange, points, 802, 12, 14.2, 0.2)
            };
            var memHistory = {
                VM1: seriesForRange(timeRange, points, 811, 41, 43.06756, 0.06),
                VM2: seriesForRange(timeRange, points, 812, 36, 37.26, 0.06)
            };
            return {
                summary: {
                    hostsAvailable: wrapPrototype(2),
                    cpuAvgPercent: wrapPrototype((29.64 + 14.2) / 2),
                    memoryAvgPercent: wrapDerived((43.06756 + 37.26) / 2),
                    diskUsedPercent: wrapPrototype(46.4),
                    networkMbps: wrapPrototype(4.6),
                    stoppedServices: wrapPrototype(1)
                },
                hosts: hosts,
                cpuHistory: cpuHistory,
                memHistory: memHistory,
                networkHistory: {
                    rx: seriesForRange(timeRange, points, 821, 1100000, 1840000, 0.2),
                    tx: seriesForRange(timeRange, points, 822, 3100000, 4380000, 0.2),
                    errors: seriesForRange(timeRange, points, 823, 0, 0, 0),
                    drops: seriesForRange(timeRange, points, 824, 0, 0, 0)
                },
                serviceFailures: [
                    { host: 'VM2', role: 'Windows Metrics Agent', count: 1, lastOffsetMs: -720000 }
                ]
            };
        },

        /* -------- Logs / events -------- */
        logs: function (timeRange, filters) {
            var rangeMs = (global.DLStore && global.DLStore.rangeToMs(timeRange && timeRange.id)) || 21600000;
            var end = global.__DL_NOW__ || Date.now();
            var start = end - rangeMs;
            var events = EVENT_POOL.filter(function (e) { return e.time >= start && e.time <= end; });
            if (filters) {
                if (filters.severity && filters.severity !== 'ALL') {
                    events = events.filter(function (e) { return e.severity === filters.severity; });
                }
                if (filters.layer && filters.layer !== 'ALL') {
                    events = events.filter(function (e) { return e.layer === filters.layer; });
                }
                if (filters.host && filters.host !== 'ALL') {
                    events = events.filter(function (e) { return e.host === filters.host; });
                }
                if (filters.text) {
                    var q = filters.text.toLowerCase();
                    events = events.filter(function (e) { return e.summary.toLowerCase().indexOf(q) >= 0; });
                }
            }
            var buckets = 24;
            var bucketMs = rangeMs / buckets;
            var density = [];
            for (var b = 0; b < buckets; b++) {
                var bStart = start + b * bucketMs;
                var bEnd = bStart + bucketMs;
                var counts = { critical: 0, error: 0, warning: 0, information: 0 };
                for (var i = 0; i < EVENT_POOL.length; i++) {
                    var e = EVENT_POOL[i];
                    if (e.time >= bStart && e.time < bEnd) {
                        if (e.severity === 'critical') { counts.critical++; }
                        else if (e.severity === 'warning') { counts.warning++; }
                        else { counts.information++; }
                    }
                }
                density.push({ time: bStart, counts: counts });
            }
            return {
                density: density,
                lanes: LAYERS.slice(0, 7),
                events: events
            };
        },

        /* -------- Investigation -------- */
        investigation: function (componentId, timeRange) {
            var deps = {
                'object-storage': { upstream: ['landing', 'curated'], downstream: ['processing', 'publishing'] },
                'landing': { upstream: ['acquisition'], downstream: ['validation', 'object-storage'] },
                'processing': { upstream: ['validation'], downstream: ['curated'] }
            };
            var d = deps[componentId] || { upstream: [], downstream: [] };
            var rangeMs = (global.DLStore && global.DLStore.rangeToMs(timeRange && timeRange.id)) || 21600000;
            var points = pointsForRangeMs(rangeMs);
            return {
                componentId: componentId,
                dependency: d,
                metrics: {
                    requestRate: seriesForRange(timeRange, points, 901, 4, 6, 0.3),
                    errorRate: seriesForRange(timeRange, points, 902, 0.4, 1.1, 0.4),
                    traffic: seriesForRange(timeRange, points, 903, 12000, 18400, 0.25),
                    driveLatency: seriesForRange(timeRange, points, 904, 8, 10.5, 0.2),
                    capacity: seriesForRange(timeRange, points, 905, 44, 46.4, 0.03),
                    scannerActivity: seriesForRange(timeRange, points, 906, 30, 34, 0.1),
                    hostDiskQueue: seriesForRange(timeRange, points, 907, 0.6, 1.1, 0.3),
                    hostMemory: seriesForRange(timeRange, points, 908, 41, 43.06756, 0.05)
                },
                timeline: EVENT_POOL.slice(0, 10)
            };
        }
    };

    global.MockData = MockData;
})(window);
