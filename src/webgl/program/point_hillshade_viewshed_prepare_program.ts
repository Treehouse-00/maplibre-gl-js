import {mat4} from 'gl-matrix';

import {
    Uniform1i,
    Uniform1f,
    Uniform2f,
    UniformMatrix4f,
} from '../uniform_binding.ts';

import {EXTENT} from '../../data/extent.ts';
import {MercatorCoordinate} from '../../geo/mercator_coordinate.ts';

import type {Context} from '../../webgl/context.ts';
import type {UniformValues, UniformLocations} from '../uniform_binding.ts';
import type {OverscaledTileID} from '../../tile/tile_id.ts';
import type {PointHillshadeStyleLayer} from '../../style/style_layer/point_hillshade_style_layer.ts';

export type PointHillshadeViewshedPrepareUniformsType = {
    'u_matrix': UniformMatrix4f;
    'u_image': Uniform1i;
    'u_latrange': Uniform2f;
    'u_exaggeration': Uniform1f;
    'u_lightCenter': Uniform2f;
    'u_falloffRadius': Uniform1f;
    'u_shadowHeight': Uniform1f;
    'u_dimension': Uniform2f;
    'u_zoom': Uniform1f;
};

const pointHillshadeViewshedPrepareUniforms = (context: Context, locations: UniformLocations): PointHillshadeViewshedPrepareUniformsType => ({
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix),
    'u_image': new Uniform1i(context, locations.u_image),
    'u_latrange': new Uniform2f(context, locations.u_latrange),
    'u_exaggeration': new Uniform1f(context, locations.u_exaggeration),
    'u_lightCenter': new Uniform2f(context, locations.u_lightCenter),
    'u_falloffRadius': new Uniform1f(context, locations.u_falloffRadius),
    'u_shadowHeight': new Uniform1f(context, locations.u_shadowHeight),
    'u_dimension': new Uniform2f(context, locations.u_dimension),
    'u_zoom': new Uniform1f(context, locations.u_zoom),
});

/** Virtual sightline height (20 m) — same as the render pass. */
const SHADOW_ALT_M = 20;

const pointHillshadeViewshedPrepareUniformValues = (
    tileID: OverscaledTileID,
    tileSize: number,
    layer: PointHillshadeStyleLayer,
): UniformValues<PointHillshadeViewshedPrepareUniformsType> => {
    const center = layer.paint.get('point-hillshade-center');
    const radiusMeters = layer.paint.get('point-hillshade-radius');
    const exaggeration = layer.paint.get('point-hillshade-exaggeration');

    // ── Tile-relative coordinate conversion (same as render pass) ─────
    const tilesAtZoom = Math.pow(2, tileID.canonical.z);
    const lightMerc = MercatorCoordinate.fromLngLat(center);
    const lightTileX = lightMerc.x * tilesAtZoom - tileID.canonical.x;
    const lightTileY = lightMerc.y * tilesAtZoom - tileID.canonical.y;

    const meterInMerc = lightMerc.meterInMercatorCoordinateUnits();
    const tileSizeMerc = 1.0 / tilesAtZoom;
    const radiusTile = (radiusMeters * meterInMerc) / tileSizeMerc;
    const shadowHeightTile = (SHADOW_ALT_M * meterInMerc) / tileSizeMerc;

    // Orthographic projection for fullscreen quad (same as hillshadePrepare)
    const matrix = mat4.create();
    mat4.ortho(matrix, 0, EXTENT, -EXTENT, 0, 0, 1);
    mat4.translate(matrix, matrix, [0, -EXTENT, 0]);

    const y = tileID.canonical.y;
    const latrange: [number, number] = [
        new MercatorCoordinate(0, y / tilesAtZoom).toLngLat().lat,
        new MercatorCoordinate(0, (y + 1) / tilesAtZoom).toLngLat().lat,
    ];

    return {
        'u_matrix': matrix,
        'u_image': 0,
        'u_latrange': latrange,
        'u_exaggeration': exaggeration,
        'u_lightCenter': [lightTileX, lightTileY],
        'u_falloffRadius': radiusTile,
        'u_shadowHeight': shadowHeightTile,
        'u_dimension': [tileSize, tileSize],
        'u_zoom': tileID.overscaledZ,
    };
};

export {
    pointHillshadeViewshedPrepareUniforms,
    pointHillshadeViewshedPrepareUniformValues,
};
