"use client";

import { useActionState, useId, useState } from "react";
import { Loader2, Scale } from "lucide-react";

import { Banner } from "@/components/banner";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { saveCorrectionFactorAction } from "../_lib/correction-factor-actions";
import { CORRECTION_FACTOR_FORM_IDLE } from "../_lib/correction-factor-state";
import type { CorrectionFactorSettings } from "../_lib/correction-factor-values";

/**
 * Section « Facteur correctif de la VO₂max ».
 *
 * ## Ce qu'elle règle, et ce qu'elle montre
 *
 * Un seul champ : le facteur **imposé**. Vide, c'est le calcul automatique qui
 * s'applique — la convention de Runalyze, dont le champ vide veut dire « laisse
 * faire ». Tout le reste du panneau est en lecture, et n'est pas décoratif :
 * imposer une valeur sans voir celle qu'on remplace, ni sur quoi elle est
 * calibrée, revient à écrire à l'aveugle.
 *
 * ## Pourquoi l'historique des courses n'est pas ici
 *
 * Une course est une performance, pas un réglage : elle se lit sur la page
 * « Progression », avec les records et les chronos prévus. Ce panneau ne porte
 * que le levier.
 *
 * **Aucun bouton accent ici** : l'accent des réglages est l'enregistrement du
 * profil, et le déplacer d'une section à l'autre ferait de chacune une candidate
 * au même poids visuel.
 */

const INTRO =
  "L’estimation par la fréquence cardiaque a un biais propre à chacun : chez qui a le cœur qui tourne haut pour l’effort produit, elle sous-lit ; chez qui l’a bas, elle sur-lit. Trainarr mesure cet écart sur tes courses déclarées et l’applique à toutes tes séances. Ce champ sert à passer outre.";

const FIELD_HINT =
  "Laisse vide pour le calcul automatique. Entre 0,7 et 1,4 — au-delà, ce n’est plus un biais individuel mais une donnée fausse.";

/** Repli si l'action échoue sans message — elle en fournit un dans tous ses cas connus. */
const GENERIC_FAILURE = "Le facteur n’a pas été enregistré.";

export function CorrectionFactorPanel({ settings }: { settings: CorrectionFactorSettings }) {
  const uid = useId();

  const [state, formAction, isSaving] = useActionState(
    saveCorrectionFactorAction,
    CORRECTION_FACTOR_FORM_IDLE,
  );

  // Champ **contrôlé** : React réinitialise un formulaire non contrôlé à la fin
  // de l'action, et la saisie disparaîtrait au premier message.
  const [factor, setFactor] = useState(settings.manual);

  // Le réglage vient d'être enregistré : la prop change, la saisie doit suivre.
  // Ajustement pendant le rendu plutôt qu'en effet — la forme que React
  // recommande pour dériver un état d'un autre.
  const [lastSaved, setLastSaved] = useState(settings.manual);
  if (lastSaved !== settings.manual) {
    setLastSaved(settings.manual);
    setFactor(settings.manual);
  }

  return (
    <Panel title="Facteur correctif de la VO₂max">
      <div aria-live="polite" className={state.status === "idle" ? "sr-only" : "mb-4"}>
        {state.status === "success" ? (
          <Banner tone="positive" title={state.message ?? "Facteur enregistré."} />
        ) : null}
        {state.status === "error" ? (
          <Banner tone="negative" title={state.message ?? GENERIC_FAILURE} />
        ) : null}
      </div>

      <form action={formAction} noValidate className="flex flex-col gap-5">
        <p className="text-[0.82rem] leading-relaxed text-fg-muted">{INTRO}</p>

        <Banner
          tone="neutral"
          title={`Facteur automatique : ${settings.automatic}`}
        >
          {settings.automaticNote}
        </Banner>

        <div className="min-w-0">
          <label htmlFor={`${uid}-factor`} className="text-[0.85rem] font-medium text-fg">
            Facteur imposé
          </label>
          <p id={`${uid}-hint`} className="mt-0.5 text-[0.76rem] leading-snug text-fg-faint">
            {FIELD_HINT}
          </p>
          <Input
            id={`${uid}-factor`}
            name="factor"
            type="text"
            inputMode="decimal"
            placeholder="automatique"
            // 16 px : en dessous, iOS zoome à la prise de focus et la PWA n'a
            // aucun geste pour revenir en arrière.
            className="mt-1.5 w-full text-base sm:w-40"
            value={factor}
            onChange={(event) => setFactor(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${uid}-hint`}
          />
        </div>

        <div>
          <Button
            type="submit"
            variant="secondary"
            disabled={isSaving}
            aria-busy={isSaving}
            className="w-full sm:w-auto"
          >
            {isSaving ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <Scale aria-hidden="true" />
            )}
            {isSaving ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
