/**
 * Parseur du sous-ensemble markdown que l'appli sait rendre — fonction pure,
 * testée, sans aucune dépendance.
 *
 * Le seul producteur de markdown ici est le coach IA, dont le prompt impose des
 * titres `###`, des puces et des paragraphes. Embarquer une bibliothèque
 * complète (CommonMark, tables, HTML brut, liens) pour ça reviendrait à ouvrir
 * une surface d'attaque — le HTML brut d'un markdown complet finit en
 * `dangerouslySetInnerHTML` — pour du texte qu'on maîtrise. Le parseur ne rend
 * donc **que** ce qui est listé ci-dessous, et tout le reste retombe en texte
 * littéral, jamais en balise.
 *
 * Grammaire reconnue :
 * - `#`, `##`, `###` suivis d'une espace → titre de niveau 1 à 3 ;
 * - lignes `- ` ou `* ` consécutives → liste à puces ;
 * - lignes non vides consécutives → paragraphe (les retours simples sont
 *   recollés, comme en markdown) ;
 * - `**gras**` à l'intérieur de n'importe lequel de ces blocs.
 *
 * Ce qui n'est pas reconnu (liens, images, code, citations, tables, HTML)
 * traverse le parseur comme du texte : le rendu React l'échappe par
 * construction.
 */

/** Un fragment de texte, gras ou non. Jamais de balise, jamais d'URL. */
export type MarkdownInline = { readonly text: string; readonly bold: boolean };

/** Un bloc de premier niveau du document. */
export type MarkdownBlock =
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3; readonly content: MarkdownInline[] }
  | { readonly kind: "paragraph"; readonly content: MarkdownInline[] }
  | { readonly kind: "list"; readonly items: MarkdownInline[][] };

/**
 * `# Titre` à `### Titre`. Les dièses doivent être suivis d'une espace (ou de
 * rien), comme en markdown : `###Titre` et `#### Titre` restent du texte.
 */
const HEADING = /^(#{1,3})(?=$|[ \t])[ \t]*(.*)$/;

/**
 * `- puce` ou `* puce`, jusqu'à trois espaces d'indentation.
 *
 * L'espace après le tiret est ce qui distingue une puce d'un `**gras**` en début
 * de ligne : `**` n'a pas d'espace après son premier astérisque.
 */
const LIST_ITEM = /^[ \t]{0,3}[-*][ \t]+(.*)$/;

const BOLD = "**";

/**
 * Découpe une ligne en fragments gras / non gras.
 *
 * Un `**` sans fermeture, ou dont le contenu est vide (`****`), n'ouvre rien :
 * les astérisques restent du texte. C'est le comportement le moins surprenant
 * quand un modèle tronque sa sortie en plein milieu d'une phrase.
 */
export function parseInline(source: string): MarkdownInline[] {
  const segments: MarkdownInline[] = [];
  let plain = "";
  let index = 0;

  const flush = () => {
    if (plain !== "") {
      segments.push({ text: plain, bold: false });
      plain = "";
    }
  };

  while (index < source.length) {
    if (source.startsWith(BOLD, index)) {
      const end = source.indexOf(BOLD, index + BOLD.length);
      const inner = end === -1 ? "" : source.slice(index + BOLD.length, end);
      if (end !== -1 && inner.trim() !== "") {
        flush();
        segments.push({ text: inner, bold: true });
        index = end + BOLD.length;
        continue;
      }
    }
    plain += source[index];
    index += 1;
  }

  flush();
  return segments;
}

/** 1, 2 ou 3 selon le nombre de dièses — la regex garantit la borne. */
function headingLevel(hashes: string): 1 | 2 | 3 {
  if (hashes.length === 1) return 1;
  return hashes.length === 2 ? 2 : 3;
}

/**
 * Le document découpé en blocs. Une source vide (ou uniquement des espaces)
 * rend un tableau vide : l'appelant décide alors de n'afficher rien du tout.
 */
export function parseMarkdownLite(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];

  // Les deux blocs à états : un paragraphe se poursuit ligne à ligne, une liste
  // s'allonge item par item, jusqu'à ce qu'autre chose les interrompe.
  let paragraph: string[] = [];
  let items: string[] | null = null;

  const closeParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", content: parseInline(paragraph.join(" ")) });
      paragraph = [];
    }
  };

  const closeList = () => {
    if (items !== null) {
      // Une liste dont toutes les puces étaient vides ne produit pas de bloc.
      if (items.length > 0) blocks.push({ kind: "list", items: items.map(parseInline) });
      items = null;
    }
  };

  const closeAll = () => {
    closeParagraph();
    closeList();
  };

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line === "") {
      closeAll();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      closeAll();
      const [, hashes, text] = heading;
      const content = text.trim();
      // `### ` seul ne titre rien : on n'ajoute pas un bloc vide à la page.
      if (content !== "") {
        blocks.push({ kind: "heading", level: headingLevel(hashes), content: parseInline(content) });
      }
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      closeParagraph();
      const text = item[1].trim();
      if (items === null) items = [];
      if (text !== "") items.push(text);
      continue;
    }

    closeList();
    paragraph.push(line);
  }

  closeAll();
  return blocks;
}
