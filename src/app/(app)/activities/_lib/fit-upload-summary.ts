/**
 * Récapitulatif d'un import FIT : transforme le rapport par fichier renvoyé par
 * `POST /api/fit/upload` en une phrase et une liste d'échecs affichables.
 *
 * Fonction pure, testée : le composant d'import ne fait que la rendre.
 */

import type {
  FitUploadResult,
  FitUploadStatus,
} from "@/app/api/fit/_lib/upload-contract";
import type { BannerTone } from "@/components/banner";

/**
 * Formulations validées pour chaque issue.
 *
 * `updated` : ce fichier avait déjà été importé (même empreinte) — l'activité
 * existante a été retrouvée, pas dupliquée.
 */
const STATUS_LABELS: Record<FitUploadStatus, { one: string; many: string }> = {
  created: { one: "importée", many: "importées" },
  updated: { one: "mise à jour", many: "mises à jour" },
};

/** Ordre de lecture du récapitulatif, du cas le plus courant au plus rare. */
const STATUS_ORDER: readonly FitUploadStatus[] = ["created", "updated"];

export type FitUploadFailure = { name: string; error: string };

export type FitUploadSummary = {
  tone: BannerTone;
  title: string;
  failures: FitUploadFailure[];
};

/** « 3 activités importées » puis, pour les suivantes, « 1 mise à jour ». */
function countPhrase(
  count: number,
  status: FitUploadStatus,
  options: { withNoun: boolean },
): string {
  const plural = count > 1;
  const label = plural ? STATUS_LABELS[status].many : STATUS_LABELS[status].one;
  if (!options.withNoun) return `${count} ${label}`;
  return `${count} ${plural ? "activités" : "activité"} ${label}`;
}

function failurePhrase(count: number): string {
  return count > 1 ? `${count} fichiers en échec` : "1 fichier en échec";
}

/**
 * Récapitulatif du lot, ou `null` si le rapport est vide (aucun fichier retenu
 * par le serveur) — l'appelant affiche alors son message d'échec générique.
 */
export function summarizeFitUpload(
  results: readonly FitUploadResult[],
): FitUploadSummary | null {
  if (results.length === 0) return null;

  const counts = new Map<FitUploadStatus, number>();
  const failures: FitUploadFailure[] = [];

  for (const result of results) {
    if (result.ok) {
      counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
    } else {
      failures.push({ name: result.name, error: result.error });
    }
  }

  const imported = STATUS_ORDER.flatMap((status) => {
    const count = counts.get(status);
    return count ? [{ status, count }] : [];
  });

  if (imported.length === 0) {
    return { tone: "negative", title: "Aucun fichier importé", failures };
  }

  const importedPhrase = imported
    .map(({ status, count }, index) =>
      countPhrase(count, status, { withNoun: index === 0 }),
    )
    .join(", ");

  if (failures.length === 0) {
    return { tone: "positive", title: importedPhrase, failures };
  }

  return {
    tone: "neutral",
    title: `${importedPhrase} — ${failurePhrase(failures.length)}`,
    failures,
  };
}
