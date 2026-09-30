"use client";

import { MaterialIcon } from "../icons";
import { useTheme } from "../theme";
import { Card } from "../ui";
import type { ThemeChoice } from "@/lib/theme";

const OPTIONS: { id: ThemeChoice; label: string; icon: string }[] = [
  { id: "light", label: "Light", icon: "light_mode" },
  { id: "dark", label: "Dark", icon: "dark_mode" },
];

/** Saved on this browser. Until someone picks one, the boot script follows
 *  the OS; after that, this choice wins. */
export function AppearanceSection() {
  const { theme, setTheme } = useTheme();

  return (
    <section>
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Appearance</h2>
      <p className="mt-1 text-[12.5px] text-ink-3">
        Light is the current look. Your choice is saved in this browser and
        overrides the system setting.
      </p>
      <Card className="mt-4 p-5">
        <div role="radiogroup" aria-label="Color theme" className="flex flex-wrap gap-2">
          {OPTIONS.map((option) => {
            const on = theme === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setTheme(option.id)}
                className={`inline-flex h-10 items-center gap-2 rounded-lg border px-3.5 text-[13.5px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                  on
                    ? "border-brand-line bg-brand-soft text-brand"
                    : "border-line-2 bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink"
                }`}
              >
                <MaterialIcon name={option.icon} className="!text-[18px]" />
                {option.label}
              </button>
            );
          })}
        </div>
      </Card>
    </section>
  );
}
