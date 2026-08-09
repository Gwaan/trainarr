import type { ReactNode } from "react";

import { BottomNav } from "@/components/nav/bottom-nav";
import { MobileHeader } from "@/components/nav/mobile-header";
import { Sidebar } from "@/components/nav/sidebar";
import { ATHLETE } from "./_lib/mock-data";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <Sidebar athlete={ATHLETE} />
      <MobileHeader athlete={ATHLETE} />

      <div className="lg:pl-[212px]">
        <main className="mx-auto w-full max-w-5xl px-4 pt-6 pb-[calc(5rem+env(safe-area-inset-bottom))] sm:px-6 lg:px-10 lg:pt-10 lg:pb-16">
          {children}
        </main>
      </div>

      <BottomNav />
    </div>
  );
}
