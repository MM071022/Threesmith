# Writes docs/models.html from docs/gallery/gallery.json (made by scripts/gallery.mjs) and the list of kinds.
# python3 scripts/models-page.py <kinds.json>   kinds.json: [[kind, description], ...] from allKinds()
import html, json, sys
from pathlib import Path

repo = Path(__file__).resolve().parent.parent
rendered = {g["kind"]: g for g in json.loads((repo / "docs/gallery/gallery.json").read_text())}
kinds = json.loads(Path(sys.argv[1]).read_text())

cards = []
for kind, g in rendered.items():
    summary = g["summary"].split(": ", 1)[-1]
    cards.append(f'<figure><img loading="lazy" src="gallery/{kind}.jpg" alt="{kind}, built by threesmith model build and rendered by three.js" width="640" height="480"><figcaption><b>{kind}</b><br>{html.escape(summary)}</figcaption></figure>')
rows = "\n".join(f"<tr><td><code>{k}</code></td><td>{html.escape(d)}</td></tr>" for k, d in kinds)

page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Threesmith models: 3D models for three.js without Blender</title>
<meta name="description" content="{len(kinds)} ready-made kinds of 3D models (vehicles, aircraft, ships, buildings, furniture, weapons, fantasy props, creatures, plants, terrain) built as clean .glb files from code by Threesmith, viewed as text and linted for three.js.">
<link rel="canonical" href="https://laaielichter.github.io/Threesmith/models.html">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<meta name="theme-color" content="#0b1117">
<meta property="og:title" content="Threesmith models: 3D models for three.js without Blender">
<meta property="og:image" content="https://laaielichter.github.io/Threesmith/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap">
<link rel="stylesheet" href="site.css">
<style>.gallery {{ grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }} .gallery figcaption b {{ color: var(--fg); }}</style>
</head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="./"><img src="logo.svg" alt="" width="30" height="30">Threesmith</a>
  <nav class="links">
    <a href="./#how">How it works</a>
    <a class="opt" href="./#tools">Tools</a>
    <a class="opt" href="models.html">Models</a>
    <a href="install.html">Install</a>
    <a class="gh" href="https://github.com/laaielichter/Threesmith">GitHub</a>
  </nav>
</div></header>
<div class="hero" style="padding-bottom:10px"><div class="wrap" style="display:block">
  <span class="eyebrow">{len(kinds)} kinds · .glb · no Blender</span>
  <h1>3D models for three.js, from code</h1>
  <p class="lead"><code>three_model_build</code> makes a clean, deterministic <code>.glb</code> from a ready-made kind or a JSON spec: a node per part, UVs and normals, names as GLTFLoader shows them, +Y up, metres, front +Z. Each render below is three.js itself, headless, loading the built file with GLTFLoader. The numbers are the builder's own summary.</p>
  <pre class="cfg" style="background:#070b10;color:#d6dee6;border:1px solid var(--line);border-radius:12px;padding:14px 16px;overflow:auto">npx threesmith model build car -o public/models/car.glb
npx threesmith model view public/models/car.glb      # front, side and top views as text
npx threesmith model lint public/models/car.glb --archetype car</pre>
</div></div>
<section><div class="wrap">
  <div class="gallery">
{chr(10).join(cards)}
  </div>
</div></section>
<section><div class="wrap">
  <h2>Every kind</h2>
  <p class="sub">Parameters per kind: <code>threesmith model kinds</code> or <code>three_model_spec</code>.</p>
  <div class="tbl"><table><thead><tr><th>Kind</th><th>What it makes</th></tr></thead><tbody>
{rows}
  </tbody></table></div>
</div></section>
<footer><div class="wrap">
  <span>Threesmith · made by laaielichter · MIT</span>
  <span><a href="./">Home</a> · <a href="install.html">Install</a> · <a href="https://github.com/laaielichter/Threesmith">GitHub</a></span>
</div></footer>
</body>
</html>
"""
(repo / "docs/models.html").write_text(page)
print("models.html:", len(cards), "renders,", len(kinds), "kinds")
