import {StyleLayer} from '../style_layer';

import properties, {type PointHillshadePaintPropsPossiblyEvaluated} from './point_hillshade_style_layer_properties';
import {type Transitionable, type Transitioning, type PossiblyEvaluated} from '../properties';

import type {PointHillshadePaintProps} from './point_hillshade_style_layer_properties';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {EvaluationParameters} from '../evaluation_parameters';

export const isPointHillshadeStyleLayer = (layer: StyleLayer): layer is PointHillshadeStyleLayer => (layer.type as string) === 'point-hillshade';

export class PointHillshadeStyleLayer extends StyleLayer {
    _transitionablePaint: Transitionable<PointHillshadePaintProps>;
    _transitioningPaint: Transitioning<PointHillshadePaintProps>;
    paint: PossiblyEvaluated<PointHillshadePaintProps, PointHillshadePaintPropsPossiblyEvaluated>;

    constructor(layer: LayerSpecification, globalState: Record<string, any>) {
        super(layer, properties, globalState);
        this.recalculate({zoom: 0, zoomHistory: {}} as EvaluationParameters, undefined);
    }

    hasOffscreenPass() {
        return false;
    }
}
