"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Suivi de l'avancement d'une génération du coach, partagé par les deux
 * formulaires qui la déclenchent (création et ajustement).
 *
 * Le problème : sur un modèle local, une génération dure des minutes. Une
 * rotative n'y dit rien — elle tourne pareil au bout de dix secondes et de trois
 * minutes. Le serveur, lui, sait où il en est (cf. `lib/ai/progress.ts`) : il ne
 * reste qu'à aller le lui demander.
 *
 * Interrogation régulière plutôt que flux poussé : la progression est déjà
 * approximative, deux secondes de latence n'y changent rien, et cela évite une
 * seconde connexion SSE ouverte pendant toute l'attente.
 */

export type GenerationProgress = {
  /**
   * Part du travail déjà faite, de 0 à 100.
   *
   * **Deux producteurs, deux échelles**, et c'est ce qu'il faut savoir avant de
   * déboguer cette barre (le détail est sur `PlanProgress`, dans
   * `lib/ai/progress.ts`) : une **création** compte ses créneaux de qualité
   * écrits et va jusqu'à 100, puisque plus rien ne peut la faire recommencer ;
   * un **ajustement** ou une **révision** comptent des caractères reçus contre
   * une taille estimée et plafonnent à 99, tant que la validation métier n'a pas
   * parlé.
   */
  percent: number;
  /** Tentative en cours, à partir de 1. */
  attempt: number;
  /**
   * Nombre total de tentatives possibles — `1` quand le chemin n'en rejoue
   * aucune, ce qui est le cas d'une création depuis la bascule sur squelette.
   * Le rang n'est alors pas affiché.
   */
  maxAttempts: number;
};

/** Rythme d'interrogation : la barre avance par petits paliers, pas en continu. */
const POLL_INTERVAL_MS = 2_000;

/**
 * La réponse de la route, quand elle décrit bien une progression.
 *
 * Vérification à la main plutôt qu'avec Zod : c'est le seul point du bundle
 * client qui aurait à valider quoi que ce soit, et trois `typeof` ne justifient
 * pas d'embarquer le validateur dans le navigateur. La route répond `null` dès
 * que la génération est finie ou inconnue.
 */
function isGenerationProgress(payload: unknown): payload is GenerationProgress {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "percent" in payload &&
    typeof payload.percent === "number" &&
    "attempt" in payload &&
    typeof payload.attempt === "number" &&
    "maxAttempts" in payload &&
    typeof payload.maxAttempts === "number"
  );
}

/**
 * Un UUID v4, y compris hors contexte sécurisé.
 *
 * `crypto.randomUUID()` n'existe **qu'**en contexte sécurisé (HTTPS ou
 * `localhost`). Une appli auto-hébergée s'ouvre tout aussi bien sur
 * `http://192.168.1.x:3000`, où l'appel lèverait un `TypeError` — en pleine
 * soumission du formulaire de plan, qui ne partirait alors jamais, pour un
 * simple confort d'affichage.
 *
 * `getRandomValues`, lui, est disponible partout. Il ne reste qu'à poser les
 * bits de version et de variante que la v4 impose, puisque la route valide un
 * UUID en bonne et due forme et refuserait une chaîne aléatoire quelconque.
 */
