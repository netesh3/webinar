/* The WhatsApp CRM's public surface for the rest of the web app.
 *
 * Webinar screens import from "@/engage" and nothing deeper: the slots below, the nav
 * entry, and the CRM page itself. Everything else under engage/ (the components, the API
 * client, the Embedded Signup loader) is private to it, and eslint.config.mjs refuses a
 * deeper import from outside. In the other direction the CRM may use the shared UI kit
 * (components/ui, controls, icons, providers) and read the webinar client, as the Go
 * module reads the core store; it does not render webinar screens.
 */
export {
  ENGAGE_HOME,
  MESSAGES_HREF,
  PEOPLE_HREF,
  RosterContactsLink,
  RosterWhatsAppCells,
  RosterWhatsAppHeaders,
  useRosterWhatsAppColumns,
  WhatsAppAccountRow,
  WhatsAppOptInCheckbox,
  WhatsAppRemindersToggle,
} from "./slots";
export { CRMScreen } from "./components/crm-screen";
export { useRosterMessaging } from "./components/roster";
export { followupGroups, type FollowupGroup } from "./buckets";
export { HostPeopleTab } from "./components/people-tab";
export { HostMessagesTab } from "./components/inbox-tab";
export { WebinarMessagesTab } from "./components/webinar-messages";
export { ReplyAlerts, useReplies } from "./components/replies";
export { WhatsAppWeekCard } from "./components/week-card";
export { EngagementFollowUp } from "./components/engagement-follow-up";
