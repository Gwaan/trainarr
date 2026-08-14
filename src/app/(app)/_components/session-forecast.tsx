import { CloudOff } from "lucide-react";

import { WeatherIcon } from "@/components/weather-icon";
import type { WeatherForecastDto } from "@/data/weather-forecast";
import { resolveDayForecast } from "@/lib/weather/forecast-plan";
import { describeWeatherCode } from "@/lib/weather/wmo";

import {
  FORECAST_ABSENCE,
  formatForecastReading,
  formatPercent,
  formatPrecipitation,
  formatTemperature,
  formatTemperatureRange,
  formatWindSpeed,
} from "../_lib/format-weather";

/**
 * La météo **prévue** d'une séance à venir.
 *
 * ## Des agrégats de journée, dits comme tels
 *
 * Une séance planifiée porte une date, jamais une heure : il n'existe donc pas
 * de « météo pendant la séance » à afficher, et prétendre le contraire
 * supposerait une heure de départ que le plan n'écrit nulle part. Ce sont des
 * valeurs de **journée** — une amplitude, un cumul, un maximum — et chaque
 * libellé le précise.
 *
 * Les précipitations, en particulier, sont le **cumul du jour** accompagné de la
 * probabilité la plus forte de la journée : « 3,6 mm » ne veut pas dire qu'il
 * pleuvra pendant la sortie, et l'écran ne le laisse pas croire.
 *
 * ## L'instant du relevé est affiché, et le lieu quand il a un nom
 *
 * Une prévision est périssable. Sans la date de son relevé, impossible de savoir
 * si l'on lit celle de ce matin ou celle d'avant-hier — et le service, lui,
 * conserve la précédente quand le relevé du jour a échoué.
 *
 * Le **lieu** se dit dès qu'il en a un, c'est-à-dire dès qu'il a été fixé dans
 * les réglages : « Prévisions : Bordeaux » répond à la question qu'un athlète se
 * pose devant une température qui ne ressemble pas à sa fenêtre. Un lieu déduit
 * des derniers départs, lui, n'a pas de nom — on connaît un point, pas une
 * ville — et l'écran n'en invente pas.
 *
 * ## Une absence se dit
 *
 * Au-delà de seize jours il n'y a pas de prévision, et sans sortie géolocalisée
 * il n'y a pas de lieu. Chaque cas a sa phrase : un blanc se lirait « beau
 * temps ».
 */
export function SessionForecast({
  forecast,
  /** Jour de la séance, date civile. */
  date,
  /** Jour courant, date civile — c'est lui qui décide de l'horizon. */
  today,
}: {
  forecast: WeatherForecastDto;
  date: string;
  today: string;
}) {
  const resolved = resolveDayForecast({ status: forecast.status, days: forecast.days, date, today });

  if (resolved.day === null) {
    return (
      <div className="rounded-button border border-border bg-surface-2/50 px-3 py-2.5">
        <p className="flex items-center gap-2 text-[0.75rem] leading-snug text-fg-faint">
          <CloudOff aria-hidden="true" strokeWidth={1.6} className="size-4 shrink-0" />
          {FORECAST_ABSENCE[resolved.availability]}
        </p>
      </div>
    );
  }

  const day = resolved.day;
  const condition = describeWeatherCode(day.weatherCode);

  /*
   * Le pied du bloc : le lieu (quand il a un nom) et l'instant du relevé, sur
   * une seule ligne. Deux lignes de gris pâle pour deux informations de même
   * poids donneraient un pavé de mentions légales sous une prévision de trois
   * valeurs.
   *
   * Le nom du lieu n'est **pas** en mono : la mono est la signature des données
   * chiffrées, une ville n'en est pas une.
   */
  const place =
    forecast.location.source === "configured" ? `Prévisions : ${forecast.location.label}` : null;
  const reading = forecast.fetchedAt === null ? null : formatForecastReading(forecast.fetchedAt);

  const measures = [
    day.apparentTemperatureMaxC === null
      ? null
      : { label: "Ressenti max", value: formatTemperature(day.apparentTemperatureMaxC) },
    day.windSpeedMaxKmh === null
      ? null
      : { label: "Vent max", value: formatWindSpeed(day.windSpeedMaxKmh) },
    day.precipitationSumMm === null
      ? null
      : {
          label: "Pluie du jour",
          value:
            day.precipitationProbabilityMaxPct === null
              ? formatPrecipitation(day.precipitationSumMm)
              : `${formatPrecipitation(day.precipitationSumMm)} · ${formatPercent(day.precipitationProbabilityMaxPct)}`,
        },
  ].filter((measure) => measure !== null);

  return (
    <div className="rounded-button border border-border bg-surface-2/50 px-3 py-2.5">
      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <WeatherIcon name={condition.icon} className="size-4 text-fg-muted" />
        <span className="text-[0.8rem] font-medium text-fg-muted">{condition.label}</span>
        {day.temperatureMinC === null || day.temperatureMaxC === null ? null : (
          <span className="num text-[0.8rem] font-semibold text-fg">
            {formatTemperatureRange(day.temperatureMinC, day.temperatureMaxC)}
          </span>
        )}
      </p>

      {measures.length === 0 ? null : (
        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {measures.map((measure) => (
            <div key={measure.label} className="flex items-baseline gap-1.5">
              <dt className="text-[0.7rem] text-fg-faint">{measure.label}</dt>
              <dd className="num text-[0.72rem] text-fg-muted">{measure.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {place === null && reading === null ? null : (
        <p className="mt-1.5 text-[0.66rem] text-fg-faint/80">
          {place}
          {place !== null && reading !== null ? " · " : null}
          {reading === null ? null : <span className="num">{reading}</span>}
        </p>
      )}
    </div>
  );
}
