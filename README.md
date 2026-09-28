# Lighthouse Image Workflow

A local CLI that reads paired Lighthouse JSON reports, maps image URLs to project assets, writes desktop/mobile variants, and previews source-reference updates.

## Install

```sh
npm install
npm link
```

Requires Node.js 20.9 or newer. The project pins Sharp CLI and Sharp locally; it does not use a global image command.

## Configure a project

Copy `project.config.example.json` into the target project and set:

- `urlMappings`: public URL prefixes and their local asset roots.
- `sourceGlobs`: files eligible for path updates.
- Optional `dimensions`: per-source viewport dimensions. If omitted, both variants use source dimensions.
- `outputFormat`: `png` by default; `jpeg` can be selected for an explicitly lossy output.
- `jpegQuality`: defaults to 90.

Only PNG and JPEG source images are supported. Originals are never overwritten or pruned. PNG is encoded losslessly at the selected dimensions; Lighthouse byte savings are advisory and any overrun is reported.

## Workflow

```sh
lh-image-workflow analyze \
  --project-root /path/to/project \
  --config .lh-image-workflow.json \
  --desktop /path/to/lighthouse-desktop.json \
  --mobile /path/to/lighthouse-mobile.json

lh-image-workflow optimize \
  --project-root /path/to/project \
  --config .lh-image-workflow.json

lh-image-workflow apply \
  --project-root /path/to/project \
  --config .lh-image-workflow.json

# After reviewing the displayed patch:
lh-image-workflow apply \
  --project-root /path/to/project \
  --config .lh-image-workflow.json \
  --apply
```

The manifest defaults to `.lh-image-workflow/manifest.json`; pass `--manifest` to place it elsewhere. `analyze` reports unmapped and ambiguous report URLs. `apply` changes existing `<picture>` source/img paths and plain `<img src>` paths only. It does not create `<picture>` markup. Ambiguous basenames and dynamic references are reported without modification.
