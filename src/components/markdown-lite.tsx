import { Fragment, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import {
  parseMarkdownLite,
  type MarkdownInline,
} from "./markdown-lite-parser";

/**
 * Rendu du markdown léger produit par le coach IA.
 *
 * **Aucun HTML n'est jamais injecté** : le parseur ne rend que des chaînes, et
 * ce composant les place dans des nœuds React, donc échappées par construction.
 * `dangerouslySetInnerHTML` n'a pas sa place ici — c'est précisément ce que le
 * couple parseur + composant évite, sur du texte qui vient d'un modèle.
 *
 * Typographie : hiérarchie de texte existante (`fg` pour les titres et le gras,
 * `fg-muted` pour le corps), aucune couleur nouvelle. Les titres sont tous des
 * `h3` : à l'intérieur d'un panneau dont le titre est un `h2`, chaque section du
 * texte est de même rang — le niveau markdown ne module que la taille, jamais la
 * structure du document (pas de niveau sauté pour les lecteurs d'écran).
 */

const HEADING_TEXT = {
  1: "text-[0.98rem]",
  2: "text-[0.92rem]",
  3: "text-[0.88rem]",
} as const;

function renderInline(content: readonly MarkdownInline[]): ReactNode {
  return content.map((segment, index) =>
    segment.bold ? (
      <strong key={index} className="font-semibold text-fg">
        {segment.text}
      </strong>
    ) : (
      <Fragment key={index}>{segment.text}</Fragment>
    ),
  );
}

export type MarkdownLiteProps = {
  /** Texte markdown léger (titres, gras, puces, paragraphes). */
  source: string;
  className?: string;
};

export function MarkdownLite({ source, className }: MarkdownLiteProps) {
  const blocks = parseMarkdownLite(source);
  if (blocks.length === 0) return null;

  return (
    <div className={cn("text-[0.85rem] leading-relaxed text-fg-muted", className)}>
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          return (
            <h3
              key={index}
              className={cn(
                "mt-5 font-semibold tracking-[-0.01em] text-fg first:mt-0",
                HEADING_TEXT[block.level],
              )}
            >
              {renderInline(block.content)}
            </h3>
          );
        }

        if (block.kind === "list") {
          return (
            <ul
              key={index}
              className="mt-2.5 list-disc space-y-1.5 pl-4 marker:text-fg-faint first:mt-0"
            >
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }

        return (
          <p key={index} className="mt-2.5 first:mt-0">
            {renderInline(block.content)}
          </p>
        );
      })}
    </div>
  );
}
