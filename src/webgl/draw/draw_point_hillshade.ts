import {DepthMode} from '../depth_mode.ts';
import {CullFaceMode} from '../cull_face_mode.ts';
import {ColorMode} from '../color_mode.ts';
import {StencilMode} from '../stencil_mode.ts';
import {
    pointHillshadeUniformValues
} from '../program/point_hillshade_program.ts';
import {
    pointHillshadeSurfaceUniformValues
} from '../program/point_hillshade_surface_program.ts';
import {
    pointHillshadeCoveragePrepareUniformValues
} from '../program/point_hillshade_coverage_prepare_program.ts';
import {
    pointHillshadeCompositeUniformValues
} from '../program/point_hillshade_composite_program.ts';
import {MercatorCoordinate} from '../../geo/mercator_coordinate.ts';
import {Color} from '@maplibre/maplibre-gl-style-spec';

import type {Context} from '../context.ts';
import type {Painter, RenderOptions} from '../../render/painter.ts';
import type {TileManager} from '../../tile/tile_manager.ts';
import type {PointHillshadeStyleLayer, CoverageLight, CoverageTile} from '../../style/style_layer/point_hillshade_style_layer.ts';
import type {OverscaledTileID} from '../../tile/tile_id.ts';

// ── Single-pass multi-light coverage rendering ─────────────────────
//
// Every coverage light for a tile is uploaded into one RGBA32F float
// texture (3 texels/light, mercator-space) and composited in a SINGLE
// draw per tile: the prepare shader loops `u_lightCount` lights via
// texelFetch and keeps the BEST-SERVED link margin, then does one spectrum
// lookup -- a single coherent colour per texel, premultiplied, rather than an
// additive stack. The composite then alpha-blends that one cached layer over
// the basemap, so overlapping coverage merges instead of blowing out.
//
// This replaces the previous O(lights x tiles) draw-call loop (each a
// full terrain + 7-probe occlusion pass) with O(tiles) draws, lifting
// the practical per-tile light limit from "draw-call bound" to
// "float-texture-width bound" (~ maxTextureSize / 2 lights per tile).
//
// Per-tile shared globals (tile transform, exaggeration, latrange,
// ambient) ride in a WebGL2 std140 uniform buffer (UBO).
//
// Texture-unit contract preserved: u_image = TEXTURE0,
// u_coverageTex = TEXTURE1; the light-data texture uses TEXTURE4.

/** Light altitude: 3 m AGL. */
const LIGHT_ALT_M = 3;

/** Texture unit for the per-light RGBA32F data texture. */
const LIGHT_TEX_UNIT = 4;
/** Texture unit for the wide-area DEM overview (R32F absolute elevation, m). */
const OVERVIEW_TEX_UNIT = 2;
/** Binding point for the LightGlobals UBO. */
const LIGHTS_UBO_BINDING = 0;
/** Coverage exaggeration (matches the legacy multi-light pass). */
const COVERAGE_EXAGGERATION = 0.5;
/** Coverage ambient term (matches the legacy multi-light pass). */
const COVERAGE_AMBIENT = 0.18;

// ── Prepared-light cache ───────────────────────────────────────

type PreparedLight = {
    light: CoverageLight;
    mercX: number;
    mercY: number;
    meterInMerc: number;
    radiusMerc: number;
};

let _preparedLights: PreparedLight[] = [];
let _preparedGeneration = -1;

function prepareLights(layer: PointHillshadeStyleLayer): PreparedLight[] {
    // Re-prepare only when lights change.
    if (!layer._lightsDirty && _preparedGeneration === layer._lights.length) {
        return _preparedLights;
    }
    _preparedLights = layer._lights.map(light => {
        const merc = MercatorCoordinate.fromLngLat(light.center);
        const meterInMerc = merc.meterInMercatorCoordinateUnits();
        return {
            light,
            mercX: merc.x,
            mercY: merc.y,
            meterInMerc,
            radiusMerc: light.falloffMeters * meterInMerc,
        };
    });
    _preparedGeneration = layer._lights.length;
    return _preparedLights;
}

