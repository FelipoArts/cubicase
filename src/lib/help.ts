// URL do tutorial no site, no idioma da interface: português em /tutorial/,
// inglês em /en/tutorial/. `articleId` é o id do artigo (ex.: "criar-servidor"),
// igual nas duas versões, e vai como âncora (#id).
const SITE = "https://cubicase.net";

export function tutorialUrl(locale: string, articleId?: string): string {
  const base = locale.toLowerCase().startsWith("en") ? `${SITE}/en/tutorial/` : `${SITE}/tutorial/`;
  return articleId ? `${base}#${articleId}` : base;
}

export type LegalPage = "privacy" | "terms" | "licenses";

/** URL de uma página legal do site, no idioma da interface (PT: /privacidade/, /termos/, /licencas/; EN: /en/privacy/, /en/terms/, /en/licenses/). */
export function legalUrl(locale: string, page: LegalPage): string {
  const en = locale.toLowerCase().startsWith("en");
  const paths: Record<LegalPage, [string, string]> = {
    privacy: ["/privacidade/", "/en/privacy/"],
    terms: ["/termos/", "/en/terms/"],
    licenses: ["/licencas/", "/en/licenses/"],
  };
  return SITE + paths[page][en ? 1 : 0];
}
