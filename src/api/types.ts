export interface Param {
  name: string;
  type: string;
  description: string;
  optional: boolean;
}

export interface Member {
  name: string;
  kind: "method" | "static-method" | "property" | "getter" | "setter";
  signature: string;
  description: string;
  params: Param[];
  returns?: string;
  type?: string;
  default?: string;
  deprecated?: string;
  /** Class this member was found on (differs from the looked-up class when inherited). */
  from?: string;
}

export interface ApiEntry {
  name: string;
  kind: "class" | "constant" | "function";
  /** Path relative to the three package root, e.g. src/objects/Mesh.js */
  file: string;
  /** Where users import it from: "three", "three/webgpu" or "three/addons/...". */
  importPath: string;
  extends?: string;
  description: string;
  constructorParams: Param[];
  members: Member[];
  deprecated?: string;
  value?: string;
}

export interface ThreeInstall {
  root: string;
  version: string;
  /** Release number, e.g. 187 for 0.187.0. */
  release: number;
}
