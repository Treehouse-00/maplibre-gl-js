/**
 * Paint property definitions for the `point-hillshade` layer type.
 *
 * These are defined inline (not generated from the style spec) because
 * `point-hillshade` is a custom layer type that doesn't exist in the
 * upstream MapLibre style specification.
 */

import {
    Properties,
    DataConstantProperty,
} from '../properties.ts';

import type {Color} from '@maplibre/maplibre-gl-style-spec';
import type {StylePropertySpecification} from '@maplibre/maplibre-gl-style-spec';

// ── Paint property types ─────────────────────────────────────────────────────

export type PointHillshadePaintProps = {
    'point-hillshade-center': DataConstantProperty<[number, number]>;
    'point-hillshade-color': DataConstantProperty<Color>;
    'point-hillshade-radius': DataConstantProperty<number>;
    'point-hillshade-intensity': DataConstantProperty<number>;
    'point-hillshade-exaggeration': DataConstantProperty<number>;
    'point-hillshade-surface-opacity': DataConstantProperty<number>;
    'point-hillshade-shadow-sigma': DataConstantProperty<number>;
    'point-hillshade-coverage-view': DataConstantProperty<number>;
};

export type PointHillshadePaintPropsPossiblyEvaluated = {
    'point-hillshade-center': [number, number];
    'point-hillshade-color': Color;
    'point-hillshade-radius': number;
    'point-hillshade-intensity': number;
    'point-hillshade-exaggeration': number;
    'point-hillshade-surface-opacity': number;
    'point-hillshade-shadow-sigma': number;
    'point-hillshade-coverage-view': number;
};

// ── Inline property specifications ───────────────────────────────────────────

const specs: Record<string, StylePropertySpecification> = {
    'point-hillshade-center': {
        type: 'array',
        value: 'number',
        length: 2,
        default: [0, 0],
        transition: false,
        expression: {interpolated: false, parameters: ['zoom']},
        'property-type': 'data-constant',
    } as any,
    'point-hillshade-color': {
        type: 'color',
        default: '#3b82f6',
        transition: true,
        expression: {interpolated: true, parameters: ['zoom']},
        'property-type': 'data-constant',
    } as any,
    'point-hillshade-radius': {
        type: 'number',
        default: 10000,
        minimum: 0,
        transition: true,
        expression: {interpolated: true, parameters: ['zoom']},
        'property-type': 'data-constant',
    } as any,
    'point-hillshade-intensity': {
        type: 'number',
        default: 0.5,
        minimum: 0,
        maximum: 1,
        transition: true,
        expression: {interpolated: true, parameters: ['zoom']},
        'property-type': 'data-constant',
    } as any,
    'point-hillshade-exaggeration': {
        type: 'number',
        default: 0.5,
        minimum: 0,
        maximum: 1,
        transition: true,
        expression: {interpolated: true, parameters: ['zoom']},
        'property-type': 'data-constant',
    } as any,
    'point-hillshade-surface-opacity': {
        type: 'number',
        default: 0.5,
        minimum: 0,
        maximum: 1,
        transition: true,
        expression: {interpolated: true, parameters: ['zoom']},
        'property-type': 'data-constant',
    } as any,
    // Log-normal shadowing std-dev (dB) for the probability-of-coverage
    // confidence -- the render-only confidence knob (default mirrors
    // coverage_core SHADOW_SIGMA_DB = 8).
    'point-hillshade-shadow-sigma': {
        type: 'number',
        default: 8,
        minimum: 0.5,
        maximum: 12,
        transition: true,
        expression: {interpolated: true, parameters: ['zoom']},
        'property-type': 'data-constant',
    } as any,
    // Coverage view mode: 0 = signal heatmap (confidence as translucency),
    // 1 = confidence reliability recolor.  Discrete, so no transition.
    'point-hillshade-coverage-view': {
        type: 'number',
        default: 0,
        minimum: 0,
        maximum: 1,
        transition: false,
        expression: {interpolated: false, parameters: ['zoom']},
        'property-type': 'data-constant',
    } as any,
};

// ── Properties singleton ─────────────────────────────────────────────────────

let paint: Properties<PointHillshadePaintProps>;
const getPaint = () => paint ||= new Properties({
    'point-hillshade-center': new DataConstantProperty(specs['point-hillshade-center']),
    'point-hillshade-color': new DataConstantProperty(specs['point-hillshade-color']),
    'point-hillshade-radius': new DataConstantProperty(specs['point-hillshade-radius']),
    'point-hillshade-intensity': new DataConstantProperty(specs['point-hillshade-intensity']),
    'point-hillshade-exaggeration': new DataConstantProperty(specs['point-hillshade-exaggeration']),
    'point-hillshade-surface-opacity': new DataConstantProperty(specs['point-hillshade-surface-opacity']),
    'point-hillshade-shadow-sigma': new DataConstantProperty(specs['point-hillshade-shadow-sigma']),
    'point-hillshade-coverage-view': new DataConstantProperty(specs['point-hillshade-coverage-view']),
});

export default ({get paint(): Properties<PointHillshadePaintProps> { return getPaint(); }});
