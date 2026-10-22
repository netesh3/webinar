import { SimulivePicker } from "@/components/simulive-discover";

/* "Simulive" from the create options: pick one of your ready recordings, from any session,
 * and go on to the simulive schedule form (/host/new?simulive=<recording>). Its own address,
 * like /host/new/meeting, so the schedule form's ?simulive= stays the one way into it. */
export default function ScheduleSimulivePage() {
  return <SimulivePicker />;
}
