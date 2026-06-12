import {DepthMode} from '../depth_mode.ts';
import {CullFaceMode} from '../cull_face_mode.ts';
import {ColorMode} from '../color_mode.ts';
import {type StencilMode} from '../stencil_mode.ts';
import {
    pointHillshadeUniformValues
} from '../program/point_hillshade_program.ts';
import {
    pointHillshadeSurfaceUniformValues
} from '../program/point_hillshade_surface_program.ts';
import {MercatorCoordinate} from '../../geo/mercator_coordinate.ts';
import {Color} from '@maplibre/maplibre-gl-style-spec';

import type {Context} from '../context.ts';
import type {Painter, RenderOptions} from '../../render/painter.ts';
import type {TileManager} from '../../tile/tile_manager.ts';
import type {PointHillshadeStyleLayer, CoverageLight} from '../../style/style_layer/point_hillshade_style_layer.ts';
import type {OverscaledTileID} from '../../tile/tile_id.ts';
import type {UniformValues} from '../uniform_binding.ts';
import type {PointHillshadeUniformsType} from '../program/point_hillshade_program.ts';
import type {PointHillshadeSurfaceUniformsType} from '../program/point_hillshade_surface_program.ts';

// ── Single-pass multi-light coverage rendering ─────────────────────
//
// Every coverage light for a tile is uploaded into one RGBA32F float
// texture (2 texels/light, mercator-space) and composited in a SINGLE
// draw per tile: the fragment shader loops `u_lightCount` lights via
// texelFetch and keeps the channel-wise max -- identical to the old
// per-light GL_MAX blend, but order-independent and blow-out free. The
// light-independent DEM/slope/normal base is computed once per fragment
// and shared across all lights.
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

// ── Per-tile uniform builders (per-light data lives in u_lightTex) ──

function coverageMainUniforms(
    lightCount: number,
): UniformValues<PointHillshadeUniformsType> {
    return {
        'u_image': 0,
        // Multi-light reads these from the UBO / float texture; the program
        // still declares the single-light uniforms, so supply harmless
        // (unused) values for them.
        'u_latrange': [0, 0],
        'u_exaggeration': COVERAGE_EXAGGERATION,
        'u_lightCenter': [0, 0],
        'u_lightColor': [0, 0, 0],
        'u_falloffRadius': 1,
        'u_lightHeight': 0,
        'u_shadowHeight': 0,
        'u_diffuse': 0,
        'u_ambient': COVERAGE_AMBIENT,
        'u_coverageTex': 1,
        'u_lightCount': lightCount,
        'u_lightTex': LIGHT_TEX_UNIT,
    };
}

function coverageSurfaceUniforms(
    lightCount: number,
    surfaceOpacity: number,
): UniformValues<PointHillshadeSurfaceUniformsType> {
    return {
        'u_image': 0,
        'u_exaggeration': COVERAGE_EXAGGERATION,
        'u_lightCenter': [0, 0],
        'u_lightColor': [0, 0, 0],
        'u_falloffRadius': 1,
        'u_lightHeight': 0,
        'u_diffuse': 0,
        'u_surfaceOpacity': surfaceOpacity,
        'u_coverageTex': 1,
        'u_lightCount': lightCount,
        'u_lightTex': LIGHT_TEX_UNIT,
    };
}

// ── GL resources for the float-texture + UBO path ──────────────────

let _lightTex: WebGLTexture | null = null;
let _lightData = new Float32Array(0);
let _lightUBO: WebGLBuffer | null = null;
const _uboData = new Float32Array(8);
const _blockBound = new WeakSet<WebGLProgram>();

/** Upload a tile's culled lights into the RGBA32F data texture (unit 4). */
function uploadTileLights(context: Context, lights: PreparedLight[]): void {
    const gl = context.gl;
    const n = lights.length;
    if (_lightData.length < n * 8) _lightData = new Float32Array(n * 8);
    const data = _lightData;
    for (let i = 0; i < n; i++) {
        const pl = lights[i];
        const o = i * 8;
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
    // 2 texels per light, single row. RGBA32F + NEAREST is texelFetch-able
    // in core WebGL2 (no float-linear extension needed for sampling).
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n * 2, 1, 0, gl.RGBA, gl.FLOAT,
        data.subarray(0, n * 8));
}

