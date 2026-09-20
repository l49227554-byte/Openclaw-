export function dataImageClipboardFile(
  dataUrl: string,
  baseName = "pasted-image",
): { file: File; dataUrl: string } | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(dataUrl.trim());
  const mimeType = match?.[1]?.toLowerCase();
  const base64 = match?.[2]?.replace(/\s+/g, "");
  if (!mimeType || !base64) {
    return null;
  }
  try {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    return {
      file: new File([bytes], `${baseName}.${mimeType.slice("image/".length)}`, { type: mimeType }),
      dataUrl: `data:${mimeType};base64,${base64}`,
    };
  } catch {
    return null;
  }
}

/** Clipboard custody is synchronous; the cold launcher can retain Files without loading readers. */
export function readChatClipboardImages(clipboard: DataTransfer | null): {
  files: File[];
  inline?: { file: File; dataUrl: string };
} {
  const files = Array.from(clipboard?.items ?? [])
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  const text = files.length === 0 ? clipboard?.getData("text/plain") : undefined;
  const inline = text ? dataImageClipboardFile(text) : null;
  return inline ? { files: [inline.file], inline } : { files };
}
