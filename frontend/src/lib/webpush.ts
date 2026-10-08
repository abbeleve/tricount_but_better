/**
 * Pure helpers for Web Push, kept free of imports so tests can load them alone.
 * The browser-facing half lives in push.ts.
 */

/** A VAPID public key as the server sends it (base64url) -> the bytes `subscribe` wants. */
export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const base64 = (text + "=".repeat((4 - (text.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64Url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes = buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * iPhone and iPad -- including an iPad that reports itself as a Mac. There,
 * only an app added to the Home Screen can receive push, so the advice differs.
 */
export function isAppleMobile(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  return /iPad|iPhone|iPod/.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
}

