export const MAX_ATTACHMENTS = 8;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

export function formatFileSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function attachmentKind(file) {
  if (/^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(file.mimeType || file.type || "") || /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(file.name)) return "image";
  if ((file.mimeType || file.type) === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
  if (/^text\//.test(file.mimeType || file.type || "") || /\.(txt|md|csv|tsv|json|ya?ml|xml|log|js|ts|py|css|html)$/i.test(file.name)) return "text";
  return "file";
}

export function transferFiles(transfer) {
  const files = Array.from(transfer?.files || []);
  if (files.length) return files;
  return Array.from(transfer?.items || []).filter(item => item.kind === "file").map(item => item.getAsFile()).filter(Boolean);
}

export function hasTransferFiles(transfer) {
  return Array.from(transfer?.types || []).includes("Files") || Array.from(transfer?.items || []).some(item => item.kind === "file");
}

// Decide the whole batch before reading bytes, so concurrent selections share the same limits.
export function selectAttachments(current, incoming) {
  const accepted = [], errors = [];
  let total = current.reduce((sum, item) => sum + item.size, 0);
  const fingerprints = new Set(current.map(item => item.fingerprint));
  for (const file of incoming) {
    const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
    if (fingerprints.has(fingerprint)) continue;
    if (!file.size) { errors.push(`${file.name} 是空文件`); continue; }
    if (file.size > MAX_FILE_BYTES) { errors.push(`${file.name} 超过 20 MB`); continue; }
    if (current.length + accepted.length >= MAX_ATTACHMENTS) { errors.push("每条消息最多添加 8 个附件"); continue; }
    if (total + file.size > MAX_TOTAL_BYTES) { errors.push("附件总大小不能超过 40 MB"); continue; }
    accepted.push({ file, fingerprint });
    fingerprints.add(fingerprint);
    total += file.size;
  }
  return { accepted, errors: [...new Set(errors)] };
}
