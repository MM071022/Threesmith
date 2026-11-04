---
name: model
description: Use when a three.js project needs a 3D model (a car, a tree, a house, a boat, a prop, terrain) and there is no asset, or when a .glb/.gltf will not load, looks wrong, is too big or too small. Builds clean .glb files from code without Blender, shows them as text views, lints them, and says which three.js loaders and decoders a file needs. Also in Dutch: "maak een model", "3D-model", "auto", "boom", "huis", "het model is onzichtbaar".
argument-hint: "[what to make or which file to check, optional]"
---

# 3D models for three.js

Make or check the model ($ARGUMENTS, or what the user asked for). glTF and three.js agree: +Y is up, units are
metres, a model's front is +Z.

1. `three_model_brief` with the name: what the thing is, the nearest ready-made kind, its parts, its real size and the
   order of tools.
2. `three_model_identify` when you need the parts, pivots (wheels, doors, rotors) and size in detail.
3. Build: `three_model_build` with a `kind` (see `three_model_spec` for the list) or your own spec. It writes a clean
   .glb (a node per part, UVs, normals) into the project, undoable with `three_undo`.
4. Look at it: `three_model_view` draws front, side and top views as text and names parts that do not touch. You
   cannot see pictures; this is how you check the shape.
5. `three_model_lint` scores it (and with `archetype` checks it is what it should be). Fix every error, build again.
6. For a model from elsewhere: `three_model_inspect` lists what is in it (size, triangles, materials, textures,
   animations) and which loaders and decoders three.js needs (DRACOLoader, MeshoptDecoder, KTX2Loader).
   `three_assets` checks the code sets them up.
7. Load it with GLTFLoader (`loadAsync`, then add `gltf.scene`), and `three_check` the page.
