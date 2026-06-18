// Coverage composite (per-frame, cheap) -- the SHADING half of the deferred
// pipeline.  The prepare pass baked a DATA field into u_coverageTex (one cached
// RGBA RT per tile): R = margin01 (link margin, normalised over RAMP_LO..RAMP_HI),
// G = presence (range x LOS x reach), B = serverId (reserved), A = reserved.
// Here we OWN the look: reconstruct the margin, map it onto the RF composite
// heatmap, and premultiply by presence x opacity, then alpha-blend over the
// basemap (ColorMode.alphaBlended) as one cohesive translucent layer.  The
// per-frame cost is one texture read + a LUT, no raymarch.  Because the look
// lives here -- not in the bake -- the ramp/contours/mesh tint are all
// art-directable with NO physics re-bake.
uniform sampler2D u_coverageTex;
uniform float u_surfaceOpacity;
// Sub-rect (offsetX, offsetY, scale) of u_coverageTex this tile samples.
// (0,0,1) for the tile's own RT; for an ANCESTOR fallback RT (its own coverage
// hasn't baked yet -- DEM still loading) it picks the tile's sub-rect of the
// coarser ancestor so coverage shows through instead of a hole.
uniform vec3 u_coverageUV;
// Confidence controls -- RENDER-ONLY (no re-bake):
//   u_shadowSigma   log-normal shadowing std-dev (dB); the confidence knob.
//   u_coverageView  0 = signal heatmap (confidence as translucency),
//                   1 = confidence recolor (reliability ramp).
uniform float u_shadowSigma;
uniform int u_coverageView;

in vec2 v_pos;

// Margin encode window -- MUST match RAMP_LO/RAMP_HI in the prepare shader.
const float RAMP_LO = -10.0;
const float RAMP_HI = 64.0;

// ── RF incandescent heatmap (weak → strong) -- tunable anchor stops ────────
// A blackbody-style signal-strength scale that keeps BRIGHTENING toward the hot
// terminus: deep RED at the weak fringe → orange → amber → gold → yellow → pale
// yellow → WHITE-HOT at the strongest core, so dense/overlapping strong signals
// read as a smooth brighten-to-white instead of a flat saturated mass.  Stops
// are evenly spaced over t = (margin - HEAT_LO) / (HEAT_HI - HEAT_LO); blended in
// LINEAR light (the col*col / sqrt pair) so the gradient stays smooth.
const int HEAT_N = 9;
const vec3 HEAT[9] = vec3[9](
    vec3(0.62, 0.07, 0.08),  // 0.000 weak fringe   deep red    #9E1215
    vec3(0.80, 0.13, 0.125), // 0.125              red         #CC2120
    vec3(0.90, 0.25, 0.125), // 0.250              red-orange  #E64020
    vec3(0.957,0.42, 0.129), // 0.375              orange      #F46B21
    vec3(0.992,0.60, 0.149), // 0.500              amber       #FD9926
    vec3(1.00, 0.76, 0.20),  // 0.625              gold        #FFC233
    vec3(1.00, 0.90, 0.36),  // 0.750              yellow      #FFE65C
    vec3(1.00, 0.969,0.72),  // 0.875              pale yellow #FFF7B8
    vec3(1.00, 1.00, 0.969)  // 1.000 strong core  white-hot   #FFFFF7
);
// Margin (dB) mapped to the heatmap ends: HEAT_LO = the red fringe, HEAT_HI =
// the white-hot core.  Spans most of the (now -10..64 dB) encode window so the
// strong-signal range gets real gradation instead of clipping to one colour.
const float HEAT_LO = -6.0;
const float HEAT_HI = 60.0;

vec3 heatColor(float margin) {
    float t = clamp((margin - HEAT_LO) / (HEAT_HI - HEAT_LO), 0.0, 1.0);
    float f = t * float(HEAT_N - 1);
    int i = min(int(floor(f)), HEAT_N - 2);
    float w = smoothstep(0.0, 1.0, f - float(i));   // ease each segment
    vec3 a = HEAT[i] * HEAT[i];                      // sRGB -> ~linear
    vec3 b = HEAT[i + 1] * HEAT[i + 1];
    return sqrt(mix(a, b, w));                       // ~linear -> sRGB
}

