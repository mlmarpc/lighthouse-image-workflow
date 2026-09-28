# Lighthouse Image Workflow

A local image review web app and Lighthouse image workflow CLI. The app opens with `npm start`; CLI commands remain available through `lh-image-workflow` after `npm link`.

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
- `outputFormat`: `png` by default; `jpeg` or `webp` can be selected for lossy output.
- `jpegQuality`: defaults to 90 and is also used as the default WebP quality.

PNG and JPEG source images are supported. Originals are never overwritten or pruned. PNG is encoded losslessly at the selected dimensions; Lighthouse byte savings are advisory and any overrun is reported.

When a report URL uses an existing `-desktop` or `-mobile` variant and the matching unsuffixed source exists, analysis uses the unsuffixed image as input and the reported variant's dimensions as maximum bounds. Resizing fits inside those bounds without cropping or changing aspect ratio, so actual output dimensions can be smaller than the requested bounds.

## Workflow

Start the standalone image review web app:

```sh
npm start
```

Choose a directory or image files in the browser. Directory selection scans nested folders. Add individual files to the same list, tune desktop and mobile output settings, then download selected variants as a ZIP or as individual files. The browser downloads outputs; source images are never modified.

The app accepts browser-readable image files and Sharp validates/decodes them during preview or export. Its local server binds to `127.0.0.1` and opens the browser automatically. Use `PORT=4179 npm start` to choose another port.

The root package keeps the CLI, web app, and shared image encoder in `cli/`, `web/`, and `shared/`. Set `OPEN_BROWSER=0` to start the server without launching a browser.

The CLI commands remain available separately:

```sh
lh-image-workflow analyze \
  --project-root /path/to/project \
  --config .lh-image-workflow.json \
  --desktop /path/to/lighthouse-desktop.json \
  --mobile /path/to/lighthouse-mobile.json

# Analyze several matching desktop/mobile pairs in one manifest.
lh-image-workflow analyze \
  --project-root /path/to/project \
  --config .lh-image-workflow.json \
  --desktop /path/to/page-a-desktop.json --mobile /path/to/page-a-mobile.json \
  --desktop /path/to/page-b-desktop.json --mobile /path/to/page-b-mobile.json

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

The manifest defaults to `.lh-image-workflow/manifest.json`; pass `--manifest` to place it elsewhere. `analyze` reports unmapped and ambiguous report URLs. CLI-generated outputs support PNG, JPEG, and WebP. `apply` changes existing `<picture>` source/img paths and plain `<img src>` paths only. It does not create `<picture>` markup. Ambiguous basenames and dynamic references are reported without modification.
