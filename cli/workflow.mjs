import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { globSync } from 'glob';
import { createTwoFilesPatch } from 'diff';
import { encodeImage, validateEncodingSettings, variantPath } from '../shared/image-processing.mjs';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const SAVINGS_KEYS = [
  'wastedBytes',
  'overallSavingsBytes',
  'potentialSavingsBytes',
  'savingsBytes',
  'totalByteSavings',
];
const SIZE_KEYS = ['totalBytes', 'resourceSize', 'transferSize', 'encodedBodySize'];

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export function parseLighthouseReport(report, viewport) {
  const audits = report?.audits;
  if (!audits || typeof audits !== 'object') {
    throw new Error(`${viewport} report has no Lighthouse audits object`);
  }

  const found = new Map();
  const visited = new Set();
  function visit(value, auditId = 'unknown') {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, auditId);
      return;
    }

    const url = typeof value.url === 'string' ? value.url : null;
    if (url && isSupportedImageUrl(url)) {
      const saving = maxNumber(value, SAVINGS_KEYS);
      const bytes = maxNumber(value, SIZE_KEYS);
      const record = {
        url,
        viewport,
        auditId,
        estimatedSavingsBytes: saving,
        reportedBytes: bytes,
        targetBytes: saving !== null && bytes !== null ? Math.max(0, bytes - saving) : null,
      };
      const key = normalizeUrl(url);
      const previous = found.get(key);
      if (!previous) found.set(key, record);
      else {
        previous.estimatedSavingsBytes = maxNullable(previous.estimatedSavingsBytes, saving);
        previous.reportedBytes = maxNullable(previous.reportedBytes, bytes);
        previous.targetBytes = minNullable(previous.targetBytes, record.targetBytes);
        previous.auditIds ??= [previous.auditId];
        previous.auditIds.push(auditId);
      }
    }

    for (const [key, child] of Object.entries(value)) visit(child, auditId === 'unknown' ? key : auditId);
  }
  visit(audits);
  return [...found.values()];
}

function maxNumber(object, keys) {
  const values = keys.map((key) => object[key]).filter((value) => Number.isFinite(value) && value >= 0);
  return values.length ? Math.max(...values) : null;
}
function maxNullable(a, b) { return a === null ? b : b === null ? a : Math.max(a, b); }
function minNullable(a, b) { return a === null ? b : b === null ? a : Math.min(a, b); }
function isSupportedImageUrl(url) {
  try { return IMAGE_EXTENSIONS.has(path.extname(new URL(url, 'https://lh.local').pathname).toLowerCase()); }
  catch { return false; }
}
function normalizeUrl(url) {
  try {
    const parsed = new URL(url, 'https://lh.local');
    parsed.hash = '';
    return parsed.href;
  } catch { return url; }
}
function pathnameOf(url) {
  try { return decodeURIComponent(new URL(url, 'https://lh.local').pathname); }
  catch { return null; }
}

export async function loadProjectConfig(projectRoot, configPath) {
  const resolvedPath = path.resolve(projectRoot, configPath);
  const config = await readJson(resolvedPath);
  if (!Array.isArray(config.urlMappings) || config.urlMappings.length === 0) {
    throw new Error('Config must define at least one urlMappings entry');
  }
  if (!Array.isArray(config.sourceGlobs) || config.sourceGlobs.length === 0) {
    throw new Error('Config must define at least one sourceGlobs entry');
  }
  for (const mapping of config.urlMappings) {
    if (!mapping.urlPrefix || !mapping.localRoot) throw new Error('Each urlMappings entry needs urlPrefix and localRoot');
  }
  return config;
}

