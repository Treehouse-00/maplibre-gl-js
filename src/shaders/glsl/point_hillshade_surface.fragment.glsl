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
        // Coverage surface: same as single-light, GL_MAX composited.
        lightCenter   = u_lightCenter;
        lightColor    = u_lightColor;
        falloffRadius = u_falloffRadius;
        diffuse       = u_diffuse;

        vec2 toLight = lightCenter - v_pos;
        float dist2D = length(toLight);
        float t2   = clamp(dist2D / falloffRadius, 0.0, 1.0);
        float att2 = (1.0 - t2) * (1.0 - t2);
        vec2 dv = (texture(u_image, v_pos).rg * 8.0 - 4.0) * u_exaggeration * 2.0;
        vec3 Ns = normalize(vec3(-dv.x, -dv.y, 1.0));
        vec3 Ls = normalize(vec3(toLight, u_lightHeight));
        float nl = max(dot(Ns, Ls), 0.0);
        nl = nl * nl * nl;
        float si = nl * diffuse * att2;
        float sa = si * u_surfaceOpacity;
        fragColor = vec4(lightColor * si, sa);
        if (sa < 0.008) discard;
    } else {
        // Single-light mode: full terrain surface computation
        lightCenter   = u_lightCenter;
        lightColor    = u_lightColor;
        falloffRadius = u_falloffRadius;
        diffuse       = u_diffuse;

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
        fragColor = vec4(lightColor * intensity, alpha);
        if (fragColor.a < 0.008) discard;
    }

#ifdef OVERDRAW_INSPECTOR
    fragColor = vec4(1.0);
#endif
}
