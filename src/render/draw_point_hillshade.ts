import {DepthMode} from '../gl/depth_mode';
import {CullFaceMode} from '../gl/cull_face_mode';
import {type ColorMode} from '../gl/color_mode';
import {type StencilMode} from '../gl/stencil_mode';
import {
    pointHillshadeUniformValues
} from './program/point_hillshade_program';
import {
    pointHillshadeSurfaceUniformValues
} from './program/point_hillshade_surface_program';
import {MercatorCoordinate} from '../geo/mercator_coordinate';

import type {Painter, RenderOptions} from './painter';
import type {TileManager} from '../tile/tile_manager';
import type {PointHillshadeStyleLayer, CoverageLight} from '../style/style_layer/point_hillshade_style_layer';
import type {OverscaledTileID} from '../tile/tile_id';

// ── Coverage texture rasterization ───────────────────────────────────
//
// Composites all CoverageLights into a premultiplied-alpha RGBA texture
// per tile, using CPU pixel iteration with quadratic radial falloff.
//
// This texture is bound to TEXTURE1 (u_coverageTex) and the shader
// branches on u_lightCount > 0 to read it.  The terrain mesh, stencil
// overlap handling, slope analysis, and NdotL compositing remain
// identical to the single-light path — no flat quads are ever drawn.

const COVERAGE_SIZE = 256;
const MAX_COVERAGE_CACHE = 64;

function tileKey(coord: OverscaledTileID): string {
    return `${coord.canonical.z}_${coord.canonical.x}_${coord.canonical.y}`;
}

/**
 * Rasterize accumulated coverage from all lights into a premultiplied
 * RGBA Uint8 buffer for a single tile.
 *
 * Returns null when no light contributes to the tile (early-out).
 */
function rasterizeCoverageForTile(
    lights: CoverageLight[],
    coord: OverscaledTileID,
): Uint8ClampedArray | null {
    const z = coord.canonical.z;
    const tX = coord.canonical.x;
    const tY = coord.canonical.y;
    const tilesAtZoom = Math.pow(2, z);
    const tileOriginX = tX / tilesAtZoom;
    const tileOriginY = tY / tilesAtZoom;
    const tileSizeMerc = 1 / tilesAtZoom;

    const S = COVERAGE_SIZE;
    const accum = new Float32Array(S * S * 4);
    let hasData = false;

    for (const light of lights) {
        const merc = MercatorCoordinate.fromLngLat(light.center as [number, number]);
        const meterInMerc = merc.meterInMercatorCoordinateUnits();
        const radiusMerc = light.falloffMeters * meterInMerc;

        // Light centre + radius in pixel space (0–S)
        const cx = ((merc.x - tileOriginX) / tileSizeMerc) * S;
        const cy = ((merc.y - tileOriginY) / tileSizeMerc) * S;
        const cr = (radiusMerc / tileSizeMerc) * S;

        if (cr < 0.5) continue;

        // Pixel bounding box (clipped to canvas)
        const px0 = Math.max(0, Math.floor(cx - cr));
        const py0 = Math.max(0, Math.floor(cy - cr));
        const px1 = Math.min(S - 1, Math.ceil(cx + cr));
        const py1 = Math.min(S - 1, Math.ceil(cy + cr));
        if (px0 > S - 1 || px1 < 0 || py0 > S - 1 || py1 < 0) continue;

        const rSq = cr * cr;
        const lr = light.color[0];
        const lg = light.color[1];
        const lb = light.color[2];
        const li = light.intensity;

        for (let py = py0; py <= py1; py++) {
            const dy = py + 0.5 - cy;
            const dySq = dy * dy;
            for (let px = px0; px <= px1; px++) {
                const dx = px + 0.5 - cx;
                const d2 = dx * dx + dySq;
                if (d2 >= rSq) continue;

                const t = Math.sqrt(d2) / cr;
                const falloff = (1 - t) * (1 - t); // quadratic
                const w = falloff * li;

                const idx = (py * S + px) * 4;
                accum[idx]     += lr * w;   // premultiplied R
                accum[idx + 1] += lg * w;   // premultiplied G
                accum[idx + 2] += lb * w;   // premultiplied B
                accum[idx + 3] += w;        // alpha = total weight
                hasData = true;
            }
        }
    }

    if (!hasData) return null;

    // Convert float accumulator to Uint8 (auto-clamped to [0,255])
    const data = new Uint8ClampedArray(S * S * 4);
    for (let i = 0; i < accum.length; i++) {
        data[i] = accum[i] * 255;
    }
    return data;
}

