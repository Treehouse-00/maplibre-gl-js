// ── Coverage Prepare (offscreen, cached) — per-node RF, raytraced ──────────
//
// Runs ONCE per tile per lights-generation into a cached RGBA RT.  For every
// texel it loops the tile's culled lights and asks a PHYSICAL question per
// node:  does this ground point receive that node's signal?
//
//   covered  iff  the link MARGIN -- after a physical terrain DIFFRACTION loss
//                 -- is above the usable floor (in range AND not shadowed out).
//
// The field's COLOUR is the link margin on the SNR/RSSI spectrum; its presence
// is the soft range roll-off.  There is deliberately NO surface-facing (N·L)
// term: this is a draped RF field, not a lit surface.  Terrain occlusion is a
// knife-edge DIFFRACTION loss folded into the margin (not a binary LOS test),
// so a ridge attenuates progressively and a blocked path still leaks a weak
// diffracted signal -- terrain reads through the shadows the way real coverage
// does.  Lights composite per texel with max ("best server").
//
// Renders over an ortho quad (point_hillshade_coverage_prepare.vertex), so
// v_pos is the tile-relative [0,1] position; per-tile globals ride the UBO.

uniform sampler2D u_image;        // RAW DEM (terrarium-encoded absolute elevation)
// Wide-area FIXED-RESOLUTION DEM overview (R32F, absolute elevation in METRES,
// already decoded -- NO terrarium unpack).  Sampled in mercator space so the
// march is continuous across tile boundaries and resolution-stable at any
// display zoom.  Only consulted when u_lg5.x (hasOverview) is set.
uniform highp sampler2D u_overviewTex;
in vec2 v_pos;

// Multi-light data: RGBA32F float texture, 3 texels per light.
//   texel 3i   : (mercX, mercY, radiusMerc, heightMerc)
//   texel 3i+1 : (colorR, colorG, colorB, diffuse)   [unused here]
//   texel 3i+2 : (marginD0, nodeGroundElev, _, _)
uniform highp sampler2D u_lightTex;
uniform int u_lightCount;

// Shared per-tile globals (WebGL2 std140 UBO).
//   u_lg0 = (tilesAtZoom, tileOriginX, tileOriginY, exaggeration)
//   u_lg1 = (latRangeLo, latRangeHi, ambient, _pad)
//   u_lg2 = (unpackR, unpackG, unpackB, baseShift)  -- DEM elevation decode
//   u_lg3 = (demUV0, demUVScale, _, _)  -- border-adjusted DEM sample mapping
//   u_lg4 = (mercMinX, mercMinY, mercSizeX, mercSizeY)  -- overview merc bounds
//   u_lg5 = (hasOverview, _, _, _)  -- 1 = march the overview, 0 = per-tile DEM
layout(std140) uniform LightGlobals {
    highp vec4 u_lg0;
    highp vec4 u_lg1;
    highp vec4 u_lg2;
    highp vec4 u_lg3;
    highp vec4 u_lg4;
    highp vec4 u_lg5;
};

#define PI 3.141592653589793

// Horizon/diffraction march: dense + long, since the bake is cached (amortised).
// More steps catch finer + longer-range surface relief -- the step LENGTH is the
// binding limit on low-topography shadows at long reach -- at more bake cost.
#define MARCH_STEPS 128
// Fallback sightline reach (tile-widths) when NO overview is loaded: the per-
// tile DEM clamps past the tile edge, so marching further is pointless.
const float MARCH_REACH_TILES = 0.6;
// Overview sightline reach in real METRES (zoom-independent).  With the
// wide-area DEM the march can cross tile boundaries, so the cap is physical,
// not tile-local -- this is what lets next-tile ridges cast shadows.  The CPU
// overview is sized to cover the viewport + at least this margin, so a march
// starting on-screen stays inside the overview.
const float MARCH_REACH_M = 18000.0;
// Antenna height above ground (m), applied at BOTH ends (symmetric 3 ft AGL):
// the receiver (this texel) and the transmitting node each sit this far above
// their OWN terrain.
const float ANTENNA_AGL_M = 0.9144;
// Equatorial circumference (m) -- converts tile-relative units to ground metres.
const float EARTH_CIRCUMFERENCE_M = 40075016.686;
// A per-light nodeGroundElev below this means "no elevation sampled" -> use the
// seam-free equal-height fallback.  Matches NODE_ELEV_SENTINEL (-1e6) in
// useNetworkCoverage.ts (the real sentinel is -1e6; any value below -1e5 picks
// the fallback, comfortably clear of real terrain).
const float NODE_ELEV_UNKNOWN = -1.0e5;
// 4/3-earth effective radius (m) -- standard atmospheric refraction; sinks the
// far ground below the level sightline in the diffraction march (mirrors
// coverage-calc.ts).
const float EARTH_RADIUS_EFFECTIVE_M = 8494667.0;
// LoRa Fresnel band-centre wavelength (m), ~900 MHz -- mirrors coverage-calc.ts.
const float WAVELENGTH_M = 0.333;
const float SQRT2 = 1.4142135623730951;
// Occlusion strength: a gain on the terrain diffraction loss.  1.0 = the raw
// single-edge physics; >1 deepens terrain shadows.  A single knife edge UNDER-
// estimates real terrain (which stacks multiple diffracting ridges -- Deygout /
// Epstein-Peterson), so a value above 1 is both the art-direction knob for "how
// much does terrain block" AND a defensible multi-edge proxy.  Try 1.2 (gentle)
// .. 2.5 (hard shadows).
const float OCCLUSION_GAIN = 2.0;

