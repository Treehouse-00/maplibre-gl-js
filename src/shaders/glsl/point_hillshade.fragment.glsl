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

// Multi-light data: RGBA32F float texture, 2 texels per light.
//   texel 2i   : (mercX, mercY, radiusMerc, heightMerc)
//   texel 2i+1 : (colorR, colorG, colorB, diffuse)
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

// Raw derivative decode (uncorrected, for occlusion probes).
vec2 sampleDeriv(vec2 pos, float exaggeration) {
    return (texture(u_image, pos).rg * 8.0 - 4.0) * exaggeration * 2.0;
}

// Per-light terrain-occluded contribution. This is the exact math of the
// original single-light path; the light-independent base (N, slopeStrength,
// accentStrength) is computed once in main() and shared across every light.
vec4 coverageLight(
    highp vec2 lightCenter, vec3 lightColor, highp float falloffRadius,
    highp float lightHeight, float diffuse, float exaggeration, float ambient,
    vec3 N, float slopeStrength, float accentStrength
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

    // Terrain occlusion probes toward the light.
    // Near-field (5 probes): local ridges and slopes.
    vec2 d1 = sampleDeriv(v_pos + ld * 0.004, exaggeration);
    vec2 d2 = sampleDeriv(v_pos + ld * 0.010, exaggeration);
    vec2 d3 = sampleDeriv(v_pos + ld * 0.025, exaggeration);
    vec2 d4 = sampleDeriv(v_pos + ld * 0.050, exaggeration);
    vec2 d5 = sampleDeriv(v_pos + ld * 0.080, exaggeration);

    float dirOcc = max(dot(d1, ld), 0.0)
                 + max(dot(d2, ld), 0.0) * 0.8
                 + max(dot(d3, ld), 0.0) * 0.6
                 + max(dot(d4, ld), 0.0) * 0.4
                 + max(dot(d5, ld), 0.0) * 0.2;

    // Mid-range probes: larger terrain features at 15-40 km scale.
    vec2 d6 = sampleDeriv(v_pos + ld * 0.15, exaggeration);
    vec2 d7 = sampleDeriv(v_pos + ld * 0.25, exaggeration);
    dirOcc += max(dot(d6, ld), 0.0) * 0.35
            + max(dot(d7, ld), 0.0) * 0.25;

    float steepness = (length(d1) + length(d2) + length(d3)
                     + length(d4) + length(d5)) * 0.2;
    float heightBlock = smoothstep(0.3, 1.5, steepness);

    float occ = (1.0 - smoothstep(0.0, 1.0, dirOcc))
              * (1.0 - heightBlock * 0.6);

    // Compositing (shared by selected-node and coverage)
    float highlight = shade * slopeStrength * occ * diffuse;
    float accent    = accentStrength * occ * 0.35;
    float glow      = NdotL * occ * 0.18;
    float raw       = (highlight + accent + glow) * atten;

    float slopeAlpha = slopeStrength * 0.55 + glow * 0.6;
    float alpha = min((slopeAlpha + ambient * 0.11) * atten, 0.60);

    return vec4(lightColor * raw, alpha);
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
        vec3 accumColor = vec3(0.0);
        float accumAlpha = 0.0;
        for (int i = 0; i < u_lightCount; i++) {
            highp vec4 a = texelFetch(u_lightTex, ivec2(i * 2, 0), 0);
            vec4 b = texelFetch(u_lightTex, ivec2(i * 2 + 1, 0), 0);
            highp vec2 lightCenter = a.xy * tilesAtZoom - tileOrigin;
            highp float falloffRadius = a.z * tilesAtZoom;
            highp float lightHeight = a.w * tilesAtZoom;
            vec4 c = coverageLight(lightCenter, b.rgb, falloffRadius,
                lightHeight, b.a, exaggeration, ambient,
                N, slopeStrength, accentStrength);
            accumColor = max(accumColor, c.rgb);
            accumAlpha = max(accumAlpha, c.a);
        }
        fragColor = vec4(accumColor, accumAlpha);
    } else {
        // Single-light (selected-node localized light) -- unchanged.
        fragColor = coverageLight(u_lightCenter, u_lightColor, u_falloffRadius,
            u_lightHeight, u_diffuse, exaggeration, ambient,
            N, slopeStrength, accentStrength);
    }

    if (fragColor.a < 0.004) discard;

#ifdef OVERDRAW_INSPECTOR
    fragColor = vec4(1.0);
#endif
}
