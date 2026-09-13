// Browser-only: shrink a photo before it is embedded in an exported workbook so six
// accepted attachments do not turn a 200 KB review file into a 20 MB one. Non-images and
// decode failures return the original bytes; the workbook builder lists those instead.

export async function shrinkForWorkbook(bytes: ArrayBuffer, maxEdge = 1000, quality = 0.65): Promise<ArrayBuffer> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return bytes;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return bytes;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    return blob ? await blob.arrayBuffer() : bytes;
  } catch {
    return bytes;
  }
}