/**
 * Get (or lazily create) the coverage GL texture for a tile.
 * Returns null when no lights contribute to the tile.
 */
function getCoverageTex(
    gl: WebGL2RenderingContext,
    layer: PointHillshadeStyleLayer,
    coord: OverscaledTileID,
): WebGLTexture | null {
    if (layer._lights.length === 0) return null;

    // Flush cache when lights have changed
    if (layer._lightsDirty) {
        layer.clearCoverageTextures(gl);
        layer._lightsDirty = false;
    }

    const key = tileKey(coord);
    const cached = layer._coverageTextures.get(key);
    if (cached) return cached;

    // Evict oldest if cache is full
    if (layer._coverageTextures.size >= MAX_COVERAGE_CACHE) {
        const oldest = layer._coverageTextures.keys().next().value;
        if (oldest != null) {
            const oldTex = layer._coverageTextures.get(oldest);
            if (oldTex) gl.deleteTexture(oldTex);
            layer._coverageTextures.delete(oldest);
        }
    }

    const pixels = rasterizeCoverageForTile(layer._lights, coord);
    if (!pixels) return null;

    const tex = gl.createTexture();
    if (!tex) return null;

    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA,
        COVERAGE_SIZE, COVERAGE_SIZE, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, pixels,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    layer._coverageTextures.set(key, tex);
    return tex;
}

export function drawPointHillshade(painter: Painter, tileManager: TileManager, layer: PointHillshadeStyleLayer, tileIDs: Array<OverscaledTileID>, renderOptions: RenderOptions) {
    if (painter.renderPass !== 'translucent') return;
    if (!tileIDs.length) return;

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

// ── Surface coverage pass ────────────────────────────────────────────

function renderPointHillshadeSurface(
    painter: Painter,
    tileManager: TileManager,
    layer: PointHillshadeStyleLayer,
    coords: Array<OverscaledTileID>,
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
    const hasCoverage = layer._lights.length > 0;

    for (const coord of coords) {
        const tile = tileManager.getTile(coord);
        if (!tile) continue;
        const fbo = tile.fbo;
        if (!fbo) continue;

        const mesh = projection.getMeshFromTileID(context, coord.canonical, useBorder, true, 'raster');
        const terrainData = painter.style.map.terrain?.getTerrainData(coord);

        // TEXTURE0: DEM derivative FBO (slope/normal data)
        context.activeTexture.set(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, fbo.colorAttachment.get());

        // TEXTURE1: coverage texture (multi-light mode)
        let lightCount = 0;
        if (hasCoverage) {
            const covTex = getCoverageTex(gl as WebGL2RenderingContext, layer, coord);
            if (covTex) {
                context.activeTexture.set(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, covTex);
                lightCount = layer._lights.length;
            }
        }

        const projectionData = transform.getProjectionData({
            overscaledTileID: coord,
            aligned: align,
            applyGlobeMatrix: !isRenderingToTexture,
            applyTerrainMatrix: true
        });

        program.draw(context, gl.TRIANGLES, depthMode, stencilModes[coord.overscaledZ], colorMode, CullFaceMode.backCCW,
            pointHillshadeSurfaceUniformValues(painter, tile, layer, lightCount), terrainData, projectionData, layer.id, mesh.vertexBuffer, mesh.indexBuffer, mesh.segments);
    }
}

// ── Main terrain detail pass ─────────────────────────────────────────

function renderPointHillshade(
    painter: Painter,
    tileManager: TileManager,
    layer: PointHillshadeStyleLayer,
    coords: Array<OverscaledTileID>,
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
    const hasCoverage = layer._lights.length > 0;

    for (const coord of coords) {
        const tile = tileManager.getTile(coord);
        if (!tile) continue;
        const fbo = tile.fbo;
        if (!fbo) continue;

        const mesh = projection.getMeshFromTileID(context, coord.canonical, useBorder, true, 'raster');
        const terrainData = painter.style.map.terrain?.getTerrainData(coord);

        // TEXTURE0: DEM derivative FBO (slope/normal data)
        context.activeTexture.set(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, fbo.colorAttachment.get());

        // TEXTURE1: coverage texture (multi-light mode)
        let lightCount = 0;
        if (hasCoverage) {
            const covTex = getCoverageTex(gl as WebGL2RenderingContext, layer, coord);
            if (covTex) {
                context.activeTexture.set(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, covTex);
                lightCount = layer._lights.length;
            }
        }

        const uniforms = pointHillshadeUniformValues(painter, tile, layer, lightCount);

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