function filterLightsForTile(
    prepared: PreparedLight[],
    coord: OverscaledTileID,
    maxLights: number,
): PreparedLight[] {
    const tilesAtZoom = Math.pow(2, coord.canonical.z);
    const originX = coord.canonical.x / tilesAtZoom;
    const originY = coord.canonical.y / tilesAtZoom;
    const size = 1 / tilesAtZoom;
    const cx = originX + size * 0.5;
    const cy = originY + size * 0.5;

    // Filter to lights whose radius intersects this tile.
    const hits: Array<{pl: PreparedLight; dist: number}> = [];
    for (const pl of prepared) {
        if (pl.mercX + pl.radiusMerc < originX) continue;
        if (pl.mercX - pl.radiusMerc > originX + size) continue;
        if (pl.mercY + pl.radiusMerc < originY) continue;
        if (pl.mercY - pl.radiusMerc > originY + size) continue;
        const dx = pl.mercX - cx;
        const dy = pl.mercY - cy;
        hits.push({pl, dist: dx * dx + dy * dy});
    }

    // Single-pass max-compositing is order-independent, so we only need to
    // sort when the (very high) safety cap is exceeded -- in that case keep
    // the largest-radius (broadest-coverage) lights.
    if (hits.length > maxLights) {
        hits.sort((a, b) => {
            const ra = a.pl.radiusMerc;
            const rb = b.pl.radiusMerc;
            if (ra !== rb) return rb - ra;
            return a.dist - b.dist;
        });
        hits.length = maxLights;
    }
    return hits.map(h => h.pl);
}

function getTileLatRange(tileID: OverscaledTileID): [number, number] {
    const tilesAtZoom = Math.pow(2, tileID.canonical.z);
    const y = tileID.canonical.y;
    return [
        new MercatorCoordinate(0, y / tilesAtZoom).toLngLat().lat,
        new MercatorCoordinate(0, (y + 1) / tilesAtZoom).toLngLat().lat,
    ];
}

// ── Per-tile coverage render-target (the prepare pass bakes into this) ──

/** Resolution of each cached per-tile coverage RT.  Decoupled from screen
 *  resolution; the composite samples it bilinearly so shadows stay crisp. */
const COVERAGE_RT_SIZE = 512;

/** Create a per-tile RGBA8 coverage render-target (RGB colour + coverage
 *  alpha).  Binds through the context's tracked state so the cache stays in
 *  sync with later `context.bindFramebuffer.set` calls. */
function createCoverageRT(context: Context, size: number): CoverageTile {
    const gl = context.gl;
    const texture = gl.createTexture()!;
    context.activeTexture.set(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer()!;
    context.bindFramebuffer.set(framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    // Unbind the new texture from the sampler unit so it isn't both an FBO
    // attachment and a bound sampler during the prepare draw.
    gl.bindTexture(gl.TEXTURE_2D, null);
    return {framebuffer, texture, generation: -1, size, z: -1, x: -1, y: -1};
}

// ── GL resources for the float-texture + UBO path ──────────────────

let _lightTex: WebGLTexture | null = null;
let _lightData = new Float32Array(0);
let _lightUBO: WebGLBuffer | null = null;
const _uboData = new Float32Array(24);
const _blockBound = new WeakSet<WebGLProgram>();

// ── Wide-area DEM overview texture (shared across a bake pass) ──────────
//
// One R32F texture holding absolute elevation (metres) over the viewport +
// march margin, uploaded from the layer's `_marchDem` mosaic.  It is bound
// ONCE per bake (all tiles share it) and sampled in mercator space by the
// prepare shader, so the occlusion march is continuous across tile boundaries
// and fixed-resolution regardless of display zoom.  A 1x1 zero stand-in is kept
// when no overview is loaded so the sampler unit always references a complete
// texture (the shader guards real use behind the hasOverview UBO flag).

let _overviewTex: WebGLTexture | null = null;
let _overviewIsReal = false;

/** Upload the layer's DEM overview into the shared R32F texture when it has
 *  changed; create a 1x1 stand-in on first use.  Returns true when a REAL
 *  overview is resident (-> the shader should march it).  Does not bind. */
function ensureOverviewTexture(context: Context, layer: PointHillshadeStyleLayer): boolean {
    const gl = context.gl;
    if (!_overviewTex) {
        _overviewTex = gl.createTexture();
        context.activeTexture.set(gl.TEXTURE0 + OVERVIEW_TEX_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, _overviewTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array(1));
        _overviewIsReal = false;
    }

    const ov = layer._marchDem;
    if (layer._marchDemDirty) {
        context.activeTexture.set(gl.TEXTURE0 + OVERVIEW_TEX_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, _overviewTex);
        if (ov) {
            // R32F absolute elevation (metres); NEAREST -> no float-linear ext
            // needed.  The march integrates many samples, so nearest is fine.
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, ov.width, ov.height, 0,
                gl.RED, gl.FLOAT, ov.grid);
            _overviewIsReal = true;
        } else {
            // Overview cleared: shrink back to the 1x1 stand-in to free memory.
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array(1));
            _overviewIsReal = false;
        }
        layer._marchDemDirty = false;
    }
    return _overviewIsReal && ov != null;
}

