import Link from "next/link";
import { Trophy } from "lucide-react";

import { Panel } from "@/components/panel";
import type { PersonalBestsDto } from "@/data/personal-bests";

import { MetricInfo } from "../../_components/metric-info";
import { describePersonalBestsUnavailable } from "../../_lib/metric-unavailable";
import {
  buildPersonalBestRows,
  describePendingBests,
} from "../_lib/personal-bests-model";
import { MetricEmptyState } from "./metric-empty-state";

/**
 * Les meilleurs temps de **tous les temps**, distance par distance, chacun
 * renvoyant vers la séance qui le porte.
 *
 * **Indépendant du filtre de période**, et le méta de la card le dit : un record
 * de tous les temps ne change pas parce qu'on regarde trois mois. Il ne
 * disparaît pas non plus quand la fenêtre affichée ne le contient pas — c'est
 * précisément ce qui en fait un record.
 */
export function PersonalBestsPanel({
  bests,
  today,
}: {
  bests: PersonalBestsDto;
  /** Jour civil courant : il décide du millésime affiché sur chaque record. */
  today: string;
}) {
  const rows = buildPersonalBestRows(bests.bests, today);
  const pending = describePendingBests(bests.pendingActivities);

  if (rows.length === 0) {
    return (
      <Panel title="Records personnels" info={<MetricInfo id="personal-bests" />} padded={false}>
        <MetricEmptyState
          icon={Trophy}
          {...describePersonalBestsUnavailable(bests.pendingActivities)}
        />
      </Panel>
    );
  }

  return (
    <Panel
      title="Records personnels"
      info={<MetricInfo id="personal-bests" />}
      meta={<span>tous les temps</span>}
      padded={false}
    >
      <table className="w-full text-[0.8rem]">
        <caption className="sr-only">
          Meilleur temps de tous les temps sur chaque distance de référence, son
          allure et la séance qui l&apos;a établi.
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="eyebrow px-4 py-2 text-left sm:px-5">
              Distance
            </th>
            <th scope="col" className="eyebrow py-2 text-right">
              Temps
            </th>
            <th scope="col" className="eyebrow py-2 text-right">
              Allure
            </th>
            <th scope="col" className="eyebrow px-4 py-2 text-right sm:px-5">
              Séance
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-border last:border-b-0">
              <th
                scope="row"
                className="num px-4 py-2 text-left font-medium whitespace-nowrap text-fg sm:px-5"
              >
                {row.distance}
              </th>
              <td className="num py-2 text-right whitespace-nowrap text-fg">{row.time}</td>
              <td className="num py-2 text-right whitespace-nowrap text-fg-muted">
                {row.pace}
              </td>
              <td className="px-4 py-2 text-right whitespace-nowrap sm:px-5">
                {/* La date **est** le lien : c'est elle qu'on cherche quand on
                    veut rouvrir la séance, et un « voir » de plus n'ajouterait
                    qu'une cible à côté de la même. */}
                <Link
                  href={row.href}
                  className="text-fg-muted transition-colors duration-150 ease-out hover:text-accent"
                >
                  {row.day ?? "Ouvrir"}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Non facultatif : tant que le rattrapage n'est pas passé, ces records
          sont calculés sur une partie seulement de l'historique, et les annoncer
          sans le dire serait faux. */}
      {pending === null ? null : (
        <p className="border-t border-border px-4 py-3 text-[0.78rem] leading-relaxed text-fg-faint sm:px-5">
          {pending}
        </p>
      )}
    </Panel>
  );
}
