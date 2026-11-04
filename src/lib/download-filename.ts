// The real name (with any accented letters) comes in the UTF-8 filename*
// that attachmentDisposition writes; the plain filename is only an ASCII
// fallback. Safe to use in client components.
export function filenameFromDisposition(disposition: string, fallback: string): string {
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // Malformed: fall back to the plain one below.
    }
  }
  return disposition.match(/filename="([^"]+)"/)?.[1] ?? fallback;
}
