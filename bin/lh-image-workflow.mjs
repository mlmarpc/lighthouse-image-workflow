#!/usr/bin/env node
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { readJson, loadProjectConfig, analyzeReports, optimizeManifest, applyManifest } from '../src/workflow.mjs';

function parseArgs(args) {
  const command = args.shift();
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const name = key.slice(2);
    if (['apply'].includes(name)) options[name] = true;
    else {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
      options[name] = value;
    }
  }
  return { command, options };
}
function required(options, name) {
  if (!options[name]) throw new Error(`Missing required option --${name}`);
  return options[name];
}
function manifestPath(options, root) {
  return path.resolve(root, options.manifest ?? '.lh-image-workflow/manifest.json');
}

try {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log('Usage: lh-image-workflow <analyze|optimize|apply> --project-root DIR --config FILE [options]\n\nCommands:\n  analyze   --desktop FILE --mobile FILE [--manifest FILE] [--format png|jpeg]\n  optimize  [--manifest FILE] [--format png|jpeg] [--jpeg-quality 1..100]\n  apply     [--manifest FILE] [--apply]');
    process.exit(0);
  }
  const projectRoot = path.resolve(required(options, 'project-root'));
  const configPath = required(options, 'config');
  const config = await loadProjectConfig(projectRoot, configPath);
  const manifestFile = manifestPath(options, projectRoot);

  if (command === 'analyze') {
    const desktopReport = await readJson(required(options, 'desktop'));
    const mobileReport = await readJson(required(options, 'mobile'));
    const format = options.format ?? config.outputFormat ?? 'png';
    const manifest = await analyzeReports({ projectRoot, config, desktopReport, mobileReport, outputFormat: format });
    await mkdir(path.dirname(manifestFile), { recursive: true });
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Manifest: ${manifestFile}`);
    console.log(`${manifest.entries.length} mapped image(s), ${manifest.unresolved.length} unresolved URL(s)`);
  } else if (command === 'optimize') {
    const manifest = await readJson(manifestFile);
    const results = await optimizeManifest({ manifest, projectRoot, outputFormat: options.format, jpegQuality: options.jpegQuality ? Number(options.jpegQuality) : undefined });
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    const over = results.filter((entry) => entry.overTargetBytes > 0).length;
    console.log(`${results.length} output(s) written; ${over} exceed Lighthouse's advisory byte target.`);
    console.log(`Manifest updated: ${manifestFile}`);
  } else if (command === 'apply') {
    const manifest = await readJson(manifestFile);
    const result = await applyManifest({ manifest, projectRoot, apply: options.apply === true });
    console.log(`${result.changedFiles} file(s) with changes; ${result.replacements} replacement(s); ${result.unsupported.length} unresolved reference(s).`);
    console.log(result.applied ? 'Source changes applied.' : 'Dry run only. Pass --apply to write source changes.');
    for (const item of result.unsupported) console.log(`UNRESOLVED ${item.source}: ${item.reason}`);
  } else {
    throw new Error('Usage: lh-image-workflow <analyze|optimize|apply> --project-root DIR --config FILE [options]');
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
