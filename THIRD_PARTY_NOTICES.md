# Third-Party Notices

Last reviewed: 2026-08-22.

The GNU Affero General Public License version 3 in `LICENSE.md` applies to
Flight Fabric source code and its AGPL-covered modifications. Other third-party
data, software, fonts, and hosted services listed here retain their own
licenses or terms and are not re-licensed merely by being used or distributed
with Flight Fabric.

This notice covers direct third-party components referenced by committed source,
vendored assets, runtime manifests, externally hosted runtime resources, and the
production dependency closures deliberately copied into desktop release
packages. Exact resolved versions and package-manager transitive closures are
governed by the committed `package-lock.json` and `Cargo.lock` files. This is a
human-maintained attribution and distribution notice, not a machine-generated
software bill of materials for every development-only transitive package.

The 2026-08-01 review checked the root, backend, frontend, Electron, mobile, and
publishable-package manifests and lockfiles; the Windows Rust sidecar dependency
tree; Electron packaging inputs; tracked vendored/binary/audio assets; and
runtime external URLs. Sections explicitly marked "not bundled" document an
integration or hosted service and do not claim that its software or data is
redistributed by Flight Fabric.

## OurAirports Data

- Source: https://ourairports.com/data/
- Mirror used by sync script: https://davidmegginson.github.io/ourairports-data/
- Files used: `airports.csv`, `runways.csv`, `countries.csv`, `regions.csv`, `airport-frequencies.csv`, `navaids.csv`
- Terms: Public Domain, with no guarantee of accuracy or fitness for use.
- Mirror license: Unlicense/public-domain dedication.
- Terms text: https://ourairports.com/data/
- Mirror license text: https://github.com/davidmegginson/ourairports-data/blob/main/LICENSE

### Notes

- Flight Fabric uses these datasets for airport/runway lookup, nearest-airport search, and timeline enrichment.
- OurAirports appreciates credit for the data source, but does not require it.
- Data is downloaded locally via `npm run data:sync` and is not embedded in this repository by default.
- Electron release packages (NSIS installer and portable) bundle required airport datasets (`airports.csv`, `runways.csv`) and ship legal notices under `resources/legal`.
- The sync script validates the expected CSV shape, computes SHA-256 hashes,
  records them in the generated manifest, and reports changes from the previous
  recorded hashes. A changed upstream hash is currently reported rather than
  rejected, so the manifest is a provenance and change-detection record rather
  than pre-download authenticity verification.

## OpenSky Network

- Source: https://opensky-network.org
- API docs: https://openskynetwork.github.io/opensky-api/
- Terms of use: https://opensky-network.org/about/terms-of-use
- Used for: ADS-B flight track data fetched via the OpenSky REST API for private development fixtures and flight-replay tooling (`scripts/real-flight-data/`, `tests/data/real-flights/`). Not used in production runtime or bundled into release packages.
- Attribution: The OpenSky Network, https://opensky-network.org

  Matthias Schaefer, Martin Strohmeier, Vincent Lenders, Ivan Martinovic and Matthias Wilhelm.
  "Bringing Up OpenSky: A Large-scale ADS-B Sensor Network for Research."
  In Proceedings of the 13th IEEE/ACM International Symposium on Information Processing in Sensor Networks (IPSN), pages 83-94, April 2014.

## SimBrief by Navigraph

- Service: https://www.simbrief.com
- OFP fetch endpoint documentation: https://developers.navigraph.com/docs/simbrief/fetching-ofp-data
- Terms of service: https://navigraph.com/legal/terms-of-service
- Privacy policy: https://navigraph.com/legal/privacy-policy
- Used for: on a user's explicit request, the local backend sends the supplied
  SimBrief username or pilot ID to SimBrief's documented latest-OFP endpoint
  and displays selected flight-plan data.
- Bundling: no SimBrief or Navigraph software, charts, navigation database, or
  account credentials are bundled with Flight Fabric.
