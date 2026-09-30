/* The WhatsApp CRM's public surface for the rest of the web app.
 *
 * Webinar screens import from "@/engage" and nothing deeper: the slots below, the nav
 * entry, and the CRM page itself. Everything else under engage/ (the components, the API
 * client, the Embedded Signup loader) is private to it, and eslint.config.mjs refuses a
 * deeper import from outside. In the other direction the CRM may use the shared UI kit
 * (components/ui, controls, icons, providers, date-picker) and read the webinar client, as the Go
 * module reads the core store; it does not render webinar screens.
 */
export {
  ENGAGE_HOME,
  MESSAGES_HREF,
  PEOPLE_HREF,
  messagesHref,
  RosterContactsLink,
  RosterWhatsAppCells,
  RosterWhatsAppHeaders,
  useRosterWhatsAppColumns,
  WhatsAppAccountRow,
  WhatsAppOptInCheckbox,
  MessagesNavButton,
} from "./slots";
export { WhatsAppScreen } from "./components/whatsapp-screen";
export { useRosterMessaging } from "./components/roster";
export { followupGroups, type FollowupGroup } from "./buckets";
export { HostPeopleTab } from "./components/people-tab";
export { HostMessagesTab } from "./components/inbox-tab";
export { HostMessagesInbox } from "./components/messages-inbox";
export { WebinarMessagesTab } from "./components/webinar-messages";
export { ReplyAlerts, useReplies } from "./components/replies";
export { WhatsAppWeekCard } from "./components/week-card";
export { EngagementFollowUp } from "./components/engagement-follow-up";
export { WebinarWhatsAppOverview } from "./components/webinar-overview";
export { WebinarWhatsAppMetrics } from "./components/webinar-whatsapp-metrics";
export { EngagementFollowUpPage } from "./components/follow-up-page";
export {
  ScheduleMessagesTab,
  type MessagesSaveHandle,
  type MessagesSummary,
  type PreviewWebinar,
} from "./components/messages/schedule-messages-tab";
export {
  channelEnabled,
  countEnabledChannel,
  reminderMinutes,
  useWebinarMessageSlots,
  type WebinarSlotsState,
} from "./slot-counts";