/** Upload the shared per-tile globals into the LightGlobals UBO. */
function updateGlobalsUBO(
    context: Context,
    tilesAtZoom: number,
    tileOriginX: number,
    tileOriginY: number,
    latLo: number,
    latHi: number,
): void {
    const gl = context.gl;
    // std140: two tightly-packed vec4s (each 16-byte aligned).
    //   u_lg0 = (tilesAtZoom, tileOriginX, tileOriginY, exaggeration)
    //   u_lg1 = (latLo, latHi, ambient, _pad)
    _uboData[0] = tilesAtZoom;
    _uboData[1] = tileOriginX;
    _uboData[2] = tileOriginY;
    _uboData[3] = COVERAGE_EXAGGERATION;
    _uboData[4] = latLo;
    _uboData[5] = latHi;
    _uboData[6] = COVERAGE_AMBIENT;
    _uboData[7] = 0;
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

// ── Single-pass multi-light coverage pass ──────────────────────────

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
    // GL_MAX (lighter-color): the brightest contribution wins per channel.
    // No blowout, no mixing -- colors stay exactly as the shader produced
    // them. This composites the surface vs. terrain passes (and against the
    // FBO); cross-light compositing now happens inside the shader.
    const maxBlend = new ColorMode(
        [gl.ONE, gl.ONE], Color.transparent, [true, true, true, true],
    );
    const surfaceOpacity = layer.paint.get('point-hillshade-surface-opacity');

    // Float-texture width caps the per-tile light count (2 texels/light).
    // On any realistic mesh this is effectively uncapped.
    const maxLights = Math.max(1, Math.floor(context.maxTextureSize / 2));

    const prepared = prepareLights(layer);
    layer._lightsDirty &&= false;

    const [stencil, coords] = painter.getStencilConfigForOverlapAndUpdateStencilID(tileIDs);

    const surfProg = surfaceOpacity > 0 ? painter.useProgram('pointHillshadeSurface') : null;
    const mainProg = painter.useProgram('pointHillshade');

    for (const coord of coords) {
        const tile = tileManager.getTile(coord);
        if (!tile?.fbo) continue;

        const tileLights = filterLightsForTile(prepared, coord, maxLights);
        if (tileLights.length === 0) continue;

        const mesh = projection.getMeshFromTileID(context, coord.canonical, false, true, 'raster');
        const terrainData = painter.style.map.terrain?.getTerrainData(coord);
        const projectionData = transform.getProjectionData({
            overscaledTileID: coord,
            aligned: align,
            applyGlobeMatrix: !renderOptions.isRenderingToTexture,
            applyTerrainMatrix: true,
        });
        const stencilMode = stencil[coord.overscaledZ];

        // Bind DEM derivative FBO (TEXTURE0) for all lights on this tile.
        context.activeTexture.set(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tile.fbo.colorAttachment.get());

        // Upload this tile's lights (TEXTURE4) + shared globals (UBO).
        const tilesAtZoom = Math.pow(2, coord.canonical.z);
        const [latLo, latHi] = getTileLatRange(coord);
        uploadTileLights(context, tileLights);
        updateGlobalsUBO(context, tilesAtZoom, coord.canonical.x, coord.canonical.y, latLo, latHi);

        // GL_MAX blend equation: lighter-color selection.
        gl.blendEquation(gl.MAX);

        const n = tileLights.length;

        // Surface glow -- one draw, all lights looped in-shader.
        if (surfProg) {
            ensureBlockBinding(context, surfProg.program);
            surfProg.draw(context, gl.TRIANGLES, depthMode, stencilMode,
                maxBlend, CullFaceMode.backCCW,
                coverageSurfaceUniforms(n, surfaceOpacity),
                terrainData, projectionData, layer.id,
                mesh.vertexBuffer, mesh.indexBuffer, mesh.segments);
        }
        // Main terrain detail -- one draw, all lights looped in-shader.
        ensureBlockBinding(context, mainProg.program);
        mainProg.draw(context, gl.TRIANGLES, depthMode, stencilMode,
            maxBlend, CullFaceMode.backCCW,
            coverageMainUniforms(n),
            terrainData, projectionData, layer.id,
            mesh.vertexBuffer, mesh.indexBuffer, mesh.segments);

        // Restore default blend equation.
        gl.blendEquation(gl.FUNC_ADD);
    }

    // Unbind the UBO so later draws that might declare a block at binding 0
    // don't accidentally read our buffer.
    gl.bindBufferBase(gl.UNIFORM_BUFFER, LIGHTS_UBO_BINDING, null);
}

// ── Main draw entry ────────────────────────────────────────────

export function drawPointHillshade(painter: Painter, tileManager: TileManager, layer: PointHillshadeStyleLayer, tileIDs: OverscaledTileID[], renderOptions: RenderOptions): void {
    if (painter.renderPass !== 'translucent') return;
    if (!tileIDs.length) return;

    // Multi-light coverage: single-pass float-texture rendering.
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
