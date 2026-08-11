import { describe, expect, it } from "vitest";

import { parseInline, parseMarkdownLite } from "./markdown-lite-parser";

describe("parseInline", () => {
  it("rend une ligne sans balisage en un seul fragment", () => {
    expect(parseInline("Belle séance en endurance.")).toEqual([
      { text: "Belle séance en endurance.", bold: false },
    ]);
  });

  it("isole les passages en gras", () => {
    expect(parseInline("Ton **allure** est régulière.")).toEqual([
      { text: "Ton ", bold: false },
      { text: "allure", bold: true },
      { text: " est régulière.", bold: false },
    ]);
  });

  it("gère plusieurs passages en gras, y compris en début et fin de ligne", () => {
    expect(parseInline("**4:52/km** de moyenne sur **10 km**")).toEqual([
      { text: "4:52/km", bold: true },
      { text: " de moyenne sur ", bold: false },
      { text: "10 km", bold: true },
    ]);
  });

  it("laisse les astérisques non fermées en texte", () => {
    expect(parseInline("Une **coupure nette")).toEqual([
      { text: "Une **coupure nette", bold: false },
    ]);
    expect(parseInline("Vide **** ici")).toEqual([{ text: "Vide **** ici", bold: false }]);
  });

  it("ne produit aucun fragment pour une ligne vide", () => {
    expect(parseInline("")).toEqual([]);
  });

  it("ne reconnaît ni lien ni HTML : tout reste du texte", () => {
    expect(parseInline("<b>ok</b> [lien](http://x) `code`")).toEqual([
      { text: "<b>ok</b> [lien](http://x) `code`", bold: false },
    ]);
  });
});

describe("parseMarkdownLite", () => {
  it("rend un tableau vide pour une source vide ou blanche", () => {
    expect(parseMarkdownLite("")).toEqual([]);
    expect(parseMarkdownLite("\n  \n\n")).toEqual([]);
  });

  it("reconnaît les trois niveaux de titre", () => {
    expect(parseMarkdownLite("# Un\n## Deux\n### Trois")).toEqual([
      { kind: "heading", level: 1, content: [{ text: "Un", bold: false }] },
      { kind: "heading", level: 2, content: [{ text: "Deux", bold: false }] },
      { kind: "heading", level: 3, content: [{ text: "Trois", bold: false }] },
    ]);
  });

  it("exige une espace après les dièses, et ignore un titre vide", () => {
    expect(parseMarkdownLite("###Titre collé")).toEqual([
      { kind: "paragraph", content: [{ text: "###Titre collé", bold: false }] },
    ]);
    expect(parseMarkdownLite("#### Quatre dièses")).toEqual([
      { kind: "paragraph", content: [{ text: "#### Quatre dièses", bold: false }] },
    ]);
    expect(parseMarkdownLite("###   ")).toEqual([]);
  });

  it("regroupe les puces consécutives, quel que soit le marqueur", () => {
    expect(parseMarkdownLite("- première\n* seconde\n  - troisième")).toEqual([
      {
        kind: "list",
        items: [
          [{ text: "première", bold: false }],
          [{ text: "seconde", bold: false }],
          [{ text: "troisième", bold: false }],
        ],
      },
    ]);
  });

  it("sépare deux listes par une ligne vide", () => {
    const blocks = parseMarkdownLite("- une\n\n- deux");
    expect(blocks).toHaveLength(2);
    expect(blocks.every((block) => block.kind === "list")).toBe(true);
  });

  it("recolle les lignes d'un même paragraphe et sépare sur ligne vide", () => {
    expect(parseMarkdownLite("Une phrase\ncoupée en deux.\n\nUne autre.")).toEqual([
      { kind: "paragraph", content: [{ text: "Une phrase coupée en deux.", bold: false }] },
      { kind: "paragraph", content: [{ text: "Une autre.", bold: false }] },
    ]);
  });

  it("ne confond pas un gras en début de ligne avec une puce", () => {
    expect(parseMarkdownLite("**Bilan** : séance tenue.")).toEqual([
      {
        kind: "paragraph",
        content: [
          { text: "Bilan", bold: true },
          { text: " : séance tenue.", bold: false },
        ],
      },
    ]);
  });

  it("découpe un feedback de coach complet", () => {
    const source = [
      "### Ce qui s'est bien passé",
      "- Allure **régulière** : 4:52/km de moyenne.",
      "- FC contenue en Z2.",
      "",
      "### Points d'attention",
      "Le découplage monte à 6,1 %,",
      "au-delà du seuil de 5 %.",
      "",
      "### Pour la suite",
      "* Une sortie longue en Z2 cette semaine.",
    ].join("\n");

    expect(parseMarkdownLite(source).map((block) => block.kind)).toEqual([
      "heading",
      "list",
      "heading",
      "paragraph",
      "heading",
      "list",
    ]);
  });

  it("interrompt un paragraphe dès la première puce, sans ligne vide", () => {
    expect(parseMarkdownLite("Constat :\n- un point").map((block) => block.kind)).toEqual([
      "paragraph",
      "list",
    ]);
  });
});
