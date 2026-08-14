"use client";

import { useActionState, useState } from "react";
import { Loader2 } from "lucide-react";

import { Banner } from "@/components/banner";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";

import { saveIntervalsAction } from "../_lib/intervals-actions";
import { INTERVALS_FORM_IDLE } from "../_lib/intervals-state";
import {
  toIntervalsFormValues,
  type IntervalsFormDefaults,
} from "../_lib/intervals-values";

import { IntervalsFields } from "./intervals-fields";

/**
 * Section « Import automatique » du profil, en mode édition.
 *
 * Un formulaire à part, avec sa propre action et son propre état : corriger un
 * identifiant intervals.icu ne doit pas obliger à repasser par le profil
 * physiologique, et l'échec de l'un ne dit rien de l'autre.
 *
 * **Aucun bouton accent ici** : le seul CTA de l'écran est l'enregistrement du
 * profil.
 */

/** Repli si l'action échoue sans message — elle en fournit un dans tous ses cas connus. */
const GENERIC_FAILURE = "Les réglages n'ont pas été enregistrés.";

const INTRO =
  "Trainarr rapatrie tes séances depuis intervals.icu, où HealthFit les dépose. Sans clé API, l'import automatique ne tourne pas : il reste le dépôt manuel d'un fichier FIT depuis la page « Activités ».";

export type IntervalsPanelProps = {
  defaults: IntervalsFormDefaults;
};

export function IntervalsPanel({ defaults }: IntervalsPanelProps) {
  const [state, formAction, isPending] = useActionState(
    saveIntervalsAction,
    INTERVALS_FORM_IDLE,
  );
  const [values, setValues] = useState(() => toIntervalsFormValues(defaults));
  const [lastState, setLastState] = useState(state);

  // Une fois l'enregistrement passé, rien ne justifie de garder la saisie de clé
  // dans la page — ni la case « effacer », qui a joué son rôle. L'identifiant,
  // lui, reste : c'est la valeur désormais en base.
  //
  // Ajustement pendant le rendu et non dans un effet : c'est la forme que React
  // recommande pour dériver un état d'un autre (`useActionState` rend un nouvel
  // objet à chaque exécution de l'action), et elle évite le rendu en cascade
  // qu'un `useEffect` provoquerait.
  if (lastState !== state) {
    setLastState(state);
    if (state.status === "success") {
      setValues((current) => ({ ...current, apiKey: "", clearApiKey: false }));
    }
  }

  const hasFeedback = state.status !== "idle";

  return (
    <Panel title="Import automatique">
      <div aria-live="polite" className={hasFeedback ? "mb-4" : "sr-only"}>
        {state.status === "success" ? (
          <Banner tone="positive" title={state.message ?? "Réglages enregistrés."} />
        ) : null}
        {state.status === "error" ? (
          <Banner tone="negative" title={state.message ?? GENERIC_FAILURE} />
        ) : null}
      </div>

      <form action={formAction} noValidate className="flex flex-col gap-5">
        <IntervalsFields
          apiKeyState={defaults.apiKeyState}
          values={values}
          onChange={setValues}
          errors={state.fieldErrors}
          intro={INTRO}
        />
        <div>
          <Button
            type="submit"
            variant="secondary"
            disabled={isPending}
            aria-busy={isPending}
            className="w-full sm:w-auto"
          >
            {isPending ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : null}
            {isPending ? "Enregistrement…" : "Enregistrer les réglages"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
