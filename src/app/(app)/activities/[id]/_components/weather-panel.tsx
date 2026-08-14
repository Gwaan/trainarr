import { CloudOff } from "lucide-react";

import { Panel } from "@/components/panel";
import { WeatherIcon } from "@/components/weather-icon";
import type { ActivityWeatherDto } from "@/data/activity-weather";
import { describeWeatherCode } from "@/lib/weather/wmo";

import {
  ACTIVITY_WEATHER_ABSENCE,
  formatObservationHour,
  formatPercent,
  formatPrecipitation,
  formatTemperature,
  formatWindDirection,
  formatWindSpeed,
} from "../../../_lib/format-weather";
import { MISSING } from "../_lib/format-detail";

/**
 * La météo **relevée** de la séance.
 *
 * ## Ce qu'elle est, et ce qu'elle n'est pas
 *
 * Une information de **contexte** : elle explique une allure dégradée, elle ne
 * la mesure pas. D'où un panneau discret — pas de chiffre géant, pas d'accent
 * (réservé à l'effort), une seule ligne de titre et quatre mesures. Les allures
 * et les FC gardent le premier plan.
 *
 * ## Les précipitations sont un cumul, et c'est écrit
 *
 * `precipitation` est, chez Open-Meteo, la somme de **l'heure qui précède**
 * l'instant relevé — les autres variables, elles, sont instantanées. Le libellé
 * le dit donc en toutes lettres : « cumul de l'heure précédente ». Écrire
 * « Pluie » au-dessus de cette valeur promettrait une averse pendant la séance
 * là où il n'y a qu'une somme horaire.
 *
 * ## Une absence se dit
 *
 * Quatre états arrivent jusqu'ici (cf. `ActivityWeatherStatus`), et trois
 * signifient « pas de météo » pour trois raisons différentes. Une séance sur
 * tapis n'a pas de position : elle doit lire « séance en intérieur », jamais un
 * vide qu'on prendrait pour une panne.
 */
export function WeatherPanel({
  weather,
  className,
}: {
  weather: ActivityWeatherDto;
  className?: string;
}) {
  if (weather.status !== "observed") {
    return (
      <Panel title="Météo" className={className}>
        <p className="flex items-center gap-2.5 text-[0.82rem] leading-relaxed text-fg-faint">
          <CloudOff aria-hidden="true" strokeWidth={1.6} className="size-4 shrink-0" />
          {ACTIVITY_WEATHER_ABSENCE[weather.status]}
        </p>
      </Panel>
    );
  }

  const condition = describeWeatherCode(weather.weatherCode);

  const measures = [
    {
      label: "Ressenti",
      value:
        weather.apparentTemperatureC === null
          ? MISSING
          : formatTemperature(weather.apparentTemperatureC),
    },
    {
      label: "Vent",
      value: weather.windSpeedKmh === null ? MISSING : formatWindSpeed(weather.windSpeedKmh),
      // La direction est une précision, pas une donnée chiffrée : elle vit sous
      // la valeur, en texte, et n'entre pas dans la colonne mono.
      note:
        weather.windDirectionDeg === null
          ? null
          : `de ${formatWindDirection(weather.windDirectionDeg)}`,
    },
    {
      label: "Humidité",
      value:
        weather.relativeHumidityPct === null
          ? MISSING
          : formatPercent(weather.relativeHumidityPct),
    },
    {
      label: "Précipitations",
      value:
        weather.precipitationMm === null
          ? MISSING
          : formatPrecipitation(weather.precipitationMm),
      note: "cumul de l'heure précédente",
    },
  ];

  return (
    <Panel
      title="Météo"
      meta={
        weather.observedAt === null ? undefined : (
          <span className="num">{formatObservationHour(weather.observedAt)}</span>
        )
      }
      className={className}
    >
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <WeatherIcon name={condition.icon} className="size-6 text-fg-muted" />
        <span className="num text-[1.5rem] leading-none font-semibold text-fg">
          {weather.temperatureC === null ? MISSING : formatTemperature(weather.temperatureC)}
        </span>
        <span className="text-[0.85rem] text-fg-muted">{condition.label}</span>
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
        {measures.map((measure) => (
          <div key={measure.label} className="min-w-0">
            <dt className="eyebrow">{measure.label}</dt>
            <dd className="num mt-1.5 truncate text-[1.05rem] leading-none font-semibold text-fg">
              {measure.value}
            </dd>
            {measure.note === undefined || measure.note === null ? null : (
              <p className="mt-1 text-[0.68rem] leading-snug text-fg-faint">{measure.note}</p>
            )}
          </div>
        ))}
      </dl>
    </Panel>
  );
}
