import type { LucideIcon } from "lucide-react";
import {
  CircleQuestionMark,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudRain,
  CloudRainWind,
  CloudSnow,
  CloudSun,
  CloudLightning,
  Sun,
} from "lucide-react";

import type { WeatherIconName } from "@/lib/weather/wmo";
import { cn } from "@/lib/utils";

/**
 * Le glyphe d'un temps.
 *
 * La traduction d'un code WMO en famille de temps vit dans `lib/weather/wmo.ts`,
 * qui est pur et testé ; ce composant ne fait que lui donner un dessin. C'est ce
 * découpage qui permet d'éprouver la table entière sans monter le moindre rendu.
 *
 * L'icône est **décorative** : elle accompagne toujours le libellé écrit
 * (« Averses modérées »), jamais elle ne le remplace. D'où `aria-hidden` —
 * l'annoncer une seconde fois aux lecteurs d'écran n'ajouterait rien.
 *
 * Pas de couleur imposée : la météo est une information de contexte, elle vit en
 * `fg-muted` chez ses appelants et ne prend jamais l'accent, réservé à l'effort.
 */
const ICONS: Record<WeatherIconName, LucideIcon> = {
  clear: Sun,
  "mostly-clear": CloudSun,
  cloudy: Cloud,
  fog: CloudFog,
  drizzle: CloudDrizzle,
  rain: CloudRain,
  showers: CloudRainWind,
  snow: CloudSnow,
  thunderstorm: CloudLightning,
  // Ni soleil ni nuage : un code qu'on n'a pas su lire ne se déguise pas en
  // beau temps (cf. `describeWeatherCode`).
  unknown: CircleQuestionMark,
};

export function WeatherIcon({
  name,
  className,
}: {
  name: WeatherIconName;
  className?: string;
}) {
  const Icon = ICONS[name];
  return <Icon aria-hidden="true" strokeWidth={1.8} className={cn("shrink-0", className)} />;
}