function resolveLocalUrl(url, projectRoot, mappings) {
  const pathname = pathnameOf(url);
  if (!pathname) return { status: 'unmapped', reason: 'invalid image URL' };
  const matches = mappings.flatMap((mapping) => {
    const prefixPath = pathnameOf(mapping.urlPrefix) ?? mapping.urlPrefix;
    const prefix = prefixPath.endsWith('/') ? prefixPath : `${prefixPath}/`;
    let originMatches = true;
    try {
      const mapUrl = new URL(mapping.urlPrefix);
      const reportUrl = new URL(url, mapUrl.origin);
      originMatches = mapUrl.origin === reportUrl.origin;
    } catch { /* A path-only prefix matches by path. */ }
    if (!originMatches || !pathname.startsWith(prefix)) return [];
    return [{ mapping, prefix, suffix: pathname.slice(prefix.length) }];
  });
  if (!matches.length) return { status: 'unmapped', reason: 'no URL prefix mapping matched' };
  const longest = Math.max(...matches.map((match) => match.prefix.length));
  const best = matches.filter((match) => match.prefix.length === longest);
  const localPaths = new Set(best.map(({ mapping, suffix }) => path.resolve(projectRoot, mapping.localRoot, suffix)));
  if (localPaths.size !== 1) return { status: 'ambiguous', reason: 'multiple URL mappings resolve this image' };
  const localPath = [...localPaths][0];
  if (!isInside(projectRoot, localPath)) return { status: 'unmapped', reason: 'mapped path escapes project root' };
  if (!existsSync(localPath)) return { status: 'unmapped', reason: 'mapped local image does not exist', localPath };
  if (!IMAGE_EXTENSIONS.has(path.extname(localPath).toLowerCase())) return { status: 'unmapped', reason: 'unsupported local image format', localPath };
  return { status: 'mapped', localPath };
}
function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function analyzeReports({ projectRoot, config, desktopReport, mobileReport, reportPairs, outputFormat = 'png' }) {
  if (!['png', 'jpeg', 'webp'].includes(outputFormat)) throw new Error(`Unsupported output format: ${outputFormat}`);
  const pairs = reportPairs?.length ? reportPairs : [{ desktopReport, mobileReport }];
  const bySource = new Map();
  const unresolved = [];
  for (const pair of pairs) {
    for (const viewport of ['desktop', 'mobile']) {
      const report = viewport === 'desktop' ? pair.desktopReport : pair.mobileReport;
      for (const item of parseLighthouseReport(report, viewport)) {
        const resolved = resolveLocalUrl(item.url, projectRoot, config.urlMappings);
        if (resolved.status !== 'mapped') {
          unresolved.push({ ...item, mappingStatus: resolved.status, reason: resolved.reason, localPath: resolved.localPath ?? null });
          continue;
        }
        const reportedMetadata = await sharp(resolved.localPath).metadata();
        const canonicalPath = canonicalSourcePath(resolved.localPath);
        const source = path.relative(projectRoot, canonicalPath).split(path.sep).join('/');
        let entry = bySource.get(source);
        if (!entry) {
          const metadata = await sharp(canonicalPath).metadata();
          const override = config.dimensions?.[source] ?? {};
          entry = {
            source,
            sourceUrl: item.url,
            sourceDimensions: { width: metadata.width, height: metadata.height },
            mappingStatus: 'mapped',
            variants: {},
          };
          for (const side of ['desktop', 'mobile']) {
            const dimensions = override[side] ?? entry.sourceDimensions;
            entry.variants[side] = {
              output: variantPath(source, side, outputFormat),
              format: outputFormat,
              quality: config[`${outputFormat}Quality`] ?? config.jpegQuality ?? 90,
              dimensions: { width: dimensions.width, height: dimensions.height },
              targetBytes: null,
              estimatedSavingsBytes: null,
              reportedBytes: null,
              audits: [],
            };
          }
          bySource.set(source, entry);
        }
        const variant = entry.variants[viewport];
        if (!config.dimensions?.[source]?.[viewport]) {
          variant.dimensions.width = Math.min(variant.dimensions.width, reportedMetadata.width);
          variant.dimensions.height = Math.min(variant.dimensions.height, reportedMetadata.height);
        }
        variant.targetBytes = minNullable(variant.targetBytes, item.targetBytes);
        variant.estimatedSavingsBytes = maxNullable(variant.estimatedSavingsBytes, item.estimatedSavingsBytes);
        variant.reportedBytes = maxNullable(variant.reportedBytes, item.reportedBytes);
        variant.audits.push({ id: item.auditId, url: item.url });
      }
    }
  }

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    projectRoot: path.resolve(projectRoot),
    outputFormat,
    jpegQuality: config.jpegQuality ?? 90,
    sourceGlobs: config.sourceGlobs,
    entries: [...bySource.values()],
    unresolved,
  };
}

function canonicalSourcePath(reportedPath) {
  const parsed = path.parse(reportedPath);
  const match = parsed.name.match(/-(desktop|mobile)$/i);
  if (!match) return reportedPath;
  const sourcePath = path.join(parsed.dir, `${parsed.name.slice(0, -match[0].length)}${parsed.ext}`);
  return existsSync(sourcePath) ? sourcePath : reportedPath;
}

