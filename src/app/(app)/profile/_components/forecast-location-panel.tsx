"use client";

import { useActionState, useId, useState } from "react";
import { Loader2, MapPin, Search } from "lucide-react";

import { Banner } from "@/components/banner";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import {
  saveForecastLocationAction,
  searchForecastLocationAction,
} from "../_lib/forecast-location-actions";
import {
  CLEAR_FORECAST_LOCATION_VALUE,
  FORECAST_LOCATION_FORM_IDLE,
  FORECAST_SEARCH_IDLE,
  type ForecastPlaceOption,
} from "../_lib/forecast-location-state";

/**
 * Section « Lieu des prévisions météo ».
 *
 * ## Ce qu'elle règle, et ce qu'elle ne touche pas
 *
 * Uniquement la météo des séances **à venir**. Celle des séances **faites** est
 * relevée aux coordonnées GPS réelles de chaque sortie et ne bouge pas : une
 * observation ne se déplace pas parce qu'on a changé un réglage.
 *
 * ## Deux formulaires, côte à côte
 *
 * Chercher n'est pas enregistrer, et un formulaire ne s'imbrique pas dans un
 * autre : la recherche a le sien (une saisie, un bouton), le choix a le sien
 * (la liste des résultats, l'enregistrement, et le retour au mode automatique).
 * Chacun garde son état et ses messages.
 *
 * La sélection, elle, vit dans l'état du composant : les champs cachés du
 * second formulaire portent le lieu choisi, ce qui évite d'encoder un lieu
 * entier dans la valeur d'un bouton radio.
 *
 * **Aucun bouton accent ici** : l'accent des réglages est l'enregistrement du
 * profil, et le déplacer d'un onglet à l'autre ferait de chaque section une
 * candidate au même poids visuel.
 */

const INTRO =
  "Par défaut, Trainarr déduit le lieu de tes prévisions du plus central de tes trente derniers départs — sans réglage, et sans rien te demander. Fixe une ville ici si tu préfères que les prévisions parlent toujours du même endroit.";

const AUTOMATIC_NOTICE =
  "Mode automatique : le lieu des prévisions suit tes derniers départs. Sans sortie géolocalisée récente, il n'y a pas de lieu, donc pas de prévision.";

/** Repli si l'action échoue sans message — elle en fournit un dans tous ses cas connus. */
const GENERIC_FAILURE = "Le lieu n'a pas été enregistré.";

/** « Bordeaux · Nouvelle-Aquitaine · France » — ce qui distingue deux homonymes. */
function placeDetail(place: ForecastPlaceOption): string {
  return [place.region, place.country].filter((part) => part !== null).join(" · ");
}

export type ForecastLocationPanelProps = {
  /** Le lieu réglé, `null` en mode automatique. Un nom, jamais des coordonnées. */
  label: string | null;
};

