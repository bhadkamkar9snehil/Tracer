/* prometheus-adapter.js - optional direct Prometheus query adapter.
   Kept separate from view files: views never build PromQL themselves,
   they call DataSource.* which, in API mode, may be backed by a
   same-origin proxy that in turn talks to this adapter server-side or
   client-side depending on deployment. */
(function (global) {
    'use strict';

    var QUERIES = {
        clusterHealth: 'minio_cluster_erasure_set_overall_health{job="minio"}',
        usableCapacityTotal: 'minio_cluster_health_capacity_usable_total_bytes{job="minio"}',
        usableCapacityFree: 'minio_cluster_health_capacity_usable_free_bytes{job="minio"}',
        usageObjectsBytes: 'minio_cluster_usage_objects_total_bytes{job="minio"}',
        usageObjectsCount: 'minio_cluster_usage_objects_count{job="minio"}',
        usageBucketsCount: 'minio_cluster_usage_objects_buckets_count{job="minio"}',
        driveHealth: 'minio_system_drive_health{job="minio"}',
        memoryUsed: 'minio_system_memory_used{job="minio"}',
        memoryTotal: 'minio_system_memory_total{job="minio"}',
        memoryUsedPerc: 'minio_system_memory_used_perc{job="minio"}',
        cpuLoadPerc: 'minio_system_cpu_load_perc{job="minio"}',
        goroutines: 'minio_system_process_go_routine_total{job="minio"}',
        uptimeSeconds: 'minio_system_process_uptime_seconds{job="minio"}',
        scanBucketsStarted: 'minio_scanner_bucket_scans_started{job="minio"}',
        scanBucketsFinished: 'minio_scanner_bucket_scans_finished{job="minio"}',
        scanObjects: 'minio_scanner_objects_scanned{job="minio"}',
        scanDirectories: 'minio_scanner_directories_scanned{job="minio"}',
        driveApiLatencyMicros: 'minio_system_drive_api_latency_micros{job="minio"}',
        requestsPerSec: 'sum(rate(minio_api_requests_total{job="minio"}[5m]))',
        requestErrorsPerSec: 'sum(rate(minio_api_requests_errors_total{job="minio"}[5m]))',
        trafficSentPerSec: 'sum(rate(minio_api_requests_traffic_sent_bytes{job="minio"}[5m]))',
        trafficReceivedPerSec: 'sum(rate(minio_api_requests_traffic_received_bytes{job="minio"}[5m]))',
        up: 'up',
        telegrafWindows: 'up{job=~"telegraf-windows-sql|telegraf-windows-sql-vm1"}',
        serviceExporter: 'up{job=~"service-exporter|service-exporter-vm1"}',
        sparkUp: 'up{job=~"spark-sql-driver|spark-sql-executors"}'
    };

    function buildUrl(baseUrl, path, params) {
        var url = baseUrl.replace(/\/$/, '') + path;
        var qs = [];
        for (var k in params) {
            if (params.hasOwnProperty(k) && params[k] !== undefined) {
                qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
            }
        }
        return qs.length ? url + '?' + qs.join('&') : url;
    }

    function PrometheusAdapter(baseUrl) {
        this.baseUrl = baseUrl || '';
    }

    PrometheusAdapter.prototype.queryInstant = function (promql, signal) {
        var url = buildUrl(this.baseUrl, '/api/v1/query', { query: promql });
        var opts = { credentials: 'same-origin' };
        if (signal) { opts.signal = signal; }
        return fetch(url, opts).then(function (res) {
            if (!res.ok) { throw new Error('Prometheus instant query failed: ' + res.status); }
            return res.json();
        });
    };

    PrometheusAdapter.prototype.queryRange = function (promql, from, to, step, signal) {
        var url = buildUrl(this.baseUrl, '/api/v1/query_range', {
            query: promql,
            start: Math.floor(from / 1000),
            end: Math.floor(to / 1000),
            step: step
        });
        var opts = { credentials: 'same-origin' };
        if (signal) { opts.signal = signal; }
        return fetch(url, opts).then(function (res) {
            if (!res.ok) { throw new Error('Prometheus range query failed: ' + res.status); }
            return res.json();
        });
    };

    PrometheusAdapter.QUERIES = QUERIES;
    global.PrometheusAdapter = PrometheusAdapter;
})(window);