- Static-site screenshot: `site/flightfabric/assets/simbrief-flight-plan.png`
  shows Flight Fabric's rendering of selected OFP fields; it does not reproduce
  a Navigraph chart, SDK, or website interface.
- Restrictions: SimBrief/Navigraph content and services retain their own terms.
  They are for personal flight-simulator use and must not be used for real-world
  navigation. Flight Fabric does not grant any rights in the returned OFP data.

## Historical SimConnect Components (not bundled)

During development, Flight Fabric used the following third-party SimConnect
components:

- `node-simconnect` 4.0.0 by Even Arneberg Rognlien and contributors.
  Source: https://github.com/EvenAR/node-simconnect
  Licence: GNU LGPL version 3 or later (`LGPL-3.0-or-later`):
  https://www.gnu.org/licenses/lgpl-3.0.html
- A Python wrapper path involving Python-SimConnect, MSFS Mobile Companion App,
  and MSFS-Glass. The recorded Python-SimConnect and MSFS-Glass code carried GNU
  AGPL version 3 terms.
  Sources:
  https://github.com/odwdinc/Python-SimConnect
  https://github.com/mracko/MSFS-Mobile-Companion-App
  https://github.com/fzsombor/MSFS-Glass
  Licence text:
  https://www.gnu.org/licenses/agpl-3.0.html

These historical implementations are not declared, bundled, or loaded by the
current release. The current Rust sidecar loads Microsoft's `SimConnect.dll`
and calls the SimConnect C ABI. Flight Fabric distributes the Rust sidecar and
its other project code under GNU AGPL version 3 only (`AGPL-3.0-only`). This
entry preserves historical attribution and does not identify any current Rust
source as third-party code.

## Microsoft Flight Simulator SimConnect Client Runtime

- Source: Microsoft Flight Simulator SDK / SimConnect SDK.
- Public source distribution: does not include `SimConnect.dll` because it is
  proprietary Microsoft runtime material and is not part of Flight Fabric's
  AGPL-licensed source. Public-source builders must obtain the runtime from an
  SDK installation they are entitled to use, as described in `README.md`.
- Official Windows binary distribution: bundles the SimConnect client runtime
  at `resources/backend/telemetry-provider/simconnect/SimConnect.dll` under the
  applicable Microsoft SDK/runtime terms so end users do not need to install
  the full Microsoft Flight Simulator SDK.
- Current bundled file size: 79,360 bytes.
- Current bundled SHA-256: `8D66D1976107F6504D2C7FDE901FDD9FB1D370BA068E9CD45877863F8DC7B40B`
- License/terms: Proprietary Microsoft Flight Simulator SDK/runtime material;
  not licensed under the GNU Affero General Public License.
- Source-distribution decision: the runtime is excluded from the sanitized
  public source mirror so proprietary binary material is not copied into the
  public source history or re-licensed under the project AGPL. The private
  maintainer repository retains the build input.
- Used for: The local MSFS telemetry sidecar dynamically loads the SimConnect client runtime so Flight Fabric can connect to the SimConnect server built into Microsoft Flight Simulator.
- Notes: The packaged app loads the bundled DLL from a trusted app resource path. Advanced users can override the DLL path with `FF_SIMCONNECT_DLL_PATH` or the app setting `simulator.simConnectDllPath`.

## PMDG Aircraft SDK Interoperability

- Products: PMDG 737 and PMDG 777 aircraft SDKs for Microsoft Flight
  Simulator, by Precision Manuals Development Group (PMDG).
- Material used: interoperability constants and data-layout metadata derived
  from the official SDK documentation/header installed with a user's licensed
  PMDG aircraft.
- Source and binary scope: the public source and official Windows builds contain
  the minimum independently written compatibility metadata needed to read
  aircraft-published ClientData and send fixed, guarded SDK control events.
  This includes event and field mappings plus declarative connector definitions,
  allowing public-source builders to build the same PMDG-capable application as
  the downloadable release.
