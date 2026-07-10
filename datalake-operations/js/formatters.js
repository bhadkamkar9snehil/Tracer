/* formatters.js - shared display formatting helpers (ES5 compatible) */
(function (global) {
    'use strict';

    var BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];

    function formatBytes(value, decimals) {
        if (value === null || value === undefined || isNaN(value)) { return '—'; }
        var d = (decimals === undefined) ? 2 : decimals;
        var v = Math.abs(value);
        if (v < 1) { return '0 B'; }
        var i = Math.min(Math.floor(Math.log(v) / Math.log(1000)), BYTE_UNITS.length - 1);
        var out = value / Math.pow(1000, i);
        return out.toFixed(i === 0 ? 0 : d) + ' ' + BYTE_UNITS[i];
    }

    function formatRate(value, unit) {
        if (value === null || value === undefined || isNaN(value)) { return '—'; }
        var u = unit || 'records/s';
        return formatCompact(value) + ' ' + u;
    }

    function formatDurationMs(value) {
        if (value === null || value === undefined || isNaN(value)) { return '—'; }
        if (value < 1000) { return Math.round(value) + ' ms'; }
        return formatDurationSeconds(value / 1000);
    }

    function formatDurationSeconds(value) {
        if (value === null || value === undefined || isNaN(value)) { return '—'; }
        var s = value;
        if (s < 1) { return Math.round(s * 1000) + ' ms'; }
        if (s < 60) {
            return (Math.round(s * 10) / 10) + ' s';
        }
        var totalSec = Math.round(s);
        var h = Math.floor(totalSec / 3600);
        var m = Math.floor((totalSec % 3600) / 60);
        var sec = totalSec % 60;
        if (h > 0) {
            return h + ' h ' + m + ' min';
        }
        if (m > 0) {
            return m + ' min ' + sec + ' s';
        }
        return sec + ' s';
    }

    function formatPercent(value, decimals) {
        if (value === null || value === undefined || isNaN(value)) { return '—'; }
        var d = (decimals === undefined) ? 1 : decimals;
        return value.toFixed(d) + '%';
    }

    function formatInteger(value) {
        if (value === null || value === undefined || isNaN(value)) { return '—'; }
        var n = Math.round(value);
        var s = Math.abs(n).toString();
        var out = '';
        for (var i = 0; i < s.length; i++) {
            if (i > 0 && (s.length - i) % 3 === 0) { out += ','; }
            out += s[i];
        }
        return (n < 0 ? '-' : '') + out;
    }

    function formatCompact(value) {
        if (value === null || value === undefined || isNaN(value)) { return '—'; }
        var abs = Math.abs(value);
        if (abs >= 1e9) { return (value / 1e9).toFixed(2) + 'B'; }
        if (abs >= 1e6) { return (value / 1e6).toFixed(2) + 'M'; }
        if (abs >= 1e3) { return (value / 1e3).toFixed(abs >= 1e4 ? 1 : 2) + 'k'; }
        return formatInteger(value);
    }

    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function formatTimestamp(value, rangeSpanMs) {
        if (value === null || value === undefined || isNaN(value)) { return '—'; }
        var d = new Date(value);
        var hh = pad2(d.getHours());
        var mm = pad2(d.getMinutes());
        var ss = pad2(d.getSeconds());
        var span = rangeSpanMs || 0;
        var day = 24 * 60 * 60 * 1000;
        if (span > 7 * day) {
            return pad2(d.getDate()) + ' ' + MONTHS[d.getMonth()];
        }
        if (span > day) {
            return pad2(d.getDate()) + ' ' + MONTHS[d.getMonth()] + ' ' + hh + ':' + mm;
        }
        return hh + ':' + mm + ':' + ss;
    }

    function formatClock(value) {
        var d = new Date(value);
        return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }

    function formatRelativeTime(value, nowMs) {
        if (value === null || value === undefined || isNaN(value)) { return '—'; }
        var now = nowMs || Date.now();
        var diffSec = Math.round((now - value) / 1000);
        if (diffSec < 0) { diffSec = 0; }
        if (diffSec < 60) { return diffSec + ' s ago'; }
        if (diffSec < 3600) { return Math.round(diffSec / 60) + ' min ago'; }
        if (diffSec < 86400) { return Math.round(diffSec / 3600) + ' h ago'; }
        return Math.round(diffSec / 86400) + ' d ago';
    }

    var STATE_LABELS = {
        healthy: 'Healthy',
        warning: 'Warning',
        critical: 'Critical',
        unknown: 'Unknown',
        unavailable: 'Unavailable',
        up: 'UP',
        down: 'DOWN',
        late: 'LATE',
        failed: 'FAILED',
        running: 'Running',
        queued: 'Queued',
        succeeded: 'Succeeded',
        skipped: 'Skipped',
        idle: 'Idle',
        available: 'Available'
    };

    function formatState(value) {
        if (!value) { return 'Unknown'; }
        var key = String(value).toLowerCase();
        return STATE_LABELS[key] || (value.charAt(0).toUpperCase() + value.slice(1));
    }

    var DRIVE_OP_LABELS = {
        'storage.RenameData': 'Rename Data',
        'storage.Delete': 'Delete',
        'storage.DiskInfo': 'Disk Information'
    };

    function formatOperationLabel(metricOperation) {
        return DRIVE_OP_LABELS[metricOperation] || metricOperation;
    }

    var Formatters = {
        formatBytes: formatBytes,
        formatRate: formatRate,
        formatDurationMs: formatDurationMs,
        formatDurationSeconds: formatDurationSeconds,
        formatPercent: formatPercent,
        formatInteger: formatInteger,
        formatCompact: formatCompact,
        formatTimestamp: formatTimestamp,
        formatClock: formatClock,
        formatRelativeTime: formatRelativeTime,
        formatState: formatState,
        formatOperationLabel: formatOperationLabel
    };

    global.Formatters = Formatters;
})(window);