function randomProgressId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 4122
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * L'action à câbler sur le `<form>`, et la progression lue pendant l'attente.
 *
 * L'identifiant est tiré **à chaque envoi**, dans une action enveloppante qui
 * l'ajoute au `FormData` juste avant de passer la main à celle de
 * `useActionState`. Il ne vit donc jamais dans le DOM : ni valeur aléatoire
 * rendue côté serveur (qui casserait l'hydratation), ni champ caché que React 19
 * remettrait à vide en réinitialisant le formulaire à la fin de chaque action —
 * un second envoi (relance après erreur, deuxième ajustement) partirait alors
 * sans identifiant, et l'attente redeviendrait muette sans que rien ne le dise.
 *
 * Un identifiant par envoi, donc, et jamais deux générations à la fois : le
 * bouton reste désactivé pendant l'attente.
 */
export function useGenerationProgress(
  isPending: boolean,
  formAction: (formData: FormData) => void,
): {
  submitWithProgress: (formData: FormData) => void;
  progress: GenerationProgress | null;
} {
  const progressId = useRef("");
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [wasPending, setWasPending] = useState(isPending);

  // Ajustement pendant le rendu (pattern React, pas d'effet) : au démarrage
  // d'une génération, la mesure de la précédente n'a plus de sens et ne doit pas
  // s'afficher les deux secondes qui précèdent la première interrogation.
  if (wasPending !== isPending) {
    setWasPending(isPending);
    setProgress(null);
  }

  const submitWithProgress = useCallback(
    (formData: FormData) => {
      // Posé avant l'appel, donc avant que `isPending` ne bascule : la première
      // interrogation trouvera l'identifiant en place.
      const id = randomProgressId();
      progressId.current = id;
      formData.set("progressId", id);
      formAction(formData);
    },
    [formAction],
  );

  useEffect(() => {
    if (!isPending) return;

    let cancelled = false;
    const controller = new AbortController();

    const poll = async (): Promise<void> => {
      const id = progressId.current;
      if (id === "") return;

      try {
        const response = await fetch(`/api/plan-progress?id=${encodeURIComponent(id)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;

        const payload: unknown = await response.json();
        if (!cancelled && isGenerationProgress(payload)) setProgress(payload);
      } catch {
        // Interrogation ratée (réseau, navigation, abandon) : la suivante arrive
        // dans deux secondes. Rien à dire à l'utilisatrice, qui attend déjà.
      }
    };

    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [isPending]);

  return { submitWithProgress, progress };
}

/**
 * La jauge seule : le rail et son remplissage, sans légende.
 *
 * Exportée parce que les deux formulaires ne l'entourent pas de la même chose —
 * la modale de création affiche le pourcentage en grand au-dessus d'elle et
 * n'aurait que faire de la légende de {@link GenerationProgressBar}, qui le
 * répéterait.
 *
 * Pas d'autre animation que la transition de largeur (150 ms, `ease-out`) :
 * c'est le mouvement qui porte l'information, tout le reste serait décoratif.
 */
export function GenerationProgressMeter({ percent }: { percent: number }) {
  return (
    <div
      role="progressbar"
      aria-label="Avancement de la génération"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1.5 w-full overflow-hidden rounded-full bg-bg"
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-150 ease-out"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/**
 * La barre d'avancement légendée, à glisser dans la bannière d'attente.
 *
 * `aria-live="off"` : la bannière qui l'accueille est une région live, et une
 * valeur qui change toutes les deux secondes y serait annoncée toutes les deux
 * secondes. La barre reste accessible à la lecture (rôle `progressbar` et
 * `aria-valuenow`), elle cesse simplement de parler par-dessus.
 *
 * Le rang de la tentative n'apparaît que s'il y en a plusieurs à tenter. Depuis
 * que la **création** écrit son plan elle-même et n'appelle plus le coach que
 * séance par séance, elle n'a plus qu'une passe : « tentative 1/1 » ne
 * décrirait rien, il ferait seulement craindre qu'il y en ait une seconde.
 * L'ajustement et la révision, eux, rejouent bien le plan et gardent la mention.
 */
export function GenerationProgressBar({ progress }: { progress: GenerationProgress }) {
  return (
    <div aria-live="off">
      <GenerationProgressMeter percent={progress.percent} />
      <p className="num mt-1.5 text-[0.76rem] text-fg-muted">
        {progress.percent}&nbsp;%
        {progress.maxAttempts > 1 ? ` — tentative ${progress.attempt}/${progress.maxAttempts}` : ''}
      </p>
    </div>
  );
}