- Not redistributed: Flight Fabric does not include PMDG aircraft packages,
  SDK headers, manuals, EULA PDFs, artwork, or other PMDG binaries or content.
- User authorization: PMDG SDK access stays disabled until the desktop user
  opens and explicitly accepts the SDK EULA installed with the matching PMDG
  aircraft. The installed EULA and the user's PMDG licence control that use.
- Trademarks: PMDG and the referenced aircraft/product names belong to their
  respective owners. No affiliation or endorsement is implied.

## MobiFlight Event Module (optional, not bundled)

- Source: https://github.com/MobiFlight/MobiFlight-WASM-Module
- Setup documentation: https://docs.mobiflight.com/guides/wasm-module/wasm-reinstall/
- License: MIT for the MobiFlight WASM Module repository; any installed release
  remains subject to the licence and notices shipped by MobiFlight.
- Used for: optional user-installed MSFS event/LVar transport for supported
  aircraft integrations. Flight Fabric detects and interoperates with the
  module over SimConnect but does not copy, install, modify, or redistribute it.

## Fenix A32X compatibility (not bundled)

- Product: FenixSim A319, A320, and A321 aircraft for Microsoft Flight
  Simulator.
- External-control documentation:
  https://support.fenixsim.com/hc/en-us/articles/12466468901135-Example-of-How-to-Bind-Switches-Knobs-and-Buttons-on-FenixSim-Aircraft-to-External-Hardware
- Consumer terms: https://fenixsim.com/assets/docs/2024-terms-and-conditions.pdf
- Used for: unofficial interoperability through aircraft-exposed LVARs and
  fixed control mappings. Users must obtain and install the applicable FenixSim
  aircraft under its own licence.
- Transport boundary: the integration uses the local simulator's named-variable
  interface and the optional documented MobiFlight transport. It uses no Fenix
  network endpoint or private internal protocol.
- Bundling: Flight Fabric includes only independently written integration code
  and the minimum interface names, value meanings, and mappings needed for
  interoperability. It does not copy, install, modify, or redistribute Fenix
  aircraft software, behavior XML, scripts, documentation, or visual assets.
- Naming: "Unofficial compatibility with the Fenix A32X; not affiliated with
  or endorsed by FenixSim." FenixSim and A319/A320/A321 product names identify
  compatibility only.

## Packaged Rust SimConnect Sidecar

- Project: `backend/telemetry-provider/rust-simconnect-sidecar/`
- Flight Fabric licence and provenance: GNU AGPL version 3
  (`AGPL-3.0-only`); see the sidecar `README.md` and the historical-provenance
  notice above.
- Direct crates: `chrono`, `libloading`, `serde`, and `serde_json`.
- Windows release dependency closure from the committed `Cargo.lock`:
  `chrono` 0.4.44, `num-traits` 0.2.19, `windows-link` 0.2.1,
  `libloading` 0.8.9, `serde` 1.0.228, `serde_core` 1.0.228,
  `serde_derive` 1.0.228, `proc-macro2` 1.0.106, `unicode-ident` 1.0.24,
  `quote` 1.0.45, `syn` 2.0.117, `serde_json` 1.0.149, `itoa` 1.0.18,
  `memchr` 2.8.0, and `zmij` 1.0.21.
- Licences: `libloading` is ISC; `memchr` is Unlicense OR MIT;
  `zmij` is MIT; `unicode-ident` is (MIT OR Apache-2.0) AND Unicode-3.0;
  the other listed crates are MIT OR Apache-2.0. Flight Fabric relies on the
  MIT option where an OR choice is offered. The required Unicode-3.0 terms for
  `unicode-ident` still apply.
- Packaging: the compiled sidecar executable is included in official desktop
  releases for SimConnect telemetry, facilities, LVar, and supported SDK
  ClientData/event transport. Procedural-macro crates are build inputs whose
  generated code contributes to the executable.

