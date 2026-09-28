import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import JSZip from 'jszip';
import { startWebServer } from '../server.mjs';
import { encodeBuffer } from '../../shared/image-processing.mjs';
import { mergeSelectedFiles } from '../src/selection.mjs';
import { buildZip } from '../src/export-utils.mjs';

test('directory and standalone file selections merge and deduplicate', () => {
  const makeFile = (name, size, lastModified, webkitRelativePath = '') => ({ name, size, lastModified, webkitRelativePath });
  const directoryImage = makeFile('hero.png', 10, 123, 'site/images/hero.png');
  const { images: fromDirectory } = mergeSelectedFiles([], [directoryImage], { directory: true, makeId: () => 'hero' });
  const duplicateStandalone = makeFile('hero.png', 10, 123);
  const extraStandalone = makeFile('icon.webp', 7, 200);
  const merged = mergeSelectedFiles(fromDirectory, [duplicateStandalone, extraStandalone], { directory: false, makeId: () => 'icon' });
  assert.equal(merged.images.length, 2);
  assert.equal(merged.added.length, 1);
  assert.equal(merged.images[0].relativePath, 'site/images/hero.png');
  assert.equal(merged.images[1].relativePath, 'icon.webp');
});

test('choosing a directory after the same individual file preserves its directory path', () => {
  const direct = { name: 'hero.png', size: 10, lastModified: 123 };
  const folderFile = { ...direct, webkitRelativePath: 'site/nested/hero.png' };
  const first = mergeSelectedFiles([], [direct], { makeId: () => 'same' });
  const second = mergeSelectedFiles(first.images, [folderFile], { directory: true });
  assert.equal(second.images.length, 1);
  assert.equal(second.images[0].id, 'same');
  assert.equal(second.images[0].relativePath, 'site/nested/hero.png');
});

test('replacing an image at the same directory path refreshes its file reference', () => {
  const oldFile = { name: 'hero.png', size: 10, lastModified: 123, webkitRelativePath: 'site/hero.png' };
  const changedFile = { ...oldFile, size: 14, lastModified: 456 };
  const first = mergeSelectedFiles([], [oldFile], { directory: true, makeId: () => 'hero' });
  const changed = mergeSelectedFiles(first.images, [changedFile], { directory: true });
  assert.equal(changed.images.length, 1);
  assert.equal(changed.updated.length, 1);
  assert.equal(changed.images[0].id, 'hero');
  assert.equal(changed.images[0].file, changedFile);
});

