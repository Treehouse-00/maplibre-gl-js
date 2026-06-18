import {
    Uniform1i,
    Uniform1f,
    Uniform3f,
} from '../uniform_binding.ts';

import type {Context} from '../../webgl/context.ts';
import type {UniformValues, UniformLocations} from '../uniform_binding.ts';

export type PointHillshadeCompositeUniformsType = {
    'u_coverageTex': Uniform1i;
    'u_surfaceOpacity': Uniform1f;
    'u_coverageUV': Uniform3f;
    'u_shadowSigma': Uniform1f;
    'u_coverageView': Uniform1i;
};

const pointHillshadeCompositeUniforms = (context: Context, locations: UniformLocations): PointHillshadeCompositeUniformsType => ({
    'u_coverageTex': new Uniform1i(context, locations.u_coverageTex),
    'u_surfaceOpacity': new Uniform1f(context, locations.u_surfaceOpacity),
    'u_coverageUV': new Uniform3f(context, locations.u_coverageUV),
    'u_shadowSigma': new Uniform1f(context, locations.u_shadowSigma),
    'u_coverageView': new Uniform1i(context, locations.u_coverageView),
});

const pointHillshadeCompositeUniformValues = (
    surfaceOpacity: number,
    // (offsetX, offsetY, scale) sub-rect of the bound coverage RT this tile
    // samples -- (0,0,1) for a tile's own RT, or its sub-rect of a coarser
    // ANCESTOR RT used as a fallback while the tile's own coverage bakes.
    coverageUV: [number, number, number],
    // Confidence render controls (no re-bake): log-normal sigma (dB) + the view
    // mode (0 = signal heatmap, 1 = confidence reliability recolor).
    shadowSigma: number,
    coverageView: number,
): UniformValues<PointHillshadeCompositeUniformsType> => ({
    'u_coverageTex': 1,
    'u_surfaceOpacity': surfaceOpacity,
    'u_coverageUV': coverageUV,
    'u_shadowSigma': shadowSigma,
    'u_coverageView': coverageView,
});

export {
    pointHillshadeCompositeUniforms,
    pointHillshadeCompositeUniformValues,
};
