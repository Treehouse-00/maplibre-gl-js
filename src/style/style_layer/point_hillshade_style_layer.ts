import {StyleLayer} from '../style_layer.ts';

import properties, {type PointHillshadePaintPropsPossiblyEvaluated} from './point_hillshade_style_layer_properties.ts';
import {type Transitionable, type Transitioning, type PossiblyEvaluated} from '../properties.ts';

import type {PointHillshadePaintProps} from './point_hillshade_style_layer_properties.ts';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {EvaluationParameters} from '../evaluation_parameters.ts';

// ── Multi-light coverage descriptor ──────────────────────────────────

export type CoverageLight = {
    center: [number, number];           // [lng, lat]
    color: [number, number, number];    // GL-ready RGB [0,1]
    falloffMeters: number;
    intensity: number;
    /** Link margin (dB) at d0 (1 km).  Drives the per-texel SNR/RSSI spectrum
     *  colour in the fragment shader: margin(distM) = marginD0 - 35*log10(distM/1000). */
    marginD0: number;
    /** Node ground elevation (m), deterministic + viewport-independent.  The
     *  occlusion march uses it for the node antenna height (an elevated repeater
     *  sees over terrain); a sentinel (< -1e5) selects the seam-free
     *  equal-height fallback in the shader. */
    nodeGroundElev: number;
};

/** A baked per-tile coverage render-target: the prepare pass renders the
 *  marched + coloured field into `texture` (via `framebuffer`) once per
 *  lights-generation; the per-frame composite then just samples it. */
export type CoverageTile = {
    framebuffer: WebGLFramebuffer;
    texture: WebGLTexture;
    /** The `_lightsGeneration` this RT was baked at; re-bake when stale. */
    generation: number;
    /** RT edge in px, and the tile's canonical z/x/y (recorded at bake) -- so
     *  the offline coverage baker can read tiles back addressed by coordinate.
     *  z stays <0 until the tile has been baked at least once. */
    size: number;
    z: number;
    x: number;
    y: number;
};

/** A wide-area, FIXED-RESOLUTION DEM overview for the occlusion march.  A
 *  viewport-covering mosaic of fixed-zoom (z12) terrarium tiles, decoded to
 *  ABSOLUTE elevation in metres and stitched CPU-side into one Float32 grid
 *  (row 0 = north), plus its normalized web-mercator bounds.  The prepare
 *  shader marches THIS instead of the per-display-tile DEM, so sightlines stay
 *  continuous across tile boundaries (no edge gradient) and keep a consistent
 *  resolution regardless of display zoom (no low-zoom under-occlusion).  When
 *  absent, the shader falls back to the per-tile DEM march -> can't regress. */
export type MarchDemOverview = {
    /** Row-major elevation grid in metres, `width * height`, row 0 = north. */
    grid: Float32Array;
    width: number;
    height: number;
    /** Normalized web-mercator bounds [0,1] (NW origin): min = NW corner. */
    mercMinX: number;
    mercMinY: number;
    mercSizeX: number;
    mercSizeY: number;
};

/** True when the BAKE-relevant per-light data (node position, reach radius,
 *  link margin) differs between two light arrays.  Colour + intensity are
 *  ignored on purpose: the coverage bake doesn't consume them, so the churn
 *  they pick up on every SSE flush must NOT invalidate the cached per-tile RTs.
 *  Lights are emitted in a stable node order, so an index-wise compare aligns. */
function coverageDataChanged(prev: CoverageLight[], next: CoverageLight[]): boolean {
    if (prev.length !== next.length) return true;
    for (let i = 0; i < next.length; i++) {
        const a = prev[i];
        const b = next[i];
        if (a.center[0] !== b.center[0] ||
            a.center[1] !== b.center[1] ||
            a.falloffMeters !== b.falloffMeters ||
            a.marginD0 !== b.marginD0 ||
            a.nodeGroundElev !== b.nodeGroundElev) {
            return true;
        }
    }
    return false;
}

export const isPointHillshadeStyleLayer = (layer: StyleLayer): layer is PointHillshadeStyleLayer => (layer.type as string) === 'point-hillshade';

export class PointHillshadeStyleLayer extends StyleLayer {
    _transitionablePaint: Transitionable<PointHillshadePaintProps>;
    _transitioningPaint: Transitioning<PointHillshadePaintProps>;
    paint: PossiblyEvaluated<PointHillshadePaintProps, PointHillshadePaintPropsPossiblyEvaluated>;