// Spectrum margin domain (dB): step-1 red fringe → step-15 green LOS ceiling.
const float SPEC_BOTTOM = -6.0;
const float SPEC_TOP = 25.0;
// Soft outer fade (dB below the fringe).  Must match RF_SPECTRUM_FADE_SPAN_DB in
// rf-field.ts so the in-range fade and the CPU cull radius agree (edge fades to
// 0 exactly at the cull boundary -> natural edge, no tile seam).
const float SPEC_FADE = 4.0;

// ── Per-tile DEM sample (the fallback elevation source) ────────────────────
// Samples the RAW terrarium-encoded DEM and decodes to METRES, using the
// border-adjusted uv (the DEM texture carries a 1px skirt).  Because this reads
// ABSOLUTE elevation -- not the zoom-normalised hillshade derivative -- the
// occlusion magnitude no longer depends on the display-tile zoom, so adjacent
// tiles at different LODs stop stepping (the seam).  NEAREST sampling is
// required: linear-interpolating the byte-packed encoding corrupts elevation.
// Past the tile edge the DEM CLAMPS, so this alone can't see cross-tile ridges.
float sampleElevationTile(vec2 tilePos) {
    vec2 uv = u_lg3.x + tilePos * u_lg3.y;          // demUV0 + p * demUVScale
    vec3 b = texture(u_image, uv).rgb * 255.0;      // raw RGB bytes
    return b.r * u_lg2.x + b.g * u_lg2.y + b.b * u_lg2.z - u_lg2.w;
}

// ── Elevation sample (overview-first, per-tile DEM fallback) ───────────────
// Prefers the wide-area FIXED-RESOLUTION overview: map the tile-relative march
// position to normalized mercator (the inverse of the light packing:
// lightCenter = merc*tilesAtZoom - tileOrigin), then to the overview's [0,1]
// uv.  When the sample lies inside the overview, read absolute elevation in
// metres directly (R32F, no decode) -- this is continuous across tile edges and
// fixed-resolution regardless of display zoom, fixing the boundary gradient and
// the low-zoom under-occlusion together.  Outside the overview (a march that
// walked past its margin) or when none is loaded, fall back to the per-tile DEM
// so coverage can never regress.
float sampleElevation(vec2 tilePos) {
    if (u_lg5.x > 0.5) {
        vec2 merc = (tilePos + u_lg0.yz) / u_lg0.x;   // (p + tileOrigin)/tilesAtZoom
        vec2 ov = (merc - u_lg4.xy) / u_lg4.zw;       // -> overview [0,1] uv
        if (ov.x >= 0.0 && ov.x <= 1.0 && ov.y >= 0.0 && ov.y <= 1.0) {
            return texture(u_overviewTex, ov).r;
        }
    }
    return sampleElevationTile(tilePos);
}

// ── TX node ground (the "light at node position + AGL" rule) ──────────────
// The transmit light is planted on the NODE's OWN ground.  Sample it from the
// overview at the node's position when the node is inside it -- the SAME DEM
// (datum + resolution) the receiver surface uses -- so a node sitting low in a
// basin yields a properly grazing, shadow-prone path instead of floating up to
// the receiver's height.  Fall back to the CPU per-node sample (z10) for nodes
// outside the overview; the caller uses equal-height only when neither exists.
float nodeGroundElevation(vec2 nodeTilePos, float cpuElev) {
    if (u_lg5.x > 0.5) {
        vec2 merc = (nodeTilePos + u_lg0.yz) / u_lg0.x;
        vec2 ov = (merc - u_lg4.xy) / u_lg4.zw;
        if (ov.x >= 0.0 && ov.x <= 1.0 && ov.y >= 0.0 && ov.y <= 1.0) {
            return texture(u_overviewTex, ov).r;
        }
    }
    return cpuElev;
}

