import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { analyzeReports, applyManifest, optimizeManifest, parseLighthouseReport, planReferenceUpdates } from '../workflow.mjs';

async function tempDir() { return mkdtemp(path.join(os.tmpdir(), 'lh-image-workflow-')); }

test('merges repeated Lighthouse URLs and derives byte targets', () => {
  const report = { audits: { 'uses-optimized-images': { details: { items: [
    { url: 'https://site.test/assets/hero.png?x=1', totalBytes: 5000, wastedBytes: 1200 },
    { url: 'https://site.test/assets/hero.png?x=1', totalBytes: 5100, wastedBytes: 800 },
    { url: 'https://site.test/assets/hero.png?x=1#fragment', totalBytes: 5000, wastedBytes: 900 },
    { url: 'https://site.test/assets/skip.webp', totalBytes: 900, wastedBytes: 400 },
  ] } } } };
  const result = parseLighthouseReport(report, 'desktop');
  assert.equal(result.length, 1);
  assert.equal(result[0].reportedBytes, 5100);
  assert.equal(result[0].estimatedSavingsBytes, 1200);
  assert.equal(result[0].targetBytes, 3800);
  assert.equal(result[0].auditIds.length, 3);
});

test('maps paired report URLs, reports unmapped assets, and merges viewport targets', async (t) => {
  const root = await tempDir(); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'public/images'), { recursive: true });
  await sharp({ create: { width: 12, height: 8, channels: 4, background: '#386fa5' } }).png().toFile(path.join(root, 'public/images/hero.png'));
  const config = {
    urlMappings: [{ urlPrefix: 'https://site.test/assets/', localRoot: 'public' }],
    sourceGlobs: ['src/**/*.html'],
  };
  const desktopReport = { audits: { 'image-audit': { details: { items: [
    { url: 'https://site.test/assets/images/hero.png', totalBytes: 9000, wastedBytes: 1000 },
    { url: 'https://other.test/no-map.png', totalBytes: 1000, wastedBytes: 500 },
  ] } } } };
  const mobileReport = { audits: { 'image-audit': { details: { items: [
    { url: 'https://site.test/assets/images/hero.png', totalBytes: 8000, wastedBytes: 700 },
  ] } } } };
  const manifest = await analyzeReports({ projectRoot: root, config, desktopReport, mobileReport, outputFormat: 'png' });
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].variants.desktop.targetBytes, 8000);
  assert.equal(manifest.entries[0].variants.mobile.targetBytes, 7300);
  assert.deepEqual(manifest.entries[0].variants.desktop.dimensions, { width: 12, height: 8 });
  assert.equal(manifest.unresolved.length, 1);
  assert.equal(manifest.unresolved[0].mappingStatus, 'unmapped');
});

test('optimizes PNG losslessly at source/configured dimensions and reports output sizes', async (t) => {
  const root = await tempDir(); t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'assets/hero.png');
  await mkdir(path.dirname(source), { recursive: true });
  const pixels = Buffer.from(Array.from({ length: 12 * 8 * 4 }, (_, i) => (i * 37) % 256));
  await sharp(pixels, { raw: { width: 12, height: 8, channels: 4 } }).png().toFile(source);
  const manifest = {
    outputFormat: 'png', jpegQuality: 90, entries: [{ source: 'assets/hero.png', variants: {
      desktop: { dimensions: { width: 12, height: 8 }, targetBytes: 1 },
      mobile: { dimensions: { width: 6, height: 6 }, targetBytes: 100000 },
    } }],
  };
  const results = await optimizeManifest({ manifest, projectRoot: root });
  assert.equal(results.length, 2);
  assert.equal(results[0].dimensions.width, 12);
  assert.equal(results[0].dimensions.height, 8);
  assert.ok(results[0].bytes > 0);
  assert.equal(results[0].overTargetBytes, results[0].bytes - 1);
  assert.equal(results[1].dimensions.width, 6);
  assert.equal(results[1].dimensions.height, 4);
  const expected = await sharp(source).raw().toBuffer();
  const actual = await sharp(path.join(root, results[0].output)).raw().toBuffer();
  assert.deepEqual(actual, expected);
});