export function ForecastLocationPanel({ label }: ForecastLocationPanelProps) {
  const uid = useId();

  const [search, searchAction, isSearching] = useActionState(
    searchForecastLocationAction,
    FORECAST_SEARCH_IDLE,
  );
  const [save, saveAction, isSaving] = useActionState(
    saveForecastLocationAction,
    FORECAST_LOCATION_FORM_IDLE,
  );

  // Saisie **contrôlée** : React réinitialise un formulaire non contrôlé à la
  // fin de l'action, et le nom cherché disparaîtrait au premier message.
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [lastSearch, setLastSearch] = useState(search);

  // Une nouvelle recherche périme la sélection précédente : elle désignait un
  // lieu qui n'est plus dans la liste. Ajustement pendant le rendu plutôt qu'en
  // effet — la forme que React recommande pour dériver un état d'un autre.
  if (lastSearch !== search) {
    setLastSearch(search);
    setSelectedId(null);
  }

  const places = search.status === "results" ? (search.places ?? []) : [];
  const selected = places.find((place) => place.id === selectedId) ?? null;

  return (
    <Panel title="Lieu des prévisions météo">
      <div aria-live="polite" className={save.status === "idle" ? "sr-only" : "mb-4"}>
        {save.status === "success" ? (
          <Banner tone="positive" title={save.message ?? "Réglage enregistré."} />
        ) : null}
        {save.status === "error" ? (
          <Banner tone="negative" title={save.message ?? GENERIC_FAILURE} />
        ) : null}
      </div>

      <div className="flex flex-col gap-5">
        <p className="text-[0.82rem] leading-relaxed text-fg-muted">{INTRO}</p>

        {label === null ? (
          <Banner tone="neutral" title="Aucun lieu fixé.">
            {AUTOMATIC_NOTICE}
          </Banner>
        ) : (
          <Banner tone="neutral" title={`Prévisions relevées à ${label}.`}>
            La météo de tes séances déjà faites, elle, reste celle de tes coordonnées
            GPS réelles.
          </Banner>
        )}

        {/* La recherche : un nom, une liste. Le géocodage est appelé côté
            serveur — le navigateur ne parle jamais à un tiers. */}
        <form action={searchAction} noValidate className="flex flex-col gap-2">
          <label
            htmlFor={`${uid}-query`}
            className="text-[0.85rem] font-medium text-fg"
          >
            Chercher un lieu
          </label>
          <p id={`${uid}-query-hint`} className="text-[0.76rem] leading-snug text-fg-faint">
            Une ville, un village. Les homonymes sont départagés par leur région et
            leur pays.
          </p>
          <div className="flex flex-wrap items-center gap-2 sm:max-w-sm">
            <Input
              id={`${uid}-query`}
              name="query"
              type="text"
              // 16 px : en dessous, iOS zoome à la prise de focus et la PWA n'a
              // aucun geste pour revenir en arrière.
              className="mt-1 min-w-0 flex-1 text-base"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Bordeaux"
              autoComplete="off"
              spellCheck={false}
              autoCorrect="off"
              aria-describedby={`${uid}-query-hint`}
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={isSearching}
              aria-busy={isSearching}
              className="mt-1"
            >
              {isSearching ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <Search aria-hidden="true" />
              )}
              Rechercher
            </Button>
          </div>
        </form>

        {/* Pas de conteneur `aria-live` ici : `Banner` porte déjà son `role`
            (`status` ou `alert`), et l'annonce se ferait deux fois. */}
        {search.status === "error" ? (
          <Banner
            tone="negative"
            title={search.message ?? "Recherche impossible pour l’instant."}
          />
        ) : null}
        {search.status === "empty" ? (
          <Banner tone="neutral" title={`Aucun lieu ne porte le nom « ${search.query} ».`}>
            Vérifie l’orthographe, ou essaie le nom de la commune plutôt que celui du
            quartier.
          </Banner>
        ) : null}

        {/* Le choix et l'enregistrement : un formulaire distinct de la
            recherche — deux gestes, deux états, et pas d'imbrication possible. */}
        <form action={saveAction} noValidate className="flex flex-col gap-4">
          {places.length > 0 ? (
            <fieldset className="min-w-0">
              <legend className="text-[0.85rem] font-medium text-fg">
                Résultats pour « {search.query} »
              </legend>
              <div className="mt-2 flex flex-col gap-2">
                {places.map((place) => {
                  const detail = placeDetail(place);
                  const checked = place.id === selectedId;

                  return (
                    <label
                      key={place.id}
                      className={cn(
                        "flex cursor-pointer items-start gap-2.5 rounded-button border px-3 py-2.5 text-[0.85rem]",
                        "transition-colors duration-150 ease-out",
                        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
                        checked
                          ? "border-accent bg-accent-soft text-fg"
                          : "border-border bg-surface-2 text-fg-muted hover:border-fg-faint/35",
                      )}
                    >
                      <input
                        type="radio"
                        name="place"
                        value={String(place.id)}
                        checked={checked}
                        onChange={() => setSelectedId(place.id)}
                        className="sr-only"
                      />
                      <MapPin
                        aria-hidden="true"
                        strokeWidth={1.6}
                        className={cn(
                          "mt-px size-4 shrink-0",
                          checked ? "text-accent" : "text-fg-faint",
                        )}
                      />
                      <span className="min-w-0">
                        <span className="font-medium text-fg">{place.name}</span>
                        {detail === "" ? null : (
                          <span className="block text-[0.76rem] text-fg-faint">{detail}</span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ) : null}

          {/* Le lieu choisi part en champs cachés : le serveur revalide tout,
              rien n'est cru sur parole au retour. */}
          {selected === null ? null : (
            <>
              <input type="hidden" name="label" value={selected.name} />
              <input type="hidden" name="latitudeDeg" value={String(selected.latitudeDeg)} />
              <input type="hidden" name="longitudeDeg" value={String(selected.longitudeDeg)} />
            </>
          )}

          <div className="flex flex-wrap gap-2">
            {places.length > 0 ? (
              <Button
                type="submit"
                variant="secondary"
                disabled={isSaving || selected === null}
                aria-busy={isSaving}
                className="w-full sm:w-auto"
              >
                {isSaving ? (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                ) : null}
                {isSaving ? "Enregistrement…" : "Fixer ce lieu"}
              </Button>
            ) : null}

            {/* Rien à effacer tant qu'aucun lieu n'est fixé. */}
            {label === null ? null : (
              <Button
                type="submit"
                name="intent"
                value={CLEAR_FORECAST_LOCATION_VALUE}
                variant="ghost"
                disabled={isSaving}
                className="w-full sm:w-auto"
              >
                Revenir au mode automatique
              </Button>
            )}
          </div>
        </form>
      </div>
    </Panel>
  );
}
