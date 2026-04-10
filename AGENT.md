# AGENT.md — MapLibre GL JS Fork (waev/point-hillshade)

## What is this?

A private fork of [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) v5.22.0 adding a custom `point-hillshade` layer type. The layer renders terrain-aware point-light illumination — simulating localized lighting from mesh network nodes onto DEM terrain tiles.

**Repo**: `dmduran12/maplibre-gl-js` (private)
**Branch**: `waev/point-hillshade`
**Base**: MapLibre GL JS v5.22.0 (commit `48caed8`)
**Submodule path**: `frontend/maplibre-fork` in the waev project

---

## Remotes

| Remote | URL | Purpose |
|--------|-----|---------|
| `origin` | `https://github.com/dmduran12/maplibre-gl-js.git` | Push target (private fork) |
| `upstream` | `https://github.com/maplibre/maplibre-gl-js.git` | Upstream MapLibre (pull only) |

---

## The `point-hillshade` Layer Type

A new layer type (`"point-hillshade"`) registered alongside MapLibre's native `hillshade`. It reuses the hillshade prepare pass (DEM → Sobel derivative FBOs) and adds two custom render passes:

1. **Surface coverage pass** (`pointHillshadeSurface`): Terrain-aware surface tint using NdotL³ facing + quadratic radial falloff. Soft colored glow on terrain slopes facing the light.

2. **Main terrain detail pass** (`pointHillshade`): Full illumination with slope analysis, 5-probe near-field occlusion, latitude-corrected derivatives, and 3-layer compositing (highlight + accent + glow).

Both shaders support two modes via `u_lightCount`:
- **Single-light** (`u_lightCount = 0`): Reads `u_lightCenter`, `u_lightColor`, `u_falloffRadius` paint properties. Used for the selected-node localized light.
- **Coverage texture** (`u_lightCount > 0`): Reads pre-composited `u_coverageTex` (RGBA). Used for multi-light network coverage where all nodes illuminate terrain simultaneously.

### Paint Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `point-hillshade-center` | `[lng, lat]` | `[0, 0]` | Light source position |
| `point-hillshade-color` | color | `#3b82f6` | Light color |
| `point-hillshade-radius` | number (meters) | `10000` | Falloff radius |
| `point-hillshade-intensity` | number [0,1] | `0.5` | Intensity (maps to diffuse 1.5–3.5) |
| `point-hillshade-exaggeration` | number [0,1] | `0.5` | Terrain exaggeration factor |
| `point-hillshade-surface-opacity` | number [0,1] | `0.5` | Surface coverage pass opacity |

---

## File Map

### New files (point-hillshade)

| File | Purpose |
|------|---------|
| `src/shaders/point_hillshade.fragment.glsl` | Main terrain detail fragment shader. Slope analysis, 5-probe occlusion, 3-layer compositing, coverage tex branching. |
| `src/shaders/point_hillshade_surface.fragment.glsl` | Surface coverage tint fragment shader. NdotL³ facing + radial falloff, coverage tex branching. |
| `src/shaders/point_hillshade.vertex.glsl` | Shared vertex shader (tile projection → `v_pos`). |
| `src/shaders/point_hillshade_viewshed_prepare.fragment.glsl` | Viewshed prepare shader. 96-step sightline march for terrain occlusion (advanced feature). |
| `src/render/draw_point_hillshade.ts` | Draw entry point. Dispatches surface + main terrain passes with stencil overlap handling. |
| `src/render/program/point_hillshade_program.ts` | Main pass uniforms (12 uniforms including `u_coverageTex`/`u_lightCount`). |
| `src/render/program/point_hillshade_surface_program.ts` | Surface pass uniforms (10 uniforms). |
| `src/render/program/point_hillshade_viewshed_prepare_program.ts` | Viewshed prepare uniforms. |
| `src/style/style_layer/point_hillshade_style_layer.ts` | Style layer class (extends `StyleLayer`). |
| `src/style/style_layer/point_hillshade_style_layer_properties.ts` | Paint property definitions (inline, not from style spec). |

### Modified MapLibre files

