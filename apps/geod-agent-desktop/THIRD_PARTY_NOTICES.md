# Third-party notices

## Proj4js, WKT parser and MGRS

GeoD uses Proj4js 2.22.0, wkt-parser 1.5.6 and mgrs 1.0.0 to display exported
rasters in their actual coordinate systems. Definitions are supplied by the
native GIS conversion worker; map previews do not fetch a remote CRS registry.
Upstream: https://github.com/proj4js/proj4js

Copyright (c) 2014, Mike Adair, Richard Greenwood, Didier Richard, Stephen Irons,
Olivier Terral and Calvin Metcalf (Proj4js and wkt-parser)

Copyright (c) 2012, Mike Adair, Richard Greenwood, Didier Richard, Stephen Irons,
Olivier Terral, Calvin Metcalf (mgrs)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.

## Cesium MCP Bridge and contracts

The three-dimensional scene uses the unmodified published packages
`cesium-mcp-bridge` 1.146.0 and `cesium-mcp-contracts` 0.7.0 from
https://github.com/gaopengbin/cesium-mcp. Versioned archives, source URLs and
SHA-256 values are recorded in `vendor/cesium-mcp.json`. GeoD owns the native
imagery, downloaded-model and conversation adapters. The application pins one
Cesium 1.146.0 instance through an npm override; its native integration is
tested locally. The bridge's upstream peer declaration currently lists
Cesium 1.143 and 1.145, so this is a GeoD-tested compatibility override.

MIT License

Copyright (c) 2025 GeoAgent Contributors (Cesium MCP Bridge)

Copyright (c) 2026 gaopengbin (Cesium MCP contracts)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## pgEdge PostgreSQL MCP

The application bundles the unmodified pgEdge PostgreSQL MCP server 1.1.0
Windows x86_64 release from https://github.com/pgEdge/pgedge-postgres-mcp.
It runs locally over standard MCP stdio for PostgreSQL/PostGIS operations.
The pinned archive and executable SHA-256 values are recorded in
`vendor/pgedge-postgres-mcp-1.1.0.json` and the distributed
`pgedge-runtime/manifest.json`. The complete PostgreSQL License ships in
`pgedge-runtime/LICENSE.md`. GeoD owns the connection and geometry adapters;
the upstream executable has not been modified.

## Codex and Node runtime

The release preparation script bundles OpenAI Codex 0.159.2 under Apache-2.0
and Node.js 24 LTS under its distributed license. The exact binary versions,
official download locations and SHA-256 values are recorded in the generated
`codex-runtime/manifest.json`. Their complete license and notice texts ship as
`CODEX-LICENSE.txt`, `CODEX-NOTICE.txt` and `NODE-LICENSE.txt` in that directory.
These runtime components do not include the Codex desktop GUI or grant access
to an OpenAI model or subscription.

The bundled npm and npx CLIs are npm 11.19.0 from the same checksum-pinned
official Node.js 24.21.0 Windows archive. Their complete unmodified package,
dependencies and license files remain in `codex-runtime/npm/`; every file is
listed in `codex-runtime/manifest.json`. npm is distributed under its Artistic
License 2.0, preserved as `codex-runtime/npm/LICENSE`. GeoD runs the CLI using
its application-local Node executable and does not install a global package
manager on the user's device.

## DBHub database MCP runtime