/** Upload a tile's culled lights into the RGBA32F data texture (unit 4). */
function uploadTileLights(context: Context, lights: PreparedLight[]): void {
    const gl = context.gl;
    const n = lights.length;
    if (_lightData.length < n * 12) _lightData = new Float32Array(n * 12);
    const data = _lightData;
    for (let i = 0; i < n; i++) {
        const pl = lights[i];
        const o = i * 12;
        // Texel A: (mercX, mercY, radiusMerc, heightMerc)
        data[o]     = pl.mercX;
        data[o + 1] = pl.mercY;
        data[o + 2] = pl.radiusMerc;
        data[o + 3] = LIGHT_ALT_M * pl.meterInMerc;
        // Texel B: (colorR, colorG, colorB, diffuse)
        data[o + 4] = pl.light.color[0];
        data[o + 5] = pl.light.color[1];
        data[o + 6] = pl.light.color[2];
        data[o + 7] = 1.5 + pl.light.intensity * 2.0;
        // Texel C: (marginD0, nodeGroundElev, _, _) -- RF link margin at d0
        // (1 km) for the spectrum colour + the node's ground elevation (m) for
        // the occlusion march's node antenna height (sentinel < -1e5 = unknown).
        data[o + 8]  = pl.light.marginD0;
        data[o + 9]  = pl.light.nodeGroundElev;
        data[o + 10] = 0;
        data[o + 11] = 0;
    }

    context.activeTexture.set(gl.TEXTURE0 + LIGHT_TEX_UNIT);
    if (!_lightTex) {
        _lightTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, _lightTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
        gl.bindTexture(gl.TEXTURE_2D, _lightTex);
    }
    // 3 texels per light, single row. RGBA32F + NEAREST is texelFetch-able
    // in core WebGL2 (no float-linear extension needed for sampling).
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n * 3, 1, 0, gl.RGBA, gl.FLOAT,
        data.subarray(0, n * 12));
}

/** Upload the shared per-tile globals into the LightGlobals UBO. */
function updateGlobalsUBO(
    context: Context,
    tilesAtZoom: number,
    tileOriginX: number,
    tileOriginY: number,
    latLo: number,
    latHi: number,
    unpack: number[],
    demUV0: number,
    demUVScale: number,
    mercMinX: number,
    mercMinY: number,
    mercSizeX: number,
    mercSizeY: number,
    hasOverview: number,
): void {
    const gl = context.gl;
    // std140: six tightly-packed vec4s (each 16-byte aligned).
    //   u_lg0 = (tilesAtZoom, tileOriginX, tileOriginY, exaggeration)
    //   u_lg1 = (latLo, latHi, ambient, _pad)
    //   u_lg2 = (unpackR, unpackG, unpackB, baseShift)   DEM elevation decode
    //   u_lg3 = (demUV0, demUVScale, _, _)               border-adjusted DEM uv
    //   u_lg4 = (mercMinX, mercMinY, mercSizeX, mercSizeY) overview merc bounds
    //   u_lg5 = (hasOverview, _, _, _)                    march overview vs DEM
    _uboData[0] = tilesAtZoom;
    _uboData[1] = tileOriginX;
    _uboData[2] = tileOriginY;
    _uboData[3] = COVERAGE_EXAGGERATION;
    _uboData[4] = latLo;
    _uboData[5] = latHi;
    _uboData[6] = COVERAGE_AMBIENT;
    _uboData[7] = 0;
    _uboData[8] = unpack[0];
    _uboData[9] = unpack[1];
    _uboData[10] = unpack[2];
    _uboData[11] = unpack[3];
    _uboData[12] = demUV0;
    _uboData[13] = demUVScale;
    _uboData[14] = 0;
    _uboData[15] = 0;
    _uboData[16] = mercMinX;
    _uboData[17] = mercMinY;
    _uboData[18] = mercSizeX;
    _uboData[19] = mercSizeY;
    _uboData[20] = hasOverview;
    _uboData[21] = 0;
    _uboData[22] = 0;
    _uboData[23] = 0;
    if (!_lightUBO) _lightUBO = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, _lightUBO);
    gl.bufferData(gl.UNIFORM_BUFFER, _uboData, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, LIGHTS_UBO_BINDING, _lightUBO);
}

