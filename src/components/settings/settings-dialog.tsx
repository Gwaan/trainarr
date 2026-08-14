"use client";

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";

import { Banner } from "@/components/banner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * La modale de réglages, et le seul endroit d'où elle s'ouvre.
 *
 * Elle enveloppe toute la coquille applicative parce que ses déclencheurs sont
 * dans la navigation — l'avatar de la sidebar et celui de la barre mobile, qui
 * ne sont jamais affichés en même temps. Un `Dialog` par déclencheur donnerait
 * deux modales et deux jeux de formulaires ; il n'y en a qu'une, et les avatars
 * la commandent par ce contexte.
 *
 * **Elle ne connaît pas les réglages qu'elle affiche.** Son contenu arrive en
 * `ReactNode` déjà rendu côté serveur (cf. `(app)/layout.tsx`) : aucune donnée
 * d'entraînement ne transite par ce composant client, et la modale reste
 * réutilisable telle quelle.
 *
 * `children` est passé tel quel : les Server Components de la coquille (sidebar,
 * en-tête, contenu de page) restent des éléments stables que React ne re-rend
 * pas quand l'état de la modale change.
 */

export type SettingsDialogControls = {
  /** Pour que le déclencheur porte son `aria-expanded` et son état visuel. */
  isOpen: boolean;
  /**
   * Ouvre la modale. L'élément passé reçoit le focus à la fermeture — sans
   * `DialogTrigger`, Radix n'a aucune référence vers quoi le renvoyer, et il
   * retomberait sur `<body>`.
   */
  open: (trigger?: HTMLElement | null) => void;
  close: () => void;
};

/**
 * Défaut inerte plutôt qu'une erreur : les mêmes composants de réglages sont
 * rendus en page, hors de toute modale, et un appel à `close()` n'y a
 * simplement rien à fermer.
 */
const INERT_CONTROLS: SettingsDialogControls = {
  isOpen: false,
  open: () => {},
  close: () => {},
};

const SettingsDialogContext =
  createContext<SettingsDialogControls>(INERT_CONTROLS);

export function useSettingsDialog(): SettingsDialogControls {
  return useContext(SettingsDialogContext);
}

export type SettingsDialogProps = {
  /** Les sections de réglages, rendues côté serveur et streamées. */
  sections: ReactNode;
  /** La coquille applicative, d'où partent les déclencheurs. */
  children: ReactNode;
};

export function SettingsDialog({ sections, children }: SettingsDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  /**
   * Une saisie a-t-elle eu lieu depuis cette ouverture-ci ?
   *
   * Le repérage se fait par l'événement `input` qui remonte du corps de la
   * modale, et non en interrogeant les formulaires : ils sont cinq (profil,
   * import, nom, mot de passe, déconnexion), chacun avec son état, et les
   * relier à cette modale pour qu'ils se déclarent « modifiés » les coupleraient
   * à un contexte qu'ils n'ont pas quand ils sont rendus en page.
   *
   * L'envoi d'un formulaire remet le drapeau à zéro : ce qui vient d'être
   * soumis n'est plus une saisie en attente, et sans cela toute fermeture après
   * un enregistrement réussi poserait une question sans objet.
   *
   * Les deux approximations que cela laisse, assumées : taper puis effacer
   * demande une confirmation pour rien (un clic), et un envoi **refusé** rend la
   * fermeture immédiate alors que les champs restent remplis. Ce second cas ne
   * survient que sous une bannière rouge affichée dans la section même — on
   * ferme alors en connaissance de cause, pas par inadvertance.
   */
  const [touched, setTouched] = useState(false);
  /** Le déclencheur à qui rendre le focus (cf. `open`). */
  const triggerRef = useRef<HTMLElement | null>(null);

  const controls = useMemo<SettingsDialogControls>(
    () => ({
      isOpen,
      open: (trigger) => {
        triggerRef.current = trigger ?? null;
        setTouched(false);
        setConfirmingClose(false);
        setIsOpen(true);
      },
      close: () => {
        setTouched(false);
        setConfirmingClose(false);
        setIsOpen(false);
      },
    }),
    [isOpen],
  );

  /**
   * Toute demande de fermeture passe par ici : croix, `Esc`, clic sur le voile,
   * bouton « Fermer ». Une saisie entamée n'est jamais avalée en silence — les
   * sections s'enregistrent chacune de leur côté, refermer sans avoir cliqué
   * « Enregistrer » perd tout ce qui a été tapé.
   *
   * Le motif est celui de la création de plan (`plan-create-dialog`) : même
   * bandeau neutre, mêmes deux issues. Il est repris parce que la perte est de
   * même nature — une saisie qui n'existe nulle part ailleurs — même si elle est
   * ici plus courte. Ce qu'on ne reprend pas, c'est le remplacement du corps par
   * la question : les réglages restent visibles derrière le bandeau, pour qu'on
   * voie ce qu'on abandonne.
   */
  function requestClose() {
    if (touched) {
      setConfirmingClose(true);
      return;
    }
    controls.close();
  }

  function handleOpenChange(next: boolean) {
    if (next) {
      controls.open(triggerRef.current);
      return;
    }
    requestClose();
  }

  return (
    <SettingsDialogContext value={controls}>
      {children}

      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent
          // Sans `DialogTrigger`, Radix rendrait le focus à une référence nulle,
          // c'est-à-dire à `<body>` : au clavier, fermer la modale ferait perdre
          // sa place dans la navigation.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
            <div className="min-w-0">
              <DialogTitle>Réglages</DialogTitle>
              <DialogDescription>
                Ton profil, ton compte et l&apos;import automatique de tes séances.
              </DialogDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Fermer"
              onClick={requestClose}
              className="-mr-2 shrink-0"
            >
              <X aria-hidden="true" />
            </Button>
          </header>

          <div
            // `input` et `submit` remontent jusqu'ici depuis n'importe quel champ
            // ou formulaire des sections, présents ou à venir.
            onInput={() => setTouched(true)}
            onSubmit={() => setTouched(false)}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5 sm:py-5"
          >
            {confirmingClose ? (
              <Banner
                tone="neutral"
                title="Fermer sans enregistrer ?"
                className="mb-4"
              >
                Chaque section a son propre bouton d&apos;enregistrement : ce qui
                vient d&apos;être saisi sans être enregistré sera perdu.
              </Banner>
            ) : null}

            {sections}
          </div>

          {/* Plein écran sur mobile : la barre d'actions doit dégager
              l'indicateur d'accueil de l'iPhone. */}
          <div className="flex items-center gap-2 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5 sm:pb-3">
            {confirmingClose ? (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setConfirmingClose(false)}
                >
                  Reprendre la saisie
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="ml-auto"
                  onClick={controls.close}
                >
                  Fermer sans enregistrer
                </Button>
              </>
            ) : (
              // Aucun accent ici : les CTA sont ceux des sections, un par
              // section. Fermer n'enregistre rien.
              <Button
                type="button"
                variant="ghost"
                className="ml-auto"
                onClick={requestClose}
              >
                Fermer
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </SettingsDialogContext>
  );
}