## Offline Voice Recognition and Push-to-Talk

- `sherpa-onnx-node` and `sherpa-onnx-win-x64` 1.13.5, by the next-gen Kaldi
  team and contributors, are bundled for local speech recognition under the
  Apache License 2.0: https://github.com/k2-fsa/sherpa-onnx
- The Windows package includes ONNX Runtime libraries used by sherpa-onnx.
  ONNX Runtime is Copyright Microsoft Corporation and licensed under the MIT
  License: https://github.com/microsoft/onnxruntime
- The bundled `sherpa-onnx-streaming-zipformer-en-2023-06-26` English
  LibriSpeech model is distributed under Apache License 2.0. Its upstream model
  repository is
  https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26.
- The LibriSpeech corpus was prepared by Vassil Panayotov with assistance from
  Daniel Povey and is available under the Creative Commons Attribution 4.0
  International licence: https://www.openslr.org/12.
- Exact shipped model-file sizes and SHA-256 values are pinned in
  `electron/voice-model-manifest.js` and verified before recognition starts.
  A source build may download the pinned runtime subset from the immutable
  upstream revision recorded there. Packaged applications bundle the verified
  files; recognition is offline and the application does not download models
  at runtime.
- The packaged desktop app includes the Apache 2.0 and Creative Commons
  Attribution 4.0 licences, the ONNX Runtime MIT licence, and ONNX Runtime
  upstream third-party notices under
  `resources/legal/voice`.
- The Windows push-to-talk helper is Flight Fabric code compiled with the Rust
  standard library and has no third-party crate dependencies. Rust standard
  library components are available under Apache-2.0 OR MIT terms.

## Packaged Backend Node.js Runtime

- Direct packages: `ajv`, `ajv-formats`, `dotenv`, `ws`
- Packaged transitive packages: `fast-deep-equal`, `fast-uri`,
  `json-schema-traverse`, `require-from-string`
- Declared in: root `package.json` and `backend/package.json`
- Licenses: `ajv`, `ajv-formats`, `fast-deep-equal`,
  `json-schema-traverse`, `require-from-string`, and `ws` are MIT;
  `dotenv` is BSD-2-Clause; `fast-uri` is BSD-3-Clause.
- Used for: JSON schema validation, environment-variable loading, and WebSocket transport in backend and desktop runtime paths.
- Packaging: these eight packages are the current production dependency closure
  copied into `resources/backend/node_modules`.
- Note: exact resolved versions are governed by the relevant lockfile(s).

## Frontend Vue Runtime and Build Packages

- Runtime packages: `vue`, `pinia`, `@floating-ui/vue`,
  `@floating-ui/dom`, `@floating-ui/core`, `@floating-ui/utils`, and
  `@vue/devtools-api`.
- Additional packages in the conservative production lockfile closure:
  `@babel/helper-string-parser`, `@babel/helper-validator-identifier`,
  `@babel/parser`, `@babel/types`, `@jridgewell/sourcemap-codec`,
  `@vue/compiler-core`, `@vue/compiler-dom`, `@vue/compiler-sfc`,
  `@vue/compiler-ssr`, `@vue/devtools-kit`, `@vue/devtools-shared`,
  `@vue/reactivity`, `@vue/runtime-core`, `@vue/runtime-dom`,
  `@vue/server-renderer`, `@vue/shared`, `birpc`, `copy-anything`, `csstype`,
  `entities`, `estree-walker`, `hookable`, `is-what`, `magic-string`, `mitt`,
  `nanoid`, `perfect-debounce`, `picocolors`, `postcss`, `rfdc`,
  `source-map-js`, `speakingurl`, and `superjson`. The optimized browser bundle
  can tree-shake packages or code paths that are not used.