// ── Confidence (reliability) recolor + %-reliability contours ──────────────
// A COOL perceptual ramp (viridis-like) for the confidence view, distinct from
// the incandescent signal heatmap so reliability reads on its own axis: dark
// purple = unreliable (coin-flip), yellow = near-certain.
const int REL_N = 5;
const vec3 REL[5] = vec3[5](
    vec3(0.267, 0.005, 0.329),  // 0.00  #440154 dark purple
    vec3(0.231, 0.322, 0.545),  // 0.25  #3b528b blue
    vec3(0.129, 0.567, 0.551),  // 0.50  #21918c teal
    vec3(0.369, 0.788, 0.384),  // 0.75  #5ec962 green
    vec3(0.992, 0.906, 0.145)   // 1.00  #fde725 yellow
);
vec3 reliabilityColor(float p) {
    float t = clamp(p, 0.0, 1.0);
    float f = t * float(REL_N - 1);
    int i = min(int(floor(f)), REL_N - 2);
    float w = smoothstep(0.0, 1.0, f - float(i));
    vec3 a = REL[i] * REL[i];
    vec3 b = REL[i + 1] * REL[i + 1];
    return sqrt(mix(a, b, w));
}

// ── Best-server categorical palette (ui-kit Prismatic wheel) ───────────────
// MIRROR of WHEEL[].base in frontend/src/components/map/meshPalette.ts (the
// saturated `-500` mid-tones).  The best-server view colours each covered pixel
// by WHICH node serves it: the bake writes the winning node's wheel slot into
// the tile B channel (1..16; 0 = uncovered) and we look its hue up here.  Keep
// these in lockstep with meshPalette.ts AND the CoverageLegend swatches.
const int WHEEL_N = 16;
const vec3 WHEEL[16] = vec3[16](
    vec3(0.749, 0.000, 0.188), // #bf0030 red
    vec3(0.329, 0.459, 0.333), // #547555 green
    vec3(0.522, 0.161, 0.384), // #852962 redpurple
    vec3(0.659, 0.678, 0.122), // #a8ad1f greenyellow
    vec3(0.243, 0.243, 0.588), // #3e3e96 bluepurple
    vec3(0.859, 0.525, 0.000), // #db8600 orangeyellow
    vec3(0.000, 0.357, 0.541), // #005b8a blue
    vec3(0.749, 0.184, 0.008), // #bf2f02 orange
    vec3(0.227, 0.424, 0.337), // #3a6c56 bluegreen
    vec3(0.675, 0.000, 0.243), // #ac003e purplered
    vec3(0.494, 0.537, 0.224), // #7e8939 yellowgreen
    vec3(0.388, 0.220, 0.576), // #633893 purple
    vec3(0.812, 0.596, 0.000), // #cf9800 yellow
    vec3(0.110, 0.259, 0.584), // #1c4295 purpleblue
    vec3(0.894, 0.455, 0.000), // #e47400 yelloworange
    vec3(0.000, 0.427, 0.545)  // #006d8b greenblue
);
// Tile B byte → wheel hue.  B encodes the winning node's slot (1..16); 0 = no
// server (gated out by presence anyway).  Wrap past 16 so extra servers reuse
// hues (matches meshPalette's modulo slot assignment).
vec3 serverColor(float bChannel) {
    int slot = int(floor(bChannel * 255.0 + 0.5)) - 1;
    if (slot < 0) slot = 0;
    return WHEEL[slot % WHEEL_N];
}

// Sub-LSB hash dither (0..1) keyed on the pixel: breaks up the 8-bit margin
// quantization when the z13 field is overzoomed (magnified) past its native
// resolution, so the ramp reads smooth instead of banding.  Applied to colour
// only -- never to pCov or the contour tests.
float ditherHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// Antialiased isoline mask: ~1 on the `level` contour of `value`, fading over
// one screen-space pixel of `value` (fwidth) so the ring stays hairline at any
// zoom.
float contourMask(float value, float level) {
    float aa = max(fwidth(value) * 1.5, 1e-5);
    return 1.0 - smoothstep(0.0, aa, abs(value - level));
}

