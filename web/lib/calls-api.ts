/* Calling's HTTP client (31 Oct 2026, docs/calling.md). Its own module, next to lib/api.ts
 * rather than inside it, the way engage/api.ts is: the same request path (lib/http.ts). */

import type { Call, ContactsResponse, StartCallRequest, StartCallResponse } from "./api-types";
import { API_BASE, fresh, post, request, seg } from "./http";

export const callsApi = {
  /** Ring somebody: into meetingSlug, or into a new instant meeting when it is omitted. */
  start: (req: StartCallRequest) => post<StartCallResponse>("/api/calls", req),
  get: (id: string) => request<Call>(`/api/calls/${seg(id)}`, fresh),
  accept: (id: string) => post<Call>(`/api/calls/${seg(id)}/accept`),
  decline: (id: string) => post<Call>(`/api/calls/${seg(id)}/decline`),
  cancel: (id: string) => post<Call>(`/api/calls/${seg(id)}/cancel`),
  /** People this host may call: by name, or one account by its whole address. */
  contacts: (q: string) => request<ContactsResponse>(`/api/contacts?q=${encodeURIComponent(q)}`, fresh),
  /** The signed-in account's event stream, for EventSource (cookie, withCredentials). */
  eventsUrl: () => `${API_BASE}/api/me/events`,
};