- Build packages: `vite`, `@vitejs/plugin-vue`
- Declared in: `frontend/package.json`
- Licences: MIT except `entities` (BSD-2-Clause), `picocolors` (ISC), and
  `source-map-js` and `speakingurl` (BSD-3-Clause).
- Used for: the Vue 3 frontend application, Pinia stores, accessible
  tooltip/popover positioning, and Vite-based frontend development/build
  tooling.

## Electron and Release Tooling Packages

- Packages: `electron`, `electron-builder`, `@electron/asar`,
  `@electron/fuses`, `@electron/rebuild`, `rcedit`, `tailwindcss`
- Declared in: `electron/package.json`
- Licenses: MIT (`rcedit` uses Apache-2.0-licensed process-launch helpers)
- Used for: desktop runtime shell, Electron runtime fuse hardening, Windows NSIS/portable package generation, native dependency rebuild support, executable icon stamping, and packaged stylesheet generation.
- Electron packages also carry `LICENSE.electron.txt` and
  `LICENSES.chromium.html` in the Windows application directory. Those files
  contain Electron's licence and the notices for Chromium and its bundled
  third-party components.

## Development and Build Tooling Packages

- Packages: `@types/node`, `@types/react`, `@typescript-eslint/parser`, `ajv`,
  `ajv-formats`, `archiver`, `dotenv`, `eslint`, `eslint-plugin-import`,
  `husky`, `react`, `rimraf`, `tailwindcss`, `tsup`, `typescript`, `unimported`,
  and `ws`.
- Declared in: root `package.json`, `packages/telemetry-client/package.json`, and `packages/telemetry-types/package.json`
- Licences: `typescript` is Apache-2.0, `rimraf` is ISC, `dotenv` is
  BSD-2-Clause, and the other listed external packages are MIT. In particular,
  the currently resolved `@typescript-eslint/parser` 8.59.2 is MIT, not
  BSD-2-Clause.
- Used for: TypeScript typechecking/builds, linting, package builds, release/archive generation, repository hygiene checks, and Git hook integration. These packages are development/build dependencies and are not Flight Fabric application data.

## Tailwind CSS

- Source: https://tailwindcss.com
- Version: governed by `electron/package.json` and the applicable lockfile at build time
- Bundled into: `frontend/tailwind.css` and `frontend-dist/tailwind.css`
- License: MIT
- Used for: utility CSS and preflight styles in the main frontend and widget surfaces.

## QRCode for JavaScript (vendored)

- Source: http://www.d-project.com/ - by Kazuhiko Arase
- Bundled into `electron/launcher/vendor/qrcode.js` and `frontend/src/utils/qr-code.js` from the `qrcode-terminal` npm package's vendor sources via an internal bundling script.
- License: MIT (Copyright (c) 2009 Kazuhiko Arase)
- Used to render offline QR codes for the phone browser dashboard URL in the Electron launcher and dashboard System tab; no network calls.

## Leaflet

- Source: https://leafletjs.com - by Volodymyr Agafonkin and Leaflet contributors
- Version: 1.9.4
- Bundled from the `leaflet` npm package into the main frontend.
- License: BSD-2-Clause (Copyright (c) 2010-2023, Volodymyr Agafonkin; Copyright (c) 2010-2011, CloudMade)
- License text: https://github.com/Leaflet/Leaflet/blob/v1.9.4/LICENSE
- Used for: interactive flight-track map in the live-map and timeline tabs.

## Splide (vendored static-site carousel)

- Source: https://splidejs.com and https://github.com/Splidejs/splide
- Version: 4.1.4
- Vendored into: `site/flightfabric/vendor/splide/` as minified JavaScript and
  core CSS, with its upstream `LICENSE` file.
- Licence: MIT (Copyright (c) 2022 Naotoshi Fujita)
- Used for: the screenshot carousel on the private/static product-site source.
  It is not included in Electron desktop packages or the sanitized public
  desktop source mirror.

## Font Awesome Free (externally hosted product-site resource)

