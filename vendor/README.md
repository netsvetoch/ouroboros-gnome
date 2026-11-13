# WHATWG URL parser

`src/gjs/vendor/field-url.js` bundles only the pure URL entry point of
[core-js-pure 3.51.0](https://github.com/zloirock/core-js/tree/v3.51.0), under
the MIT license in [core-js-pure.LICENSE](core-js-pure.LICENSE).
It exports `FieldURL` for validation of URL form values and resolution of table hyperlinks. It does not install
global `URL` or `URLSearchParams` constructors or use a browser process.

Normal TypeScript and Flatpak builds use the committed file and require no npm
downloads. Flatpak includes the license alongside the application.

Rebuild with `python3 scripts/build-field-url.py`. That optional maintenance
command downloads the pinned core-js-pure package and esbuild 0.28.2 into a
temporary directory, verifies the source package integrity and emits a readable
ES module. No dependency is installed in the project.

Reviewed npm archive integrity:
`sha512-NE4SFDJ+qzQeqHG2vVSNwopzS6zZNPYJ5kinIqs+OofTqGzOmICgT89E/yvS9XY7rwb3eU1utWXTJ9nVFqv74A==`

Generated source SHA-256:
`56b559c20cd75a481a153b7b6dc5fcdd470dae2d6089b90857cf130abaeca9d6`.

# Markdown parser

`src/gjs/vendor/markdown-parser.js` bundles [Marked 18.0.7](https://github.com/markedjs/marked),
[parse5 8.1.1](https://github.com/inikulin/parse5) and
[entities 9.0.0](https://github.com/fb55/entities). Marked matches the version in
the reviewed Ouroboros gateway. Its GFM output is parsed into inert HTML data;
application code filters this tree and constructs GTK widgets and escaped Pango
markup. This bundle neither renders HTML nor fetches assets or executes scripts.

Licenses are preserved in [marked.LICENSE](marked.LICENSE),
[parse5.LICENSE](parse5.LICENSE) (MIT), and
[entities.LICENSE](entities.LICENSE) (BSD-2-Clause). Flatpak installs all three.
Normal builds and application startup require no package downloads.

Rebuild with `python3 scripts/build-markdown.py`. This optional maintenance
command downloads the three pinned source packages, verifies each npm archive
against the integrity below, installs them with esbuild 0.28.2 in a temporary
directory with lifecycle scripts disabled, and emits a readable ES module.
No dependency is installed in the project.

Reviewed npm archive integrities:

- Marked: `sha512-iDVQ5ldaiKXn6b2JroX5kgRfmwgqolW7NpaEzTl1k/2Zh1njIEN9yniyLV/mOvWwtsE8OGgkjsCYvijuPk1dtA==`
- parse5: `sha512-EcR/6WDcU7b2N3vQSxKALCk9lXGtUMQxXio008OEMBE0kavu/7JLfBEeFPzi43nMqVDSbEn3QCK+BMCc9zO//w==`
- entities: `sha512-oJFNDJg3kTPwAD1cNn2+WmUq4wFoo09npc3Ydf1D7ED4smRiWrsKnaLxykrTWgyGEcusc87P5dxlAleol9kpkg==`

Generated source SHA-256:
`6fc83ba5702de31027ad14541e3b29f4ee18315f53ed62612456baee3b3668e1`.


The chat entry point additionally bundles selected pure source helpers from
[Ouroboros chat_markdown.js at 15cacd3](https://github.com/razzant/ouroboros/blob/15cacd32310868934da44d3c5c6b68ccb6cf458a/web/modules/chat_markdown.js).
`ouroboros-chat-source.js` preserves those helpers, with only added exports for
`protectLatexDelimiters` and `renderImageReference`. They neutralize raw HTML,
preserve code and math delimiters, and produce inert image references. The chat
parser uses GFM with `breaks: true`; component documents retain `breaks: false`.
The upstream MIT license is in [ouroboros.LICENSE](ouroboros.LICENSE) and is
included in Flatpak. Helpers' SHA-256:
`57c9e702b4ec2de57cfb440c554cdd938645723e6db370d293fa98987d8ea9e6`.


# Code language detector

`src/gjs/vendor/code-detector.js` bundles the common language subset of
[Highlight.js 11.11.1](https://github.com/highlightjs/highlight.js/tree/11.11.1).
The detector uses the same 37-language set and alphabetical comparison order as
the reviewed gateway's `web/highlight.min.js`; the explicit subset preserves
upstream tie-breaking despite npm common's different registration order.
Its only application entry point returns a detected language. Display and colors
are provided by native GtkSourceView, and no generated HTML is mounted or executed.
`detectorLanguages` exposes the subset for conformance checks.

The BSD-3-Clause license is preserved in
[highlight.js.LICENSE](highlight.js.LICENSE) and installed in Flatpak.
Rebuild with `python3 scripts/build-code-detector.py`. This optional command uses
pinned npm source and esbuild 0.28.2 in a temporary directory, verifies the source
archive integrity, and disables install lifecycle scripts. Normal TypeScript and
Flatpak builds and application startup require no package downloads.

Reviewed npm archive integrity:
`sha512-Xwwo44whKBVCYoliBQwaPvtd/2tYFkRQtXDWj1nackaV2JPXx3L0+Jvd8/qCJ2p+ML0/XVkJ2q+Mr+UVdpJK5w==`

Generated source SHA-256:
`4cf9022f54f82e911390afeca220cdc5f4b379d57b438df41b17cc3772b642d6`.


# Native chart engine

`src/gjs/vendor/chart-engine.js` bundles
[Chart.js 4.4.8](https://github.com/chartjs/Chart.js/tree/v4.4.8), matching the
reviewed gateway, and [@kurkle/color 0.3.4](https://github.com/kurkle/color).
All built-in controllers/plugins/scales are registered. The application selects
BasicPlatform with static rendering; its Canvas 2D adapter uses owned Cairo
surfaces and Pango text. No DOM, browser, gateway static asset, or remote chart
service is required.

MIT licenses are preserved in [chart.js.LICENSE](chart.js.LICENSE) and
[kurkle-color.LICENSE](kurkle-color.LICENSE), and installed in Flatpak.
Rebuild with `python3 scripts/build-chart-engine.py`: pinned source archives are
verified and bundled using esbuild 0.28.2 in a temporary directory with lifecycle
scripts disabled. Ordinary builds and application startup download no packages.

Reviewed npm archive integrities:

- Chart.js: `sha512-IkGZlVpXP+83QpMm4uxEiGqSI7jFizwVtF3+n5Pc3k7sMO+tkd0qxh2OzLhenM0K80xtmAONWGBn082EiBQSDA==`
- @kurkle/color: `sha512-M5UknZPHRu3DEDWoipU6sE8PdkZ6Z/S+v4dD+Ke8IaNlpdSQah50lz1KtcFBa2vsdOnwbbnxJwVM4wty6udA5w==`

Generated source SHA-256:
`314fd70da75f9d8d2d5b4260175ffb45a603aca3680e6770c4e184363a92c070`.


# Native map runtime

Flatpak builds [libshumate 1.7.0](https://download.gnome.org/sources/libshumate/1.7/)
(LGPL-2.1-or-later) and [protobuf-c 1.5.2](https://github.com/protobuf-c/protobuf-c/releases/tag/v1.5.2)
(BSD-2-Clause). Source archive SHA-256 values are pinned in the Flatpak manifest;
licenses are installed in `/app/share/licenses/libshumate/COPYING` and
`/app/share/licenses/protobuf-c/LICENSE`. The Shumate typelib and shared library
are retained in the application. No web map engine is used.

[patches/libshumate-1.7-raster.patch](patches/libshumate-1.7-raster.patch) decodes
standard raster tiles through GDK before falling back to GdkPixbuf, reports
missing paintables as decode errors, honors `shumate_set_user_agent`, preserves
a deferred grid tick when recomputation happens within the same frame, and
allows map completion signals without sysprof (its timing sentinel is -1).
The application also re-notifies the viewport on two frames after movement for
unpatched host libraries. This bounded workaround does not retry HTTP requests.
The native map's source/session is independent of gateway credentials.


# Native formula engine

`src/gjs/vendor/math-engine.js` bundles [KaTeX 0.17.0](https://github.com/KaTeX/KaTeX/tree/v0.17.0)
(MIT, `katex.LICENSE`) and [MathJax 3.2.2](https://github.com/mathjax/MathJax-src/tree/3.2.2)
(Apache-2.0, `mathjax-full.LICENSE`). Both licenses are installed in Flatpak.
KaTeX matches the reviewed gateway's version and compiles TeX to inert MathML;
MathJax's MathML input and synchronous SVG output embed their font paths
(`fontCache: 'none'`). `liteAdaptor` replaces a DOM. No browser, CDN, external
font, dynamic package loader, or TeX executable is required.

[math-engine-source.js](math-engine-source.js) selects KaTeX's non-strict,
untrusted configuration and a maximum of 1000 macro expansions. Parse failures
use readable-source fallback. Trusted HTML/URL features stay disabled as in the
gateway. There is no mhchem extension in the reviewed gateway, so `\ce` is
likewise unsupported. Independent messages have independent macro objects;
formulas within one document are prepared once in source order, including lazy
tables and hidden blocks. Global definitions persist within that document.
The wrapper validates dimensions and excludes external SVG resources. Native
librsvg ink bounds retain overhanging rules, raises and overlaps that extend
outside MathML's logical box. KaTeX's rule background is changed from MathML's
hardcoded black to inherited `currentColor`, matching its HTML foreground.
The SVG font metrics/spacing need not be pixel-identical to KaTeX HTML output.

Rebuild with `python3 scripts/build-math-engine.py`. It verifies pinned npm
archives, disables install lifecycle scripts and bundles using esbuild 0.28.2.
Normal builds and startup use the committed bundle without package downloads.
Reviewed npm archive integrities:

- mathjax-full 3.2.2: `sha512-+LfG9Fik+OuI8SLwsiR02IVdjcnRCy5MufYLi0C3TdMT56L/pjB0alMVGgoWJF8pN9Rc7FESycZB9BMNWIid5w==`
- katex 0.17.0: `sha512-Vdw0ATsQ9V+LuegM/BTwQqV/6cTl5lbGcIrU+BCgLxyf6bo38ybOr372tuSIxir3CN720flu1meYR6XzNMwQnw==`

Generated source SHA-256:
`690d7b711c0ebd79723e928085c494a4e99b95d66dbb16b494396e1855141be6`.

`node scripts/build-katex-fixture.mjs /path/to/ouroboros-checkout` reproduces 54
MathML/error conformance cases using the gateway's actual KaTeX bundle. It checks
its SHA-256 `45fbe318fea878fdc0a111913dc1f87894b2c439360d0228c086ef313f213efc`,
verified against the [pinned upstream file](https://github.com/razzant/ouroboros/blob/15cacd32310868934da44d3c5c6b68ccb6cf458a/web/vendor/katex/katex.min.js).
Results are retained in `tests/fixtures/katex-gateway-0.17.json` for Node/GJS
checks without the upstream checkout or any network access.


# Native Mermaid display

`vendor/mermaid-browser.js` is the exact Mermaid 11.16.1 browser distribution in
[the reviewed gateway](https://github.com/razzant/ouroboros/blob/15cacd32310868934da44d3c5c6b68ccb6cf458a/web/mermaid.min.js).
SHA-256: `18327bef70d96fb505fe7287d9f6a7362ebf07ff6576ddfaffb1a06f3e1a2954`.
The MIT license is retained as `mermaid.LICENSE` and installed in Flatpak;
third-party notices remain in the unchanged distribution. Reproduce both files
with `python3 scripts/build-mermaid-engine.py`, which downloads the pinned
upstream files and verifies their hashes. Normal builds copy this classic script
byte-for-byte to the runtime's vendor directory, without passing it through
TypeScript's ESM conversion. Startup requires no package/CDN download.

Mermaid's DOM layout runs in one unparented WebKit view with its own WebContext,
ephemeral network session and content manager. The view never becomes a child
of the visible GTK interface. CSP and a content filter block network resources;
inline raster data images are permitted. The program uses Mermaid's strict mode,
HTML label layout matching the gateway, and the same parser/layout distribution.
Each job resets configuration so earlier directives do not affect later jobs.
A serial queue handles cancellation, a render deadline, and process recovery;
the web process is terminated after an idle interval. No gateway object, token,
cookie, static SPA, or remote diagram service is supplied to this worker.

The visible diagram uses Gtk.DrawingArea and librsvg/Cairo. Controls, scrolling,
zoom, source copy, SVG export and extracted links use GTK. HTML label
runs (including flowcharts and Journey) are converted to positioned SVG text using DOM ranges,
computed font metrics and Canvas text measurement. `switch` fallbacks are removed
to prevent duplicate labels; SVG text preserves whitespace across tspan runs.
Styles and SVG references are checked before returning the result; external
links become native controls rather than active SVG content.

`tests/fixtures/mermaid-diagrams.json` covers the locally bundled diagram types,
legacy variants, front matter, Unicode and inline images. The GJS test verifies
the set against Mermaid's actual registered catalog, excluding service entries,
the unavailable external ELK plugin and the broken legacy state renderer.
The latter's `getRootDoc` failure was reproduced directly with the unchanged
upstream distribution. These unavailable renderers retain readable source.
Node and HTML-label images are fetched by the native Soup client: approved same-origin file
and task-artifact routes use Gateway authentication; all other HTTP(S) sources
use an anonymous session without cookies or tokens. Redirects remain anonymous.
PNG/JPEG/GIF/WebP and SVG are decoded natively and normalized to embedded PNG;
SVG decoding has no base URI. Byte/pixel limits, cancellation and job-level URL
deduplication bound the work. The worker receives only image data, never gateway
credentials. FlowDB getters are temporarily adapted for the pinned version so
render() can reparse the original source without rewriting labels or links.
`tests/diagram-images-gjs.js` covers real HTTP headers, redirects, embedded pixel
colors, SVG dimensions, invalid/oversized data, cancellation and recovery.
The tiny GIF/JPEG/WebP fixtures are generated solid-color 3×2 images.
For HTML labels, per-job DOM assignment hooks parse image attributes through an
[inert HTML template](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/template).
The discovery layout uses an embedded placeholder; native loading then precedes
another layout of the unchanged source with real image dimensions. At most four
loads run concurrently. The hooks cover innerHTML, img.src and setAttribute and
are restored in finally; failed parallel requests are removed from the worker's
pending map. Positioned SVG images replace HTML img elements together with the
existing SVG text conversion. Image alt text and enclosing links are retained.
The corpus includes image labels on flowchart nodes/edges, class and state;
original raster colors are checked in Cairo pixels. Sequence actor names strip
img in the unchanged upstream SVG-text renderer and do not trigger native loads.
External fonts/styles, responsive srcset and other nested media in HTML labels
remain unsupported by the local SVG pipeline; readable source remains available.
