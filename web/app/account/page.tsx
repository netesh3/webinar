import { AccountScreen } from "@/components/account-screen";
import { TopNav } from "@/components/top-nav";

export default function AccountPage() {
  return (
    <>
      <TopNav />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-5">
        <AccountScreen />
      </main>
    </>
  );
}