// ── Knife-edge diffraction (replaces the binary LOS test) ──────────────────
// ITU-R P.526 single-edge loss J(v) (dB) for Fresnel parameter v.  0 dB once
// the first Fresnel zone is ~60% clear (v <= -0.78), ~6 dB at a grazing ray
// (v = 0), rising for deeper shadow.  Mirror of rfKnifeEdgeDiffractionLossDb()
// in rf-field.ts.  (log10(x) = log(x) * 0.4342944819.)
float diffractionLossDb(float v) {
    if (v <= -0.78) return 0.0;
    float t = sqrt((v - 0.1) * (v - 0.1) + 1.0) + v - 0.1;
    return 6.9 + 8.6858896 * log(t);   // 6.9 + 20*log10(t)
}

// Terrain diffraction march: walk the receiver->node path and take the WORST
// first-Fresnel clearance, converting it to a knife-edge diffraction loss (dB).
// Geometry mirrors the CPU lineOfSight() in coverage-calc.ts -- 4/3-earth
// curvature sinks the far ground below the level sightline, and the clearance
// is normalised by the first Fresnel radius (v = -sqrt(2)*clearance/F1) -- so
// the GPU march and the CPU reference agree (validated in
// rf-diffraction.test.ts).  This replaces the binary horizon test: a ridge
// intruding the Fresnel zone attenuates smoothly, and a blocking ridge gives a
// large but FINITE loss (the signal diffracts over the edge).
float marchDiffractionLoss(vec2 marchDir, float dist2D, float antRx, float antTx,
                           float distTotalM, float metersPerTileUnit, float reachTiles) {
    float marchLen = min(dist2D, reachTiles);
    float stepSize = marchLen / float(MARCH_STEPS);
    float worstV = -1.0e9;
    for (int i = 1; i <= MARCH_STEPS; i++) {
        float marchT = stepSize * float(i);
        float d1 = max(marchT * metersPerTileUnit, 1.0);   // RX -> sample (m)
        float d2 = distTotalM - d1;                         // sample -> node (m)
        if (d2 <= 1.0) break;                               // reached the node
        float elev = sampleElevation(v_pos + marchDir * marchT);
        // 4/3-earth curvature drop + the straight LOS line from antRx to antTx.
        float effGround = elev + (d1 * d2) / (2.0 * EARTH_RADIUS_EFFECTIVE_M);
        float losH = antRx + (antTx - antRx) * (d1 / distTotalM);
        float clearance = losH - effGround;                 // + = LOS clears ground
        float f1 = sqrt(WAVELENGTH_M * d1 * d2 / distTotalM);  // first Fresnel radius
        float vSample = -SQRT2 * clearance / max(f1, 0.01);    // v = -sqrt(2)*C
        worstV = max(worstV, vSample);
        if (worstV > 10.0) break;                           // deep shadow, blocked
    }
    return diffractionLossDb(worstV);
}

// ── Deferred field encoding (the LUT now lives in the COMPOSITE) ────────────
// This pass bakes the link margin as a normalised scalar (margin01); the
// composite reconstructs + colours it.  RAMP_LO..RAMP_HI is the encodable margin
// window: RAMP_LO is the reach floor (SPEC_BOTTOM - SPEC_FADE), below which
// presence is already 0 so nothing visible is clipped; RAMP_HI sits ABOVE the
// green ceiling (25 dB) to give the composite headroom for its brighter
// icy-blue "excellent" peak.  Decoupling data from look lets the composite own
// the ramp, contours, mesh tint and cross-fade with NO physics re-bake.
const float RAMP_LO = -10.0;
const float RAMP_HI = 64.0;

// margin(distM) = marginD0 - 10*N*log10(max(distM, d0)/d0),  N=3.5, d0=1km.
// distM = 3 * dist2D / lightHeight  (lightHeight encodes 3 m AGL in tile units).
float rfMargin(float marginD0, float dist2D, float lightHeight) {
    float distM = 3.0 * dist2D / max(lightHeight, 1e-9);
    float decades = log(max(distM, 1000.0) / 1000.0) * 0.4342944819032518;
    return marginD0 - 35.0 * decades;
}

