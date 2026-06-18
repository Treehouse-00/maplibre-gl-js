uniform sampler2D u_image;
in vec2 v_pos;

uniform vec2 u_latrange;
uniform float u_exaggeration;
uniform vec2 u_lightCenter;
uniform vec3 u_lightColor;
uniform float u_falloffRadius;
uniform float u_lightHeight;
uniform float u_shadowHeight;
uniform float u_diffuse;
uniform float u_ambient;

// Coverage texture (network coverage mode)
uniform sampler2D u_coverageTex;
uniform int u_lightCount;

// Multi-light data: RGBA32F float texture, 3 texels per light.
//   texel 3i   : (mercX, mercY, radiusMerc, heightMerc)
//   texel 3i+1 : (colorR, colorG, colorB, diffuse)
//   texel 3i+2 : (marginD0, _, _, _)
// All values are mercator-space (tile-independent); the draw pass folds
// the per-tile transform into the UBO below.
uniform highp sampler2D u_lightTex;

// Shared per-tile lighting globals (WebGL2 std140 UBO). Bound only on the
// multi-light pass; the single-light (selected-node) path reads the
// individual uniforms above and never touches this block.
//   u_lg0 = (tilesAtZoom, tileOriginX, tileOriginY, exaggeration)
//   u_lg1 = (latRangeLo, latRangeHi, ambient, _pad)
layout(std140) uniform LightGlobals {
    highp vec4 u_lg0;
    highp vec4 u_lg1;
};

#define PI 3.141592653589793
#define MARCH_STEPS 32

// Derivative decode with the hillshade-prepare zoom exaggeration undone, so
// the sightline march reads consistent physical slopes at any DEM zoom.
vec2 sampleDerivZoom(vec2 pos, float exaggeration, float zoomCorrection) {
    return (texture(u_image, pos).rg * 8.0 - 4.0) * zoomCorrection * exaggeration * 2.0;
}

// Invert hillshade-prepare's zoom-dependent vertical exaggeration for a tile
// zoom, so the horizon march is consistent across DEM zoom levels.
float computeZoomCorrection(float zoom) {
    float exaggerationFactor = zoom < 2.0 ? 0.4 : zoom < 4.5 ? 0.35 : 0.3;
    float hillshadeExagg = zoom < 15.0 ? (zoom - 15.0) * exaggerationFactor : 0.0;
    return pow(2.0, -hillshadeExagg);
}

// Slope-integrated horizon march toward a light.  Returns terrain visibility
// in [0,1]: 1 = clear sightline, 0 = blocked by an intervening ridge.  Ported
// from the viewshed-prepare pass: integrate the zoom-normalized derivative
// along the ray to reconstruct the relative rise, track the max horizon angle,
// and shadow the texel when a ridge rises above the line to the node antenna.
// Tile-edge feathered (the march clamps at tile boundaries) and early-outs
// once the texel is unambiguously shadowed.
float marchVisibility(vec2 marchDir, float dist2D, float lightHeight,
                      float exaggeration, float zoomCorrection) {
    // 3 ft AGL (0.9144 m) node antenna -- matches the RF model's RF_DEFAULT_AGL_M.
    // lightHeight encodes 3 m in tile units, so scale to 0.9144 m.
    float shadowHeight = lightHeight * (0.9144 / 3.0);
    float edgeDist = min(min(v_pos.x, 1.0 - v_pos.x), min(v_pos.y, 1.0 - v_pos.y));
    float edgeConfidence = smoothstep(0.0, 0.04, edgeDist);

    float marchLen = min(dist2D, 0.45);
    float stepSize = marchLen / float(MARCH_STEPS);
    float nodeAngle = atan(shadowHeight, max(dist2D, 1e-5));

    float maxHorizon = -PI;
    float accumH = 0.0;
    vec2 prevDeriv = sampleDerivZoom(v_pos, exaggeration, zoomCorrection);
    for (int i = 1; i <= MARCH_STEPS; i++) {
        float marchDist = stepSize * float(i);
        vec2 currDeriv = sampleDerivZoom(v_pos + marchDir * marchDist, exaggeration, zoomCorrection);
        accumH += dot((prevDeriv + currDeriv) * 0.5, marchDir) * stepSize;
        maxHorizon = max(maxHorizon, atan(accumH, marchDist));
        prevDeriv = currDeriv;
        if (maxHorizon > nodeAngle + 0.05) break;   // unambiguously shadowed
    }
    float rawVisibility = smoothstep(-0.008, 0.008, nodeAngle - maxHorizon);
    return mix(1.0, rawVisibility, edgeConfidence);
}

