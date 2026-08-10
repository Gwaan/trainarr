"use client";

import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload } from "lucide-react";

import {
  FIT_UPLOAD_FIELD,
  UNEXPECTED_ERROR_MESSAGE,
  fitUploadResponseSchema,
} from "@/app/api/fit/_lib/upload-contract";
import { Banner } from "@/components/banner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

import {
  summarizeFitUpload,
  type FitUploadSummary,
} from "../_lib/fit-upload-summary";

/**
 * En-tête de la page « Activités », porteur de l'import manuel de fichiers FIT.
 *
 * L'en-tête est un composant client parce que le bouton d'import, la zone de
 * dépôt et le récapitulatif partagent le même état : ils sont rendus à trois
 * endroits différents du flux (dans l'action de l'en-tête, puis en pleine
 * largeur sous celui-ci). Tout ce qui vient du serveur — le badge ou le CTA
 * Strava — reste rendu côté serveur et transite par `stravaAction`.
 */

const UPLOAD_ENDPOINT = "/api/fit/upload";

const GENERIC_FAILURE: FitUploadSummary = {
  tone: "negative",
  title: UNEXPECTED_ERROR_MESSAGE,
  failures: [],
};

export type ActivitiesHeaderProps = {
  title: string;
  subtitle: string;
  /** Badge « Strava connecté » ou bouton de connexion, rendus côté serveur. */
  stravaAction?: ReactNode;
};

export function ActivitiesHeader({
  title,
  subtitle,
  stravaAction,
}: ActivitiesHeaderProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isPending, setIsPending] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [summary, setSummary] = useState<FitUploadSummary | null>(null);

  /**
   * La zone de dépôt n'apparaît qu'au survol d'un glisser-déposer de fichiers
   * sur la page. Le compteur de profondeur évite qu'elle disparaisse au passage
   * d'un élément enfant, et le `dragover`/`drop` global empêche le navigateur
   * d'ouvrir le fichier lâché à côté.
   */
  useEffect(() => {
    let depth = 0;

    const carriesFiles = (event: globalThis.DragEvent) =>
      event.dataTransfer?.types.includes("Files") ?? false;

    const onDragEnter = (event: globalThis.DragEvent) => {
      if (!carriesFiles(event)) return;
      depth += 1;
      setIsDragging(true);
    };

    const onDragOver = (event: globalThis.DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
    };

    const onDragLeave = (event: globalThis.DragEvent) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDragging(false);
    };

    const onDrop = (event: globalThis.DragEvent) => {
      event.preventDefault();
      depth = 0;
      setIsDragging(false);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);

    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  async function upload(files: File[]) {
    if (files.length === 0 || isPending) return;

    setIsPending(true);
    setSummary(null);

    try {
      const body = new FormData();
      for (const file of files) body.append(FIT_UPLOAD_FIELD, file);

      const response = await fetch(UPLOAD_ENDPOINT, { method: "POST", body });
      const payload: unknown = await response.json().catch(() => null);
      const parsed = fitUploadResponseSchema.safeParse(payload);

      // Un rejet (413 notamment) peut porter un motif exploitable dans le même
      // format de réponse : l'afficher vaut mieux que le message générique.
      if (!parsed.success) {
        setSummary(GENERIC_FAILURE);
        return;
      }
      if (!response.ok) {
        setSummary(summarizeFitUpload(parsed.data.results) ?? GENERIC_FAILURE);
        return;
      }

      setSummary(summarizeFitUpload(parsed.data.results) ?? GENERIC_FAILURE);

      // Rafraîchit la liste des semaines dès qu'au moins une sortie a bougé.
      if (parsed.data.results.some((result) => result.ok)) router.refresh();
    } catch {
      // Réseau coupé, requête interrompue : rien n'est arrivé au serveur.
      setSummary(GENERIC_FAILURE);
    } finally {
      setIsPending(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    void upload(Array.from(event.dataTransfer.files));
  }

  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        action={
          <div className="flex items-center gap-2">
            {stravaAction}
            <Button
              type="button"
              variant="secondary"
              // Le libellé complet reste le nom accessible : sur mobile, seule
              // la forme courte est affichée, faute de place à côté du badge.
              aria-label="Importer des fichiers FIT"
              aria-busy={isPending}
              disabled={isPending}
              onClick={() => inputRef.current?.click()}
            >
              {isPending ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <Upload aria-hidden="true" strokeWidth={1.8} />
              )}
              {isPending ? (
                "Import…"
              ) : (
                <>
                  <span className="sm:hidden">Fichiers FIT</span>
                  <span className="hidden sm:inline">Importer des fichiers FIT</span>
                </>
              )}
            </Button>
            {/* Chemin réel depuis un iPhone : le bouton ouvre le sélecteur natif. */}
            <input
              ref={inputRef}
              type="file"
              accept=".fit"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                // Réinitialisé pour que le même fichier puisse être resoumis.
                event.target.value = "";
                void upload(files);
              }}
            />
          </div>
        }
      />

      {isDragging ? (
        <div
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
          className="rounded-card border border-dashed border-accent bg-accent-soft px-4 py-8 text-center"
        >
          <p className="text-sm font-medium text-fg">Dépose tes fichiers .fit ici</p>
          <p className="mt-1 text-[0.78rem] text-fg-faint">
            Ils seront analysés puis ajoutés à ton historique.
          </p>
        </div>
      ) : null}

      {/*
        Région live permanente : elle doit exister avant la mise à jour pour que
        le récapitulatif soit annoncé. Hors résultat, `sr-only` la sort du flux
        (position absolue), donc de l'espacement de la colonne.
      */}
      <div aria-live="polite" className={summary ? undefined : "sr-only"}>
        {summary ? (
          <Banner tone={summary.tone} title={summary.title}>
            {summary.failures.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {summary.failures.map((failure, index) => (
                  <li key={`${failure.name}-${index}`}>
                    <span className="num text-fg">{failure.name}</span>{" "}
                    <span aria-hidden="true">—</span> {failure.error}
                  </li>
                ))}
              </ul>
            ) : null}
          </Banner>
        ) : null}
      </div>
    </>
  );
}