The additional SQL input connector bundles pinned
[DBHub](https://github.com/bytebase/dbhub) 1.4.0 (MIT),
mysql2 3.24.5 (MIT), mssql 11.0.1 (MIT), and oracledb 7.0.1
(Apache-2.0 OR UPL-1.0). Versioned npm dependencies and their integrity
values are locked in vendor/dbhub/package-lock.json. Complete package
license files are preserved in dbhub-runtime/node_modules/; the generated
dbhub-runtime/manifest.json records every shipped file's SHA-256.
The runtime uses the already bundled Node.js; it does not install Node,
database drivers, or Oracle client software on the user's system.

GeoD applies a versioned TLS extension to the four DBHub DSN parsers and
fixes mysql2's IP certificate identity check independently of its SNI name.
The exact original file hashes and deterministic changes are recorded in
`scripts/patch-dbhub-tls.py`; the extension source is `vendor/dbhub/geod-tls.mjs`.
Upstream license headers and notices are preserved. Native session settings
select CA/hostname verification and optional client certificates; these are
not modifications to a system database driver or trust store.

## Local audio transcription

Audio transcription bundles unmodified whisper.cpp 1.9.4 and its CPU ggml
libraries from the official Windows x64 release b5130:
https://github.com/ggml-org/whisper.cpp/releases/tag/b5130.
The archive hash and optional multilingual base/tiny model hashes are pinned
in `vendor/audio/runtime-lock.json`; every shipped binary is listed in
`audio-runtime/manifest.json`. The complete MIT license, Copyright (c)
2023-2026 The ggml authors, ships as `audio-runtime/LICENSE-whisper.txt`.
The optional model weights come from https://huggingface.co/ggerganov/whisper.cpp
at the revision recorded in that lock. They are downloaded on the user's
device after the user chooses to prepare the model, and are not embedded in
the installer. Audio inference runs locally. Only transcript text is passed
to the selected AI model. FFmpeg is used solely for development fixtures
and is not included in this runtime.

## Application-local Python and optional GIS skills

Document extraction also bundles unmodified pypdf 6.19.0 under BSD-3-Clause.
Its wheel checksum is pinned in `vendor/document-runtime.lock.json`, and its
complete license remains in `document-runtime/pypdf-6.19.0.dist-info/licenses/`.
Word, Excel and PowerPoint extraction uses Python's standard library to read
Open XML package parts; it does not execute macros, links or formulas.

Encrypted Open XML packages use msoffcrypto-tool 6.0.0 (MIT). PDF and Office
decryption includes cryptography 50.0.2 (Apache-2.0 OR BSD-3-Clause), cffi 2.1.1
(MIT), pycparser 3.0 (BSD-3-Clause), and olefile 0.47 (BSD-2-Clause). Their exact
official PyPI wheels and SHA-256 values are pinned in the same lock file.
Complete licenses remain in the distributed document-runtime package metadata.
Passwords are passed to the application-local parser through its input pipe;
decrypted Open XML packages are read from memory.

The versioned patch in `scripts/patch-document-crypto.py` corrects Agile
password/HMAC padding comparisons, key-size padding and empty-password handling
in msoffcrypto-tool 6.0.0. Original and modified source hashes are recorded in
the generated runtime manifest. Password verification and payload integrity
verification remain enabled; unmodified upstream license files are retained.


The base installer includes CPython 3.13.11 from python.org under the Python
Software Foundation license. Its license and pinned file hashes remain in
python-runtime/LICENSE.txt and python-runtime/manifest.json.

GIS packages are separately installed, hash-pinned components. The vector
component contains GeoPandas, Pyogrio, PyProj, Shapely and Pandas; the raster
component contains Rasterio. NumPy and shared dependencies are cached once.
Each component retains distribution license files and metadata. Versions and
archive hashes are recorded in vendor/gis-components.json; original accepted
wheel pins are recorded in vendor/gdal-runtime-1.1.3.lock. These packages are
not installed into the user's system Python. The bundled skill MCP adapter is
GeoD code and does not require a separate FastMCP runtime.

The source files under `src/components/agents/`, beUI files under
`src/components/motion/`, and their supporting files in `src/lib/hooks/` and
`src/lib/touch.ts` are adapted from
[beUI](https://github.com/starc007/ui-components).

MIT License

Copyright (c) 2026 Saurabh Chauhan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## AreaCity administrative boundary snapshot

Source: https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov

Release: 2025.251231.260403, collected 2026-04-03. The bundled index and
compressed geometry are derived from its published ok_geo.csv asset.
The source repository declares the MIT license, whose terms are reproduced
above. Copyright (c) 2019 xiangyuecn. Original GCJ-02 coordinates are converted
to WGS84 by GeoD Agent when a region is requested.

## OpenLayers MCP Bridge

The map executor uses openlayers-mcp-bridge and openlayers-mcp-protocol 0.2.0
from https://github.com/gaopengbin/openlayers-mcp. This local development
candidate is built on revision 13459a5a9fcbb488871f4b189288019e36b96533 with
the 2026-10-01 source changes. Versioned tarballs are kept under `vendor/`;
their hashes and verification are recorded in the implementation report.

MIT License

Copyright (c) 2026 gaopengbin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The functional icons used throughout the desktop application are from
[Lucide](https://github.com/lucide-icons/lucide).

ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part
of Feather (MIT). All other copyright (c) for Lucide are held by Lucide
Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

Some imported component references originated from
[Phosphor Icons](https://github.com/phosphor-icons/react); their notice is
retained below.

MIT License

Copyright (c) 2020 Phosphor Icons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## RTK (optional component)

RTK 0.40.0 is downloaded separately from the official release and verified
against the pinned archive and executable SHA-256 values in vendor/rtk-runtime.json.
It is not included in the desktop installer. GeoD invokes its unmodified stdin
pipe filters; original user commands are executed by the existing engine.

Upstream: https://github.com/rtk-ai/rtk/tree/v0.40.0

The tagged LICENSE is Apache License 2.0. The complete license is retained in
vendor/rtk-0.40.0-LICENSE.txt and installed alongside the optional executable.
