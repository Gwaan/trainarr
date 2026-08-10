import {
  Activity,
  CalendarRange,
  LayoutDashboard,
  Sparkles,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

export type NavLink = {
  href: string;
  label: string;
  icon: LucideIcon;
};

export const NAV_LINKS: readonly NavLink[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/activities", label: "Activités", icon: Activity },
  { href: "/progression", label: "Progression", icon: TrendingUp },
  { href: "/plan", label: "Plan", icon: CalendarRange },
  { href: "/coach", label: "Coach", icon: Sparkles },
];

/** Le dashboard n'est actif que sur `/` exactement, les autres le sont aussi sur leurs sous-routes. */
export function isActivePath(pathname: string, href: string): boolean {
  return href === "/"
    ? pathname === "/"
    : pathname === href || pathname.startsWith(`${href}/`);
}