- Source: https://fontawesome.com and https://github.com/FortAwesome/Font-Awesome
- Version: 7.3.1
- CDN URLs: `https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@7.3.1/`
- CDN terms and policies: https://www.jsdelivr.com/terms
- Upstream licence summary: icons are CC BY 4.0, fonts are SIL OFL 1.1, and
  non-font/non-icon code is MIT.
- Upstream licence text: https://github.com/FortAwesome/Font-Awesome/blob/7.3.1/LICENSE.txt
- Used for: solid and brand icons on `site/flightfabric/`.
- Bundling: the repository contains only stylesheet references. Browsers fetch
  the CSS and referenced webfonts from jsDelivr; Font Awesome files are not
  committed to this repository or included in desktop packages. Upstream files
  retain their embedded attribution comments.

## OpenStreetMap Standard Tiles and Data

- Source: https://www.openstreetmap.org/copyright
- License/data terms: Open Data Commons Open Database License (ODbL) 1.0
- Tile service and usage policy:
  https://operations.osmfoundation.org/policies/tiles/
- Used for: the standard labeled raster basemap in live-map and timeline views.
  Tiles are fetched interactively from `https://tile.openstreetmap.org` and are
  not bundled with Flight Fabric.
- Attribution: displayed in-app as `OpenStreetMap contributors` through the
  Leaflet attribution control.
- Service note: Flight Fabric does not prefetch tiles or offer offline tile
  downloads. The community-operated service is best effort and can be disabled
  in Settings. Desktop tile requests use a Flight Fabric-specific user agent;
  LAN browsers use their normal browser identification, origin referrer, and
  cache.

## Historical CARTO Screenshot

- `site/flightfabric/assets/live-map.png` depicts an older Flight Fabric build
  and retains its visible OpenStreetMap and CARTO attribution.
- Current application builds do not request CARTO basemap tiles.

## GitHub Release and Update Hosting (hosted service only)

- Service: GitHub Releases and `raw.githubusercontent.com`.
- Used for: the backend fetches the Flight Fabric project's public update
  manifest at startup and at most once per day, then accepts download links only
  under the project's GitHub Releases path.
