import { AppShell } from "@/components/app-shell";
import { SettingsScreen } from "@/components/settings/settings-screen";

export default function SettingsPage() {
  return (
    <AppShell>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-5">
        <SettingsScreen />
      </main>
    </AppShell>
  );
}
