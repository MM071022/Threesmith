// Rebuild the self-hosted interactive preview from the installed three.js and Threesmith builder.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'rolldown';
import { buildModel } from '../dist/model/index.js';
const root = resolve(import.meta.dirname,'..');
const out = resolve(root,'docs/assets'); mkdirSync(out,{recursive:true});
const result = buildModel({kind:'robot',params:{scheme:1}});
writeFileSync(resolve(out,'robot.glb.gz'),gzipSync(result.glb,{level:9}));
writeFileSync(resolve(out,'robot.json'),JSON.stringify({kind:'robot',params:{scheme:1},triangles:result.info.triangles,nodes:result.info.nodes.length,bytes:result.glb.length,score:result.report.overall,summary:result.summary},null,2)+'\n');
copyFileSync(resolve(root,'node_modules/three/LICENSE'),resolve(out,'three-LICENSE.txt'));
await build({input:resolve(root,'scripts/site/viewer.js'),plugins:[{
  name:'browser-uuid',
  transform(code,id) {
    if(!id.replaceAll('\\','/').endsWith('/three/build/three.core.js')) return;
    const definition=/function generateUUID\(\) \{[\s\S]*?\n\}/g;
    if([...code.matchAll(definition)].length!==1) throw new Error('Expected the pinned three.js UUID helper');
    // These are rendering IDs. A cryptographic UUID also satisfies security scanners without excluding the bundle.
    return {code:code.replace(definition,'function generateUUID() { return globalThis.crypto.randomUUID(); }'),map:null};
  }
}],output:{file:resolve(out,'viewer.js'),format:'esm',minify:true,banner:'/*! Three.js r187 (MIT). See three-LICENSE.txt. */'}});
console.log(result.summary); console.log('docs/assets/viewer.js and robot.glb.gz');
