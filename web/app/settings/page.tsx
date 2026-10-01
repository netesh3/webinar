import { AppShell } from "@/components/app-shell";
import { SettingsScreen } from "@/components/settings/settings-screen";

export default function SettingsPage() {
  return (
    <AppShell>
      <main className="flex w-full min-w-0 flex-1 flex-col px-4 pb-8 sm:px-6">
        <SettingsScreen />
      </main>
    </AppShell>
  );
}
