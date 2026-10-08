/**
 * Web Push on this device: whether it can work here, and switching it on or off.
 *
 * The service worker (public/sw.js) shows what arrives. This module manages the
 * browser's subscription and keeps the server's copy of it current.
 */

import { api } from "./api";
import { getLanguage } from "./i18n";
import { base64UrlToBytes, bytesToBase64Url, isAppleMobile } from "./webpush";

export type PushState =
  | "unsupported" // this browser has no Web Push at all
  | "install" // iPhone/iPad in a browser tab: only a Home Screen app can get push
  | "denied" // notifications are blocked for this site
  | "off"
  | "on";

const ENDPOINT_KEY = "tbb.push-endpoint";

function remember(endpoint: string | null): void {
  try {
    if (endpoint) localStorage.setItem(ENDPOINT_KEY, endpoint);
    else localStorage.removeItem(ENDPOINT_KEY);
  } catch {
    /* private browsing: sign-out simply cannot tell the server */
  }
}

function remembered(): string | null {
  try {
    return localStorage.getItem(ENDPOINT_KEY);
  } catch {
    return null;
  }
}

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {
    /* no push on this device; the in-app list still works */
  });
}

async function subscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** A subscription made for an older server key can no longer be delivered to. */
function madeFor(sub: PushSubscription, publicKey: string): boolean {
  const key = sub.options.applicationServerKey;
  return !key || bytesToBase64Url(key) === publicKey;
}

async function save(sub: PushSubscription): Promise<void> {
  const { endpoint, keys } = sub.toJSON();
  await api<void>("/push/subscriptions", {
    method: "PUT",
    body: { endpoint, keys, language: getLanguage() },
  });
  remember(sub.endpoint);
}

export async function currentPushState(): Promise<PushState> {
  if (!pushSupported()) {
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches;
    const apple = isAppleMobile(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
    return apple && !standalone ? "install" : "unsupported";
  }
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "off";
  return (await subscription()) ? "on" : "off";
}

/** Must run from a tap: browsers only show the permission prompt for a user gesture. */
export async function enablePush(publicKey: string): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";

  await navigator.serviceWorker.register("/sw.js");
  const registration = await navigator.serviceWorker.ready;
  let sub = await registration.pushManager.getSubscription();
  if (sub && !madeFor(sub, publicKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(publicKey),
  });
  await save(sub);
  return "on";
}

export async function disablePush(): Promise<PushState> {
  const sub = await subscription();
  if (sub) {
    await api<void>("/push/subscriptions", {
      method: "DELETE",
      body: { endpoint: sub.endpoint },
    }).catch(() => {
      /* the push service forgets it on unsubscribe; the server learns on the next send */
    });
    await sub.unsubscribe();
  }
  remember(null);
  return "off";
}

/**
 * After sign-in, and when the language changes: tell the server who this device
 * now belongs to and which language to write in. Never prompts.
 */
export async function syncPush(publicKey: string): Promise<void> {
  if (!pushSupported() || Notification.permission !== "granted") return;
  let sub = await subscription();
  if (!sub) return;
  if (!madeFor(sub, publicKey)) {
    await sub.unsubscribe();
    const registration = await navigator.serviceWorker.ready;
    sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(publicKey),
    });
  }
  await save(sub);
}

/**
 * On sign-out, so the next person to use this browser does not get the
 * account's news. Synchronous on purpose: the request is sent before the
 * caller clears the tokens it needs.
 */
export function releasePush(): void {
  const endpoint = remembered();
  remember(null);
  if (endpoint) {
    api<void>("/push/subscriptions", { method: "DELETE", body: { endpoint } }).catch(() => {});
  }
  if (pushSupported()) {
    subscription()
      .then((sub) => sub?.unsubscribe())
      .catch(() => {});
  }
}

type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/** The unread count on the Home Screen icon, where the platform supports it. */
export function setAppBadge(count: number): void {
  const nav = navigator as BadgeNavigator;
  const done = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.();
  done?.catch(() => {});
}