- Bundling: no GitHub software or third-party repository content is bundled by
  this integration. Network access is subject to GitHub's applicable terms
  (https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)
  and privacy statement
  (https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

## Licence Texts For Bundled Software

The notices below are reproduced for software included in Flight Fabric source
or compiled distributions. Build-only packages retain their licence files in
their installed npm packages and are not copied into the Flight Fabric runtime,
unless another section above states otherwise.

### MIT-Licensed Components

The MIT permission text below applies to these bundled components and copyright
notices:

- Ajv: Copyright (c) 2015-2021 Evgeny Poberezkin
- ajv-formats: Copyright (c) 2020 Evgeny Poberezkin
- fast-deep-equal: Copyright (c) 2017 Evgeny Poberezkin
- json-schema-traverse: Copyright (c) 2017 Evgeny Poberezkin
- require-from-string: Copyright (c) Vsevolod Strukchinsky
  <floatdrop@gmail.com> (github.com/floatdrop)
- ws:
  - Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
  - Copyright (c) 2013 Arnout Kazemier and contributors
  - Copyright (c) 2016 Luigi Pinca and contributors
- Floating UI packages: Copyright (c) 2021-present Floating UI contributors
- Vue: Copyright (c) 2018-present, Yuxi (Evan) You
- Pinia: Copyright (c) 2019-present Eduardo San Martin Morote
- Vue Devtools API/Kit/Shared: Copyright (c) 2023 webfansplz
- Babel parser/helper/types packages: Copyright (c) 2012-present Sebastian
  McKenzie and other contributors; parser contributors are recorded upstream
- `@jridgewell/sourcemap-codec`: Copyright 2024 Justin Ridgewell
- `birpc`: Copyright (c) 2021 Anthony Fu
- `copy-anything` and `is-what`: Copyright (c) 2018 Luca Ban - Mesqueeb
- `csstype`: Copyright (c) 2017-2018 Fredrik Nicol
- `estree-walker`: Copyright (c) 2015-2020 its contributors
- `hookable` and `perfect-debounce`: Copyright (c) Pooya Parsa
- `magic-string`: Copyright 2018 Rich Harris
- `mitt`: Copyright (c) 2021 Jason Miller
- `nanoid`: Copyright 2017 Andrey Sitnik
- `postcss`: Copyright 2013 Andrey Sitnik
- `rfdc`: Copyright 2019 David Mark Clements
- `superjson`: Copyright (c) 2020 Simon Knott and contributors
- Electron: Copyright (c) Electron contributors; Copyright (c) 2013-2020
  GitHub Inc.
- Tailwind CSS: Copyright (c) Tailwind Labs, Inc.
- QRCode for JavaScript: Copyright (c) 2009 Kazuhiko Arase
- Splide: Copyright (c) 2022 Naotoshi Fujita
- Rust `chrono`: Copyright (c) 2014-2026 Kang Seonghoon and contributors
- Rust `num-traits`: Copyright (c) 2014 The Rust Project Developers
- Rust `windows-link`: Copyright (c) Microsoft Corporation
- Rust `serde`, `serde_core`, `serde_derive`, and `serde_json`: Erick
  Tryzelaar, David Tolnay, and contributors
- Rust `proc-macro2`: David Tolnay, Alex Crichton, and contributors
- Rust `unicode-ident`, `quote`, `syn`, `itoa`, and `zmij`: David Tolnay and
  contributors (the additional Unicode-3.0 notice for `unicode-ident` is below)
- Rust `memchr`: Copyright (c) 2015 Andrew Gallant

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### BSD 2-Clause Components

This licence applies to:

- dotenv: Copyright (c) 2015, Scott Motte
- entities: Copyright (c) Felix Böhm
- Leaflet:
  - Copyright (c) 2010-2023, Volodymyr Agafonkin
  - Copyright (c) 2010-2011, CloudMade

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

### BSD 3-Clause Components

This licence applies to:

- `fast-uri`:

  Copyright (c) 2011-2021, Gary Court until
  https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae

  Copyright (c) 2021-present The Fastify team
  <https://github.com/fastify/fastify#team>

- `source-map-js`: Copyright (c) 2009-2011, Mozilla Foundation and
  contributors
- `speakingurl`: Copyright (c) 2013-2017 Sascha Droste

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. The names of any contributors may not be used to endorse or promote
   products derived from this software without specific prior written
   permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS AND CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

The complete `fast-uri` contributor list is available at
https://github.com/garycourt/uri-js/graphs/contributors.

### ISC Components

This licence applies to:

- Rust `libloading`: Copyright © 2015, Simonas Kazlauskas
- `picocolors`: Copyright (c) 2021-2024 Oleksii Raspopov, Kostiantyn
  Denysov, and Anton Verinov

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

### Unicode License v3

This licence applies to the Unicode identifier data in Rust `unicode-ident`.

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2023 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY DOWNLOADING,
INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR SOFTWARE, YOU
UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE TERMS AND CONDITIONS
OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT DOWNLOAD, INSTALL, COPY,
DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a copy of
data files and any associated documentation (the "Data Files") or software and
any associated documentation (the "Software") to deal in the Data Files or
Software without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, and/or sell copies of the Data Files
or Software, and to permit persons to whom the Data Files or Software are
furnished to do so, provided that either (a) this copyright and permission
notice appear with all copies of the Data Files or Software, or (b) this
copyright and permission notice appear in associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF THIRD
PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE BE
LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES, OR ANY
DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall not be
used in advertising or otherwise to promote the sale, use or other dealings in
these Data Files or Software without prior written authorization of the
copyright holder.