test('web API previews in memory and returns selected export bytes with a safe filename', async (t) => {
  const { server, url } = await startWebServer({ port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const original = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#246b58' } }).png().toBuffer();
  const originalCopy = Buffer.from(original);
  const params = new URLSearchParams({ name: 'photos/nature/hero.png', viewport: 'mobile', format: 'webp', quality: '73', width: '12', height: '10' });
  const preview = await fetch(`${url}/api/preview?${params}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: original });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('x-image-width'), '12');
  assert.equal(preview.headers.get('x-image-height'), '8');
  const previewBuffer = Buffer.from(await preview.arrayBuffer());
  const previewMeta = await sharp(previewBuffer).metadata();
  assert.equal(previewMeta.format, 'webp');
  assert.deepEqual([previewMeta.width, previewMeta.height], [12, 8]);
  assert.deepEqual(original, originalCopy);

  const exported = await fetch(`${url}/api/export?${params}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: original });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /hero-mobile\.webp/);
  assert.deepEqual(Buffer.from(await exported.arrayBuffer()), previewBuffer);

  const bad = await fetch(`${url}/api/preview?${new URLSearchParams({ ...Object.fromEntries(params), quality: '0' })}`, { method: 'POST', body: original });
  assert.equal(bad.status, 400);
  const invalidImage = await fetch(`${url}/api/preview?${params}`, { method: 'POST', body: Buffer.from('not an image') });
  assert.equal(invalidImage.status, 400);

  const paletteParams = new URLSearchParams({ name: 'palette.png', viewport: 'desktop', format: 'png', quality: '82', width: '24', height: '16', palette: 'true', colors: '16' });
  const paletteResponse = await fetch(`${url}/api/preview?${paletteParams}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: original });
  assert.equal(paletteResponse.status, 200);
  assert.equal((await sharp(Buffer.from(await paletteResponse.arrayBuffer())).metadata()).isPalette, true);
  const paletteExport = await fetch(`${url}/api/export?${paletteParams}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: original });
  assert.equal((await sharp(Buffer.from(await paletteExport.arrayBuffer())).metadata()).isPalette, true);
  const invalidPalette = await fetch(`${url}/api/preview?${new URLSearchParams({ ...Object.fromEntries(paletteParams), colors: '1' })}`, { method: 'POST', body: original });
  assert.equal(invalidPalette.status, 400);

  const gradientPixels = Buffer.alloc(64 * 64 * 3);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const offset = (y * 64 + x) * 3;
    gradientPixels[offset] = x * 4;
    gradientPixels[offset + 1] = y * 4;
    gradientPixels[offset + 2] = (x + y) * 2;
  }
  const gradient = await sharp(gradientPixels, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
  const renderWithColorLimit = async (colors) => {
    const query = new URLSearchParams({ name: 'gradient.png', viewport: 'desktop', format: 'png', quality: '82', width: '64', height: '64', palette: 'true', colors: String(colors) });
    const response = await fetch(`${url}/api/preview?${query}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: gradient });
    assert.equal(response.status, 200);
    return Buffer.from(await response.arrayBuffer());
  };
  const twoColors = await renderWithColorLimit(2);
  const sixteenColors = await renderWithColorLimit(16);
  assert.notDeepEqual(twoColors, sixteenColors);
  assert.notEqual(twoColors.length, sixteenColors.length);
});

test('ZIP archive preserves selected relative paths and variant filenames', async () => {
  const archiveBytes = await buildZip([
    { path: 'site/images/hero-desktop.webp', data: new Uint8Array([1, 2, 3]) },
    { path: 'standalone/logo-mobile.png', data: new Uint8Array([4, 5]) },
  ]);
  const archive = await JSZip.loadAsync(archiveBytes);
  assert.deepEqual(Object.keys(archive.files).filter((name) => !archive.files[name].dir).sort(), ['site/images/hero-desktop.webp', 'standalone/logo-mobile.png']);
  assert.deepEqual([...await archive.file('site/images/hero-desktop.webp').async('uint8array')], [1, 2, 3]);
});

test('PNG palette slider enforces its color limit and visibly changes the result', async () => {
  const width = 96;
  const height = 96;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    pixels[offset] = Math.round(x / (width - 1) * 255);
    pixels[offset + 1] = Math.round(y / (height - 1) * 255);
    pixels[offset + 2] = Math.round((x + y) / (width + height - 2) * 255);
  }
  const input = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const settings = { input, dimensions: { width, height }, format: 'png', quality: 82, palette: true };
  const countColors = async (buffer) => {
    const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const colors = new Set();
    for (let offset = 0; offset < data.length; offset += info.channels) colors.add(`${data[offset]},${data[offset + 1]},${data[offset + 2]}`);
    return colors.size;
  };
  const low = await encodeBuffer({ ...settings, colors: 8 });
  const high = await encodeBuffer({ ...settings, colors: 32 });
  const lowCount = await countColors(low.data);
  const highCount = await countColors(high.data);
  assert.ok(lowCount <= 8, `expected at most 8 colors, received ${lowCount}`);
  assert.ok(highCount <= 32, `expected at most 32 colors, received ${highCount}`);
  assert.ok(highCount > lowCount, `expected 32-color setting to retain more colors than 8-color setting (${lowCount}, ${highCount})`);
  assert.notEqual(low.data.length, high.data.length);
});