void main() {
    vec4 fld = texture(u_coverageTex, u_coverageUV.xy + v_pos * u_coverageUV.z);
    float presence = fld.g;

    // Reconstruct the link margin (dB) the prepare pass encoded.
    float margin = RAMP_LO + fld.r * (RAMP_HI - RAMP_LO);
    // Overzoom anti-banding: a sub-LSB hash dither on the margin used ONLY for
    // colour (NOT pCov or contours), so the magnified 8-bit field reads smooth
    // past z13 instead of stepping.  Amplitude = +/-0.5 of one R quant step.
    float marginColor = margin + (ditherHash(gl_FragCoord.xy) - 0.5) * (RAMP_HI - RAMP_LO) / 255.0;

    // Probability of coverage from log-normal shadowing: P = Phi(margin / sigma)
    // (logistic approx of the normal CDF, mirror of rfProbabilityOfCoverage()).
    // The margin is a MEDIAN estimate; real signals scatter ~sigma dB around it,
    // so a thin positive margin is a coin-flip, not a promise.  sigma is a live
    // render uniform (the confidence knob) -- no re-bake.
    float sigma = max(u_shadowSigma, 0.5);
    float pCov = 1.0 / (1.0 + exp(-1.702 * margin / sigma));

    vec3 col;
    float alpha;
    if (u_coverageView == 1) {
        // CONFIDENCE view: recolor by reliability on the cool ramp; reliability
        // lives in the HUE, so alpha is just presence x opacity (don't also fade
        // by pCov, or low-reliability coverage would vanish).
        col = reliabilityColor(pCov);
        alpha = presence * u_surfaceOpacity;
    } else if (u_coverageView == 2) {
        // BEST-SERVER view: colour by WHICH node serves this pixel (tile B =
        // wheel slot).  Link margin drives brightness so strong-served ground
        // reads brighter, and confidence still rides translucency like the
        // signal view so the views stay visually comparable.
        float tHot = clamp((marginColor - HEAT_LO) / (HEAT_HI - HEAT_LO), 0.0, 1.0);
        col = serverColor(fld.b) * mix(0.5, 1.15, tHot);
        alpha = presence * mix(0.12, 1.0, pCov) * u_surfaceOpacity;
    } else {
        // SIGNAL view (default): incandescent heatmap, confidence as TRANSLUCENCY
        // alone -- faint where unsure, solid where not -- so the hues stay pure.
        col = heatColor(marginColor);
        // Incandescent bloom: past mid-strength the core keeps brightening toward
        // white so dense / overlapping strong signals read as brighten-to-terminus.
        float tHot = clamp((marginColor - HEAT_LO) / (HEAT_HI - HEAT_LO), 0.0, 1.0);
        col *= 1.0 + 0.30 * smoothstep(0.5, 1.0, tHot);
        alpha = presence * mix(0.12, 1.0, pCov) * u_surfaceOpacity;
    }

    // Coverage contours (SPLAT-style rings), gated to covered pixels so empty
    // ground stays clean.  Antialiased via the screen-space derivative of the
    // contoured field (fwidth in contourMask), so they stay hairline at any zoom.
    //   SIGNAL view     → crisp isolines at fixed link-margin dB thresholds
    //                     (+20 / +10 / 0 / -6 dB): the SPLAT coverage rings, with
    //                     0 dB marking the usable-coverage edge.
    //   CONFIDENCE view → %-reliability rings where pCov crosses 50% / 90%
    //                     (the SPLAT .plo/.lcf analog).
    float covered = step(0.01, presence);
    float contour = 0.0;
    if (u_coverageView == 1) {
        contour = max(contourMask(pCov, 0.5), contourMask(pCov, 0.9));
    } else if (u_coverageView == 0) {
        contour = max(
            max(contourMask(margin, 20.0), contourMask(margin, 10.0)),
            max(contourMask(margin, 0.0), contourMask(margin, -6.0))
        );
    }
    // (best-server view draws no isolines -- the hue regions ARE the read.)
    contour *= covered;
    col = mix(col, vec3(1.0), contour * 0.85);
    alpha = max(alpha, contour * 0.9 * u_surfaceOpacity);

    if (alpha < 0.004) discard;

    // Premultiplied so the [ONE, 1-srcA] blend composites it correctly.
    fragColor = vec4(col * alpha, alpha);

#ifdef OVERDRAW_INSPECTOR
    fragColor = vec4(1.0);
#endif
}