    // ── Multi-light coverage state ────────────────────────────────────
    _lights: CoverageLight[] = [];
    _lightsDirty = false;
    /** Monotonic id bumped on every `setLights` so the draw pass can tell when
     *  a cached per-tile coverage RT is stale and must be re-baked. */
    _lightsGeneration = 0;
    /** Per-tile baked coverage render-targets keyed by tile key (`z_x_y`).
     *  Rendered once per lights-generation in the prepare step; the per-frame
     *  composite just samples them (no per-frame raymarch). */
    _coverageTextures: Map<string, CoverageTile> = new Map();
    /** Wide-area fixed-resolution DEM overview for the occlusion march (null =
     *  none loaded yet -> the shader falls back to the per-tile DEM march). */
    _marchDem: MarchDemOverview | null = null;
    /** Set when `_marchDem` changed and the draw pass must re-upload the GPU
     *  overview texture before the next bake. */
    _marchDemDirty = false;
    /** AGGREGATE-TILE mode: when true the layer does NOT bake; it composites
     *  precomputed coverage DATA tiles served from its (raster) source straight
     *  through the composite shader.  This is the production path -- the live
     *  multi-light bake is bypassed entirely (zero per-frame march). */
    _aggregateTiles = false;

    constructor(layer: LayerSpecification, globalState: Record<string, any>) {
        super(layer, properties, globalState);
        this.recalculate({zoom: 0, zoomHistory: {}} as EvaluationParameters, undefined);
    }

    hasOffscreenPass(): boolean {
        return false;
    }

    /**
     * Push an array of coverage lights.  The draw pass lazily creates
     * per-tile coverage textures from this data.
     */
    setLights(lights: CoverageLight[]): void {
        // Only invalidate the cached per-tile coverage RTs when data the BAKE
        // depends on actually changes (node position, reach, link margin).
        // setLights fires on every SSE flush with a fresh array whose only
        // differences are usually the shader-ignored intensity/colour, so an
        // unconditional bump would re-bake every visible tile each flush.
        const changed = coverageDataChanged(this._lights, lights);
        this._lights = lights;
        if (changed) {
            this._lightsDirty = true;
            this._lightsGeneration++;
        }
    }

    getLightCount(): number {
        return this._lights.length;
    }

    /**
     * Push the wide-area DEM overview the occlusion march samples.  Changing
     * the terrain source invalidates EVERY cached coverage RT, so this bumps
     * the generation to force a full re-bake (like a lights change), and flags
     * the GPU texture for re-upload in the draw pass.
     */
    setMarchDem(overview: MarchDemOverview): void {
        this._marchDem = overview;
        this._marchDemDirty = true;
        this._lightsGeneration++;
    }

    /** Enable/disable AGGREGATE-TILE mode (composite served coverage tiles
     *  instead of baking).  The layer's source must be the coverage raster
     *  source when this is on. */
    setAggregateTileMode(on: boolean): void {
        this._aggregateTiles = on;
    }

    /** Drop the DEM overview -> the march falls back to the per-tile DEM. */
    clearMarchDem(): void {
        if (!this._marchDem) return;
        this._marchDem = null;
        this._marchDemDirty = true;
        this._lightsGeneration++;
    }

    /** Release all cached coverage render-targets (framebuffers + textures). */
    clearCoverageTextures(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
        for (const c of this._coverageTextures.values()) {
            gl.deleteFramebuffer(c.framebuffer);
            gl.deleteTexture(c.texture);
        }
        this._coverageTextures.clear();
    }

    /**
     * Read every CURRENT-generation baked coverage tile back to CPU, addressed
     * by canonical z/x/y.  This is the bridge the offline coverage baker uses to
     * turn live GPU bakes into a served tile pyramid; it is NOT part of normal
     * rendering.  Each `data` is RGBA8, `size*size*4`, exactly as `gl.readPixels`
     * returns it (row 0 = the framebuffer's bottom row).  Stale tiles (older
     * generation) and never-baked entries are skipped.  Saves + restores the
     * framebuffer binding, so it's safe to call between frames.
     */
    readbackCoverageTiles(
        gl: WebGL2RenderingContext,
    ): Array<{z: number; x: number; y: number; size: number; data: Uint8Array}> {
        const out: Array<{z: number; x: number; y: number; size: number; data: Uint8Array}> = [];
        const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        for (const rt of this._coverageTextures.values()) {
            if (rt.z < 0 || rt.generation !== this._lightsGeneration) continue;
            const data = new Uint8Array(rt.size * rt.size * 4);
            gl.bindFramebuffer(gl.FRAMEBUFFER, rt.framebuffer);
            gl.readPixels(0, 0, rt.size, rt.size, gl.RGBA, gl.UNSIGNED_BYTE, data);
            out.push({z: rt.z, x: rt.x, y: rt.y, size: rt.size, data});
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
        return out;
    }
}
