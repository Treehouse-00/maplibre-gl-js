import {
    Uniform1i,
    Uniform1f,
    Uniform2f,
    Uniform3f,
} from '../uniform_binding';

import {MercatorCoordinate} from '../../geo/mercator_coordinate';

import type {Context} from '../../webgl/context';
import type {UniformValues, UniformLocations} from '../uniform_binding';
import type {Tile} from '../../tile/tile';
import type {Painter} from '../../render/painter';
import type {PointHillshadeStyleLayer} from '../../style/style_layer/point_hillshade_style_layer';

export type PointHillshadeSurfaceUniformsType = {
    'u_image': Uniform1i;
    'u_exaggeration': Uniform1f;
    'u_lightCenter': Uniform2f;
    'u_lightColor': Uniform3f;
    'u_falloffRadius': Uniform1f;
    'u_lightHeight': Uniform1f;
    'u_diffuse': Uniform1f;
    'u_surfaceOpacity': Uniform1f;
    'u_coverageTex': Uniform1i;
    'u_lightCount': Uniform1i;
};

const pointHillshadeSurfaceUniforms = (context: Context, locations: UniformLocations): PointHillshadeSurfaceUniformsType => ({
    'u_image': new Uniform1i(context, locations.u_image),
    'u_exaggeration': new Uniform1f(context, locations.u_exaggeration),
    'u_lightCenter': new Uniform2f(context, locations.u_lightCenter),
    'u_lightColor': new Uniform3f(context, locations.u_lightColor),
    'u_falloffRadius': new Uniform1f(context, locations.u_falloffRadius),
    'u_lightHeight': new Uniform1f(context, locations.u_lightHeight),
    'u_diffuse': new Uniform1f(context, locations.u_diffuse),
    'u_surfaceOpacity': new Uniform1f(context, locations.u_surfaceOpacity),
    'u_coverageTex': new Uniform1i(context, locations.u_coverageTex),
    'u_lightCount': new Uniform1i(context, locations.u_lightCount),
});

/** Light altitude: 3 m AGL — matches terrain pass. */
const LIGHT_ALT_M = 3;

const pointHillshadeSurfaceUniformValues = (
    painter: Painter,
    tile: Tile,
    layer: PointHillshadeStyleLayer,
    lightCount = 0,
): UniformValues<PointHillshadeSurfaceUniformsType> => {
    const center = layer.paint.get('point-hillshade-center');
    const color = layer.paint.get('point-hillshade-color');
    const radiusMeters = layer.paint.get('point-hillshade-radius');
    const intensity = layer.paint.get('point-hillshade-intensity');
    const exaggeration = layer.paint.get('point-hillshade-exaggeration');
    const surfaceOpacity = layer.paint.get('point-hillshade-surface-opacity');

    const tileID = tile.tileID;
    const tilesAtZoom = Math.pow(2, tileID.canonical.z);
    const lightMerc = MercatorCoordinate.fromLngLat(center);
    const lightTileX = lightMerc.x * tilesAtZoom - tileID.canonical.x;
    const lightTileY = lightMerc.y * tilesAtZoom - tileID.canonical.y;

    const meterInMerc = lightMerc.meterInMercatorCoordinateUnits();
    const tileSizeMerc = 1.0 / tilesAtZoom;
    const radiusTile = (radiusMeters * meterInMerc) / tileSizeMerc;
    const heightTile = (LIGHT_ALT_M * meterInMerc) / tileSizeMerc;
    const diffuse = 1.5 + intensity * 2.0;

    return {
        'u_image': 0,
        'u_exaggeration': exaggeration,
        'u_lightCenter': [lightTileX, lightTileY],
        'u_lightColor': [color.r, color.g, color.b],
        'u_falloffRadius': radiusTile,
        'u_lightHeight': heightTile,
        'u_diffuse': diffuse,
        'u_surfaceOpacity': surfaceOpacity,
        'u_coverageTex': 1,
        'u_lightCount': lightCount,
    };
};

export {
    pointHillshadeSurfaceUniforms,
    pointHillshadeSurfaceUniformValues,
};
