"use client";

import { useActionState, useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { Loader2, LogOut } from "lucide-react";

import { Banner } from "@/components/banner";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AUTH_NAME_MAX_LENGTH, AUTH_PASSWORD_MIN_LENGTH } from "@/lib/auth/limits";
import { cn } from "@/lib/utils";

import {
  changeAccountPasswordAction,
  signOutAction,
  updateAccountNameAction,
} from "../_lib/account-actions";
import { ACCOUNT_FORM_IDLE, type AccountFormState } from "../_lib/account-state";

/**
 * Section « Ton compte » — l'identité de connexion, distincte du profil
 * physiologique.
 *
 * Trois formulaires côte à côte, jamais imbriqués (HTML l'interdit), chacun avec
 * son propre état : corriger son nom ne doit pas obliger à ressaisir un mot de
 * passe, et l'échec de l'un ne doit rien dire des deux autres.
 *
 * **Aucun bouton accent ici**, et c'est la conséquence directe des trois
 * formulaires : la section n'a pas *une* action principale à désigner, elle en a
 * trois. Les distinguer par l'accent reviendrait à en élire une au hasard, et la
 * déconnexion doit rester doublement en retrait — elle se déclencherait sinon en
 * croyant valider.
 */

/** Repli si une action échoue sans message — elle en fournit un dans tous ses cas connus. */
const GENERIC_FAILURE = "L'opération n'a pas abouti.";

/** Concatène les `id` de description d'un champ, en écartant ceux qui n'existent pas. */
function describedBy(...ids: (string | false)[]): string | undefined {
  const kept = ids.filter((id) => id !== false);
  return kept.length > 0 ? kept.join(" ") : undefined;
}

/**
 * Retour d'une action, annoncé aux lecteurs d'écran.
 *
 * La région live est permanente : elle doit exister **avant** la mise à jour
 * pour être annoncée. Sans message, `sr-only` la sort du flux.
 */
function Feedback({ state }: { state: AccountFormState }) {
  const hasFeedback = state.status !== "idle";

  return (
    <div aria-live="polite" className={hasFeedback ? "mb-4" : "sr-only"}>
      {state.status === "success" ? (
        <Banner tone="positive" title={state.message ?? "Enregistré."} />
      ) : null}
      {state.status === "error" ? (
        <Banner tone="negative" title={state.message ?? GENERIC_FAILURE} />
      ) : null}
    </div>
  );
}

/**
 * Un champ : libellé, aide, saisie, erreur.
 *
 * **`text-base` n'est pas décoratif** : en dessous de 16 px, iOS zoome à la
 * prise de focus, et en PWA `standalone` aucun geste ne ramène en arrière. Il
 * l'emporte donc sur la taille par défaut de `Input`.
 */
function AccountField({
  id,
  name,
  label,
  hint,
  error,
  type,
  autoComplete,
  value,
  onChange,
  className,
}: {
  id: string;
  name: string;
  label: string;
  hint?: string;
  error?: string;
  type: "text" | "password";
  autoComplete: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-[0.85rem] font-medium text-fg">
        {label}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="mt-1 text-[0.76rem] leading-snug text-fg-faint">
          {hint}
        </p>
      ) : null}
      <Input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        aria-required="true"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(
          Boolean(hint) && `${id}-hint`,
          Boolean(error) && `${id}-error`,
        )}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn("text-base", hint ? "mt-2" : "mt-1.5", className)}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-[0.76rem] leading-snug text-negative">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Sous-titre d'un des trois blocs de la section. */
function BlockHeading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <h3 className="text-[0.9rem] font-semibold text-fg">{title}</h3>
      <p className="mt-1 text-[0.78rem] leading-relaxed text-fg-muted">{children}</p>
    </div>
  );
}

