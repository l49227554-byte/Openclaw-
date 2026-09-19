export function dataImageClipboardFile(
  dataUrl: string,
  baseName = "pasted-image",
): { file: File; dataUrl: string } | null {
  const trimmed = dataUrl.trim();
  const commaIndex = trimmed.indexOf(",");
  const match =
    commaIndex >= 0
      ? /^data:(image\/[a-z0-9.+-]+);base64$/i.exec(trimmed.slice(0, commaIndex))
      : null;
  if (!match) {
    return null;
  }
  const mimeType = match[1]?.toLowerCase();
  const base64Source = trimmed.slice(commaIndex + 1);
  if (!mimeType || !base64Source) {
    return null;
  }
  const base64 = base64Source.replace(/\s+/g, "");
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const extension = mimeType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || "png";
    return {
      file: new File([bytes], `${baseName}.${extension}`, { type: mimeType }),
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
