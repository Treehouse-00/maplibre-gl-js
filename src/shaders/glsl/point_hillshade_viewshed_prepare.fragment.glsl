// ── Viewshed Prepare ─────────────────────────────────────────────
// Runs ONCE per DEM tile in the offscreen pass.  For every texel,
// traces a sightline toward the node using the hillshade-prepare
// derivative texture and outputs a smooth visibility value [0, 1].
//
// Key: derivatives are ZOOM-NORMALIZED to remove the hillshade-prepare
// exaggeration factor, producing consistent results at every zoom level.

uniform sampler2D u_image;        // derivative texture (from hillshade prepare)
in vec2 v_pos;

uniform vec2 u_latrange;
uniform float u_exaggeration;
uniform vec2 u_lightCenter;       // node position in tile-relative [0,1]
uniform float u_falloffRadius;    // coverage radius in tile-relative units
uniform float u_shadowHeight;     // virtual sightline height in tile-relative units
uniform float u_zoom;             // DEM tile zoom level

#define PI 3.141592653589793
#define NUM_STEPS 96

// Decode derivatives from the hillshade-prepare texture and UNDO the
// zoom-dependent vertical exaggeration that hillshade-prepare bakes in.
// This makes the sightline analysis produce identical results regardless
// of which DEM tile zoom level is loaded.
vec2 sampleDeriv(vec2 pos, float zoomCorrection) {
    vec2 raw = texture(u_image, pos).rg * 8.0 - 4.0;
    return raw * zoomCorrection * u_exaggeration * 2.0;
}

void main() {
    vec2 toLight  = u_lightCenter - v_pos;
    float dist2D  = length(toLight);
    vec2 marchDir = toLight / (dist2D + 1e-6);

    // ── Early out: outside coverage radius ────────────────────────
    float t = dist2D / u_falloffRadius;
    if (t > 1.0) {
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    // ── Undo hillshade-prepare zoom-dependent exaggeration ───────────
    // hillshade-prepare multiplies derivatives by pow(2, -exagg) where
    // exagg = (zoom - 15) * factor for zoom < 15, else 0.
    // We invert this to get physical slopes independent of tile zoom.
    float exaggerationFactor = u_zoom < 2.0 ? 0.4 : u_zoom < 4.5 ? 0.35 : 0.3;
    float hillshadeExagg = u_zoom < 15.0 ? (u_zoom - 15.0) * exaggerationFactor : 0.0;
    float zoomCorrection = pow(2.0, -hillshadeExagg);

    // ── Tile-edge confidence ───────────────────────────────────────
    // Near tile boundaries the march probes sample clamped/repeated
    // edge derivatives.  Feather the viewshed toward 1.0 (unoccluded)
    // at edges so adjacent tiles blend seamlessly via the neutral value.
    float edgeDist = min(min(v_pos.x, 1.0 - v_pos.x), min(v_pos.y, 1.0 - v_pos.y));
    float edgeConfidence = smoothstep(0.0, 0.04, edgeDist);

    // ── Sightline march ──────────────────────────────────────────
    float marchLen = min(dist2D, 0.45);
    float stepSize = marchLen / float(NUM_STEPS);

    float maxHorizon = -PI;
    float accumH     =  0.0;
    vec2  prevDeriv  = sampleDeriv(v_pos, zoomCorrection);

    for (int i = 1; i <= NUM_STEPS; i++) {
        float marchDist = stepSize * float(i);
        vec2 samplePos  = v_pos + marchDir * marchDist;
        vec2 currDeriv  = sampleDeriv(samplePos, zoomCorrection);

        float slopeContrib = dot((prevDeriv + currDeriv) * 0.5, marchDir);
        accumH += slopeContrib * stepSize;

        float horizAngle = atan(accumH, marchDist);
        maxHorizon = max(maxHorizon, horizAngle);

        prevDeriv = currDeriv;
    }

    // ── Visibility ─────────────────────────────────────────────
    float nodeAngle = atan(u_shadowHeight, max(dist2D, 1e-5));
    float rawVisibility = smoothstep(-0.008, 0.008, nodeAngle - maxHorizon);

    // Blend toward unoccluded at tile edges to eliminate seams.
    float visibility = mix(1.0, rawVisibility, edgeConfidence);

    fragColor = vec4(visibility, visibility, visibility, 1.0);
}
