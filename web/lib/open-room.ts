/** Open a live / preview room in a new tab. Keeps manage / browse / my-webinars
 *  in place so ending or admitting people does not lose the host's place. */
export function openRoomTab(url: string): void {
  const tab = window.open(url, "_blank", "noopener,noreferrer");
  if (tab) tab.opener = null;
}
