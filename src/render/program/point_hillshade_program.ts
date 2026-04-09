import {
    Uniform1i,
    Uniform1f,
    Uniform2f,
    Uniform3f,
} from '../uniform_binding';

import {MercatorCoordinate} from '../../geo/mercator_coordinate';

import type {Context} from '../../gl/context';
import type {UniformValues, UniformLocations} from '../uniform_binding';
import type {Tile} from '../../tile/tile';
import type {Painter} from '../painter';
import type {PointHillshadeStyleLayer} from '../../style/style_layer/point_hillshade_style_layer';
import type {OverscaledTileID} from '../../tile/tile_id';

export type PointHillshadeUniformsType = {
    'u_image': Uniform1i;
    'u_latrange': Uniform2f;
    'u_exaggeration': Uniform1f;
    'u_lightCenter': Uniform2f;
    'u_lightColor': Uniform3f;
    'u_falloffRadius': Uniform1f;
    'u_lightHeight': Uniform1f;
    'u_shadowHeight': Uniform1f;
    'u_diffuse': Uniform1f;
    'u_ambient': Uniform1f;
    'u_coverageTex': Uniform1i;
    'u_lightCount': Uniform1i;
};

const pointHillshadeUniforms = (context: Context, locations: UniformLocations): PointHillshadeUniformsType => ({
    'u_image': new Uniform1i(context, locations.u_image),
    'u_latrange': new Uniform2f(context, locations.u_latrange),
    'u_exaggeration': new Uniform1f(context, locations.u_exaggeration),
    'u_lightCenter': new Uniform2f(context, locations.u_lightCenter),
    'u_lightColor': new Uniform3f(context, locations.u_lightColor),
    'u_falloffRadius': new Uniform1f(context, locations.u_falloffRadius),
    'u_lightHeight': new Uniform1f(context, locations.u_lightHeight),
    'u_shadowHeight': new Uniform1f(context, locations.u_shadowHeight),
    'u_diffuse': new Uniform1f(context, locations.u_diffuse),
    'u_ambient': new Uniform1f(context, locations.u_ambient),
    'u_coverageTex': new Uniform1i(context, locations.u_coverageTex),
    'u_lightCount': new Uniform1i(context, locations.u_lightCount),
});

/** Light altitude: 3 m AGL — low point source just above the antenna. */
const LIGHT_ALT_M = 3;

/** Virtual height for shadow sightline (20 m). Decoupled from the
 *  physical light height so shadows respond to real ridges, not every
 *  small slope that would occlude a 3 m source. */
const SHADOW_ALT_M = 20;

const pointHillshadeUniformValues = (
    painter: Painter,
    tile: Tile,
    layer: PointHillshadeStyleLayer,
): UniformValues<PointHillshadeUniformsType> => {
    const center = layer.paint.get('point-hillshade-center');
    const color = layer.paint.get('point-hillshade-color');
    const radiusMeters = layer.paint.get('point-hillshade-radius');
    const intensity = layer.paint.get('point-hillshade-intensity');
    const exaggeration = layer.paint.get('point-hillshade-exaggeration');

    // ── Convert light position to tile-relative coordinates ───────────
    const tileID = tile.tileID;
    const tilesAtZoom = Math.pow(2, tileID.canonical.z);
    const lightMerc = MercatorCoordinate.fromLngLat(center as [number, number]);
    const lightTileX = lightMerc.x * tilesAtZoom - tileID.canonical.x;
    const lightTileY = lightMerc.y * tilesAtZoom - tileID.canonical.y;

    // ── Convert falloff radius from meters to tile-relative units ─────
    const meterInMerc = lightMerc.meterInMercatorCoordinateUnits();
    const tileSizeMerc = 1.0 / tilesAtZoom;
    const radiusTile = (radiusMeters * meterInMerc) / tileSizeMerc;

    // ── Light height in tile-relative units ───────────────────────────
    const heightTile = (LIGHT_ALT_M * meterInMerc) / tileSizeMerc;

    // ── Diffuse multiplier: 1.5 – 3.5 based on intensity ─────────────
    const diffuse = 1.5 + intensity * 2.0;

    // ── Virtual shadow height in tile units ─────────────────────────
    const shadowHeightTile = (SHADOW_ALT_M * meterInMerc) / tileSizeMerc;

    return {
        'u_image': 0,
        'u_latrange': getTileLatRange(tileID),
        'u_exaggeration': exaggeration,
        'u_lightCenter': [lightTileX, lightTileY],
        'u_lightColor': [color.r, color.g, color.b],
        'u_falloffRadius': radiusTile,
        'u_lightHeight': heightTile,
        'u_shadowHeight': shadowHeightTile,
        'u_diffuse': diffuse,
        'u_ambient': 0.18,
        'u_coverageTex': 1,
        'u_lightCount': 0,
    };
};

function getTileLatRange(tileID: OverscaledTileID): [number, number] {
    const tilesAtZoom = Math.pow(2, tileID.canonical.z);
    const y = tileID.canonical.y;
    return [
        new MercatorCoordinate(0, y / tilesAtZoom).toLngLat().lat,
        new MercatorCoordinate(0, (y + 1) / tilesAtZoom).toLngLat().lat,
    ];
}

export {
    pointHillshadeUniforms,
    pointHillshadeUniformValues,
};
