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

// Multi-light data: RGBA32F float texture, 2 texels per light.
//   texel 2i   : (mercX, mercY, radiusMerc, heightMerc)
//   texel 2i+1 : (colorR, colorG, colorB, diffuse)
uniform highp sampler2D u_lightTex;

// Shared per-tile lighting globals (WebGL2 std140 UBO), multi-light only.
//   u_lg0 = (tilesAtZoom, tileOriginX, tileOriginY, exaggeration)
//   u_lg1 = (latRangeLo, latRangeHi, ambient, _pad)
layout(std140) uniform LightGlobals {
    highp vec4 u_lg0;
    highp vec4 u_lg1;
};

// Per-light surface tint. Exact math of the original surface pass; the
// light-independent surface normal Ns is computed once in main().
vec4 surfaceLight(
    highp vec2 lightCenter, vec3 lightColor, highp float falloffRadius,
    highp float lightHeight, float diffuse, vec3 Ns
) {
    vec2 toLight = lightCenter - v_pos;
    float dist2D = length(toLight);
    float t = clamp(dist2D / falloffRadius, 0.0, 1.0);
    float atten = (1.0 - t) * (1.0 - t);
    vec3 L = normalize(vec3(toLight, lightHeight));
    float nl = max(dot(Ns, L), 0.0);
    nl = nl * nl * nl;
    float si = nl * diffuse * atten;
    float sa = si * u_surfaceOpacity;
    return vec4(lightColor * si, sa);
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
        vec3 accumColor = vec3(0.0);
        float accumAlpha = 0.0;
        for (int i = 0; i < u_lightCount; i++) {
            highp vec4 a = texelFetch(u_lightTex, ivec2(i * 2, 0), 0);
            vec4 b = texelFetch(u_lightTex, ivec2(i * 2 + 1, 0), 0);
            highp vec2 lightCenter = a.xy * tilesAtZoom - tileOrigin;
            highp float falloffRadius = a.z * tilesAtZoom;
            highp float lightHeight = a.w * tilesAtZoom;
            vec4 c = surfaceLight(lightCenter, b.rgb, falloffRadius,
                lightHeight, b.a, Ns);
            accumColor = max(accumColor, c.rgb);
            accumAlpha = max(accumAlpha, c.a);
        }
        fragColor = vec4(accumColor, accumAlpha);
        if (fragColor.a < 0.008) discard;
    } else {
        // Single-light mode -- unchanged.
        fragColor = surfaceLight(u_lightCenter, u_lightColor, u_falloffRadius,
            u_lightHeight, u_diffuse, Ns);
        if (fragColor.a < 0.008) discard;
    }

#ifdef OVERDRAW_INSPECTOR
    fragColor = vec4(1.0);
#endif
}
