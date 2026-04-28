import {StyleLayer} from '../style_layer';

import properties, {type PointHillshadePaintPropsPossiblyEvaluated} from './point_hillshade_style_layer_properties';
import {type Transitionable, type Transitioning, type PossiblyEvaluated} from '../properties';

import type {PointHillshadePaintProps} from './point_hillshade_style_layer_properties';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {EvaluationParameters} from '../evaluation_parameters';

// ── Multi-light coverage descriptor ──────────────────────────────────

export type CoverageLight = {
    center: [number, number];           // [lng, lat]
    color: [number, number, number];    // GL-ready RGB [0,1]
    falloffMeters: number;
    intensity: number;
};

export const isPointHillshadeStyleLayer = (layer: StyleLayer): layer is PointHillshadeStyleLayer => (layer.type as string) === 'point-hillshade';

export class PointHillshadeStyleLayer extends StyleLayer {
    _transitionablePaint: Transitionable<PointHillshadePaintProps>;
    _transitioningPaint: Transitioning<PointHillshadePaintProps>;
    paint: PossiblyEvaluated<PointHillshadePaintProps, PointHillshadePaintPropsPossiblyEvaluated>;

    // ── Multi-light coverage state ────────────────────────────────────
    _lights: CoverageLight[] = [];
    _lightsDirty = false;
    /** Per-tile coverage textures keyed by `z_x_y`. Managed by the draw pass. */
    _coverageTextures: Map<string, WebGLTexture> = new Map();

    constructor(layer: LayerSpecification, globalState: Record<string, any>) {
        super(layer, properties, globalState);
        this.recalculate({zoom: 0, zoomHistory: {}} as EvaluationParameters, undefined);
    }

    hasOffscreenPass() {
        return false;
    }

    /**
     * Push an array of coverage lights.  The draw pass lazily creates
     * per-tile coverage textures from this data.
     */
    setLights(lights: CoverageLight[]) {
        this._lights = lights;
        this._lightsDirty = true;
    }

    getLightCount(): number {
        return this._lights.length;
    }

    /** Release all cached GL textures. */
    clearCoverageTextures(gl: WebGLRenderingContext | WebGL2RenderingContext) {
        for (const tex of this._coverageTextures.values()) {
            gl.deleteTexture(tex);
        }
        this._coverageTextures.clear();
    }
}
