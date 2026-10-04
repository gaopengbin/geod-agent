# Source and implementation boundary

This crate is an independent implementation owned by the GeoD Agent repository.
It has no dependency on the old GeoD desktop directory, a local symlink, or an old
product package. Its public API is an ordinary versioned Rust crate (0.1.0).

The implementation was checked against the 3D Tiles specification and the old
GeoD desktop implementation's behavior. The latter is MIT licensed, copyright
2025–2026 gaopengbin, repository HEAD `0938626b16aa2662df6058b2a7bd7733c72a3f14`.
The actual files inspected on 2026-10-02 had these SHA-256 hashes (the checkout
may contain changes beyond that HEAD):

| File in old `src-tauri/src/tiles3d` | SHA-256 |
| --- | --- |
| fetcher.rs | 7c542dfa177574f66e44520dbbdf2cb294da22f9654001a03f012f3d9806ebc3 |
| filter.rs | 236ac64a352975ba6a88766bdde7fc6976ada10fa4286c1a6e78f818c35cffc7 |
| tileset.rs | 65f237e7bfec898a3c2ecb49a6f97bc97d180670b62b8e058abdfdb10f7fe1d5 |
| mod.rs | ec689cb549dfa9d77d72f7cbc6228b1ea08af93dd22ebe59a49c398d4ec9a1a0 |

No source file was copied unchanged. The downloader, content rewriter, implicit
tree expansion, manifest and verification implementation were written here.
The transform composition and geographic bounding-volume rules are based on the
standard. The application itself retains its MIT license.

Primary references:

- [3D Tiles specification](https://github.com/CesiumGS/3d-tiles/tree/main/specification)
- [Implicit tiling](https://github.com/CesiumGS/3d-tiles/blob/main/specification/ImplicitTiling/README.adoc)
- [Official sample snapshot used for real downloads](https://github.com/CesiumGS/3d-tiles-samples/tree/a30bfdf2d6cc55f4c3078e8aea3a793af6ebfd56)

The official sample files are acceptance artifacts, not bundled product presets.

## 2026-10-03 S2 and legacy format references

The S2 address, projection and subdivision code was independently implemented
from the [S2 bounding-volume extension](https://github.com/CesiumGS/3d-tiles/blob/main/extensions/3DTILES_bounding_volume_S2/README.md).
Tile transforms are ignored for these geographic volumes. Hilbert orientation,
Morton availability indexing, polar extrema and octree height ranges are tested.

Frozen numeric facts in `tests/data/s2-reference.json` were generated from the
published CesiumJS 1.146.0 S2Cell at commit
`b8d3a36fe98a3e432eb89253c95d5f20e605e0f1` (Apache-2.0), without copying its
source implementation. They cover 35 cells, public center/vertex calculations
and all children of non-leaf reference cells. The level-zero face IDs are
constructed from the normative bit layout because the upstream convenience
helper adds a position bit at level zero.

The same pinned Cesium snapshot supplies `BatchedDeprecated1/2` reference
assets. The real GLB 1 geometry is the
[Khronos Box sample](https://github.com/KhronosGroup/glTF-Sample-Models/tree/d7a3cc8e51d7c573771ae77a57f16b0662a905c6/1.0/Box),
snapshot `d7a3cc8e51d7c573771ae77a57f16b0662a905c6`. These reference assets
are downloaded acceptance artifacts and are not distributed with the product.
Locally generated S2 wrappers are explicitly test fixtures, not public data.
