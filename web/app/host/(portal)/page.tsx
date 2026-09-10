import { HostWebinarsScreen } from "@/components/host-webinars-screen";

// Client-rendered: the host session is an httpOnly cookie scoped to the API
// origin, and the browser is what holds it.
export default function HostHomePage() {
  return <HostWebinarsScreen />;
}