/** Link a program's LightGlobals block to the UBO binding point (once). */
function ensureBlockBinding(context: Context, program: WebGLProgram): void {
    if (_blockBound.has(program)) return;
    const gl = context.gl;
    const idx = gl.getUniformBlockIndex(program, 'LightGlobals');
    if (idx !== gl.INVALID_INDEX) {
        gl.uniformBlockBinding(program, idx, LIGHTS_UBO_BINDING);
    }
    _blockBound.add(program);
}

// ── Coverage source resolution (own RT or ancestor fallback) ───────

/** Max ancestor levels to walk for a coverage fallback (4 = up to a 16x16
 *  block; deeper ancestors are too coarse to read as the tile's coverage). */
const MAX_COVERAGE_FALLBACK_LEVELS = 4;

/** Resolve which cached coverage RT to drape on a tile, plus the sub-rect UV to
 *  sample it with.  Preference: the tile's OWN freshly-baked RT (uv 0,0,1); else
 *  -- while the tile's DEM is still loading, so its own RT isn't baked -- the
 *  nearest baked ANCESTOR RT with the tile's sub-rect UV, so the tile shows
 *  coarse coverage instead of a black hole; else a STALE own RT (older
 *  generation) over a hole during a re-bake.  null = draw nothing (basemap). */
function resolveCoverageSource(
    layer: PointHillshadeStyleLayer,
    coord: OverscaledTileID,
    generation: number,
): {rt: CoverageTile; uv: [number, number, number]} | null {
    const own = layer._coverageTextures.get(coord.key);
    if (own && own.generation === generation) return {rt: own, uv: [0, 0, 1]};

    // Walk up the canonical pyramid for any baked ancestor coverage RT (they
    // persist in _coverageTextures from when the user was zoomed out).
    const cz = coord.canonical.z;
    for (let k = 1; k <= MAX_COVERAGE_FALLBACK_LEVELS && k <= cz; k++) {
        const anc = layer._coverageTextures.get(coord.scaledTo(cz - k).key);
        if (anc) {
            const span = 1 << k;          // tiles per ancestor edge at this depth
            const inv = 1 / span;
            // Tile's offset within the ancestor, NW-origin (x east, y south) --
            // the same convention the composite samples v_pos in.
            const fx = (coord.canonical.x & (span - 1)) * inv;
            const fy = (coord.canonical.y & (span - 1)) * inv;
            return {rt: anc, uv: [fx, fy, inv]};
        }
    }
    // A stale own RT still beats a hole while a re-bake is in flight.
    if (own) return {rt: own, uv: [0, 0, 1]};
    return null;
}

// ── Dev instrumentation (gated; zero-cost when off) ────────────────
//
// Set `globalThis.__COVERAGE_PERF__ = true` in the devtools console to log the
// per-bake cost: stale tiles re-baked, total lights marched across them, and
// the CPU submit time of the bake loop.  This is the Phase-0 baseline that
// steers the temporal + occlusion work; precise GPU time
// (EXT_disjoint_timer_query) is a later add once the march is tuned.
function coveragePerfEnabled(): boolean {
    return typeof globalThis !== 'undefined' &&
        (globalThis as {__COVERAGE_PERF__?: boolean}).__COVERAGE_PERF__ === true;
}

// ── Phase-2 stub: the served-tile data contract (gated; zero-cost when off) ──
//
// Set `globalThis.__COVERAGE_TILE_STUB__ = true` to prove the precomputed-tile
// architecture WITHOUT any server: each baked coverage RT is read back to CPU
// (RGBA8) and re-uploaded as a plain texture that the composite samples INSTEAD
// of the live RT -- emulating "serve the bake as a tile, load it, colour it"
// with the composite shader 100% unchanged.  If coverage looks identical with
// the flag on, a served tile == the RT and the client flip is safe.  This is
// also the gl.readPixels primitive the offline baker reuses.
function coverageTileStubEnabled(): boolean {
    return typeof globalThis !== 'undefined' &&
        (globalThis as {__COVERAGE_TILE_STUB__?: boolean}).__COVERAGE_TILE_STUB__ === true;
}

const _stubTextures = new Map<string, {texture: WebGLTexture; generation: number}>();
let _stubReadBuffer = new Uint8Array(0);

/** Read a baked coverage RT back to CPU and re-upload it as a plain texture --
 *  the round-trip a served tile takes (bake -> tile bytes -> load).  Cached per
 *  tile + generation, so the GPU->CPU readback happens once per (re)bake. */