test('combines report pairs, resolves viewport variants to originals, and fits without cropping', async (t) => {
  const root = await tempDir(); t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'assets/features');
  await mkdir(folder, { recursive: true });
  for (const [name, width, height] of [
    ['hero.png', 12, 8], ['hero-desktop.png', 6, 6], ['hero-mobile.png', 4, 6],
    ['other.png', 20, 10], ['other-desktop.png', 10, 5], ['other-mobile.png', 5, 5],
    ['portrait.png', 8, 12], ['portrait-desktop.png', 6, 6], ['portrait-mobile.png', 6, 4],
  ]) {
    await sharp({ create: { width, height, channels: 4, background: '#386fa5' } }).png().toFile(path.join(folder, name));
  }
  const config = {
    urlMappings: [{ urlPrefix: 'https://site.test/assets/', localRoot: 'assets' }],
    sourceGlobs: ['src/**/*.html'],
  };
  const report = (name, viewport) => ({ audits: { images: { details: { items: [
    { url: `https://site.test/assets/features/${name}-${viewport}.png`, totalBytes: 9000, wastedBytes: 1000 },
  ] } } } });
  const manifest = await analyzeReports({
    projectRoot: root,
    config,
    reportPairs: [
      { desktopReport: report('hero', 'desktop'), mobileReport: report('hero', 'mobile') },
      { desktopReport: report('other', 'desktop'), mobileReport: report('other', 'mobile') },
      { desktopReport: report('portrait', 'desktop'), mobileReport: report('portrait', 'mobile') },
    ],
  });
  assert.equal(manifest.entries.length, 3);
  const hero = manifest.entries.find((entry) => entry.source.endsWith('hero.png'));
  assert.ok(hero);
  assert.deepEqual(hero.variants.desktop.dimensions, { width: 6, height: 6 });
  assert.deepEqual(hero.variants.mobile.dimensions, { width: 4, height: 6 });
  const outputs = await optimizeManifest({ manifest, projectRoot: root });
  const heroDesktop = outputs.find((entry) => entry.source.endsWith('hero.png') && entry.viewport === 'desktop');
  const heroMobile = outputs.find((entry) => entry.source.endsWith('hero.png') && entry.viewport === 'mobile');
  assert.deepEqual(heroDesktop.dimensions, { width: 6, height: 4 });
  assert.deepEqual(heroMobile.dimensions, { width: 4, height: 3 });
  assert.equal(heroDesktop.output, 'assets/features/hero-desktop.png');
  assert.equal(heroMobile.output, 'assets/features/hero-mobile.png');
  const portraitDesktop = outputs.find((entry) => entry.source.endsWith('portrait.png') && entry.viewport === 'desktop');
  const portraitMobile = outputs.find((entry) => entry.source.endsWith('portrait.png') && entry.viewport === 'mobile');
  assert.deepEqual(portraitDesktop.dimensions, { width: 4, height: 6 });
  assert.deepEqual(portraitMobile.dimensions, { width: 3, height: 4 });
});


test('uses JPEG only when explicitly selected and writes JPEG variants', async (t) => {
  const root = await tempDir(); t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'assets/photo.png');
  await mkdir(path.dirname(source), { recursive: true });
  await sharp({ create: { width: 10, height: 6, channels: 3, background: '#8c4f27' } }).png().toFile(source);
  const manifest = { outputFormat: 'png', entries: [{ source: 'assets/photo.png', variants: {
    desktop: { dimensions: { width: 10, height: 6 }, targetBytes: null },
    mobile: { dimensions: { width: 10, height: 6 }, targetBytes: null },
  } }] };
  const results = await optimizeManifest({ manifest, projectRoot: root, outputFormat: 'jpeg', jpegQuality: 91 });
  assert.equal(manifest.outputFormat, 'jpeg');
  assert.equal(results[0].output, 'assets/photo-desktop.jpg');
  assert.equal((await sharp(path.join(root, results[0].output)).metadata()).format, 'jpeg');
  assert.equal(results[0].dimensions.width, 10);
  assert.equal(results[0].dimensions.height, 6);
});

test('previews and applies static picture/img references; reports unsupported references', async (t) => {
  const root = await tempDir(); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'), { recursive: true });
  const file = path.join(root, 'src/page.html');
  const initial = '<picture><source media="(max-width: 600px)" srcset="/images/hero.png"><img src="/images/hero.png"></picture>\n<img src="/images/other.png">\n<img src="<?= $dynamicHero ?>">';
  await writeFile(file, initial);
  const manifest = { sourceGlobs: ['src/**/*.html'], entries: [
    { source: 'public/images/hero.png', variants: { mobile: { output: 'public/images/hero-mobile.png' }, desktop: { output: 'public/images/hero-desktop.png' } } },
    { source: 'public/images/other.png', variants: { mobile: { output: 'public/images/other-mobile.png' }, desktop: { output: 'public/images/other-desktop.png' } } },
    { source: 'public/images/dynamic.png', variants: { mobile: { output: 'public/images/dynamic-mobile.png' }, desktop: { output: 'public/images/dynamic-desktop.png' } } },
  ] };
  const dry = await applyManifest({ manifest, projectRoot: root });
  assert.equal(dry.changedFiles, 1);
  assert.equal(dry.replacements, 3);
  assert.equal(dry.applied, false);
  assert.ok(dry.unsupported.some((item) => item.source.endsWith('dynamic.png')));
  assert.equal(await readFile(file, 'utf8'), initial);
  const applied = await applyManifest({ manifest, projectRoot: root, apply: true });
  assert.equal(applied.applied, true);
  const updated = await readFile(file, 'utf8');
  assert.match(updated, /hero-mobile\.png/);
  assert.match(updated, /hero-desktop\.png/);
  assert.match(updated, /other-desktop\.png/);
  assert.match(updated, /\$dynamicHero/);
});

test('leaves duplicate source basenames unresolved as ambiguous', () => {
  const contents = { 'src/page.html': '<img src="hero.png">' };
  const manifest = { entries: [
    { source: 'a/hero.png', variants: { desktop: { output: 'a/hero-desktop.png' }, mobile: { output: 'a/hero-mobile.png' } } },
    { source: 'b/hero.png', variants: { desktop: { output: 'b/hero-desktop.png' }, mobile: { output: 'b/hero-mobile.png' } } },
  ] };
  const plan = planReferenceUpdates(contents, manifest);
  assert.equal(plan.replacements.length, 0);
  assert.ok(plan.unsupported.every((item) => item.reason === 'ambiguous basename'));
});
