#!/usr/bin/env python3
"""Concatenates the modular source into datalake-operations-standalone.html.

The modular files under css/ and js/ remain the maintainable source; this
script produces the single-file deployment/embedding artifact. Re-run after
changing any source file.
"""
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(os.path.dirname(ROOT), "datalake-operations-standalone.html")

CSS_FILES = [
    "css/tokens.css",
    "css/base.css",
    "css/layout.css",
    "css/components.css",
    "css/charts.css",
    "css/responsive.css",
]

JS_FILES = [
    "js/vendor/echarts.min.js",
    "js/formatters.js",
    "js/state.js",
    "js/mock-data.js",
    "js/data-source.js",
    "js/prometheus-adapter.js",
    "js/charts.js",
    "js/interactions.js",
    "js/navigation.js",
    "js/router.js",
    "js/views/overview.js",
    "js/views/acquisition.js",
    "js/views/storage.js",
    "js/views/processing.js",
    "js/views/quality.js",
    "js/views/publishing.js",
    "js/views/infrastructure.js",
    "js/views/logs.js",
    "js/views/investigation.js",
    "js/views/detail.js",
    "js/app.js",
]


def read(path):
    with open(os.path.join(ROOT, path), "r", encoding="utf-8") as f:
        return f.read()


def build():
    css_blob = "\n".join("/* ---- %s ---- */\n%s" % (p, read(p)) for p in CSS_FILES)
    js_blob = "\n".join(";\n/* ---- %s ---- */\n%s" % (p, read(p)) for p in JS_FILES)

    html = []
    html.append("<!doctype html>")
    html.append('<html lang="en">')
    html.append("<head>")
    html.append('<meta charset="utf-8">')
    html.append('<meta name="viewport" content="width=device-width, initial-scale=1">')
    html.append('<meta name="robots" content="noindex">')
    html.append("<title>Data Lake Operations</title>")
    html.append("<style>\n%s\n</style>" % css_blob)
    html.append("</head>")
    html.append("<body>")
    html.append('<div id="dl-app" class="dl-app">')
    html.append('  <header id="dl-header" class="dl-header"></header>')
    html.append('  <nav id="dl-nav" class="dl-nav"></nav>')
    html.append('  <div id="dl-context-strip" class="dl-context-strip"></div>')
    html.append('  <main id="dl-view" class="dl-view"></main>')
    html.append('  <div id="dl-drawer-root" class="dl-drawer-root"></div>')
    html.append('  <div id="dl-tooltip-root" class="dl-tooltip-root"></div>')
    html.append('  <div id="dl-toast-root" class="dl-toast-root"></div>')
    html.append("</div>")
    html.append("<script>\n%s\n</script>" % js_blob)
    html.append("""<script>
  (function () {
    if (window.DataLakeUI && typeof window.DataLakeUI.mount === 'function') {
      var host = document.getElementById('dl-app');
      window.DataLakeUI.mount(host, {
        mode: 'mock',
        initialRoute: 'flow',
        refreshIntervalMs: 15000,
        theme: 'light',
        hostLabels: { VM1: 'Data Node', VM2: 'Operations Node' },
        showTechnicalDetails: true
      });
    }
  })();
</script>""")
    html.append("</body>")
    html.append("</html>")
    html.append("")

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(html))

    size_kb = os.path.getsize(OUT_PATH) / 1024.0
    print("Wrote %s (%.1f KB)" % (OUT_PATH, size_kb))


if __name__ == "__main__":
    build()