function roundtripCoverageTexture(
    context: Context,
    key: string,
    rt: CoverageTile,
    generation: number,
): WebGLTexture {
    const cached = _stubTextures.get(key);
    if (cached && cached.generation === generation) return cached.texture;

    const gl = context.gl;
    const size = COVERAGE_RT_SIZE;
    const n = size * size * 4;
    if (_stubReadBuffer.length < n) _stubReadBuffer = new Uint8Array(n);

    // Read the baked RGBA8 RT back to CPU (== the baker's "encode to tile" input).
    const prevFramebuffer = context.bindFramebuffer.current;
    context.bindFramebuffer.set(rt.framebuffer);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, _stubReadBuffer);
    context.bindFramebuffer.set(prevFramebuffer);

    // Re-upload as a plain texture (== the client "loads the served tile").
    let texture = cached?.texture ?? null;
    context.activeTexture.set(gl.TEXTURE1);
    if (!texture) {
        texture = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
        gl.bindTexture(gl.TEXTURE_2D, texture);
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        _stubReadBuffer.subarray(0, n));
    _stubTextures.set(key, {texture, generation});
    return texture;
}

// ── Cached prepare → composite (multi-light coverage) ──────────────
//
// The expensive per-light DEM march runs in an OFFSCREEN prepare pass that
// bakes the marched + spectrum-coloured field into a per-tile RGBA RT
// (`_coverageTextures`), keyed by tile + lights-generation.  It re-bakes only
// when the light set changes or a new tile appears.  The per-frame composite
// then just samples that RT on the terrain mesh -- O(tiles) texture reads,
// no march.

function bakeCoverageTiles(
    painter: Painter,
    tileManager: TileManager,
    layer: PointHillshadeStyleLayer,
    prepared: PreparedLight[],
    coords: OverscaledTileID[],
    maxLights: number,
): number {
    const context = painter.context;
    const gl = context.gl;
    const generation = layer._lightsGeneration;

    // Collect tiles whose cached RT is missing or baked at an older generation.
    const stale: OverscaledTileID[] = [];
    for (const coord of coords) {
        const tile = tileManager.getTile(coord);
        if (!tile?.fbo || !tile.dem || !tile.demTexture) continue;
        const rt = layer._coverageTextures.get(coord.key);
        if (!rt || rt.generation !== generation) stale.push(coord);
    }
    if (stale.length === 0) return generation;

    // Phase-0 baseline: time the bake loop's CPU submit + count work (gated).
    const perf = coveragePerfEnabled();
    const perfStart = perf ? performance.now() : 0;
    let perfLights = 0;

    const program = painter.useProgram('pointHillshadeCoveragePrepare');
    // Save the bound target/viewport: terrain may have an FBO bound during the
    // translucent pass, so restore exactly what was there after the bakes.
    const prevFramebuffer = context.bindFramebuffer.current;
    const prevViewport = context.viewport.current;

    // Upload (when changed) + bind the shared wide-area DEM overview ONCE for
    // the whole bake -- every tile marches the same mercator-space overview.
    const hasOverview = ensureOverviewTexture(context, layer);
    context.activeTexture.set(gl.TEXTURE0 + OVERVIEW_TEX_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, _overviewTex);
    const ov = layer._marchDem;
    const ovMinX = hasOverview && ov ? ov.mercMinX : 0;
    const ovMinY = hasOverview && ov ? ov.mercMinY : 0;
    const ovSizeX = hasOverview && ov ? ov.mercSizeX : 1;   // 1 = avoid /0 (guarded)
    const ovSizeY = hasOverview && ov ? ov.mercSizeY : 1;
    const hasOverviewF = hasOverview ? 1 : 0;

    for (const coord of stale) {
        const tile = tileManager.getTile(coord);
        if (!tile?.fbo || !tile.dem || !tile.demTexture) continue;
        let rt = layer._coverageTextures.get(coord.key);
        if (!rt) {
            rt = createCoverageRT(context, COVERAGE_RT_SIZE);
            layer._coverageTextures.set(coord.key, rt);
        }
        // Record the canonical tile coordinate so the offline baker can address
        // this RT by z/x/y when reading it back.
        rt.z = coord.canonical.z;
        rt.x = coord.canonical.x;
        rt.y = coord.canonical.y;

        context.bindFramebuffer.set(rt.framebuffer);
        context.viewport.set([0, 0, COVERAGE_RT_SIZE, COVERAGE_RT_SIZE]);
        context.clear({color: Color.transparent});

        const tileLights = filterLightsForTile(prepared, coord, maxLights);
        if (perf) perfLights += tileLights.length;
        if (tileLights.length > 0) {
            // RAW DEM elevation (TEXTURE0) + per-light data (TEXTURE4) + globals UBO.
            // The occlusion march reads ABSOLUTE elevation (metres), so it is
            // resolution-independent -- mixed-LOD tiles no longer seam.
            const dem = tile.dem;
            context.activeTexture.set(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tile.demTexture.texture);
            const tilesAtZoom = Math.pow(2, coord.canonical.z);
            const [latLo, latHi] = getTileLatRange(coord);
            // DEM carries a 1px skirt: map tile-relative [0,1] -> the inner
            // dim x dim data region of the stride x stride texture.
            const demUV0 = 1 / dem.stride;
            const demUVScale = dem.dim / dem.stride;
            uploadTileLights(context, tileLights);
            updateGlobalsUBO(context, tilesAtZoom, coord.canonical.x, coord.canonical.y,
                latLo, latHi, dem.getUnpackVector(), demUV0, demUVScale,
                ovMinX, ovMinY, ovSizeX, ovSizeY, hasOverviewF);
            ensureBlockBinding(context, program.program);
            program.draw(context, gl.TRIANGLES,
                DepthMode.disabled, StencilMode.disabled, ColorMode.unblended, CullFaceMode.disabled,
                pointHillshadeCoveragePrepareUniformValues(tileLights.length, LIGHT_TEX_UNIT, OVERVIEW_TEX_UNIT),
                null, null, layer.id,
                painter.rasterBoundsBuffer, painter.quadTriangleIndexBuffer, painter.rasterBoundsSegments);
        }
        rt.generation = generation;
    }

    // Unbind the UBO + restore the previous render target/viewport.
    gl.bindBufferBase(gl.UNIFORM_BUFFER, LIGHTS_UBO_BINDING, null);
    context.bindFramebuffer.set(prevFramebuffer);
    context.viewport.set(prevViewport);
    if (perf) {
        const ms = performance.now() - perfStart;
        // eslint-disable-next-line no-console
        console.log(`[coverage] bake ${stale.length} tiles, ${perfLights} lights, ` +
            `overview=${hasOverviewF}, ${ms.toFixed(2)}ms CPU submit`);
    }
    return generation;
}