// ── Per-node signal: link margin (dB) + presence, gated by range + LOS ──────
// Returns vec2(margin, presence).  presence is 0 when out of range or fully
// terrain-occluded -- the occlusion acts as negative coverage.
vec2 nodeSignal(highp vec2 lightCenter, highp float falloffRadius,
                highp float lightHeight, float marginD0, float nodeGroundElev,
                float antRx, float metersPerTileUnit) {
    vec2 toLight = lightCenter - v_pos;
    float dist2D = length(toLight);

    float margin0 = rfMargin(marginD0, dist2D, lightHeight);

    // In-range gate on the UN-occluded margin (diffraction only lowers it, so a
    // texel already past the fade floor stays out): a soft physics-driven fade
    // that hits 0 exactly at the cull radius -> neighbouring tiles stay seamless.
    float reach0 = smoothstep(SPEC_BOTTOM - SPEC_FADE, SPEC_BOTTOM + 1.0, margin0);
    if (reach0 <= 0.002) return vec2(margin0, 0.0);

    // Thin geometric edge-guard in the last 10% of the cull radius (the visible
    // edge is the physical fade above, not this clamp).
    float radial = 1.0 - smoothstep(0.90, 1.0, dist2D / falloffRadius);
    if (radial <= 0.002) return vec2(margin0, 0.0);

    // Per-node terrain occlusion: a PHYSICAL knife-edge diffraction loss (dB)
    // from the worst first-Fresnel clearance along the path, folded into the
    // margin.
    float distM = max(dist2D * metersPerTileUnit, 1.0);
    // Light at the node's reported position + AGL: node ground from the march
    // DEM (overview) at its position, else the CPU per-node sample (z10), else
    // equal-height (antRx) only when the node has no DEM at all.
    float nodeGround = nodeGroundElevation(lightCenter, nodeGroundElev);
    float antTx = (nodeGround > NODE_ELEV_UNKNOWN) ? (nodeGround + ANTENNA_AGL_M) : antRx;
    vec2 ld = toLight / (dist2D + 0.0001);
    float reachTiles = (u_lg5.x > 0.5) ? (MARCH_REACH_M / metersPerTileUnit) : MARCH_REACH_TILES;
    float diffLoss = marchDiffractionLoss(ld, dist2D, antRx, antTx, distM, metersPerTileUnit, reachTiles);

    // Diffraction is extra path loss: behind a ridge the link survives at a
    // weaker margin (a faint diffracted signal), not a hard zero.  OCCLUSION_GAIN
    // scales how hard terrain bites; recompute the range roll-off from the
    // EFFECTIVE margin so deep shadow fades to nothing.
    float margin = margin0 - diffLoss * OCCLUSION_GAIN;
    float reach = smoothstep(SPEC_BOTTOM - SPEC_FADE, SPEC_BOTTOM + 1.0, margin);
    return vec2(margin, reach * radial);
}

void main() {
    highp float tilesAtZoom = u_lg0.x;
    highp vec2  tileOrigin  = u_lg0.yz;
    // Tile-relative unit -> ground metres at this tile's latitude (mercator):
    // one tile spans (circumference / 2^z) * cos(lat) on the ground.
    float latMid = radians((u_lg1.x + u_lg1.y) * 0.5);
    float metersPerTileUnit = (EARTH_CIRCUMFERENCE_M / tilesAtZoom) * cos(latMid);
    // Receiver antenna elevation -- sampled ONCE per texel (shared by every
    // light's march), not per light.
    float antRx = sampleElevation(v_pos) + ANTENNA_AGL_M;

    // Merge every converging node into ONE coherent value: the BEST-SERVED link
    // margin -- the SNR a receiver here would actually get.  Combining in dB
    // space then doing a single spectrum lookup gives one colour, not an
    // additive stack, so overlapping coverage stays coherent (no blow-out).
    float bestMargin = -1.0e30;
    float bestPresence = 0.0;
    for (int i = 0; i < u_lightCount; i++) {
        highp vec4 a = texelFetch(u_lightTex, ivec2(i * 3, 0), 0);
        highp vec4 cdata = texelFetch(u_lightTex, ivec2(i * 3 + 2, 0), 0);
        highp vec2 lightCenter = a.xy * tilesAtZoom - tileOrigin;
        highp float falloffRadius = a.z * tilesAtZoom;
        highp float lightHeight = a.w * tilesAtZoom;
        vec2 sig = nodeSignal(lightCenter, falloffRadius, lightHeight,
            cdata.x, cdata.y, antRx, metersPerTileUnit);
        if (sig.y > 0.002 && sig.x > bestMargin) {
            bestMargin = sig.x;
            bestPresence = sig.y;
        }
    }
    if (bestPresence <= 0.002) {
        fragColor = vec4(0.0);
        return;
    }

    // Deferred G-buffer: bake the DATA the composite shades from, not a colour.
    //   R = margin01  (best link margin, normalised over RAMP_LO..RAMP_HI)
    //   G = presence  (range x radial x LOS roll-off)
    //   B = serverId  (reserved for mesh-by-mesh tint; 0 until wired)
    //   A = 1         (reserved)
    // NOT premultiplied colour -- the composite reconstructs the margin, runs
    // the spectrum LUT, and premultiplies, so the look is fully art-directable
    // without re-baking the physics.
    float margin01 = clamp((bestMargin - RAMP_LO) / (RAMP_HI - RAMP_LO), 0.0, 1.0);
    fragColor = vec4(margin01, bestPresence, 0.0, 1.0);
}
