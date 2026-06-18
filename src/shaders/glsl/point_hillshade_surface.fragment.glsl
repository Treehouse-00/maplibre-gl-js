// Surface Coverage Render Pass
// Terrain-aware surface tint using NdotL facing + radial falloff.
// No sightline march -- occlusion is handled by the terrain detail pass.

uniform sampler2D u_image;
in vec2 v_pos;

uniform float u_exaggeration;
uniform vec2 u_lightCenter;
uniform vec3 u_lightColor;
uniform float u_falloffRadius;
uniform float u_lightHeight;
uniform float u_diffuse;
uniform float u_surfaceOpacity;

// Coverage texture (network coverage mode)
uniform sampler2D u_coverageTex;
uniform int u_lightCount;

// Multi-light data: RGBA32F float texture, 3 texels per light.
//   texel 3i   : (mercX, mercY, radiusMerc, heightMerc)
//   texel 3i+1 : (colorR, colorG, colorB, diffuse)
//   texel 3i+2 : (marginD0, _, _, _)
uniform highp sampler2D u_lightTex;

// Shared per-tile lighting globals (WebGL2 std140 UBO), multi-light only.
//   u_lg0 = (tilesAtZoom, tileOriginX, tileOriginY, exaggeration)
//   u_lg1 = (latRangeLo, latRangeHi, ambient, _pad)
layout(std140) uniform LightGlobals {
    highp vec4 u_lg0;
    highp vec4 u_lg1;
};

// ── SNR/RSSI spectrum colour ramp ──────────────────────────────────
// MIRROR of SPECTRUM_HEX (frontend/src/components/map/map-geo.ts) and
// SPECTRUM_BREAKPOINTS (shared/lora-radio.ts) -- keep in sync if either
// table moves.  Identical to the terrain-detail pass so the surface glow
// and the detail composite the SAME RF-margin colour under GL_MAX.
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

// distM = 3 * dist2D / lightHeight (lightHeight encodes 3 m AGL in tile units);
// margin(distM) = marginD0 - 10*N*log10(max(distM, d0)/d0),  N=3.5, d0=1km.
float rfMargin(float marginD0, float dist2D, float lightHeight) {
    float distM = 3.0 * dist2D / max(lightHeight, 1e-9);
    float decades = log(max(distM, 1000.0) / 1000.0) * 0.4342944819032518;
    return marginD0 - 35.0 * decades;
}

#define PI 3.141592653589793
#define MARCH_STEPS 32

// Terrain occlusion march helpers -- IDENTICAL to point_hillshade.fragment.glsl
// so the surface glow and the detail pass shadow the same way under GL_MAX.
vec2 sampleDerivZoom(vec2 pos, float exaggeration, float zoomCorrection) {
    return (texture(u_image, pos).rg * 8.0 - 4.0) * zoomCorrection * exaggeration * 2.0;
}

float computeZoomCorrection(float zoom) {
    float exaggerationFactor = zoom < 2.0 ? 0.4 : zoom < 4.5 ? 0.35 : 0.3;
    float hillshadeExagg = zoom < 15.0 ? (zoom - 15.0) * exaggerationFactor : 0.0;
    return pow(2.0, -hillshadeExagg);
}

// Slope-integrated horizon march toward a light -> terrain visibility [0,1].
float marchVisibility(vec2 marchDir, float dist2D, float lightHeight,
                      float exaggeration, float zoomCorrection) {
    // 3 ft AGL (0.9144 m) node antenna -- matches RF_DEFAULT_AGL_M.
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
        if (maxHorizon > nodeAngle + 0.05) break;
    }
    float rawVisibility = smoothstep(-0.008, 0.008, nodeAngle - maxHorizon);
    return mix(1.0, rawVisibility, edgeConfidence);
}

// Per-light surface tint. The light-independent surface normal Ns is computed
// once in main(); the horizon march shadows the glow behind ridges.
vec4 surfaceLight(
    highp vec2 lightCenter, vec3 lightColor, highp float falloffRadius,
    highp float lightHeight, float diffuse, vec3 Ns, float marginD0,
    float exaggeration, float zoomCorrection
) {
    vec2 toLight = lightCenter - v_pos;
    float dist2D = length(toLight);
    vec2 marchDir = toLight / (dist2D + 1e-6);
    float t = clamp(dist2D / falloffRadius, 0.0, 1.0);
    float atten = (1.0 - t) * (1.0 - t);
    vec3 L = normalize(vec3(toLight, lightHeight));
    float nl = max(dot(Ns, L), 0.0);
    nl = nl * nl * nl;
    // Terrain occlusion: shadow the surface glow behind ridges so the GL_MAX
    // composite with the detail pass doesn't fill the shadows back in.
    float occ = marchVisibility(marchDir, dist2D, lightHeight, exaggeration, zoomCorrection);
    float si = nl * diffuse * atten * occ;
    float sa = si * u_surfaceOpacity;
    // Headline colour: mesh-agnostic RF margin on the SNR/RSSI spectrum.
    vec3 col = lightColor;
    if (marginD0 > -1.0e29) {
        col = spectrumColor(rfMargin(marginD0, dist2D, lightHeight));
    }
    return vec4(col * si, sa);
}

void main() {
    bool multi = u_lightCount > 0;
    float exaggeration = multi ? u_lg0.w : u_exaggeration;

    // Surface normal (light-independent) -- computed once, shared.
    vec2 dv = (texture(u_image, v_pos).rg * 8.0 - 4.0) * exaggeration * 2.0;
    vec3 Ns = normalize(vec3(-dv.x, -dv.y, 1.0));

    if (multi) {
        // Single-pass multi-light: loop every light, max-composite
        // (channel-wise) -- identical to the old per-light GL_MAX blend.
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
            vec4 contrib = surfaceLight(lightCenter, b.rgb, falloffRadius,
                lightHeight, b.a, Ns, cdata.x, exaggeration, zoomCorrection);
            accumColor = max(accumColor, contrib.rgb);
            accumAlpha = max(accumAlpha, contrib.a);
        }
        fragColor = vec4(accumColor, accumAlpha);
        if (fragColor.a < 0.008) discard;
    } else {
        // Single-light mode -- keeps its own colour (sentinel marginD0),
        // zoomCorrection 1.0 (focused view doesn't plumb the tile zoom).
        fragColor = surfaceLight(u_lightCenter, u_lightColor, u_falloffRadius,
            u_lightHeight, u_diffuse, Ns, -1.0e30, exaggeration, 1.0);
        if (fragColor.a < 0.008) discard;
    }

#ifdef OVERDRAW_INSPECTOR
    fragColor = vec4(1.0);
#endif
}
