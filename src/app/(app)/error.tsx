"use client";

import { useEffect } from "react";
import { CircleAlert, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-full border border-border bg-surface-2">
        <CircleAlert
          aria-hidden="true"
          strokeWidth={1.6}
          className="size-6 text-negative"
        />
      </span>

      <h1 className="mt-5 text-lg font-semibold text-fg">
        Cet écran n&apos;a pas pu s&apos;afficher
      </h1>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-balance text-fg-muted">
        Une erreur inattendue est survenue pendant le chargement de tes données.
        Tu peux réessayer&nbsp;: rien n&apos;a été modifié.
      </p>

      {error.digest ? (
        <p className="num mt-4 text-[0.72rem] text-fg-faint">
          Référence : {error.digest}
        </p>
      ) : null}

      <Button onClick={reset} className="mt-6">
        <RotateCw aria-hidden="true" className="size-4" />
        Réessayer
      </Button>
    </div>
  );
}