function drawCoverageMultiLight(
    painter: Painter,
    tileManager: TileManager,
    layer: PointHillshadeStyleLayer,
    tileIDs: OverscaledTileID[],
    renderOptions: RenderOptions,
) {
    const context = painter.context;
    const gl = context.gl;
    const projection = painter.style.projection;
    const transform = painter.transform;
    const align = !painter.options.moving;

    const depthMode = painter.getDepthModeForSublayer(0, DepthMode.ReadOnly);
    const surfaceOpacity = layer.paint.get('point-hillshade-surface-opacity');
    const shadowSigma = layer.paint.get('point-hillshade-shadow-sigma');
    const coverageView = layer.paint.get('point-hillshade-coverage-view');

    // Float-texture width caps the per-tile light count (3 texels/light).
    const maxLights = Math.max(1, Math.floor(context.maxTextureSize / 3));

    const prepared = prepareLights(layer);
    layer._lightsDirty &&= false;

    const [stencil, coords] = painter.getStencilConfigForOverlapAndUpdateStencilID(tileIDs);

    // 1. Offscreen prepare: (re-)bake stale tiles into their cached coverage RTs.
    const generation = bakeCoverageTiles(painter, tileManager, layer, prepared, coords, maxLights);

    // 2. Composite: drape each tile's cached coverage RT on the terrain mesh.
    const program = painter.useProgram('pointHillshadeComposite');
    const stub = coverageTileStubEnabled();
    for (const coord of coords) {
        const src = resolveCoverageSource(layer, coord, generation);
        if (!src) continue;

        const mesh = projection.getMeshFromTileID(context, coord.canonical, false, true, 'raster');
        const terrainData = painter.style.map.terrain?.getTerrainData(coord);
        const projectionData = transform.getProjectionData({
            overscaledTileID: coord,
            aligned: align,
            applyGlobeMatrix: !renderOptions.isRenderingToTexture,
            applyTerrainMatrix: true,
        });
        const stencilMode = stencil[coord.overscaledZ];

        // Stub (dev): sample a CPU round-tripped copy of the OWN RT to prove a
        // served tile reconstructs the field identically (own-RT only; ancestor
        // fallbacks keep the live RT).
        const coverageTexture = (stub && src.uv[2] === 1.0)
            ? roundtripCoverageTexture(context, coord.key, src.rt, generation)
            : src.rt.texture;
        context.activeTexture.set(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, coverageTexture);

        // Alpha-blend the premultiplied coverage layer over the basemap
        // (ColorMode.alphaBlended = [ONE, 1-srcAlpha], default FUNC_ADD): one
        // cohesive translucent overlay, no additive blow-out.  src.uv selects
        // the tile's own RT (0,0,1) or its sub-rect of an ancestor fallback.
        program.draw(context, gl.TRIANGLES, depthMode, stencilMode,
            ColorMode.alphaBlended, CullFaceMode.backCCW,
            pointHillshadeCompositeUniformValues(surfaceOpacity, src.uv, shadowSigma, coverageView),
            terrainData, projectionData, layer.id,
            mesh.vertexBuffer, mesh.indexBuffer, mesh.segments);
    }
}

