const fingerprint = (file) => `${file.name}\0${file.size}\0${file.lastModified}`;
const cleanPath = (value) => value.replaceAll('\\', '/').replace(/^\/+/, '');

export function mergeSelectedFiles(current, files, {
  directory = false,
  makeId = () => crypto.randomUUID(),
  getRelativePath = (file) => directory ? (file.webkitRelativePath || file.name) : file.name,
} = {}) {
  const images = [...current];
  const added = [];
  const updated = [];
  for (const file of files) {
    const relativePath = cleanPath(getRelativePath(file));
    const signature = fingerprint(file);
    if (directory) {
      const samePath = images.find((image) => image.relativePath === relativePath);
      if (samePath) {
        if (samePath.fingerprint !== signature) {
          const replacement = { ...samePath, file, fingerprint: signature, directory: true };
          images[images.indexOf(samePath)] = replacement;
          updated.push(replacement);
        }
        continue;
      }
      const looseMatchIndex = images.findIndex((image) => !image.directory && image.fingerprint === signature);
      if (looseMatchIndex >= 0) {
        const replacement = { ...images[looseMatchIndex], file, relativePath, fingerprint: signature, directory: true };
        images[looseMatchIndex] = replacement;
        updated.push(replacement);
        continue;
      }
    } else if (images.some((image) => image.fingerprint === signature)) {
      continue;
    }
    const image = { id: makeId(file, relativePath), file, relativePath, fingerprint: signature, directory };
    images.push(image);
    added.push(image);
  }
  return { images, added, updated };
}
