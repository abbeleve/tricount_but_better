import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { keys, useMarkNotificationsRead, useNotifications, useServerConfig } from "../hooks/queries";
import { useAuth } from "../hooks/useAuth";
import { useI18n } from "../lib/i18n";
import { setAppBadge, syncPush } from "../lib/push";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAppPath(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//");
}

/**
 * Glue between the service worker and the app, mounted once. It renders nothing:
 *  - a push that lands while the app is open refreshes the badge and balances
 *  - a tapped notification routes inside the open app instead of reloading it
 *  - `?n=<id>` on arrival marks that notification read, then leaves the URL
 *  - this device's push subscription follows the signed-in user and language
 *  - the Home Screen icon carries the unread count
 */
export function NotificationBridge() {
  const { user } = useAuth();
  const { language } = useI18n();
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const publicKey = useServerConfig().data?.push_public_key;
  const notifications = useNotifications(Boolean(user));
  const { mutate: markRead } = useMarkNotificationsRead();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const message = event.data as { type?: unknown; url?: unknown } | null;
      if (message?.type === "push") {
        client.invalidateQueries({ queryKey: keys.notifications });
        client.invalidateQueries({ queryKey: keys.teams });
        client.invalidateQueries({ queryKey: ["team"] });
      } else if (message?.type === "open" && isAppPath(message.url)) {
        navigate(message.url);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [client, navigate]);

  const opened = new URLSearchParams(location.search).get("n");
  useEffect(() => {
    if (!user || !opened) return;
    if (UUID.test(opened)) markRead([opened]);
    const params = new URLSearchParams(location.search);
    params.delete("n");
    const search = params.toString();
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : "" },
      { replace: true, state: location.state },
    );
  }, [user, opened, markRead, navigate, location.pathname, location.search, location.state]);

  useEffect(() => {
    if (user && publicKey) syncPush(publicKey).catch(() => {});
  }, [user, publicKey, language]);

  // Another account may sign in next; it must never see this one's list.
  useEffect(() => {
    if (!user) client.removeQueries({ queryKey: keys.notifications });
  }, [user, client]);

  const unread = user ? notifications.data?.unread_count : 0;
  useEffect(() => {
    if (unread !== undefined) setAppBadge(unread);
  }, [unread]);

  return null;
}
