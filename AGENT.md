# MapLibre fork guide

This directory is a git submodule, not ordinary vendored source. The parent repository pins an exact commit from `https://github.com/Treehouse-00/maplibre-gl-js.git`; `.gitmodules` tracks `main`. Check the submodule's current branch/remotes before pushing because a local checkout may be detached or on a feature branch.

The current package is `maplibre-gl@6.0.0-11`, built as ESM. The waev-specific change is the custom `point-hillshade` style-layer type.

## waev integration map

| Area | Files |
|---|---|
| layer construction and paint evaluation | `src/style/style_layer/point_hillshade_style_layer.ts`, `point_hillshade_style_layer_properties.ts` |
| style-layer factory | `src/style/create_style_layer.ts` |
| render dispatch | `src/render/painter.ts` |
| draw orchestration | `src/webgl/draw/draw_point_hillshade.ts` |
| uniforms/programs | `src/webgl/program/point_hillshade*_program.ts`, `program_uniforms.ts` |
| shader registration | `src/shaders/shaders.ts` |
| shaders | `src/shaders/glsl/point_hillshade*.glsl` |

The implementation supports a focused point light and coverage-texture modes. Consult the current property definitions and draw code for the exact paint-property set; do not copy a property table from old documentation.

waev consumers live one level up in `frontend/src/components/map/`:

- `LocalizedLightLayer.tsx` — focused-node terrain light;
- `NetworkCoverageLayer.tsx` — aggregate dynamic field;
- `NetworkCoverageTilesLayer.tsx` — baked coverage tiles.

The latter coverage paths are not necessarily enabled in production. A fork change must be safe for both active focused lighting and preserved tuning/cold paths.

## Rendering invariants

- `point-hillshade` depends on DEM/hillshade derivative textures. Preserve the relationship with the terrain source and standard hillshade preparation.
- Texture-unit assignments, pass ordering, stencil overlap handling, and framebuffer ownership are correctness constraints. Change them only with focused render tests.
- Keep the layer factory, painter dispatch, program registry, shader registry, and public paint-property definitions synchronized.
- Relative TypeScript imports follow the fork's explicit `.ts` convention.
- Exported declarations need the explicit typing required by the isolated declaration build.
- MapLibre v6 is WebGL2 and ESM-only in this fork.

## Build and test

After changing GLSL:

```sh
npm run generate-shaders
```

Minimum validation:

```sh
npm run typecheck
npm run lint
npm run build-prod
```

Run the focused unit, integration, render, or build suite for the subsystem changed. `npm test` is the broad upstream suite and is substantially more expensive.

Generated `src/shaders/glsl/*.glsl.g.ts` files are produced by `generate-shaders`; edit the `.glsl` source, not generated output. Production artifacts are `dist/maplibre-gl.mjs`, `dist/maplibre-gl-worker.mjs`, CSS, and declarations.

After rebuilding the fork, validate the parent app from the repository root:

```sh
npm run build --workspace frontend
npm run test --workspace frontend
```

The parent Vite config intentionally excludes `maplibre-gl` from dependency optimization, dedupes it, and imports `frontend/src/lib/maplibre-worker.ts` before every map-bearing route. A fork upgrade that changes its export or worker contract must update those controls together.

## Submodule workflow

Changes require two commits:

1. the implementation commit in the MapLibre fork;
2. the updated submodule pointer in the waev parent repository.

Never stage unrelated parent changes while committing inside the submodule. Never describe the local feature-branch name as the parent repository's tracked branch without checking `.gitmodules`.

For upstream synchronization, expect conflicts around the small integration seam listed above. Re-run code generation and the fork gates after resolving any merge; then rebuild and test the parent frontend.
