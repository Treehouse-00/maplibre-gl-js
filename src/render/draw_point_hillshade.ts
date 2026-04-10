import {DepthMode} from '../gl/depth_mode';
import {CullFaceMode} from '../gl/cull_face_mode';
import {ColorMode} from '../gl/color_mode';
import {StencilMode} from '../gl/stencil_mode';
import {
    pointHillshadeUniformValues
} from './program/point_hillshade_program';
import {
    pointHillshadeSurfaceUniformValues
} from './program/point_hillshade_surface_program';
import {MercatorCoordinate} from '../geo/mercator_coordinate';
import {Color} from '@maplibre/maplibre-gl-style-spec';

import type {Painter, RenderOptions} from './painter';
import type {TileManager} from '../tile/tile_manager';
import type {PointHillshadeStyleLayer, CoverageLight} from '../style/style_layer/point_hillshade_style_layer';
import type {OverscaledTileID} from '../tile/tile_id';
import type {Tile} from '../tile/tile';
import type {UniformValues} from './uniform_binding';
import type {PointHillshadeUniformsType} from './program/point_hillshade_program';
import type {PointHillshadeSurfaceUniformsType} from './program/point_hillshade_surface_program';

// ── Multi-light coverage rendering ─────────────────────────────────
//
// Each coverage light is rendered using the SAME single-light terrain
// shader (u_lightCount = 0) that drives the selected-node localized
// light.  Lights are composited with additive blending (GL_ONE,
// GL_ONE) so each node’s terrain-occluded illumination accumulates
// naturally.  The result is identical to “every node selected at once”
// — full DEM-derived slope analysis, 5-probe occlusion, and NdotL
// compositing per light.

/** Max lights rendered per tile.  Uncapped — every node in
 *  the viewport gets the full terrain-occluded light effect. */
const MAX_LIGHTS_PER_TILE = 9999;

/** Light altitude: 3 m AGL. */
const LIGHT_ALT_M = 3;
/** Virtual shadow height for sightline probes. */
const SHADOW_ALT_M = 20;

// ── Prepared-light cache ───────────────────────────────────────

interface PreparedLight {
    light: CoverageLight;
    mercX: number;
    mercY: number;
    meterInMerc: number;
    radiusMerc: number;
}

let _preparedLights: PreparedLight[] = [];
let _preparedGeneration = -1;

