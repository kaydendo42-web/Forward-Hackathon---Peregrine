export function money(cents: number | null) {
  return cents === null ? 'Not supplied' : new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(cents / 100);
}

export function download(bytes: ArrayBuffer | string, filename: string, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