/** Bouton de soumission secondaire — cf. l'en-tête du fichier : jamais l'accent. */
function SecondarySubmit({
  pending,
  label,
  pendingLabel,
}: {
  pending: boolean;
  label: string;
  pendingLabel: string;
}) {
  return (
    <Button
      type="submit"
      variant="secondary"
      disabled={pending}
      aria-busy={pending}
      className="w-full sm:w-auto"
    >
      {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
      {pending ? pendingLabel : label}
    </Button>
  );
}

/** Change le nom d'affichage du compte. */
function NameForm({ name }: { name: string }) {
  const [state, formAction, isPending] = useActionState(
    updateAccountNameAction,
    ACCOUNT_FORM_IDLE,
  );
  // Champ contrôlé : React réinitialise un formulaire non contrôlé une fois
  // l'action terminée, et la saisie serait perdue au moindre refus.
  const [value, setValue] = useState(name);
  const uid = useId();

  return (
    <div>
      {/* Aucun repère de position (« plus haut ») : cette section est rendue
          tantôt sous le formulaire de profil (création), tantôt dans son propre
          onglet — la phrase doit rester vraie des deux côtés. */}
      <BlockHeading title="Nom du compte">
        Le nom de ton identité de connexion. Il est indépendant de ton prénom de
        profil, qui décrit la coureuse et sert aux calculs.
      </BlockHeading>
      <Feedback state={state} />
      <form action={formAction} noValidate className="flex flex-col gap-3">
        <AccountField
          id={`${uid}-name`}
          name="name"
          label="Nom"
          error={state.fieldErrors?.name}
          type="text"
          autoComplete="name"
          value={value}
          onChange={setValue}
          className="sm:max-w-xs"
        />
        <div>
          <SecondarySubmit
            pending={isPending}
            label="Mettre à jour le nom"
            pendingLabel="Mise à jour…"
          />
        </div>
        <p className="text-[0.74rem] text-fg-faint">
          {AUTH_NAME_MAX_LENGTH} caractères maximum.
        </p>
      </form>
    </div>
  );
}

/** Les trois saisies du changement de mot de passe, vidées après un succès. */
const EMPTY_PASSWORDS = {
  currentPassword: "",
  newPassword: "",
  newPasswordConfirm: "",
};

/** Change le mot de passe, contre présentation de l'actuel. */
function PasswordForm() {
  const [state, formAction, isPending] = useActionState(
    changeAccountPasswordAction,
    ACCOUNT_FORM_IDLE,
  );
  const [values, setValues] = useState(EMPTY_PASSWORDS);
  const [lastState, setLastState] = useState(state);
  const uid = useId();

  // Une fois le mot de passe changé, rien ne justifie de garder l'ancien ni le
  // nouveau dans la page. Les champs restent remplis sur un refus, pour qu'une
  // faute de frappe n'oblige pas à tout retaper.
  //
  // Ajustement pendant le rendu et non dans un effet : c'est la forme que React
  // recommande pour dériver un état d'un autre (`useActionState` rend un nouvel
  // objet à chaque exécution de l'action), et elle évite le rendu en cascade
  // qu'un `useEffect` provoquerait.
  if (lastState !== state) {
    setLastState(state);
    if (state.status === "success") setValues(EMPTY_PASSWORDS);
  }

  const setField = (field: keyof typeof EMPTY_PASSWORDS, value: string) =>
    setValues((current) => ({ ...current, [field]: value }));

  return (
    <div>
      <BlockHeading title="Mot de passe">
        Le mot de passe actuel est demandé : sans lui, une session laissée
        ouverte suffirait à s&apos;approprier le compte. Tes autres appareils
        seront déconnectés — celui-ci reste connecté.
      </BlockHeading>
      <Feedback state={state} />
      <form action={formAction} noValidate className="flex flex-col gap-4">
        <AccountField
          id={`${uid}-current`}
          name="currentPassword"
          label="Mot de passe actuel"
          error={state.fieldErrors?.currentPassword}
          type="password"
          autoComplete="current-password"
          value={values.currentPassword}
          onChange={(value) => setField("currentPassword", value)}
          className="sm:max-w-xs"
        />
        <AccountField
          id={`${uid}-new`}
          name="newPassword"
          label="Nouveau mot de passe"
          hint={`${AUTH_PASSWORD_MIN_LENGTH} caractères minimum. Il n'y a pas de récupération par e-mail : conserve-le.`}
          error={state.fieldErrors?.newPassword}
          type="password"
          autoComplete="new-password"
          value={values.newPassword}
          onChange={(value) => setField("newPassword", value)}
          className="sm:max-w-xs"
        />
        <AccountField
          id={`${uid}-confirm`}
          name="newPasswordConfirm"
          label="Confirme ton nouveau mot de passe"
          error={state.fieldErrors?.newPasswordConfirm}
          type="password"
          autoComplete="new-password"
          value={values.newPasswordConfirm}
          onChange={(value) => setField("newPasswordConfirm", value)}
          className="sm:max-w-xs"
        />
        <div>
          <SecondarySubmit
            pending={isPending}
            label="Changer le mot de passe"
            pendingLabel="Changement…"
          />
        </div>
      </form>
    </div>
  );
}

/**
 * Déconnexion.
 *
 * Un `<form action={…}>` sur une Server Action, jamais un `onClick` qui
 * appellerait le client better-auth : le navigateur ne parle pas directement à
 * la couche d'authentification, et c'est le serveur qui fait expirer le cookie.
 */
function SignOutForm() {
  const [state, formAction, isPending] = useActionState(
    signOutAction,
    ACCOUNT_FORM_IDLE,
  );

  return (
    <div>
      <BlockHeading title="Se déconnecter">
        Ferme cette session et efface le cookie de cet appareil. Il faudra ton
        e-mail et ton mot de passe pour revenir.
      </BlockHeading>
      {/* Un échec n'est jamais avalé : se croire déconnectée à tort est pire
          que ne pas avoir de bouton. */}
      <Feedback state={state} />
      <form action={formAction}>
        <Button
          type="submit"
          variant="ghost"
          disabled={isPending}
          aria-busy={isPending}
          className="w-full border border-border sm:w-auto"
        >
          {isPending ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <LogOut aria-hidden="true" />
          )}
          {isPending ? "Déconnexion…" : "Se déconnecter"}
        </Button>
      </form>
    </div>
  );
}