function prepareLights(layer: PointHillshadeStyleLayer): PreparedLight[] {
    // Re-prepare only when lights change
    if (!layer._lightsDirty && _preparedGeneration === layer._lights.length) {
        return _preparedLights;
    }
    _preparedLights = layer._lights.map(light => {
        const merc = MercatorCoordinate.fromLngLat(light.center as [number, number]);
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
): PreparedLight[] {
    const tilesAtZoom = Math.pow(2, coord.canonical.z);
    const originX = coord.canonical.x / tilesAtZoom;
    const originY = coord.canonical.y / tilesAtZoom;
    const size = 1 / tilesAtZoom;
    const cx = originX + size * 0.5;
    const cy = originY + size * 0.5;

    // Filter to lights whose radius intersects this tile
    const hits: {pl: PreparedLight; dist: number; isObserver: boolean}[] = [];
    for (const pl of prepared) {
        if (pl.mercX + pl.radiusMerc < originX) continue;
        if (pl.mercX - pl.radiusMerc > originX + size) continue;
        if (pl.mercY + pl.radiusMerc < originY) continue;
        if (pl.mercY - pl.radiusMerc > originY + size) continue;
        const dx = pl.mercX - cx;
        const dy = pl.mercY - cy;
        const isObs = pl.light.color[0] > 0.4 && pl.light.color[2] > 0.8; // violet = observer
        hits.push({pl, dist: dx * dx + dy * dy, isObserver: isObs});
    }

    // Sort: largest radius first (observers), smallest last (sensors).
    // With additive blend, the first-drawn lights establish the colour
    // base.  Observers (violet, large radius) paint the broad coverage,
    // then smaller repeaters/sensors fill in detail without drowning
    // out the observer tint.
    hits.sort((a, b) => {
        const ra = a.pl.radiusMerc;
        const rb = b.pl.radiusMerc;
        if (ra !== rb) return rb - ra; // largest first
        return a.dist - b.dist;        // then closer first
    });
    return hits.slice(0, MAX_LIGHTS_PER_TILE).map(h => h.pl);
}

// ── Per-light uniform builders ───────────────────────────────────

function getTileLatRange(tileID: OverscaledTileID): [number, number] {
    const tilesAtZoom = Math.pow(2, tileID.canonical.z);
    const y = tileID.canonical.y;
    return [
        new MercatorCoordinate(0, y / tilesAtZoom).toLngLat().lat,
        new MercatorCoordinate(0, (y + 1) / tilesAtZoom).toLngLat().lat,
    ];
}

function coverageLightMainUniforms(
    pl: PreparedLight,
    tileID: OverscaledTileID,
): UniformValues<PointHillshadeUniformsType> {
    const tilesAtZoom = Math.pow(2, tileID.canonical.z);
    const tileSizeMerc = 1.0 / tilesAtZoom;
    const lightTileX = pl.mercX * tilesAtZoom - tileID.canonical.x;
    const lightTileY = pl.mercY * tilesAtZoom - tileID.canonical.y;
    const radiusTile = (pl.light.falloffMeters * pl.meterInMerc) / tileSizeMerc;
    const heightTile = (LIGHT_ALT_M * pl.meterInMerc) / tileSizeMerc;
    const shadowTile = (SHADOW_ALT_M * pl.meterInMerc) / tileSizeMerc;
    const diffuse = 1.5 + pl.light.intensity * 2.0;

    return {
        'u_image': 0,
        'u_latrange': getTileLatRange(tileID),
        'u_exaggeration': 0.5,
        'u_lightCenter': [lightTileX, lightTileY],
        'u_lightColor': pl.light.color,
        'u_falloffRadius': radiusTile,
        'u_lightHeight': heightTile,
        'u_shadowHeight': shadowTile,
        'u_diffuse': diffuse,
        'u_ambient': 0.18,
        'u_coverageTex': 1,
        'u_lightCount': 0,  // single-light shader path
    };
}

function coverageLightSurfaceUniforms(
    pl: PreparedLight,
    tileID: OverscaledTileID,
    surfaceOpacity: number,
): UniformValues<PointHillshadeSurfaceUniformsType> {
    const tilesAtZoom = Math.pow(2, tileID.canonical.z);
    const tileSizeMerc = 1.0 / tilesAtZoom;
    const lightTileX = pl.mercX * tilesAtZoom - tileID.canonical.x;
    const lightTileY = pl.mercY * tilesAtZoom - tileID.canonical.y;
    const radiusTile = (pl.light.falloffMeters * pl.meterInMerc) / tileSizeMerc;
    const heightTile = (LIGHT_ALT_M * pl.meterInMerc) / tileSizeMerc;
    const diffuse = 1.5 + pl.light.intensity * 2.0;

    return {
        'u_image': 0,
        'u_exaggeration': 0.5,
        'u_lightCenter': [lightTileX, lightTileY],
        'u_lightColor': pl.light.color,
        'u_falloffRadius': radiusTile,
        'u_lightHeight': heightTile,
        'u_diffuse': diffuse,
        'u_surfaceOpacity': surfaceOpacity,
        'u_coverageTex': 1,
        'u_lightCount': 0,  // single-light shader path
    };
}

// ── Multi-light additive coverage pass ────────────────────────────

function drawCoverageMultiLight(
    painter: Painter,
    tileManager: TileManager,
    layer: PointHillshadeStyleLayer,
    tileIDs: Array<OverscaledTileID>,
    renderOptions: RenderOptions,
) {
    const context = painter.context;
    const gl = context.gl;
    const projection = painter.style.projection;
    const transform = painter.transform;
    const align = !painter.options.moving;

    const depthMode = painter.getDepthModeForSublayer(0, DepthMode.ReadOnly);
    // GL_MAX (Lighter Color): each pixel keeps the brightest light’s
    // output.  No blowout, no mixing — pure whole-pixel selection.
    // Colors stay exactly as the shader produced them.
    const maxBlend = new ColorMode(
        [gl.ONE, gl.ONE], Color.transparent, [true, true, true, true],
    );
    const surfaceOpacity = layer.paint.get('point-hillshade-surface-opacity');

    const prepared = prepareLights(layer);
    if (layer._lightsDirty) layer._lightsDirty = false;

    // Additive blend inside the render-to-texture FBO: each light’s
    // terrain-occluded contribution accumulates.  The R2T system
    // handles the final drape onto terrain with its own blend/stencil.
    const [stencil, coords] = painter.getStencilConfigForOverlapAndUpdateStencilID(tileIDs);

    const surfProg = surfaceOpacity > 0 ? painter.useProgram('pointHillshadeSurface') : null;
    const mainProg = painter.useProgram('pointHillshade');

    for (const coord of coords) {
        const tile = tileManager.getTile(coord);
        if (!tile || !tile.fbo) continue;

        const tileLights = filterLightsForTile(prepared, coord);
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

        // Bind DEM derivative FBO once for all lights on this tile
        context.activeTexture.set(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tile.fbo.colorAttachment.get());

        // Set GL_MAX blend equation: Lighter Color selection
        (gl as WebGL2RenderingContext).blendEquation((gl as WebGL2RenderingContext).MAX);

        for (const pl of tileLights) {
            // Surface glow
            if (surfProg) {
                surfProg.draw(context, gl.TRIANGLES, depthMode, stencilMode,
                    maxBlend, CullFaceMode.backCCW,
                    coverageLightSurfaceUniforms(pl, coord, surfaceOpacity),
                    terrainData, projectionData, layer.id,
                    mesh.vertexBuffer, mesh.indexBuffer, mesh.segments);
            }
            // Main terrain detail
            mainProg.draw(context, gl.TRIANGLES, depthMode, stencilMode,
                maxBlend, CullFaceMode.backCCW,
                coverageLightMainUniforms(pl, coord),
                terrainData, projectionData, layer.id,
                mesh.vertexBuffer, mesh.indexBuffer, mesh.segments);
        }

        // Restore default blend equation
        (gl as WebGL2RenderingContext).blendEquation(gl.FUNC_ADD);
    }
}

// ── Main draw entry ────────────────────────────────────────────

export function drawPointHillshade(painter: Painter, tileManager: TileManager, layer: PointHillshadeStyleLayer, tileIDs: Array<OverscaledTileID>, renderOptions: RenderOptions) {
    if (painter.renderPass !== 'translucent') return;
    if (!tileIDs.length) return;

    // Multi-light coverage: per-light additive rendering
    if (layer._lights.length > 0) {
        drawCoverageMultiLight(painter, tileManager, layer, tileIDs, renderOptions);
        return;
    }

    // Single-light path (selected-node localized light)
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
