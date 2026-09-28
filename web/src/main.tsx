import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { buildZip } from './export-utils.mjs';
import { mergeSelectedFiles, type SelectedImage } from './selection.mjs';
import { clearSession, loadSession, saveSources, saveUiState, type AccessDirectoryHandle, type AccessHandle, type SourceHandle } from './session-store';
import './style.css';

type Viewport = 'desktop' | 'mobile';
type Format = 'png' | 'jpeg' | 'webp';
type Settings = { format: Format; quality: number; width: number; height: number; palette: boolean; colors: number };
type ImageDetails = SelectedImage & { width: number; height: number; originalUrl: string };
type ExportItem = { path: string; data: Uint8Array };

const INITIAL_FORMAT: Format = 'png';
const OUTPUT_EXTENSION: Record<Format, string> = { png: '.png', jpeg: '.jpg', webp: '.webp' };
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'tif', 'tiff', 'heic', 'heif']);
const defaults = (width: number, height: number): Record<Viewport, Settings> => ({
  desktop: { format: INITIAL_FORMAT, quality: 82, width, height, palette: false, colors: 64 },
  mobile: { format: INITIAL_FORMAT, quality: 82, width, height, palette: false, colors: 64 },
});
const settingsKey = (id: string, viewport: Viewport) => `${id}:${viewport}`;
const byteLabel = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;

function isImage(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return file.type.startsWith('image/') || IMAGE_EXTENSIONS.has(extension);
}

function readDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve({ width: image.naturalWidth, height: image.naturalHeight }); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name} is not a readable image`)); };
    image.src = url;
  });
}

function outputPath(image: ImageDetails, viewport: Viewport, format: Format) {
  const path = image.relativePath.replaceAll('\\', '/');
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const file = slash >= 0 ? path.slice(slash + 1) : path;
  const base = file.replace(/\.[^.]*$/, '') || 'image';
  return `${dir}${base}-${viewport}${OUTPUT_EXTENSION[format]}`;
}

async function renderRequest(endpoint: 'preview' | 'export', image: ImageDetails, viewport: Viewport, settings: Settings) {
  const params = new URLSearchParams({
    name: image.relativePath, viewport, format: settings.format, quality: String(settings.quality),
    width: String(settings.width), height: String(settings.height),
    palette: String(settings.palette), colors: String(settings.colors),
  });
  const response = await fetch(`/api/${endpoint}?${params}`, {
    method: 'POST', headers: { 'content-type': image.file.type || 'application/octet-stream' }, body: image.file,
  });
  if (!response.ok) {
    let message = `Image processing failed (${response.status})`;
    try { message = (await response.json()).error || message; } catch { /* Keep fallback. */ }
    throw new Error(message);
  }
  return response;
}

function VariantPanel({ image, viewport, settings, selected, onSettings, onSelect }: {
  image: ImageDetails; viewport: Viewport; settings: Settings; selected: boolean;
  onSettings: (settings: Settings) => void; onSelect: (selected: boolean) => void;
}) {
  const [previewUrl, setPreviewUrl] = useState('');
  const [showingOriginal, setShowingOriginal] = useState(false);
  const [previewSize, setPreviewSize] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setShowingOriginal(false);
    const timer = window.setTimeout(async () => {
      setLoading(true); setError('');
      try {
        const response = await renderRequest('preview', image, viewport, settings);
        const blob = await response.blob();
        const nextUrl = URL.createObjectURL(blob);
        if (active) {
          setPreviewUrl((previous) => { if (previous) URL.revokeObjectURL(previous); return nextUrl; });
          setPreviewSize(blob.size);
        } else URL.revokeObjectURL(nextUrl);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Unable to create preview');
      } finally { if (active) setLoading(false); }
    }, 160);
    return () => { active = false; window.clearTimeout(timer); };
  }, [image, viewport, settings.format, settings.quality, settings.width, settings.height, settings.palette, settings.colors]);

  const setDimension = (key: 'width' | 'height', value: string) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 30000) return;
    const aspectRatio = image.width / image.height;
    const dimensions = key === 'width'
      ? { width: number, height: Math.max(1, Math.round(number / aspectRatio)) }
      : { width: Math.max(1, Math.round(number * aspectRatio)), height: number };
    if (dimensions.width <= 30000 && dimensions.height <= 30000) onSettings({ ...settings, ...dimensions });
  };

  const downloadVariant = async () => {
    setDownloading(true); setError('');
    try {
      const response = await renderRequest('export', image, viewport, settings);
      const filename = outputPath(image, viewport, settings.format).split('/').pop() || 'image-output';
      download(await response.blob(), filename);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to download image'); }
    finally { setDownloading(false); }
  };

  return <section className="variant-panel">
    <div className="variant-title">
      <label className="check-label"><input type="checkbox" checked={selected} onChange={(event) => onSelect(event.target.checked)} />{viewport}</label>
      <span className="variant-actions"><span>{settings.width} × {settings.height}</span><button className="single-download" disabled={downloading} onClick={() => void downloadVariant()} title={`Download ${viewport} output`}>{downloading ? 'Preparing…' : '↓ Download'}</button></span>
    </div>
    <div className="preview checker" style={{ aspectRatio: `${image.width} / ${image.height}` }}>
      {showingOriginal ? <img src={image.originalUrl} alt="Original image comparison" /> : previewUrl ? <img src={previewUrl} alt={`${viewport} compressed preview`} /> : <span>{loading ? 'Rendering preview…' : error || 'Preview'}</span>}
      <button className="compare-toggle" disabled={!previewUrl} onClick={() => setShowingOriginal((value) => !value)}>{showingOriginal ? 'Show compressed' : 'Show original'}</button>
    </div>
    <div className="control-grid">
      <label>Format<select value={settings.format} onChange={(event) => onSettings({ ...settings, format: event.target.value as Format })}>
        <option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option>
      </select></label>
      {settings.format !== 'png' && <label>Quality <b>{settings.quality}</b><input type="range" min="1" max="100" value={settings.quality} onChange={(event) => onSettings({ ...settings, quality: Number(event.target.value) })} /></label>}
      {settings.format === 'png' && <div className="palette-settings"><label className="palette-toggle"><input type="checkbox" checked={settings.palette} onChange={(event) => onSettings({ ...settings, palette: event.target.checked })} /> Reduce palette</label><label className="palette-count">Colors <b>{settings.colors}</b><input type="range" min="2" max="256" value={settings.colors} disabled={!settings.palette} onChange={(event) => onSettings({ ...settings, colors: Number(event.target.value) })} /></label><small className="palette-hint">{settings.palette ? `Preview and export use up to ${settings.colors} colors` : 'Enable Reduce palette to apply the color limit'}</small></div>}
      <div className="dimension-fields"><label>Width<input type="number" min="1" max="30000" value={settings.width} onChange={(event) => setDimension('width', event.target.value)} /></label><label>Height<input type="number" min="1" max="30000" value={settings.height} onChange={(event) => setDimension('height', event.target.value)} /></label></div>
    </div>
    <div className="size-readout">
      <div className="size-stat original-stat"><span>Original</span><b>{byteLabel(image.file.size)}</b></div>
      <div className={`size-stat preview-stat ${previewSize !== null && previewSize < image.file.size ? 'smaller' : previewSize !== null ? 'larger' : ''}`}><span>Preview</span><b>{previewSize === null ? '—' : byteLabel(previewSize)}</b></div>
      <div className="size-stat savings-stat"><span>Estimated savings</span><b>{previewSize === null ? '—' : byteLabel(Math.abs(image.file.size - previewSize))}</b><small>{previewSize === null ? 'Waiting for preview' : previewSize < image.file.size ? `${Math.round((1 - previewSize / image.file.size) * 100)}% smaller` : previewSize > image.file.size ? `${Math.round((previewSize / image.file.size - 1) * 100)}% larger` : 'Same size'}</small></div>
    </div>
  </section>;
}

type FilePickerWindow = Window & {
  showDirectoryPicker?: () => Promise<AccessDirectoryHandle>;
  showOpenFilePicker?: (options?: { multiple?: boolean }) => Promise<AccessHandle[]>;
};
type FileCandidate = { file: File; relativePath: string };

function supportsPersistentPickers() {
  const picker = window as FilePickerWindow;
  return Boolean(indexedDB && picker.showDirectoryPicker && picker.showOpenFilePicker);
}

async function readDirectory(handle: AccessDirectoryHandle, prefix = handle.name): Promise<FileCandidate[]> {
  const images: FileCandidate[] = [];
  for await (const [name, child] of handle.entries()) {
    if (child.kind === 'directory') images.push(...await readDirectory(child, `${prefix}/${name}`));
    else images.push({ file: await child.getFile(), relativePath: `${prefix}/${name}` });
  }
  return images;
}

async function readSource(source: SourceHandle): Promise<FileCandidate[]> {
  return source.handle.kind === 'directory'
    ? readDirectory(source.handle)
    : [{ file: await source.handle.getFile(), relativePath: source.handle.name }];
}

function App() {
  const directoryInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const bootStarted = useRef(false);
  const dragDepth = useRef(0);
  const imagesRef = useRef<ImageDetails[]>([]);
  const [images, setImages] = useState<ImageDetails[]>([]);
  const [settings, setSettings] = useState<Record<string, Settings>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [exportMode, setExportMode] = useState<'zip' | 'individual'>('zip');
  const [sources, setSources] = useState<SourceHandle[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [restorePending, setRestorePending] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    directoryInput.current?.setAttribute('webkitdirectory', '');
    directoryInput.current?.setAttribute('directory', '');
  }, []);

  const selectedCount = useMemo(() => Object.values(selected).filter(Boolean).length, [selected]);

  const addCandidates = async (candidates: FileCandidate[], source?: SourceHandle, directory = false) => {
    if (!candidates.length) return;
    setScanning(true); setError(''); setNotice('');
    try {
      const valid = candidates.filter(({ file }) => isImage(file));
      const invalidCount = candidates.length - valid.length;
      const paths = new Map(valid.map(({ file, relativePath }) => [file, relativePath]));
      const filtered = source ? valid.filter(({ file, relativePath }) => !removedIds.includes(`${source.id}::${relativePath}`)) : valid;
      const filteredFiles = filtered.map(({ file }) => file);
      const currentImages = imagesRef.current;
      const merged = mergeSelectedFiles(currentImages, filteredFiles, {
        directory,
        getRelativePath: (file) => paths.get(file) || file.name,
        makeId: (file, relativePath) => source ? `${source.id}::${relativePath}` : crypto.randomUUID(),
      });
      const refreshed: ImageDetails[] = [];
      const rejected: string[] = [];
      for (const item of [...merged.added, ...merged.updated]) {
        try {
          const dimensions = await readDimensions(item.file);
          refreshed.push({ ...item, ...dimensions, originalUrl: URL.createObjectURL(item.file) });
        } catch { rejected.push(item.relativePath); }
      }
      const refreshedById = new Map(refreshed.map((image) => [image.id, image]));
      const nextImages = merged.images.map((item) => {
        const replacement = refreshedById.get(item.id);
        const prior = currentImages.find((image) => image.id === item.id);
        if (replacement) {
          if (prior && prior.originalUrl !== replacement.originalUrl) URL.revokeObjectURL(prior.originalUrl);
          return replacement;
        }
        return prior;
      }).filter((item): item is ImageDetails => Boolean(item));
      imagesRef.current = nextImages;
      setImages(nextImages);
      setSettings((prior) => {
        const updated = { ...prior };
        for (const image of refreshed.filter((entry) => merged.added.some((addition) => addition.id === entry.id))) {
          updated[settingsKey(image.id, 'desktop')] ??= defaults(image.width, image.height).desktop;
          updated[settingsKey(image.id, 'mobile')] ??= defaults(image.width, image.height).mobile;
        }
        return updated;
      });
      const addedCount = merged.added.filter((item) => refreshedById.has(item.id)).length;
      if (invalidCount || rejected.length) setNotice(`Added ${addedCount} image${addedCount === 1 ? '' : 's'}; skipped ${invalidCount + rejected.length} unsupported or unreadable file${invalidCount + rejected.length === 1 ? '' : 's'}.`);
      else if (addedCount) setNotice(`Added ${addedCount} image${addedCount === 1 ? '' : 's'}.`);
      else if (merged.updated.length) setNotice(`Updated ${merged.updated.length} image${merged.updated.length === 1 ? '' : 's'}.`);
      else setNotice(filtered.length === 0 && valid.length ? 'Previously removed images were skipped.' : 'Those images are already in the list.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to add images'); }
    finally { setScanning(false); }
  };

  const addFiles = (list: FileList | null, directory: boolean) => {
    if (!list?.length) return;
    const files = Array.from(list);
    return addCandidates(files.map((file) => ({ file, relativePath: directory ? (file.webkitRelativePath || file.name) : file.name })), undefined, directory);
  };

  const addSource = async (source: SourceHandle) => {
    setSources((old) => {
      const current = [...old, source];
      void saveSources(current).catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to save selected file handles'));
      return current;
    });
    try {
      await addCandidates(await readSource(source), source, source.handle.kind === 'directory');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to read the selected files');
    }
  };

  const pickDirectory = async () => {
    const picker = window as FilePickerWindow;
    if (!picker.showDirectoryPicker) { directoryInput.current?.click(); return; }
    try { const handle = await picker.showDirectoryPicker(); await addSource({ id: crypto.randomUUID(), handle }); }
    catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : 'Unable to select folder'); }
  };

  const pickFiles = async () => {
    const picker = window as FilePickerWindow;
    if (!picker.showOpenFilePicker) { filesInput.current?.click(); return; }
    try {
      const handles = await picker.showOpenFilePicker({ multiple: true });
      for (const handle of handles) await addSource({ id: crypto.randomUUID(), handle });
    } catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : 'Unable to select files'); }
  };

  const restoreFiles = async () => {
    setScanning(true); setError('');
    try {
      for (const source of sources) {
        let permission = await source.handle.queryPermission({ mode: 'read' });
        if (permission !== 'granted') permission = await source.handle.requestPermission({ mode: 'read' });
        if (permission !== 'granted') throw new Error(`Read permission was not granted for ${source.handle.name}`);
      }
      for (const source of sources) await addCandidates(await readSource(source), source, source.handle.kind === 'directory');
      setRestorePending(false);
      setNotice('Previous image session restored.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to restore the previous session'); }
    finally { setScanning(false); }
  };

  useEffect(() => {
    if (bootStarted.current) return;
    bootStarted.current = true;
    void (async () => {
      try {
        const saved = await loadSession();
        if (saved.state) {
          const restoredSettings: Record<string, Settings> = {};
          for (const [key, value] of Object.entries(saved.state.settings)) {
            const previous = value as Partial<Settings>;
            restoredSettings[key] = { format: previous.format || INITIAL_FORMAT, quality: previous.quality ?? 82, width: previous.width ?? 1, height: previous.height ?? 1, palette: previous.palette ?? false, colors: previous.colors ?? 64 };
          }
          setSettings(restoredSettings);
          setSelected(saved.state.selected);
          setExportMode(saved.state.exportMode);
          setRemovedIds(saved.state.removedIds || []);
        }
        setSources(saved.sources);
        if (saved.sources.length && supportsPersistentPickers()) {
          const permissions = await Promise.all(saved.sources.map((source) => source.handle.queryPermission({ mode: 'read' })));
          if (permissions.every((permission) => permission === 'granted')) {
            for (const source of saved.sources) await addCandidates(await readSource(source), source, source.handle.kind === 'directory');
          } else setRestorePending(true);
        } else if (saved.sources.length) setNotice('This browser cannot restore saved file handles. Select your files again.');
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load the previous image session'); }
      finally { setReady(true); }
    })();
  }, []);

  useEffect(() => {
    if (!ready) return;
    void saveUiState({ settings, selected, exportMode, removedIds }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to save image settings'));
  }, [ready, settings, selected, exportMode, removedIds]);

  useEffect(() => {
    if (ready) void saveSources(sources).catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to save selected file handles'));
  }, [ready, sources]);

  const updateSettings = (id: string, viewport: Viewport, value: Settings) => setSettings((old) => ({ ...old, [settingsKey(id, viewport)]: value }));
  const updateSelection = (id: string, viewport: Viewport, value: boolean) => setSelected((old) => ({ ...old, [settingsKey(id, viewport)]: value }));

  const exportSelected = async () => {
    const choices = images.flatMap((image) => (['desktop', 'mobile'] as const)
      .filter((viewport) => selected[settingsKey(image.id, viewport)])
      .map((viewport) => ({ image, viewport, settings: settings[settingsKey(image.id, viewport)] || defaults(image.width, image.height)[viewport] })));
    if (!choices.length) { setError('Select at least one desktop or mobile output.'); return; }
    setExporting(true); setError(''); setNotice('');
    const outputs: ExportItem[] = [];
    try {
      for (const choice of choices) {
        const response = await renderRequest('export', choice.image, choice.viewport, choice.settings);
        outputs.push({ path: outputPath(choice.image, choice.viewport, choice.settings.format), data: new Uint8Array(await response.arrayBuffer()) });
      }
      if (exportMode === 'zip') {
        const archive = await buildZip(outputs);
        download(blobFromBytes(archive, 'application/zip'), 'image-exports.zip');
      } else outputs.forEach((output) => download(blobFromBytes(output.data), output.path.split('/').pop() || 'image-output'));
      setNotice(`Exported ${outputs.length} variant${outputs.length === 1 ? '' : 's'}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Export failed'); }
    finally { setExporting(false); }
  };

  const removeImage = (id: string) => {
    setImages((old) => {
      const removed = old.find((image) => image.id === id);
      if (removed) URL.revokeObjectURL(removed.originalUrl);
      const next = old.filter((image) => image.id !== id);
      imagesRef.current = next;
      return next;
    });
    setRemovedIds((old) => old.includes(id) ? old : [...old, id]);
    setSources((old) => old.filter((source) => source.handle.kind !== 'file' || !id.startsWith(`${source.id}::`)));
    setSelected((old) => { const next = { ...old }; delete next[settingsKey(id, 'desktop')]; delete next[settingsKey(id, 'mobile')]; return next; });
    setSettings((old) => { const next = { ...old }; delete next[settingsKey(id, 'desktop')]; delete next[settingsKey(id, 'mobile')]; return next; });
  };

  const clearAll = async () => {
    images.forEach((image) => URL.revokeObjectURL(image.originalUrl));
    imagesRef.current = [];
    setImages([]); setSettings({}); setSelected({}); setSources([]); setRemovedIds([]); setRestorePending(false); setNotice(''); setError('');
    await clearSession().catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to clear the saved session'));
  };

  return <main
    onDragEnter={(event) => {
      if (!Array.from(event.dataTransfer.types).includes('Files')) return;
      event.preventDefault();
      dragDepth.current++;
      setDraggingFiles(true);
    }}
    onDragOver={(event) => {
      if (!Array.from(event.dataTransfer.types).includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }}
    onDragLeave={(event) => {
      if (!Array.from(event.dataTransfer.types).includes('Files')) return;
      event.preventDefault();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDraggingFiles(false);
    }}
    onDrop={(event) => {
      if (!Array.from(event.dataTransfer.types).includes('Files')) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDraggingFiles(false);
      void addFiles(event.dataTransfer.files, false);
    }}
  >
    {draggingFiles && <div className="page-drop-overlay" role="status" aria-live="polite"><div><span className="drop-icon">＋</span><b>Drop images to add them</b><small>Image files only · originals stay on your device</small></div></div>}
    <header className="topbar">
      <div className="toolbar-pickers">
        <button className="picker-button" onClick={() => void pickDirectory()}><span className="picker-icon">▧</span><span><b>Select a folder</b><small>Includes nested folders</small></span></button>
        <button className="picker-button" onClick={() => void pickFiles()}><span className="picker-icon">＋</span><span><b>Add image files</b><small>Select one or more images</small></span></button>
        {images.length > 0 && <button className="clear-button" onClick={() => void clearAll()}>Clear all</button>}
        <input ref={directoryInput} hidden type="file" multiple accept="image/*" onChange={(event) => { void addFiles(event.target.files, true); event.target.value = ''; }} />
        <input ref={filesInput} hidden type="file" multiple accept="image/*" onChange={(event) => { void addFiles(event.target.files, false); event.target.value = ''; }} />
      </div>
      <div className="export-tools toolbar-download"><label>Download as<select value={exportMode} onChange={(event) => setExportMode(event.target.value as 'zip' | 'individual')}><option value="zip">ZIP archive</option><option value="individual">Individual files</option></select></label></div>
      <div className="header-tools"><span className="image-count">{images.length} images · {selectedCount} selected</span><button className="primary" disabled={!selectedCount || exporting} onClick={exportSelected}>{exporting ? 'Preparing…' : 'Export selected'}</button></div>
    </header>
    <section className="intro"><div><p className="eyebrow">Image optimization</p><h1>Choose images to optimize</h1><p>Select a folder, add individual files, or drop images anywhere on this page. Your originals stay on your device.</p></div></section>
    {!supportsPersistentPickers() && <p className="persistence-note">This browser can’t restore selected files after refresh. Reselect them to continue.</p>}
    {restorePending && <div className="restore-session"><span>Previous images are saved. Allow file access to restore them.</span><button onClick={() => void restoreFiles()} disabled={scanning}>Restore previous session</button></div>}
    {(notice || error) && <div className={`notice ${error ? 'error' : 'success'}`}>{error || notice}<button onClick={() => { setError(''); setNotice(''); }}>Dismiss</button></div>}
    {images.length === 0 ? <div className="empty-state"><div className="empty-icon">▤</div><h2>{scanning ? 'Reading selected images…' : 'Nothing selected yet'}</h2><p>Choose a directory or add individual image files to begin.</p></div> : <div className="image-list"><div className="list-head"><span>Original</span><span>Desktop output</span><span>Mobile output</span></div>
      {images.map((image, index) => <article className="image-row" key={image.id}>
        <div className="image-row-heading"><div className="image-name"><span>{String(index + 1).padStart(2, '0')}</span><div><b title={image.relativePath}>{image.relativePath.split('/').pop()}</b><small title={image.relativePath}>{image.relativePath}</small></div></div><button className="remove-button" title="Remove image" onClick={() => removeImage(image.id)}>Remove</button></div>
        <div className="image-row-content"><div className="source-cell"><div className="source-thumb checker" style={{ aspectRatio: `${image.width} / ${image.height}` }}><img src={image.originalUrl} alt="Original" /></div><div className="source-meta"><small>{image.width} × {image.height}</small><div className="source-file-size"><span>Original file</span><b>{byteLabel(image.file.size)}</b></div></div></div>
          {(['desktop', 'mobile'] as const).map((viewport) => <VariantPanel key={settingsKey(image.id, viewport)} image={image} viewport={viewport} settings={settings[settingsKey(image.id, viewport)] || defaults(image.width, image.height)[viewport]} selected={!!selected[settingsKey(image.id, viewport)]} onSettings={(value) => updateSettings(image.id, viewport, value)} onSelect={(value) => updateSelection(image.id, viewport, value)} />)}
        </div>
      </article>)}
    </div>}
    <footer>Local processing only · Original files are never modified</footer>
  </main>;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function blobFromBytes(bytes: Uint8Array, type = 'application/octet-stream') {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type });
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
