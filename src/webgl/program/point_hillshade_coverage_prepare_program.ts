import {mat4} from 'gl-matrix';

import {
    Uniform1i,
    UniformMatrix4f,
} from '../uniform_binding.ts';

import {EXTENT} from '../../data/extent.ts';

import type {Context} from '../../webgl/context.ts';
import type {UniformValues, UniformLocations} from '../uniform_binding.ts';

export type PointHillshadeCoveragePrepareUniformsType = {
    'u_matrix': UniformMatrix4f;
    'u_image': Uniform1i;
    'u_lightCount': Uniform1i;
    'u_lightTex': Uniform1i;
    'u_overviewTex': Uniform1i;
};

const pointHillshadeCoveragePrepareUniforms = (context: Context, locations: UniformLocations): PointHillshadeCoveragePrepareUniformsType => ({
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix),
    'u_image': new Uniform1i(context, locations.u_image),
    'u_lightCount': new Uniform1i(context, locations.u_lightCount),
    'u_lightTex': new Uniform1i(context, locations.u_lightTex),
    'u_overviewTex': new Uniform1i(context, locations.u_overviewTex),
});

/** Orthographic projection for the full-tile prepare quad — same as the
 *  hillshade-prepare pass (rasterBounds geometry in EXTENT space → clip). */
function coveragePrepareMatrix(): mat4 {
    const matrix = mat4.create();
    mat4.ortho(matrix, 0, EXTENT, -EXTENT, 0, 0, 1);
    mat4.translate(matrix, matrix, [0, -EXTENT, 0]);
    return matrix;
}

const pointHillshadeCoveragePrepareUniformValues = (
    lightCount: number,
    lightTexUnit: number,
    overviewTexUnit: number,
): UniformValues<PointHillshadeCoveragePrepareUniformsType> => ({
    'u_matrix': coveragePrepareMatrix(),
    'u_image': 0,
    'u_lightCount': lightCount,
    'u_lightTex': lightTexUnit,
    'u_overviewTex': overviewTexUnit,
});

export {
    pointHillshadeCoveragePrepareUniforms,
    pointHillshadeCoveragePrepareUniformValues,
};