// ── SNR/RSSI spectrum colour ramp ──────────────────────────────────
// MIRROR of SPECTRUM_HEX (frontend/src/components/map/map-geo.ts) and
// SPECTRUM_BREAKPOINTS (shared/lora-radio.ts) -- keep in sync if either
// table moves.  16 colours (red sig-0 -> green sig-15) keyed by the link
// margin (dB) at each breakpoint, so the per-texel RF margin reads green
// (strong) near a node -> red (weak) at the fringe, mesh-agnostic.
const vec3 SPECTRUM[16] = vec3[16](
    vec3(0.945, 0.259, 0.329), vec3(0.965, 0.310, 0.298),
    vec3(0.980, 0.361, 0.267), vec3(0.992, 0.412, 0.239),
    vec3(1.000, 0.486, 0.141), vec3(1.000, 0.565, 0.000),
    vec3(1.000, 0.639, 0.000), vec3(0.980, 0.718, 0.000),
    vec3(0.945, 0.749, 0.000), vec3(0.902, 0.780, 0.000),
    vec3(0.843, 0.816, 0.000), vec3(0.773, 0.851, 0.000),
    vec3(0.694, 0.890, 0.000), vec3(0.580, 0.929, 0.000),
    vec3(0.392, 0.973, 0.039), vec3(0.000, 1.000, 0.251)
);
const float SPECBP[16] = float[16](
    -1.0e30, -6.0, -4.0, -2.0, 0.0, 1.5, 3.0, 4.5,
     6.0, 8.0, 10.0, 12.0, 15.0, 18.0, 21.0, 25.0
);

// Smoothly interpolate the spectrum by link margin (dB).
vec3 spectrumColor(float margin) {
    if (margin < SPECBP[1]) return SPECTRUM[0];
    if (margin >= SPECBP[15]) return SPECTRUM[15];
    for (int i = 1; i < 15; i++) {
        if (margin < SPECBP[i + 1]) {
            float t = (margin - SPECBP[i]) / (SPECBP[i + 1] - SPECBP[i]);
            return mix(SPECTRUM[i], SPECTRUM[i + 1], t);
        }
    }
    return SPECTRUM[15];
}

// Per-texel RF link margin (dB) from a light's d0 margin + the radial
// distance.  lightHeight encodes 3 m AGL in the SAME tile units as dist2D,
// so distM = 3 * dist2D / lightHeight; then
//   margin(distM) = marginD0 - 10*N*log10(max(distM, d0)/d0),  N=3.5, d0=1km.
float rfMargin(float marginD0, float dist2D, float lightHeight) {
    float distM = 3.0 * dist2D / max(lightHeight, 1e-9);
    float decades = log(max(distM, 1000.0) / 1000.0) * 0.4342944819032518;
    return marginD0 - 35.0 * decades;
}

// Per-light terrain-occluded contribution. This is the exact math of the
// original single-light path; the light-independent base (N, slopeStrength,
// accentStrength) is computed once in main() and shared across every light.
vec4 coverageLight(
    highp vec2 lightCenter, vec3 lightColor, highp float falloffRadius,
    highp float lightHeight, float diffuse, float exaggeration, float ambient,
    vec3 N, float slopeStrength, float accentStrength, float marginD0,
    float zoomCorrection
) {
    vec2 toLight = lightCenter - v_pos;
    float dist2D = length(toLight);
    vec2 ld = toLight / (dist2D + 0.0001);

    // Radial falloff (quadratic ease-out)
    float t = clamp(dist2D / falloffRadius, 0.0, 1.0);
    float atten = (1.0 - t) * (1.0 - t);

    // Facing: 3D surface-light N.L
    vec3 L = normalize(vec3(toLight, lightHeight));
    float NdotL = max(dot(N, L), 0.0);
    float shade = smoothstep(0.0, 0.45, NdotL);

    // Raytrace-precise terrain occlusion: a slope-integrated horizon march
    // toward the light, replacing the old 7-probe slope heuristic.  occ is
    // terrain visibility [0,1] -- 1 clear, 0 blocked by an intervening ridge.
    float occ = marchVisibility(ld, dist2D, lightHeight, exaggeration, zoomCorrection);

    // Compositing (shared by selected-node and coverage)
    float highlight = shade * slopeStrength * occ * diffuse;
    float accent    = accentStrength * occ * 0.35;
    float glow      = NdotL * occ * 0.18;
    float raw       = (highlight + accent + glow) * atten;

    float slopeAlpha = slopeStrength * 0.55 + glow * 0.6;
    float alpha = min((slopeAlpha + ambient * 0.11) * atten, 0.60);

    // Headline colour: mesh-agnostic RF margin on the SNR/RSSI spectrum (green
    // strong near the node -> red weak at the fringe).  The selected-node
    // single-light path passes a sentinel marginD0 and keeps lightColor.
    vec3 col = lightColor;
    if (marginD0 > -1.0e29) {
        col = spectrumColor(rfMargin(marginD0, dist2D, lightHeight));
    }
    return vec4(col * raw, alpha);
}