| File | Change |
|------|--------|
| `src/render/painter.ts` | Import + dispatch `drawPointHillshade` in `renderLayer()`. |
| `src/render/program/program_uniforms.ts` | Register `pointHillshade`, `pointHillshadeSurface`, `pointHillshadeViewshedPrepare` programs. |
| `src/render/render_to_texture.ts` | Add `'point-hillshade'` to `LAYERS_TO_TEXTURES` lookup. |
| `src/shaders/shaders.ts` | Import + register shader sources for all point-hillshade programs. |
| `src/style/create_style_layer.ts` | Handle `'point-hillshade'` in layer factory switch. |
| `src/tile/tile.ts` | (Minor) Support for coverage data on tiles. |
| `src/ui/map.ts` | (Minor) Type support for custom layer. |

---

## Shader Architecture

```
DEM tile (loaded by hillshade source)
    ↓ hillshade prepare pass (Sobel → derivative FBO)
    ↓
tile.fbo (RG = dx/dy derivatives)
    ↓
┌─────────────────────────────┐
│ pointHillshadeSurface       │  ← reads tile.fbo TEXTURE0
│   NdotL³ × falloff × color │     optionally reads u_coverageTex TEXTURE1
│   → soft terrain tint       │
└─────────────────────────────┘
    ↓ (translucent blend)
┌─────────────────────────────┐
│ pointHillshade              │  ← reads tile.fbo TEXTURE0
│   slope + occlusion + N·L  │     optionally reads u_coverageTex TEXTURE1
│   → detailed illumination   │
└─────────────────────────────┘
```

Both shaders share `point_hillshade.vertex.glsl` which projects tile vertices and outputs `v_pos` in [0,1] tile-relative space.

---

## Build

```bash
# Generate .g.ts shader files from GLSL sources
npm run generate-shaders

# Production build (outputs dist/maplibre-gl.js)
npm run build-prod

# After rebuilding, clear Vite cache in the frontend:
rm -rf ../node_modules/.vite
# Then restart frontend dev server with:
npx vite --force
```

**Build pipeline**: `generate-shaders` transpiles `.glsl` → `.glsl.g.ts` (minified string exports). `build-prod` runs Rollup to produce `dist/maplibre-gl.js`. The frontend's `package.json` references the fork via `"maplibre-gl": "file:./maplibre-fork"`.

**Important**: Always run `generate-shaders` before `build-prod` after editing any `.glsl` file. The `.g.ts` files are gitignored — they're regenerated at build time.

---

## Submodule Workflow

The fork is a git submodule of the waev project at `frontend/maplibre-fork`.

```bash
# Clone waev with submodule
git clone --recurse-submodules https://github.com/dmduran12/waev.git

# Or initialize after clone
git submodule update --init --recursive

# After making changes in the fork:
cd frontend/maplibre-fork
git add -A && git commit -m "description"
git push origin waev/point-hillshade

# Then update the submodule pointer in waev:
cd ../..
git add frontend/maplibre-fork
git commit -m "chore: update maplibre-fork submodule"
```

---

## Syncing with Upstream

```bash
cd frontend/maplibre-fork
git fetch upstream
git merge upstream/main   # or rebase, depending on preference
# Resolve conflicts (likely in modified files: painter.ts, shaders.ts, etc.)
npm run generate-shaders
npm run build-prod
git push origin waev/point-hillshade
```

---

## Key Design Decisions

- **No offscreen pass**: `hasOffscreenPass()` returns `false`. The point-hillshade reuses derivative FBOs created by the standard hillshade's offscreen pass. The point-hillshade layer MUST be paired with a hillshade source in the style.

- **Coverage texture branching**: The `u_lightCount`/`u_coverageTex` uniforms allow the same shader to serve both single-light (selected node) and multi-light (network coverage) modes without shader recompilation. When `u_lightCount > 0`, the shader reads a pre-composited RGBA texture instead of per-light uniforms.

- **Texture unit allocation**: `u_image` (derivative FBO) binds to `TEXTURE0`. `u_coverageTex` binds to `TEXTURE1`. Do not clobber these assignments.

- **Alpha clamping**: Main pass caps at 0.60 alpha, surface pass respects `u_surfaceOpacity`. This prevents blow-out when many lights overlap.
