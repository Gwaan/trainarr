import Link from "next/link";
import { Flag } from "lucide-react";

import { Panel } from "@/components/panel";
import type { Vo2maxCorrectionDto } from "@/data/vo2max-correction";
import { cn } from "@/lib/utils";

import { buildRaceRows, describeCorrection } from "../_lib/race-results-model";
import { MetricEmptyState } from "./metric-empty-state";

/**
 * Les **courses déclarées** : l'historique, et ce que chacune apporte au
 * recalage de la VO₂max.
 *
 * ## Pourquoi ici, et pas dans les réglages
 *
 * Une course est une **donnée de performance**, pas un réglage : elle a la même
 * nature que les records personnels juste au-dessus et que les chronos prévus
 * plus haut, et elle se lit dans le même mouvement — « ce que j'ai fait, ce que
 * ça vaut ». La ranger sous « Réglages › Profil » aurait obligé à ouvrir une
 * modale pour consulter son palmarès, et à traverser deux écrans pour
 * comprendre d'où sort le facteur qui multiplie les valeurs de cette page-ci.
 *
 * Ce qui vit dans les réglages, c'est le **facteur manuel** — lui est bien un
 * réglage, et il n'a rien à faire ici.
 *
 * ## Indépendant du filtre de période
 *
 * Comme les records, et le méta de la card le dit : une course de l'an dernier
 * calibre toujours, et elle ne doit pas disparaître parce qu'on regarde trois
 * mois. Le facteur, lui, ne dépend d'aucune fenêtre.
 *
 * ## La déclaration ne se fait pas ici
 *
 * Elle se fait depuis le détail d'une séance, qui est le seul endroit où la
 * fréquence cardiaque et le dénivelé de la course sont disponibles. Le tableau
 * renvoie donc vers la séance, il n'ouvre aucun formulaire.
 */
export function RacesPanel({
  correction,
  today,
}: {
  correction: Vo2maxCorrectionDto;
  /** Jour civil courant : il décide du millésime affiché sur chaque course. */
  today: string;
}) {
  const rows = buildRaceRows(correction, today);
  const copy = describeCorrection(correction);

  if (rows.length === 0) {
    return (
      <Panel title="Courses déclarées" padded={false}>
        <MetricEmptyState icon={Flag} title={copy.title} description={copy.description} />
      </Panel>
    );
  }

  return (
    <Panel
      title="Courses déclarées"
      meta={<span>tous les temps</span>}
      padded={false}
    >
      <table className="w-full text-[0.8rem]">
        <caption className="sr-only">
          Tes courses déclarées, de la plus récente à la plus ancienne, et ce que
          chacune apporte au recalage de ta VO₂max estimée.
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="eyebrow px-4 py-2 text-left sm:px-5">
              Épreuve
            </th>
            <th scope="col" className="eyebrow py-2 text-right">
              Distance
            </th>
            <th scope="col" className="eyebrow py-2 text-right">
              Temps
            </th>
            <th scope="col" className="eyebrow px-4 py-2 text-right sm:px-5">
              Recalage
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-border last:border-b-0">
              <th scope="row" className="px-4 py-2 text-left font-medium sm:px-5">
                {/* Le nom **est** le lien : c'est lui qu'on vise pour rouvrir la
                    séance. Une course courue sans montre n'en a pas — elle reste
                    du texte, plutôt qu'une cible morte. */}
                {row.href === null ? (
                  <span className="text-fg">{row.name}</span>
                ) : (
                  <Link
                    href={row.href}
                    className="text-fg transition-colors duration-150 ease-out hover:text-accent"
                  >
                    {row.name}
                  </Link>
                )}
                {row.day === null ? null : (
                  <span className="num mt-0.5 block text-[0.72rem] text-fg-faint">
                    {row.day}
                  </span>
                )}
              </th>
              <td className="num py-2 text-right whitespace-nowrap text-fg-muted">
                {row.distance}
              </td>
              <td className="num py-2 text-right whitespace-nowrap text-fg">{row.time}</td>
              <td
                className={cn(
                  "num px-4 py-2 text-right whitespace-nowrap sm:px-5",
                  // La course qui porte le facteur est la seule à ressortir : le
                  // tableau répond d'abord à « laquelle recale mes valeurs ? ».
                  row.calibrating ? "font-semibold text-fg" : "text-fg-faint",
                )}
              >
                {row.calibration}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Non facultatif : c'est ce pied qui rend le facteur explicable — sa
          valeur seule ne dit ni d'où elle sort ni s'il faut la croire. */}
      <div className="border-t border-border px-4 py-3 sm:px-5">
        <p className="text-[0.78rem] font-medium text-fg">{copy.title}</p>
        <p className="mt-1 text-[0.78rem] leading-relaxed text-fg-faint">
          {copy.description}
        </p>
      </div>
    </Panel>
  );
}