void main() {
    bool multi = u_lightCount > 0;

    // Multi-light reads the shared globals from the UBO; single-light reads
    // the per-draw uniforms. (In single-light mode the UBO is unbound and
    // reads as zero, but the ternaries below never select it.)
    float exaggeration = multi ? u_lg0.w  : u_exaggeration;
    vec2  latrange     = multi ? u_lg1.xy : u_latrange;
    float ambient      = multi ? u_lg1.z  : u_ambient;

    // Latitude-corrected derivatives + slope analysis (light-independent).
    float scaleFactor = cos(radians(
        (latrange[0] - latrange[1]) * (1.0 - v_pos.y) + latrange[1]));
    vec4 pixel = texture(u_image, v_pos);
    vec2 rawDeriv = ((pixel.rg * 8.0) - 4.0) / scaleFactor;
    vec2 deriv = rawDeriv * exaggeration * 2.0;

    float slope = atan(0.625 * length(deriv));
    float slopeStrength = sin(slope);
    float accentStrength = 1.0 - cos(slope);
    vec3 N = normalize(vec3(-deriv.x, -deriv.y, 1.0));

    if (multi) {
        // Single-pass multi-light: loop every light for this tile and
        // composite with max() (channel-wise) -- identical to the old
        // per-light GL_MAX blend, but order-independent and blow-out free.
        highp float tilesAtZoom = u_lg0.x;
        highp vec2  tileOrigin  = u_lg0.yz;
        float zoomCorrection = computeZoomCorrection(log2(tilesAtZoom));
        vec3 accumColor = vec3(0.0);
        float accumAlpha = 0.0;
        for (int i = 0; i < u_lightCount; i++) {
            highp vec4 a = texelFetch(u_lightTex, ivec2(i * 3, 0), 0);
            vec4 b = texelFetch(u_lightTex, ivec2(i * 3 + 1, 0), 0);
            highp vec4 cdata = texelFetch(u_lightTex, ivec2(i * 3 + 2, 0), 0);
            highp vec2 lightCenter = a.xy * tilesAtZoom - tileOrigin;
            highp float falloffRadius = a.z * tilesAtZoom;
            highp float lightHeight = a.w * tilesAtZoom;
            vec4 contrib = coverageLight(lightCenter, b.rgb, falloffRadius,
                lightHeight, b.a, exaggeration, ambient,
                N, slopeStrength, accentStrength, cdata.x, zoomCorrection);
            accumColor = max(accumColor, contrib.rgb);
            accumAlpha = max(accumAlpha, contrib.a);
        }
        fragColor = vec4(accumColor, accumAlpha);
    } else {
        // Single-light (selected-node localized light) -- keeps its own colour
        // (sentinel marginD0 disables the spectrum map).  zoomCorrection 1.0:
        // the focused single-light view doesn't plumb the tile zoom.
        fragColor = coverageLight(u_lightCenter, u_lightColor, u_falloffRadius,
            u_lightHeight, u_diffuse, exaggeration, ambient,
            N, slopeStrength, accentStrength, -1.0e30, 1.0);
    }

    if (fragColor.a < 0.004) discard;

#ifdef OVERDRAW_INSPECTOR
    fragColor = vec4(1.0);
#endif
}