/** Ce qu'on montre quand personne n'est connecté : une porte, pas un formulaire mort. */
function SignedOutNotice() {
  return (
    <div>
      <p className="text-[0.85rem] leading-relaxed text-fg-muted">
        Aucune session ouverte sur cet appareil. Les réglages du compte — nom et
        mot de passe — demandent d&apos;être connectée.
      </p>
      <Link
        href="/login"
        className={cn(
          "mt-4 inline-flex h-11 items-center justify-center rounded-button border border-border bg-surface-2 px-4",
          "text-sm font-semibold text-fg transition-colors duration-150 ease-out",
          "hover:border-fg-faint/35 hover:bg-surface-2/60",
        )}
      >
        Se connecter
      </Link>
    </div>
  );
}

export type AccountPanelProps = {
  /** `null` : aucune session — la section n'expose alors ni réglage ni déconnexion. */
  account: { name: string } | null;
};

export function AccountPanel({ account }: AccountPanelProps) {
  return (
    <Panel title="Ton compte">
      {account === null ? (
        <SignedOutNotice />
      ) : (
        <div className="flex flex-col gap-6">
          <NameForm name={account.name} />
          <div className="border-t border-border pt-6">
            <PasswordForm />
          </div>
          {/* La déconnexion est mise à l'écart des formulaires d'édition : on ne
              la déclenche pas en croyant enregistrer. */}
          <div className="border-t border-border pt-6">
            <SignOutForm />
          </div>
        </div>
      )}
    </Panel>
  );
}