export async function optimizeManifest({ manifest, projectRoot, outputFormat, jpegQuality }) {
  const format = outputFormat ?? manifest.outputFormat ?? 'png';
  if (!['png', 'jpeg', 'webp'].includes(format)) throw new Error(`Unsupported output format: ${format}`);
  const quality = jpegQuality ?? manifest.jpegQuality ?? 90;
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error('JPEG quality must be an integer from 1 to 100');
  const results = [];

  for (const entry of manifest.entries) {
    const source = path.resolve(projectRoot, entry.source);
    if (!isInside(projectRoot, source) || !existsSync(source)) throw new Error(`Missing or unsafe source image: ${entry.source}`);
    const originalName = path.basename(source, path.extname(source));
    for (const viewport of ['desktop', 'mobile']) {
      const variant = entry.variants[viewport];
      const variantFormat = outputFormat ?? variant.format ?? format;
      const quality = jpegQuality ?? variant.quality ?? manifest.jpegQuality ?? 90;
      validateEncodingSettings(variantFormat, quality, variant.dimensions);
      const dimensions = variant.dimensions;
      const extension = variantFormat === 'jpeg' ? '.jpg' : variantFormat === 'webp' ? '.webp' : '.png';
      const outputRelative = path.posix.join(path.posix.dirname(entry.source), `${originalName}-${viewport}${extension}`);
      const output = path.resolve(projectRoot, outputRelative);
      const outMeta = await encodeImage({ source, output, dimensions, format: variantFormat, quality });
      const targetBytes = variant.targetBytes;
      results.push({
        source: entry.source,
        viewport,
        output: outputRelative,
        dimensions: { width: outMeta.width, height: outMeta.height },
        bytes: outMeta.size,
        targetBytes,
        overTargetBytes: targetBytes === null ? null : Math.max(0, outMeta.size - targetBytes),
      });
      variant.output = outputRelative;
      variant.format = variantFormat;
      variant.quality = quality;
      variant.actualBytes = outMeta.size;
      variant.actualDimensions = { width: outMeta.width, height: outMeta.height };
      variant.overTargetBytes = targetBytes === null ? null : Math.max(0, outMeta.size - targetBytes);
    }
  }
  manifest.outputFormat = format;
  manifest.jpegQuality = quality;
  return results;
}

export function planReferenceUpdates(contentsByFile, manifest) {
  const changes = [];
  const unsupported = [];
  const entries = manifest.entries;
  const ambiguousNames = new Map();
  for (const entry of entries) {
    const base = path.posix.basename(entry.source);
    ambiguousNames.set(base, (ambiguousNames.get(base) ?? 0) + 1);
  }

  for (const [file, originalText] of Object.entries(contentsByFile)) {
    let text = originalText;
    const alreadyApplied = new Set();
    const updateTag = (tag, viewport, entry) => {
      const sourceName = path.posix.basename(entry.source);
      const outputName = path.posix.basename(entry.variants[viewport].output);
      return tag.replace(/\b(src(?:set)?)\s*=\s*(["'])([\s\S]*?)\2/gi, (full, attr, quote, value) => {
        const hasSourcePath = value.includes(entry.source) || value.includes(entry.source.replaceAll('/', path.sep));
        if (!hasSourcePath && ambiguousNames.get(sourceName) > 1) return full;
        const escaped = escapeRegExp(sourceName);
        const matcher = new RegExp(`${escaped}(?![-\\w])`);
        if (!matcher.test(value)) return full;
        const next = value.replace(matcher, outputName);
        changes.push({ file, viewport, before: value, after: next, source: entry.source });
        alreadyApplied.add(entry.source);
        return `${attr}=${quote}${next}${quote}`;
      });
    };

    text = text.replace(/<picture\b[\s\S]*?<\/picture>/gi, (picture) => {
      picture = picture.replace(/<source\b[^>]*>/gi, (tag) => {
        let next = tag;
        for (const entry of entries) next = updateTag(next, 'mobile', entry);
        return next;
      });
      return picture.replace(/<img\b[^>]*>/gi, (tag) => {
        let next = tag;
        for (const entry of entries) next = updateTag(next, 'desktop', entry);
        return next;
      });
    });
    text = text.replace(/<img\b[^>]*>/gi, (tag) => {
      let next = tag;
      for (const entry of entries) next = updateTag(next, 'desktop', entry);
      return next;
    });

    if (text !== originalText) changes.push({ file, originalText, updatedText: text });
  }

  const changedSources = new Set(changes.filter((change) => change.source).map((change) => change.source));
  for (const entry of entries) {
    if (changedSources.has(entry.source)) continue;
    const outputs = [entry.variants.mobile.output, entry.variants.desktop.output].map((name) => path.posix.basename(name));
    const allText = Object.values(contentsByFile).join('\n');
    if (outputs.every((name) => allText.includes(name))) continue;
    unsupported.push({ source: entry.source, reason: ambiguousNames.get(path.posix.basename(entry.source)) > 1 ? 'ambiguous basename' : 'no direct existing image reference found' });
  }
  const fileChanges = changes.filter((item) => item.originalText !== undefined);
  return { fileChanges, replacements: changes.filter((item) => item.before !== undefined), unsupported };
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export async function applyManifest({ manifest, projectRoot, apply = false }) {
  const files = manifest.sourceGlobs.flatMap((pattern) => globSync(pattern, { cwd: projectRoot, nodir: true }));
  const uniqueFiles = [...new Set(files)].sort();
  const contents = {};
  for (const rel of uniqueFiles) contents[rel] = await readFile(path.join(projectRoot, rel), 'utf8');
  const plan = planReferenceUpdates(contents, manifest);
  for (const change of plan.fileChanges) {
    const patch = createTwoFilesPatch(change.file, change.file, change.originalText, change.updatedText, 'before', 'after');
    process.stdout.write(patch);
    if (apply) await writeFile(path.join(projectRoot, change.file), change.updatedText);
  }
  return { changedFiles: plan.fileChanges.length, replacements: plan.replacements.length, unsupported: plan.unsupported, applied: apply };
}
