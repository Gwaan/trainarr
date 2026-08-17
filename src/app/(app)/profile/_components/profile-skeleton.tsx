import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Une ligne de champ : libellé, aide, saisie. */
function FieldSkeleton({ inputClassName }: { inputClassName: string }) {
  return (
    <div>
      <Skeleton className="h-3.5 w-24" />
      <Skeleton className="mt-2 h-3 w-72 max-w-full" />
      <Skeleton className={cn("mt-3 h-11", inputClassName)} />
    </div>
  );
}

function PanelSkeleton({
  titleWidth,
  children,
}: {
  titleWidth: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-border bg-surface">
      <div className="border-b border-border px-4 py-3 sm:px-5">
        <Skeleton className={cn("h-3", titleWidth)} />
      </div>
      <div className="flex flex-col gap-5 p-4 sm:p-5">{children}</div>
    </div>
  );
}

/**
 * Squelette des réglages à onglets, servi partout où `SettingsTabs` se charge :
 * en repli du `<Suspense>` de la page comme de celui de la modale.
 *
 * **Un seul squelette pour les deux hôtes**, exactement comme il n'y a qu'un
 * seul `SettingsTabs` : une géométrie qui dériverait d'un côté seulement est le
 * défaut qu'on cherche à rendre impossible.
 *
 * Il reprend la barre d'onglets puis le contenu de l'onglet ouvert par défaut,
 * « Profil » — ses deux panneaux et son bouton. La colonne est plate, comme
 * dans le rendu réel : le panneau d'onglet n'est qu'un `<div>` sans effet de
 * mise en page, et la région live du formulaire est hors flux tant qu'elle est
 * vide. Toute modification de `SettingsTabs` ou de `ProfileForm` doit être
 * répercutée ici.
 */
export function SettingsTabsSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Chargement des réglages"
      className="flex flex-col gap-4 sm:gap-5"
    >
      {/* Barre d'onglets : trois colonnes égales dans une gouttière bordée. */}
      <div className="grid auto-cols-fr grid-flow-col gap-1 rounded-button border border-border p-0.5">
        {[0, 1, 2].map((tab) => (
          <Skeleton key={tab} className="h-11 rounded-[6px]" />
        ))}
      </div>

      <PanelSkeleton titleWidth="w-16">
        <FieldSkeleton inputClassName="w-full sm:max-w-xs" />
        {/* Sexe : trois choix côte à côte à partir de `sm` */}
        <div>
          <Skeleton className="h-3.5 w-12" />
          <Skeleton className="mt-2 h-3 w-full max-w-lg" />
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {[0, 1, 2].map((choice) => (
              <Skeleton key={choice} className="h-[2.85rem]" />
            ))}
          </div>
        </div>
        <FieldSkeleton inputClassName="w-full sm:w-48" />
      </PanelSkeleton>

      <PanelSkeleton titleWidth="w-40">
        {/* Fréquences cardiaques : deux champs courts sur une ligne */}
        <div>
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="mt-2 h-3 w-full max-w-md" />
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-3">
            {[0, 1].map((field) => (
              <div key={field}>
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-2.5 h-11 w-32" />
              </div>
            ))}
          </div>
        </div>
        <FieldSkeleton inputClassName="w-32" />
      </PanelSkeleton>

      {/* Bouton d'enregistrement, et la phrase qui le suit à partir de `sm`. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Skeleton className="h-12 w-full sm:w-32" />
        <Skeleton className="h-3.5 w-72 max-w-full" />
      </div>

      {/* Correction d'altitude : un paragraphe, un bandeau de méthode, une case
          et deux coefficients côte à côte, puis le bouton — puis le facteur
          correctif, bâti sur le même patron avec un seul champ. Les deux
          panneaux suivent le profil dans l'onglet « Profil ». */}
      <PanelSkeleton titleWidth="w-36">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-16 w-full" />
        <div className="flex flex-col gap-4 sm:flex-row sm:gap-5">
          {[0, 1].map((coefficient) => (
            <div key={coefficient} className="flex-1">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="mt-2 h-3 w-full" />
              <Skeleton className="mt-3 h-11 w-full" />
            </div>
          ))}
        </div>
        <Skeleton className="h-11 w-full sm:w-32" />
      </PanelSkeleton>

      <PanelSkeleton titleWidth="w-48">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <FieldSkeleton inputClassName="w-full sm:w-40" />
        <Skeleton className="h-11 w-full sm:w-32" />
      </PanelSkeleton>


      <span className="sr-only">Chargement des réglages…</span>
    </div>
  );
}

/**
 * Squelette de la page « Réglages » : son en-tête, puis les onglets.
 *
 * Il ne peut coller qu'à **une** des deux formes de la page, qui ne se décident
 * qu'une fois le profil lu : l'édition à onglets, ou l'écran plein de création
 * quand aucun profil n'existe. C'est l'édition qui est reprise ici — la
 * création n'arrive qu'une fois dans la vie d'une installation, l'édition à
 * chaque visite.
 */
export function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      {/* En-tête : titre + sous-titre */}
      <div>
        <Skeleton className="h-8 w-64 max-w-full sm:h-9" />
        <Skeleton className="mt-2.5 h-3.5 w-96 max-w-full" />
      </div>

      <SettingsTabsSkeleton />
    </div>
  );
}
