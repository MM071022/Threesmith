export type ModelCategory = "geometry" | "materials" | "performance" | "rig" | "loading" | "archetype";
export type ModelSeverity = "error" | "warning" | "info";

export interface ModelRule {
  id: string;
  category: ModelCategory;
  severity: ModelSeverity;
  title: string;
  /** How to fix it, in one sentence. */
  fix: string;
}

export interface ModelFinding {
  rule: string;
  category: ModelCategory;
  severity: ModelSeverity;
  file: string;
  /** Node path the finding is about, when there is one. */
  node?: string;
  message: string;
}

/** The categories every lint reports. "archetype" is added when a model is checked against what it should be. */
export const MODEL_CATEGORIES: ModelCategory[] = ["geometry", "materials", "performance", "rig", "loading"];

/** "loading" is what three.js's GLTFLoader needs to read the file at all (decoders, supported extensions). */
export const MODEL_WEIGHTS: Record<ModelCategory, number> = { geometry: 0.35, materials: 0.2, performance: 0.15, rig: 0.15, loading: 0.15, archetype: 0.2 };

const list: ModelRule[] = [
  { id: "model/flipped-faces", category: "geometry", severity: "error", title: "Faces turned the wrong way", fix: "Flip the winding of the marked triangles (neighbours must share an edge in opposite directions); they show as holes or pink backfaces." },
  { id: "model/open-edges", category: "geometry", severity: "warning", title: "Open edges on a single-sided surface", fix: "Close the gap, or mark the material double sided if the surface is meant to be thin." },
  { id: "model/non-manifold", category: "geometry", severity: "info", title: "Edge shared by more than two triangles", fix: "Split the surfaces or remove the stray triangle." },
  { id: "model/degenerate-triangles", category: "geometry", severity: "warning", title: "Triangles without area", fix: "Merge or delete the vertices of the flat triangles." },
  { id: "model/mirrored-node", category: "geometry", severity: "info", title: "Node with a negative scale", fix: "Bake the negative scale into the meshes under it. three.js flips the face winding of a mirrored mesh so it still renders, but normal-mapped tangents, physics colliders and code that reads the scale see it mirrored." },
  { id: "model/asymmetry", category: "geometry", severity: "info", title: "Almost symmetric, but not quite", fix: "Mirror one half onto the other so left and right match, unless the difference is meant (an exhaust on one side)." },
  { id: "model/floating-part", category: "geometry", severity: "info", title: "Part that does not touch the rest of the model", fix: "Move the part so it touches (or overlaps) what it is attached to, or make it a separate model if it is meant to stand alone." },
  { id: "model/missing-normals", category: "materials", severity: "warning", title: "Mesh without normals", fix: "Export the normals. Without them GLTFLoader turns on flatShading for the material, so the surface looks faceted; geometry.computeVertexNormals() is the runtime fallback." },
  { id: "model/vertex-colors", category: "materials", severity: "info", title: "Vertex colours multiply the material colour", fix: "Keep COLOR_0 only when it is meant: GLTFLoader sets material.vertexColors = true, and a material you assign yourself needs vertexColors: true to keep them." },
  { id: "model/emissive-strength", category: "materials", severity: "info", title: "Emissive strength above 1", fix: "GLTFLoader puts KHR_materials_emissive_strength in emissiveIntensity; it only reads as a glow with tone mapping and a bloom pass (UnrealBloomPass, or BloomNode with WebGPU)." },
  { id: "model/transmission", category: "performance", severity: "info", title: "Transmission material", fix: "KHR_materials_transmission becomes a MeshPhysicalMaterial with transmission, and the renderer draws the opaque scene into an extra render target for it every frame. Use alphaMode BLEND for simple glass on the web." },
  { id: "model/missing-uv", category: "materials", severity: "error", title: "Textured material on a mesh without UVs", fix: "Add UV coordinates (TEXCOORD_0) to the mesh." },
  { id: "model/missing-tangents", category: "materials", severity: "warning", title: "Normal map without tangents", fix: "Export tangents so the normal map lights the same in every engine." },
  { id: "model/uv-out-of-range", category: "materials", severity: "info", title: "UVs outside 0..1 on a texture that does not repeat", fix: "Move the UVs into 0..1, or let the texture repeat (wrap mode REPEAT, glTF's default)." },
  { id: "model/texture-size", category: "materials", severity: "warning", title: "Large texture for the web", fix: "Scale it down to 2048 or less (many phones cap renderer.capabilities.maxTextureSize at 4096), or compress it to KTX2." },
  { id: "model/texture-not-power-of-two", category: "materials", severity: "info", title: "Texture size is not a power of two", fix: "WebGL2 and WebGPU mipmap any size, but 512, 1024, 2048... keep the mip chain clean and KTX2 (Basis) compression needs sizes in multiples of 4." },
  { id: "model/triangle-budget", category: "performance", severity: "warning", title: "Over the triangle budget", fix: "Reduce the detail (npx @gltf-transform/cli simplify in.glb out.glb), or add LODs (THREE.LOD)." },
  { id: "model/draw-calls", category: "performance", severity: "info", title: "Many draw calls", fix: "Every mesh and material pair is one draw call in three.js (and one more per shadow-casting light): merge static parts (BufferGeometryUtils.mergeGeometries), share materials, or use InstancedMesh for repeats. npx @gltf-transform/cli optimize joins and instances meshes." },
  { id: "model/uncompressed", category: "performance", severity: "info", title: "Big file without compression", fix: "Compress it: npx @gltf-transform/cli optimize in.glb out.glb --compress draco --texture-compress webp (then GLTFLoader needs a DRACOLoader; see three_model_needs)." },
  { id: "model/scale-suspect", category: "geometry", severity: "warning", title: "Size looks like the wrong unit", fix: "three.js and GLTFLoader use metres: rescale the export (centimetres and millimetres are the usual mistake) instead of scaling the Object3D at runtime." },
  { id: "model/origin-off-centre", category: "rig", severity: "info", title: "Origin far from the model", fix: "Move the origin to the middle of the base, so object.position places the model and object.rotation turns it about itself." },
  { id: "model/texture-memory", category: "performance", severity: "warning", title: "Over the texture memory budget", fix: "Lower the texture sizes, or share textures between materials." },
  { id: "model/opaque-glass", category: "materials", severity: "warning", title: "Glass that light cannot pass", fix: "Give glass alphaMode BLEND with a low alpha (about 0.15 to 0.3) and a low roughness, or a transmission; opaque glass hides the cockpit or the room behind it. Dark, solid glass is fine on a model with nothing behind it." },
  { id: "model/many-materials", category: "performance", severity: "info", title: "Many materials", fix: "Merge materials that can share a texture atlas; every material is a draw call." },
  { id: "model/duplicate-node-names", category: "rig", severity: "error", title: "Two nodes with the same name", fix: "Give every node a unique name: GLTFLoader renames the second one to Name_1 (the original stays in userData.name), so getObjectByName finds only the first." },
  { id: "model/renamed-on-load", category: "rig", severity: "warning", title: "Node name GLTFLoader changes", fix: "Rename the node without spaces and without [ ] . : / (and without a numbered suffix like .001): GLTFLoader cleans names for animation track bindings, so getObjectByName with the name from the modelling tool finds nothing." },
  { id: "model/unnamed-node", category: "rig", severity: "info", title: "Node without a name", fix: "Name the node; code finds parts with getObjectByName and animations bind to names." },
  { id: "model/ground-offset", category: "rig", severity: "info", title: "Model does not sit on y = 0", fix: "Move the origin so the lowest point is at y = 0, unless that is intended." },
  { id: "model/contract-missing-node", category: "rig", severity: "error", title: "Node required by the contract is missing", fix: "Restore or rename the node, or update the contract if the change is intended." },
  { id: "model/contract-extra-node", category: "rig", severity: "warning", title: "Node the contract does not list", fix: "Remove the node, or add it to the contract." },
  { id: "model/contract-order", category: "rig", severity: "warning", title: "Nodes are in a different order than the contract", fix: "Restore the order, or update the contract; scripts that use child indices depend on it." },
  { id: "model/contract-size", category: "geometry", severity: "error", title: "Size differs from the contract", fix: "Rescale the model, or update the contract with the new measured value and its source." },
  { id: "model/contract-triangles", category: "performance", severity: "warning", title: "Triangle count over the contract", fix: "Reduce the detail, or raise the budget in the contract on purpose." },
  { id: "model/contract-ground", category: "geometry", severity: "warning", title: "Lowest point differs from the contract", fix: "Move the origin so the model sits where the contract says." },
  { id: "archetype/missing-part", category: "archetype", severity: "error", title: "A part this kind of thing needs is missing", fix: "Add the part as its own node with a name the archetype recognises (see `model identify`)." },
  { id: "archetype/part-count", category: "archetype", severity: "warning", title: "Too few or too many of a part", fix: "Add or remove nodes so the count matches what this kind of thing has." },
  { id: "archetype/pivot", category: "archetype", severity: "warning", title: "A moving part has its pivot in the wrong place", fix: "Move the node origin: a wheel to its hub, a hinged part to its hinge, a turret to its base." },
  { id: "archetype/wheel-axis", category: "archetype", severity: "warning", title: "A wheel lies the wrong way", fix: "Turn the wheel so its short side is along its axle." },
  { id: "archetype/size", category: "archetype", severity: "warning", title: "Size far from what this kind of thing is", fix: "Check the unit: this is probably a scale mistake. Rescale to metres." },
  { id: "archetype/orientation", category: "archetype", severity: "warning", title: "The model points sideways", fix: "Turn the model so its front faces +Z and its length runs along z." },
  { id: "archetype/optional-part", category: "archetype", severity: "info", title: "Usual parts this model does not have", fix: "Add the parts you want; they are optional." },
  { id: "model/empty-geometry", category: "rig", severity: "warning", title: "No geometry in the file", fix: "Check the export: the file holds no triangles." },
  { id: "model/unsupported-extension", category: "loading", severity: "error", title: "Extension GLTFLoader does not support", fix: "Register a plugin for it with gltfLoader.register(), or convert the file (npx @gltf-transform/cli has commands for most extensions); a required extension it does not know stops the load or drops the data." },
  { id: "model/needs-decoder", category: "loading", severity: "info", title: "Needs a decoder in three.js", fix: "Set up the loader the file needs before loading it (DRACOLoader, MeshoptDecoder or KTX2Loader; three_model_needs prints the code), or GLTFLoader throws." },
  { id: "model/compressed-geometry", category: "loading", severity: "info", title: "Geometry is compressed, so it was not checked", fix: "Lint the uncompressed source file for winding, holes and symmetry; sizes, names and parts were still checked from the accessor bounds." },
];

export const MODEL_RULES: Record<string, ModelRule> = Object.fromEntries(list.map((r) => [r.id, r]));
