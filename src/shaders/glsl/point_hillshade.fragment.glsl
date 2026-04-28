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

// ── Coverage texture (network coverage mode) ─────────────────────────
uniform sampler2D u_coverageTex;
uniform int u_lightCount;

#define PI 3.141592653589793

// ── Raw derivative decode (uncorrected, for occlusion probes) ──────
vec2 sampleDeriv(vec2 pos) {
    return (texture(u_image, pos).rg * 8.0 - 4.0) * u_exaggeration * 2.0;
}

void main() {
    // ── Latitude-corrected derivatives (same as native hillshade) ────
    float scaleFactor = cos(radians(
        (u_latrange[0] - u_latrange[1]) * (1.0 - v_pos.y) + u_latrange[1]));
    vec4 pixel = texture(u_image, v_pos);
    vec2 rawDeriv = ((pixel.rg * 8.0) - 4.0) / scaleFactor;
    vec2 deriv = rawDeriv * u_exaggeration * 2.0;

    // ── Slope analysis ────────────────────────────────────────────────
    float slope = atan(0.625 * length(deriv));
    float slopeStrength = sin(slope);
    float accentStrength = 1.0 - cos(slope);

    vec3 N = normalize(vec3(-deriv.x, -deriv.y, 1.0));

    // ── Light source selection ───────────────────────────────────────
    vec2 lightCenter;
    vec3 lightColor;
    float falloffRadius;
    float diffuse;
    float coverageAlpha = 1.0;

    // Both single-light (selected node) and multi-light (coverage)
    // use per-light uniforms set by the draw pass.
    lightCenter   = u_lightCenter;
    lightColor    = u_lightColor;
    falloffRadius = u_falloffRadius;
    diffuse       = u_diffuse;

    // ── Point light geometry ─────────────────────────────────────────
    vec2 toLight = lightCenter - v_pos;
    float dist2D = length(toLight);
    vec2 ld = toLight / (dist2D + 0.0001);

    // ── Radial falloff (quadratic ease-out) ──────────────────────────
    float t = clamp(dist2D / falloffRadius, 0.0, 1.0);
    float atten = (1.0 - t) * (1.0 - t);

    // ── Facing: 3D surface–light N·L ─────────────────────────────────
    vec3 L = normalize(vec3(toLight, u_lightHeight));
    float NdotL = max(dot(N, L), 0.0);
    float shade = smoothstep(0.0, 0.45, NdotL);

    // ── Terrain occlusion probes toward the light ─────────────────
    // Near-field (5 probes): detect local ridges and slopes.
    vec2 d1 = sampleDeriv(v_pos + ld * 0.004);
    vec2 d2 = sampleDeriv(v_pos + ld * 0.010);
    vec2 d3 = sampleDeriv(v_pos + ld * 0.025);
    vec2 d4 = sampleDeriv(v_pos + ld * 0.050);
    vec2 d5 = sampleDeriv(v_pos + ld * 0.080);

    float dirOcc = max(dot(d1, ld), 0.0)
                 + max(dot(d2, ld), 0.0) * 0.8
                 + max(dot(d3, ld), 0.0) * 0.6
                 + max(dot(d4, ld), 0.0) * 0.4
                 + max(dot(d5, ld), 0.0) * 0.2;

    // Mid-range probes: detect larger terrain features at 15–40 km scale.
    vec2 d6 = sampleDeriv(v_pos + ld * 0.15);
    vec2 d7 = sampleDeriv(v_pos + ld * 0.25);
    dirOcc += max(dot(d6, ld), 0.0) * 0.35
            + max(dot(d7, ld), 0.0) * 0.25;

    float steepness = (length(d1) + length(d2) + length(d3)
                     + length(d4) + length(d5)) * 0.2;
    float heightBlock = smoothstep(0.3, 1.5, steepness);

    float occ = (1.0 - smoothstep(0.0, 1.0, dirOcc))
              * (1.0 - heightBlock * 0.6);

    // ── Compositing (shared by selected-node and coverage) ──────────
    float highlight = shade * slopeStrength * occ * diffuse;
    float accent    = accentStrength * occ * 0.35;
    float glow      = NdotL * occ * 0.18;
    float raw       = (highlight + accent + glow) * atten;

    float slopeAlpha = slopeStrength * 0.55 + glow * 0.6;
    float alpha = min((slopeAlpha + u_ambient * 0.11) * atten, 0.60);

    fragColor = vec4(lightColor * raw, alpha);
    if (fragColor.a < 0.004) discard;

#ifdef OVERDRAW_INSPECTOR
    fragColor = vec4(1.0);
#endif
}
