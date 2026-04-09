// ── Surface Coverage Render Pass ─────────────────────────────────────
// Terrain-aware surface tint using NdotL facing + radial falloff.
// No sightline march — occlusion is handled by the terrain detail pass.

uniform sampler2D u_image;
in vec2 v_pos;

uniform float u_exaggeration;
uniform vec2 u_lightCenter;
uniform vec3 u_lightColor;
uniform float u_falloffRadius;
uniform float u_lightHeight;
uniform float u_diffuse;
uniform float u_surfaceOpacity;

// ── Coverage texture (network coverage mode) ─────────────────────────
uniform sampler2D u_coverageTex;
uniform int u_lightCount;

void main() {
    // ── Light source selection ───────────────────────────────────────
    vec2 lightCenter;
    vec3 lightColor;
    float falloffRadius;
    float diffuse;
    float coverageAlpha = 1.0;

    if (u_lightCount > 0) {
        // Network coverage mode: read pre-composited coverage texture
        vec4 cov = texture(u_coverageTex, v_pos);
        if (cov.a < 0.001) discard;
        lightColor    = cov.rgb / cov.a;
        coverageAlpha = cov.a;
        lightCenter   = v_pos;
        falloffRadius = 999.0;
        diffuse       = u_diffuse;
    } else {
        // Single-light mode: use paint property uniforms
        lightCenter   = u_lightCenter;
        lightColor    = u_lightColor;
        falloffRadius = u_falloffRadius;
        diffuse       = u_diffuse;
    }

    vec2 toLight = lightCenter - v_pos;
    float dist2D = length(toLight);

    float t    = clamp(dist2D / falloffRadius, 0.0, 1.0);
    float atten = (1.0 - t) * (1.0 - t);

    vec2 deriv = (texture(u_image, v_pos).rg * 8.0 - 4.0) * u_exaggeration * 2.0;
    vec3 N = normalize(vec3(-deriv.x, -deriv.y, 1.0));
    vec3 L = normalize(vec3(toLight, u_lightHeight));
    float NdotL = max(dot(N, L), 0.0);
    NdotL = NdotL * NdotL * NdotL;

    float intensity = NdotL * diffuse * atten;
    float alpha     = intensity * u_surfaceOpacity;

    // Scale by coverage alpha in network mode
    if (u_lightCount > 0) {
        intensity *= coverageAlpha;
        alpha     *= coverageAlpha;
    }

    fragColor = vec4(lightColor * intensity, alpha);

#ifdef OVERDRAW_INSPECTOR
    fragColor = vec4(1.0);
#endif
}
