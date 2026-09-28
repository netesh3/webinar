import { SettingsScreen } from "@/components/settings/settings-screen";
import { TopNav } from "@/components/top-nav";

export default function SettingsPage() {
  return (
    <>
      <TopNav />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-5">
        <SettingsScreen />
      </main>
    </>
  );
}