// ── Aggregate-tile composite (precomputed served coverage tiles) ──────────
//
// The PRODUCTION path: the layer's (raster) source serves precomputed coverage
// DATA tiles (R=margin01, G=presence, ... -- the same field the bake produced),
// and MapLibre handles fetch + cache + pyramid-level selection.  Here we just
// drape each loaded tile's texture on the terrain mesh through the UNCHANGED
// composite shader -- O(tiles) texture reads, zero march, zero bake.

function drawCoverageFromTiles(
    painter: Painter,
    tileManager: TileManager,
    layer: PointHillshadeStyleLayer,
    tileIDs: OverscaledTileID[],
    renderOptions: RenderOptions,
) {
    const context = painter.context;
    const gl = context.gl;
    const projection = painter.style.projection;
    const transform = painter.transform;
    const align = !painter.options.moving;

    const depthMode = painter.getDepthModeForSublayer(0, DepthMode.ReadOnly);
    const surfaceOpacity = layer.paint.get('point-hillshade-surface-opacity');
    const shadowSigma = layer.paint.get('point-hillshade-shadow-sigma');
    const coverageView = layer.paint.get('point-hillshade-coverage-view');
    const [stencil, coords] = painter.getStencilConfigForOverlapAndUpdateStencilID(tileIDs);
    const program = painter.useProgram('pointHillshadeComposite');

    for (const coord of coords) {
        const tile = tileManager.getTile(coord);
        // Skip tiles whose coverage data hasn't loaded yet (MapLibre fills them
        // in over subsequent frames; the basemap shows through meanwhile).
        if (!tile?.texture) continue;

        const mesh = projection.getMeshFromTileID(context, coord.canonical, false, true, 'raster');
        const terrainData = painter.style.map.terrain?.getTerrainData(coord);
        const projectionData = transform.getProjectionData({
            overscaledTileID: coord,
            aligned: align,
            applyGlobeMatrix: !renderOptions.isRenderingToTexture,
            applyTerrainMatrix: true,
        });
        const stencilMode = stencil[coord.overscaledZ];

        // Bind the served coverage DATA tile to u_coverageTex (unit 1); the
        // composite reconstructs margin -> heatmap -> confidence live.  LINEAR +
        // CLAMP: the field is smooth, sampled whole-tile (uv 0,0,1).
        context.activeTexture.set(gl.TEXTURE1);
        tile.texture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);

        program.draw(context, gl.TRIANGLES, depthMode, stencilMode,
            ColorMode.alphaBlended, CullFaceMode.backCCW,
            pointHillshadeCompositeUniformValues(surfaceOpacity, [0, 0, 1], shadowSigma, coverageView),
            terrainData, projectionData, layer.id,
            mesh.vertexBuffer, mesh.indexBuffer, mesh.segments);
    }
}

// ── Main draw entry ────────────────────────────────

