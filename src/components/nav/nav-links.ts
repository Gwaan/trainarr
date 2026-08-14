import {
  CalendarDays,
  LayoutDashboard,
  ListChecks,
  Sparkles,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

export type NavLink = {
  href: string;
  label: string;
  icon: LucideIcon;
};

/**
 * Les cinq onglets, dans l'ordre où l'on s'en sert : l'état du jour, le temps,
 * les tendances, le programme, le coach.
 *
 * « Calendrier » garde l'URL `/activities` : c'est l'index de la collection dont
 * `/activities/[id]` est le détail, et c'est bien cet onglet qui doit rester
 * actif quand on ouvre une sortie. Le titre a changé, pas la ressource.
 *
 * Cinq colonnes, et pas une de plus : la bottom-nav est en `grid-cols-5` et
 * « Progression » y tient déjà de justesse sur un écran de 320 px.
 */
export const NAV_LINKS: readonly NavLink[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/activities", label: "Calendrier", icon: CalendarDays },
  { href: "/progression", label: "Progression", icon: TrendingUp },
  { href: "/plan", label: "Plan", icon: ListChecks },
  { href: "/coach", label: "Coach", icon: Sparkles },
];

/** Le dashboard n'est actif que sur `/` exactement, les autres le sont aussi sur leurs sous-routes. */
export function isActivePath(pathname: string, href: string): boolean {
  return href === "/"
    ? pathname === "/"
    : pathname === href || pathname.startsWith(`${href}/`);
}