export function drawPointHillshade(painter: Painter, tileManager: TileManager, layer: PointHillshadeStyleLayer, tileIDs: OverscaledTileID[], renderOptions: RenderOptions): void {
    if (painter.renderPass !== 'translucent') return;
    if (!tileIDs.length) return;

    // Production path: composite precomputed served coverage tiles (no bake).
    if (layer._aggregateTiles) {
        drawCoverageFromTiles(painter, tileManager, layer, tileIDs, renderOptions);
        return;
    }

    // Multi-light coverage: single-pass float-texture rendering (live bake).
    if (layer._lights.length > 0) {
        drawCoverageMultiLight(painter, tileManager, layer, tileIDs, renderOptions);
        return;
    }

    // Single-light path (selected-node localized light).
    const {isRenderingToTexture} = renderOptions;
    const projection = painter.style.projection;
    const useSubdivision = projection.useSubdivision;

    const depthMode = painter.getDepthModeForSublayer(0, DepthMode.ReadOnly);
    const colorMode = painter.colorModeForRenderPass();

    const surfaceOpacity = layer.paint.get('point-hillshade-surface-opacity');

    if (useSubdivision) {
        if (surfaceOpacity > 0) {
            const [surfStencilBL, surfStencilB, surfCoords] = painter.stencilConfigForOverlapTwoPass(tileIDs);
            renderPointHillshadeSurface(painter, tileManager, layer, surfCoords, surfStencilBL, depthMode, colorMode, false, isRenderingToTexture);
            renderPointHillshadeSurface(painter, tileManager, layer, surfCoords, surfStencilB, depthMode, colorMode, true, isRenderingToTexture);
        }
        const [stencilBorderless, stencilBorders, coords] = painter.stencilConfigForOverlapTwoPass(tileIDs);
        renderPointHillshade(painter, tileManager, layer, coords, stencilBorderless, depthMode, colorMode, false, isRenderingToTexture);
        renderPointHillshade(painter, tileManager, layer, coords, stencilBorders, depthMode, colorMode, true, isRenderingToTexture);
    } else {
        const [stencil, coords] = painter.getStencilConfigForOverlapAndUpdateStencilID(tileIDs);
        if (surfaceOpacity > 0) {
            renderPointHillshadeSurface(painter, tileManager, layer, coords, stencil, depthMode, colorMode, false, isRenderingToTexture);
        }
        renderPointHillshade(painter, tileManager, layer, coords, stencil, depthMode, colorMode, false, isRenderingToTexture);
    }
}

// ── Single-light render passes (selected-node localized light) ──────

function renderPointHillshadeSurface(
    painter: Painter,
    tileManager: TileManager,
    layer: PointHillshadeStyleLayer,
    coords: OverscaledTileID[],
    stencilModes: {[_: number]: Readonly<StencilMode>},
    depthMode: Readonly<DepthMode>,
    colorMode: Readonly<ColorMode>,
    useBorder: boolean,
    isRenderingToTexture: boolean,
) {
    const projection = painter.style.projection;
    const context = painter.context;
    const transform = painter.transform;
    const gl = context.gl;

    const program = painter.useProgram('pointHillshadeSurface');
    const align = !painter.options.moving;

    for (const coord of coords) {
        const tile = tileManager.getTile(coord);
        if (!tile) continue;
        const fbo = tile.fbo;
        if (!fbo) continue;

        const mesh = projection.getMeshFromTileID(context, coord.canonical, useBorder, true, 'raster');
        const terrainData = painter.style.map.terrain?.getTerrainData(coord);

        context.activeTexture.set(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, fbo.colorAttachment.get());

        const projectionData = transform.getProjectionData({
            overscaledTileID: coord,
            aligned: align,
            applyGlobeMatrix: !isRenderingToTexture,
            applyTerrainMatrix: true
        });

        program.draw(context, gl.TRIANGLES, depthMode, stencilModes[coord.overscaledZ], colorMode, CullFaceMode.backCCW,
            pointHillshadeSurfaceUniformValues(painter, tile, layer), terrainData, projectionData, layer.id, mesh.vertexBuffer, mesh.indexBuffer, mesh.segments);
    }
}

// ── Main terrain detail pass ───────────────────────────────────────

function renderPointHillshade(
    painter: Painter,
    tileManager: TileManager,
    layer: PointHillshadeStyleLayer,
    coords: OverscaledTileID[],
    stencilModes: {[_: number]: Readonly<StencilMode>},
    depthMode: Readonly<DepthMode>,
    colorMode: Readonly<ColorMode>,
    useBorder: boolean,
    isRenderingToTexture: boolean,
) {
    const projection = painter.style.projection;
    const context = painter.context;
    const transform = painter.transform;
    const gl = context.gl;

    const program = painter.useProgram('pointHillshade');
    const align = !painter.options.moving;

    for (const coord of coords) {
        const tile = tileManager.getTile(coord);
        if (!tile) continue;
        const fbo = tile.fbo;
        if (!fbo) continue;

        const mesh = projection.getMeshFromTileID(context, coord.canonical, useBorder, true, 'raster');
        const terrainData = painter.style.map.terrain?.getTerrainData(coord);

        context.activeTexture.set(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, fbo.colorAttachment.get());

        const uniforms = pointHillshadeUniformValues(painter, tile, layer);

        const projectionData = transform.getProjectionData({
            overscaledTileID: coord,
            aligned: align,
            applyGlobeMatrix: !isRenderingToTexture,
            applyTerrainMatrix: true
        });

        program.draw(context, gl.TRIANGLES, depthMode, stencilModes[coord.overscaledZ], colorMode, CullFaceMode.backCCW,
            uniforms, terrainData, projectionData, layer.id, mesh.vertexBuffer, mesh.indexBuffer, mesh.segments);
    }
}
